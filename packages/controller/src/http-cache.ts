// HTTP cache for proxied subresources. Service worker responses never reach
// the browser's own HTTP cache, so without this every visit refetches and
// re-rewrites every script.
//
// Follows RFC 9111 for a private cache. Deliberately conservative:
//   - subresource GETs only: documents can depend on login state
//   - nothing with Set-Cookie or `Vary: Cookie`, nothing `no-store`
//   - partitioned by the requesting site, as browsers do
//   - requests with their own Range / conditional headers bypass it
//
// A miss costs one Map lookup: entries persisted in the Cache API are indexed
// in memory at startup, so an uncached URL never waits on storage.
import {
	Plugin,
	registrableDomain,
	type KazeFetchHandler,
	type KazeFetchRequest,
	type KazeFetchParsed,
} from "@kaze/core";
import {
	BareResponse,
	type RawHeaders,
} from "@mercuryworkshop/proxy-transports";

const CACHE_NAME = "kaze-http-v3";
const MAX_MEMORY_BYTES = 64 * 1024 * 1024;
const MAX_ENTRY_BYTES = 16 * 1024 * 1024;
const MAX_PERSISTED = 3000;
const CACHE_URL = "https://kz-cache.invalid/";
// how long an early request waits for the persisted index (see waitForIndex)
const INDEX_WAIT_MS = 150;

type Entry = {
	key: string;
	id: string;
	status: number;
	statusText: string;
	headers: RawHeaders;
	body: ArrayBuffer;
	storedAt: number;
};

type Directives = Record<string, string | true>;

function header(headers: RawHeaders, name: string): string | null {
	for (const [k, v] of headers) if (k.toLowerCase() === name) return v;
	return null;
}

function parseCacheControl(value: string | null): Directives {
	const out: Directives = {};
	if (!value) return out;
	for (const raw of value.split(",")) {
		const part = raw.trim();
		if (!part) continue;
		const eq = part.indexOf("=");
		if (eq === -1) out[part.toLowerCase()] = true;
		else
			out[part.slice(0, eq).trim().toLowerCase()] = part
				.slice(eq + 1)
				.trim()
				.replace(/^"|"$/g, "");
	}
	return out;
}

/** RFC 9111 4.2.1 freshness lifetime in seconds; null when unknown */
function lifetime(headers: RawHeaders, cc: Directives): number | null {
	for (const d of ["s-maxage", "max-age"]) {
		const n = parseInt(cc[d] as string, 10);
		if (Number.isFinite(n)) return n;
	}
	const date = Date.parse(header(headers, "date") ?? "");
	const expires = Date.parse(header(headers, "expires") ?? "");
	if (Number.isFinite(expires))
		return Math.max(
			0,
			(expires - (Number.isFinite(date) ? date : Date.now())) / 1000
		);
	const modified = Date.parse(header(headers, "last-modified") ?? "");
	if (Number.isFinite(modified) && Number.isFinite(date) && modified <= date)
		return ((date - modified) * 0.1) / 1000;
	return null;
}

/**
 * "fresh": serve it. "revalidate": stale, but within the response's
 * stale-while-revalidate window (RFC 5861): serve it and refresh it in the
 * background. "stale": revalidate before serving.
 */
function freshness(entry: Entry): "fresh" | "revalidate" | "stale" {
	const cc = parseCacheControl(header(entry.headers, "cache-control"));
	if (cc["no-cache"]) return "stale";
	if (
		(header(entry.headers, "pragma") ?? "").toLowerCase().includes("no-cache")
	)
		return "stale";
	const life = lifetime(entry.headers, cc);
	if (life === null) return "stale";
	const age =
		(parseInt(header(entry.headers, "age") ?? "0", 10) || 0) +
		(Date.now() - entry.storedAt) / 1000;
	if (age < life) return "fresh";
	// must-revalidate forbids serving stale; Cache-Control: no-cache was handled above
	if (cc["must-revalidate"] || cc["proxy-revalidate"]) return "stale";
	const swr = parseInt(cc["stale-while-revalidate"] as string, 10);
	return Number.isFinite(swr) && age < life + swr ? "revalidate" : "stale";
}

function isStorable(status: number, headers: RawHeaders): boolean {
	if (status !== 200 && status !== 203) return false;
	if (header(headers, "set-cookie") !== null) return false;
	if (header(headers, "content-range") !== null) return false;
	const cc = parseCacheControl(header(headers, "cache-control"));
	if (cc["no-store"]) return false;
	const vary = (header(headers, "vary") ?? "").toLowerCase();
	if (vary.includes("*") || vary.includes("cookie")) return false;
	return (
		lifetime(headers, cc) !== null ||
		header(headers, "etag") !== null ||
		header(headers, "last-modified") !== null
	);
}

