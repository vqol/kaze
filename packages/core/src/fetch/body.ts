import { BareResponse } from "@mercuryworkshop/proxy-transports";
import {
	BodyType,
	KazeFetchHandler,
	KazeFetchParsed,
	KazeFetchRequest,
} from ".";
import {
	flagEnabled,
	isHtmlMimeType,
	isJavascriptMimeType,
	rewriteCss,
	rewriteHtml,
	rewriteJs,
	rewriteWorkers,
	rewriteHtmlStream,
	canStreamHtml,
} from "@/shared";
import { sniffEncoding } from "@/shared/sniffEncoding";
import { _TextDecoder } from "@/shared/snapshot";

const MAX_REWRITE_CACHE_BYTES = 64 * 1024 * 1024;
// below this a worker round trip costs more than the rewrite
const OFFLOAD_MIN_BYTES = 4 * 1024;

/**
 * Same bytes from the http cache means the same rewrite, so keep the output
 * (the frame's prefix is fixed per handler). Keyed by the cache entry id.
 */
async function rewriteCached(
	handler: KazeFetchHandler,
	response: BareResponse,
	kind: string,
	rewrite: () => Promise<Uint8Array | string>
): Promise<any> {
	const id = (response as any).kzCacheId as string | undefined;
	if (!id) return rewrite();
	const key = kind + id;
	const cache = handler.rewriteCache;
	const hit = cache.get(key);
	if (hit !== undefined) return typeof hit === "string" ? hit : hit.slice();
	const out = await rewrite();
	cache.set(key, typeof out === "string" ? out : out.slice());
	handler.rewriteCacheBytes += out.length;
	if (handler.rewriteCacheBytes > MAX_REWRITE_CACHE_BYTES) {
		cache.clear();
		handler.rewriteCacheBytes = 0;
	}
	return out;
}

export async function rewriteBody(
	handler: KazeFetchHandler,
	request: KazeFetchRequest,
	parsed: KazeFetchParsed,
	response: BareResponse
): Promise<BodyType> {
	switch (parsed.destination) {
		case "iframe":
		case "document":
			if (isHtmlMimeType(response.headers.get("content-type") ?? "")) {
				if (
					response.body instanceof ReadableStream &&
					flagEnabled("streamHtml", handler.context, parsed.meta.origin) &&
					canStreamHtml(handler.context)
				) {
					return rewriteHtmlStream(
						response.body,
						response.headers.get("content-type"),
						handler.context,
						parsed.meta,
						{
							loadScripts: true,
							inline: true,
							source: parsed.url.href,
							headers: response.rawHeaders,
							history: parsed.trackedClient!.history,
						}
					);
				}
				const buf = await response.arrayBuffer();
				const bytes = new Uint8Array(buf);
				const encoding = sniffEncoding(
					bytes,
					response.headers.get("content-type")
				);
				const htmlContent = new _TextDecoder(encoding).decode(bytes);

				return rewriteHtml(htmlContent, handler.context, parsed.meta, {
					loadScripts: true,
					inline: true,
					source: parsed.url.href,
					headers: response.rawHeaders,
					// reasonably confident that a document fetch is impossible without a client
					history: parsed.trackedClient!.history,
				});
			} else {
				return response.body;
			}
		case "script": {
			// do not attempt to rewrite a 404 response
			if (response.ok) {
				const ct = response.headers.get("content-type");
				// don't rewrite invalid module scripts when the server declares a non-JS type
				if (parsed.isModule && ct && !isJavascriptMimeType(ct)) {
					return response.body;
				}

				let rewritten = rewriteCached(
					handler,
					response,
					parsed.isModule ? "m" : "s",
					async () => {
						let bytes = new Uint8Array(await response.arrayBuffer());
						if (
							handler.rewriteOffload &&
							bytes.byteLength >= OFFLOAD_MIN_BYTES
						) {
							const { output, input } = await handler.rewriteOffload.js(
								bytes,
								response.url,
								handler.context.prefix.href,
								parsed.meta,
								parsed.isModule
							);
							if (output !== null) return output;
							bytes = input as Uint8Array;
						}
						return rewriteJs(
							bytes,
							response.url,
							handler.context,
							parsed.meta,
							parsed.isModule
						);
					}
				);
				rewritten = await rewritten;

				if (
					flagEnabled("debugSourceURL", handler.context, parsed.meta.origin)
				) {
					if (rewritten instanceof Uint8Array) {
						rewritten = new TextDecoder().decode(rewritten);
					}
					rewritten += `\n//# sourceURL=${parsed.url.href}`;
				}

				return rewritten as unknown as ArrayBuffer;
			}
			return response.body;
		}
		case "style":
			return (await rewriteCached(handler, response, "c", async () => {
				const text = await response.text();
				if (handler.rewriteOffload && text.length >= OFFLOAD_MIN_BYTES) {
					const { output } = await handler.rewriteOffload.css(
						text,
						response.url,
						handler.context.prefix.href,
						parsed.meta
					);
					if (output !== null) return output;
				}
				return rewriteCss(text, handler.context, parsed.meta);
			})) as string;
		case "sharedworker":
		case "worker":
			return rewriteWorkers(
				new Uint8Array(await response.arrayBuffer()),
				response.url,
				handler.context,
				parsed.meta,
				parsed.isModule
			);
		default:
			return response.body;
	}
}
