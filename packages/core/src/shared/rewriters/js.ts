import { resolveFlags, KazeContext } from "@/shared";
import { URLMeta } from "@rewriters/url";

import { getRewriter, JsRewriterOutput } from "@rewriters/wasm";
import { bytesToBase64 } from "@/shared/util";
import {
	TextDecoder_decode,
	_RegExp,
	RegExp_exec,
	Object_keys,
	_WeakMap,
	Performance_now,
} from "../snapshot";

// eslint-disable-next-line kaze-core/no-globals
Error.stackTraceLimit = 50;

type RewriterResult = {
	js: string | Uint8Array;
	map: Uint8Array | null;
	tag: string;
	errors: string[];
};
// the rewriter caches its parsed config by object identity, so hand it the
// same object for as long as globals + prefix stay the same
const jsConfigCache: WeakMap<object, { prefix: string; obj: object }> =
	new _WeakMap([]);
function jsConfigFor(context: KazeContext) {
	const globals = context.config.globals;
	const prefix = context.prefix.pathname;
	const hit = jsConfigCache.get(globals);
	if (hit && hit.prefix === prefix) return hit.obj;
	const obj = { ...globals, prefix };
	jsConfigCache.set(globals, { prefix, obj });
	return obj;
}

function rewriteJsWasm(
	input: string | Uint8Array,
	source: string | null,
	context: KazeContext,
	meta: URLMeta,
	isModule: boolean,
	// meta.base is a getter that queries the document; read it once per rewrite
	base: URL = meta.base
): RewriterResult {
	const [rewriter, ret] = getRewriter(context, meta);

	const flagsobj = resolveFlags(context, base);

	try {
		let out: JsRewriterOutput;
		const before = Performance_now();
		// try {
		if (typeof input === "string") {
			out = rewriter.rewrite_js(
				jsConfigFor(context),
				flagsobj,
				context.interface.codecEncode,
				input,
				base.href,
				source || "(unknown)",
				isModule
			);
		} else {
			out = rewriter.rewrite_js_bytes(
				jsConfigFor(context),
				flagsobj,
				context.interface.codecEncode,
				input,
				base.href,
				source || "(unknown)",
				isModule
			);
		}
		// } catch (err) {
		// 	const err1 = err as Error;
		// 	console.warn(
		// 		"failed rewriting js for",
		// 		source,
		// 		err1.message,
		// 		input instanceof Uint8Array ? textDecoder.decode(input) : input
		// 	);

		// 	return { js: input, tag: "", map: null };
		// }
		if (flagsobj.rewriterLogs) {
			dbg.time(meta, before, `oxc rewrite for "${source || "(unknown)"}"`);
		}

		const { js, map, scramtag, errors } = out;

		return {
			js: typeof input === "string" ? TextDecoder_decode(js) : js,
			tag: scramtag,
			map,
			errors,
		};
	} finally {
		ret();
	}
}

export function rewriteJsInner(
	js: string | Uint8Array,
	url: string | null,
	context: KazeContext,
	meta: URLMeta,
	isModule = false,
	base: URL = meta.base
) {
	return rewriteJsWasm(js, url, context, meta, isModule, base);
}

// Every construct the rewriter can change contains one of these (see
// rewriter/js/src/visitor.rs), so source without any comes back byte-identical
// and doesn't need the wasm round trip. Backslash covers unicode-escaped
// identifiers, "[" computed access, "..." rest patterns. Keep in sync with the
// visitor. Most inline handlers and small evals land here.
const NEEDS_REWRITE =
	/[[\\]|location|parent|top|eval|postMessage|debugger|import|export|new|\.\.\./;

export function rewriteJs(
	js: string | Uint8Array,
	url: string | null,
	context: KazeContext,
	meta: URLMeta,
	isModule = false
): string | Uint8Array {
	// snapshotted exec: a page must not be able to force this path
	if (typeof js === "string" && RegExp_exec(NEEDS_REWRITE, js) === null) {
		const { flags, siteFlags } = context.config;
		const f =
			siteFlags && Object_keys(siteFlags).length
				? resolveFlags(context, meta.base)
				: flags;
		if (
			f.allowInvalidJs &&
			!f.sourcemaps &&
			!f.captureErrors &&
			!f.scramitize &&
			!f.rewriterLogs
		)
			return js;
	}
	const base = meta.base;
	const flags = resolveFlags(context, base);
	try {
		const res = rewriteJsInner(js, url, context, meta, isModule, base);
		let newjs = res.js;

		if (flags.sourcemaps && res.map) {
			const pushmap = globalThis[context.config.globals.pushsourcemapfn];
			if (pushmap) {
				pushmap(res.map, res.tag);
			} else {
				const text =
					typeof newjs === "string" ? newjs : TextDecoder_decode(newjs);
				// base64 string literal: ~1.33x the map size and a single string
				// for the engine to scan, instead of a [1,2,3,...] array literal
				// (~3.5x the size, one element per byte); decoded lazily client side
				const sourcemapfn = `${context.config.globals.pushsourcemapfn}("${bytesToBase64(res.map)}", "${res.tag}");`;

				// don't put the sourcemap call before "use strict"
				const strictMode = new _RegExp(/^\s*(['"])use strict\1;?/);
				if (strictMode.test(text)) {
					newjs = text.replace(strictMode, `$&\n${sourcemapfn}`);
				} else {
					newjs = `${sourcemapfn}\n${text}`;
				}
			}
		}

		if (flags.rewriterLogs) {
			for (const error of res.errors) {
				dbg.error("oxc parse error", error);
			}
		}

		return newjs;
	} catch (err) {
		dbg.warn(
			"failed rewriting js for",
			url || "(unknown)",
			err.message,
			typeof js !== "string" ? TextDecoder_decode(js) : js
		);
		if (flags.allowInvalidJs) {
			return js;
		} else {
			throw err;
		}
	}
}