function keyFor(
	request: KazeFetchRequest,
	parsed: KazeFetchParsed
): string | null {
	if (request.method !== "GET") return null;
	if (parsed.destination === "document" || parsed.destination === "iframe")
		return null;
	if (request.cache === "no-store" || request.cache === "reload") return null;
	const h = request.initialHeaders;
	if (h.has("range") || h.has("if-none-match") || h.has("if-modified-since"))
		return null;
	// the destination stands in for Vary: Accept, the site for Vary: Origin
	const site = registrableDomain(
		(parsed.clientUrl ?? parsed.url).hostname || "opaque"
	);
	return `${site}|${parsed.destination}|${parsed.url.href}`;
}

function toResponse(entry: Entry, url: string): BareResponse {
	const response = BareResponse.fromTransferrableResponse(
		{
			body: entry.body.slice(0),
			headers: entry.headers,
			status: entry.status,
			statusText: entry.statusText,
		},
		url
	);
	(response as any).kzCacheId = entry.id;
	return response;
}

export class ProxyHttpCache extends Plugin {
	private memory = new Map<string, Entry>();
	private memoryBytes = 0;
	private persisted: Set<string> | null = null;
	private storage: Promise<Cache> | null = null;
	private indexed: Promise<void> | null = null;
	private hits = new WeakMap<KazeFetchRequest, true>();
	private revalidating = new WeakMap<KazeFetchRequest, Entry>();
	private nextId = 0;

	constructor() {
		super("kaze-http-cache");
		if (typeof caches === "undefined") return;
		this.storage = caches.open(CACHE_NAME);
		this.indexed = this.storage
			.then(async (cache) => {
				const stored = await cache.keys();
				for (const r of stored.slice(
					0,
					Math.max(0, stored.length - MAX_PERSISTED)
				))
					void cache.delete(r);
				this.persisted = new Set(
					stored
						.slice(-MAX_PERSISTED)
						.map((r) => decodeURIComponent(r.url.slice(CACHE_URL.length)))
				);
			})
			.catch(() => {
				this.storage = null;
			});
	}

	/**
	 * Requests made while the index is still loading (a page restored at
	 * startup) wait for it a little, so a persisted entry isn't a miss just
	 * for arriving early; past the wait they go to the network as before.
	 */
	private async waitForIndex() {
		if (this.persisted || !this.indexed) return;
		let timer: ReturnType<typeof setTimeout> | undefined;
		await Promise.race([
			this.indexed,
			new Promise<void>((r) => (timer = setTimeout(r, INDEX_WAIT_MS))),
		]);
		clearTimeout(timer);
	}

	private remember(entry: Entry) {
		const old = this.memory.get(entry.key);
		if (old) this.memoryBytes -= old.body.byteLength;
		this.memory.delete(entry.key);
		this.memory.set(entry.key, entry);
		this.memoryBytes += entry.body.byteLength;
		for (const [k, e] of this.memory) {
			if (this.memoryBytes <= MAX_MEMORY_BYTES) break;
			this.memory.delete(k);
			this.memoryBytes -= e.body.byteLength;
		}
	}

	private persist(entry: Entry) {
		if (!this.storage) return;
		const meta = encodeURIComponent(
			JSON.stringify({
				id: entry.id,
				status: entry.status,
				statusText: entry.statusText,
				headers: entry.headers,
				storedAt: entry.storedAt,
			})
		);
		void this.storage
			.then((cache) =>
				cache.put(
					CACHE_URL + encodeURIComponent(entry.key),
					new Response(entry.body.slice(0), { headers: { "x-kz-meta": meta } })
				)
			)
			.then(() => this.persisted?.add(entry.key))
			.catch(() => {});
	}

	private async lookup(key: string): Promise<Entry | undefined> {
		const hit = this.memory.get(key);
		if (hit) {
			// most recently used goes last; eviction walks from the front
			this.memory.delete(key);
			this.memory.set(key, hit);
			return hit;
		}
		if (!this.storage) return undefined;
		await this.waitForIndex();
		if (!this.persisted?.has(key)) return undefined;
		try {
			const cache = await this.storage;
			const stored = await cache.match(CACHE_URL + encodeURIComponent(key));
			if (!stored) return undefined;
			const meta = JSON.parse(
				decodeURIComponent(stored.headers.get("x-kz-meta") ?? "")
			);
			const entry: Entry = { key, ...meta, body: await stored.arrayBuffer() };
			this.remember(entry);
			return entry;
		} catch {
			return undefined;
		}
	}

	attach(handler: KazeFetchHandler) {
		const hooks = handler.hooks.fetch;

		this.tap(hooks.request, async (ctx, props) => {
			if (props.earlyResponse) return;
			const key = keyFor(ctx.request, ctx.parsed);
			if (!key) return;
			const entry = await this.lookup(key);
			if (!entry) return;

			const state =
				ctx.request.cache === "no-cache" ? "stale" : freshness(entry);
			if (state !== "stale") {
				this.hits.set(ctx.request, true);
				props.earlyResponse = toResponse(entry, ctx.parsed.url.href);
				if (state === "revalidate")
					this.revalidateLater(handler, ctx.request, key);
				return;
			}

			const etag = header(entry.headers, "etag");
			const modified = header(entry.headers, "last-modified");
			if (!etag && !modified) return;
			if (etag) props.init.headers!.push(["If-None-Match", etag]);
			if (modified) props.init.headers!.push(["If-Modified-Since", modified]);
			this.revalidating.set(ctx.request, entry);
		});

		this.tap(hooks.preresponse, async (ctx, props) => {
			const request = ctx.request;
			if (this.hits.has(request)) return;

			const pending = this.revalidating.get(request);
			if (pending && props.response.status === 304) {
				// keep the bytes (and the rewrite-cache id), refresh the metadata
				const updates = new Map(
					props.response.rawHeaders.map(([k, v]) => [k.toLowerCase(), v])
				);
				updates.delete("content-length");
				updates.delete("content-encoding");
				const headers: RawHeaders = pending.headers
					.filter(([k]) => !updates.has(k.toLowerCase()))
					.concat([...updates]);
				const entry = { ...pending, headers, storedAt: Date.now() };
				this.remember(entry);
				this.persist(entry);
				props.response = toResponse(entry, ctx.parsed.url.href);
				return;
			}

			const key = keyFor(request, ctx.parsed);
			const response = props.response;
			if (
				!key ||
				!response.body ||
				!isStorable(response.status, response.rawHeaders)
			)
				return;
			const length = parseInt(
				header(response.rawHeaders, "content-length") ?? "0",
				10
			);
			if (length > MAX_ENTRY_BYTES) return;

			// the page gets one branch immediately, the cache collects the other
			const [forPage, forCache] = response.body.tee();
			props.response = BareResponse.fromTransferrableResponse(
				{
					body: forPage,
					headers: response.rawHeaders,
					status: response.status,
					statusText: response.statusText,
				},
				response.url
			);
			// the entry's id is known now, so this first response already fills
			// the rewrite cache (body.ts) and the first reload hits it. If the
			// entry never gets stored the id matches nothing: no false hits.
			const id = this.newId();
			(props.response as any).kzCacheId = id;
			void this.collect(key, id, forCache, response);
		});
	}

	private refreshing = new Set<string>();
	/**
	 * stale-while-revalidate: the page already has the stale copy; run the
	 * request again through the whole fetch pipeline (cookies, hooks) as a
	 * no-cache request, which revalidates the entry with If-None-Match /
	 * If-Modified-Since and stores the result. One at a time per entry.
	 */
	private revalidateLater(
		handler: KazeFetchHandler,
		request: KazeFetchRequest,
		key: string
	) {
		if (this.refreshing.has(key)) return;
		this.refreshing.add(key);
		void (async () => {
			try {
				const response = await handler.handleFetch({
					...request,
					cache: "no-cache",
				});
				// nobody reads it: let a streamed body go
				const body = response.body as unknown;
				if (body instanceof ReadableStream) await body.cancel();
			} catch {
				// the stale copy stays until it expires
			} finally {
				this.refreshing.delete(key);
			}
		})();
	}

	private newId() {
		return String(++this.nextId) + ":" + Date.now();
	}

	private async collect(
		key: string,
		id: string,
		body: ReadableStream<Uint8Array>,
		response: BareResponse
	) {
		const reader = body.getReader();
		const chunks: Uint8Array[] = [];
		let size = 0;
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				size += value.byteLength;
				if (size > MAX_ENTRY_BYTES) {
					await reader.cancel();
					return;
				}
				chunks.push(value);
			}
		} catch {
			return;
		}
		const bytes = new Uint8Array(size);
		let offset = 0;
		for (const c of chunks) {
			bytes.set(c, offset);
			offset += c.byteLength;
		}
		const entry: Entry = {
			key,
			id,
			status: response.status,
			statusText: response.statusText,
			headers: response.rawHeaders,
			body: bytes.buffer,
			storedAt: Date.now(),
		};
		this.remember(entry);
		this.persist(entry);
	}
}
