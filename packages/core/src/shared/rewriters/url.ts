import { KazeContext } from "@/shared";
import { rewriteJs } from "@rewriters/js";
import { QP } from "@/fetch/parse";

import {
	TextEncoder_encode,
	_URL,
	_URLSearchParams,
	atob,
	encodeURIComponent,
	RegExp_exec,
	String_indexOf,
	String,
	String_startsWith,
	URL_createObjectURL,
} from "../snapshot";

// user: manually triggered navigation
// link: link clicked by the user. still user initiated, but doesn't wipe
// location: location = ...
export type NavigationType = "user" | "link" | "location";

export type RewriteUrlOptions = {
	referrerPolicy?: string;
	isModule?: boolean;
	navigateType?: NavigationType;
	topFrame?: string;
	parentFrame?: string;
	isIframe?: string;
	mode?: string;
	credentials?: string;
	destination?: RequestDestination;
};

export type URLMetaSnapshot = {
	baseHref: string;
	baseOrigin: string;
	initiatorOrigin: string;
};

export type URLMeta = {
	origin: _URL;
	base: _URL;
	/** strings from origin/base, remembered while the page's location and <base> stay put */
	snapshot?: () => URLMetaSnapshot;
	topFrameName?: string;
	parentFrameName?: string;
	referrerPolicy?: string;
};

function tryCanParseURL(url: string, origin?: string | URL): _URL | null {
	try {
		return new _URL(url, origin);
	} catch {
		return null;
	}
}

/** context.prefix never changes; URL getters are slow enough to matter here */
function prefixStrings(context: KazeContext) {
	return (context.prefixStrings ??= {
		href: context.prefix.href,
		origin: context.prefix.origin,
	});
}

export function rewriteBlob(url: string, context: KazeContext, meta: URLMeta) {
	const blob = new _URL(url.substring("blob:".length));

	return "blob:" + meta.origin.origin + blob.pathname;
}

export function unrewriteBlob(
	url: string,
	context: KazeContext,
	_meta: URLMeta
) {
	const blob = new _URL(url.substring("blob:".length));

	return "blob:" + context.prefix.origin + blob.pathname;
}

function dataToBlob(url: string) {
	const commaIndex = url.indexOf(",");
	if (commaIndex === -1) return null;

	const meta = url.slice("data:".length, commaIndex);
	const data = url.slice(commaIndex + 1);

	const metaParts = meta.split(";");
	const mediaType = metaParts.shift() || "";
	const isBase64 = metaParts.some((part) => part.toLowerCase() === "base64");
	const params = metaParts.filter(
		(part) => part && part.toLowerCase() !== "base64"
	);

	let type = mediaType || "text/plain";
	if (!mediaType) {
		const hasCharset = params.some((part) =>
			String_startsWith(part.toLowerCase(), "charset=")
		);
		if (!hasCharset) {
			params.push("charset=US-ASCII");
		}
	}
	if (params.length) type += ";" + params.join(";");

	let bytes: Uint8Array;
	if (isBase64) {
		let base64 = data.replace(/\s/g, "");
		base64 = base64.replace(/-/g, "+").replace(/_/g, "/");
		const binString = atob(base64);
		bytes = new Uint8Array(binString.length);
		for (let i = 0; i < binString.length; i++) {
			bytes[i] = binString.charCodeAt(i);
		}
	} else {
		let decoded = data;
		try {
			decoded = decodeURIComponent(data);
		} catch {
			// If decode fails, fall back to raw data.
		}
		bytes = TextEncoder_encode(decoded);
	}

	const blob = new Blob([bytes], { type });
	const objectUrl = URL_createObjectURL(blob);
	return { blob, objectUrl };
}

export function rewriteUrl(
	url: string | URL,
	context: KazeContext,
	meta: URLMeta,
	options?: RewriteUrlOptions
) {
	url = String(url);

	// plain relative/absolute urls skip the scheme checks below
	const first = url[0];
	const special =
		first === "j" ||
		first === "b" ||
		first === "d" ||
		first === "m" ||
		first === "a";

	if (special && String_startsWith(url, "javascript:")) {
		return (
			"javascript:" +
			rewriteJs(
				url.slice("javascript:".length),
				"(javascript: url)",
				context,
				meta
			)
		);
	} else if (special && String_startsWith(url, "blob:")) {
		return context.prefix.href + url;
	} else if (special && String_startsWith(url, "data:")) {
		const URL_MAX_LENGTH = 1024 * 1024 * 2;
		const BUFFER = 1024;
		// chrome will explode if you make a request to a service worker with a 2MB+ URL
		// there's an okayish workaround which is just Pretending It's a Blob
		if (url.length + context.prefix.href.length + BUFFER > URL_MAX_LENGTH) {
			const { objectUrl } = dataToBlob(url);
			return (
				context.prefix.href +
				rewriteBlob(objectUrl, context, meta) +
				"?" +
				QP.fakeDataURL +
				"=1"
			);
		}

		return context.prefix.href + url;
	} else if (
		special &&
		(String_startsWith(url, "mailto:") || String_startsWith(url, "about:"))
	) {
		return url;
	} else {
		const snapshot = meta.snapshot?.();
		let base = snapshot ? snapshot.baseHref : meta.base.href;

		if (String_startsWith(base, "about:"))
			base = unrewriteUrl(self.location.href, context); // jank!!!!! weird jank!!!
		let href: string;
		if (
			first === "/" &&
			RegExp_exec(PLAIN_ROOT_PATH, url) !== null &&
			String_indexOf(url, "/.") === -1 &&
			String_startsWith(base, "http")
		) {
			// the common root-relative url: resolving it is just concatenation
			href = (snapshot ? snapshot.baseOrigin : meta.base.origin) + url;
		} else {
			const realUrl = tryCanParseURL(url, base);
			if (!realUrl) return url;

			if (realUrl.protocol != "http:" && realUrl.protocol != "https:") {
				// custom protocol. best thing to do is pass it through so it can open an app etc
				// there's also extension:// pages we might need to worry about later
				return url;
			}
			href = realUrl.href;
		}

		// split the fragment off the serialized url instead of using the hash
		// setter (which re-serializes); the first "#" always starts the fragment
		let fragment = "";
		const hashAt = href.indexOf("#");
		if (hashAt !== -1) {
			fragment = href.slice(hashAt + 1);
			href = href.slice(0, hashAt);
		}
		const encodedHash = context.interface.codecEncode(fragment);
		const realHash = encodedHash ? "#" + encodedHash : "";

		// same output as URLSearchParams#toString, without allocating one
		let params = "";
		const add = (key: string, value: string) => {
			params += (params ? "&" : "?") + key + "=" + formEncode(value);
		};
		const referrerPolicy =
			!options?.isModule && (options?.referrerPolicy ?? meta.referrerPolicy);
		if (referrerPolicy) add(QP.referrerPolicy, referrerPolicy);
		if (options?.isModule) add(QP.isModule, "module");
		if (options?.topFrame) add(QP.topFrame, options.topFrame);
		if (options?.parentFrame) add(QP.parentFrame, options.parentFrame);
		if (options?.isIframe) add(QP.isIframe, options.isIframe);
		if (options?.mode) add(QP.mode, options.mode);
		if (options?.credentials) add(QP.credentials, options.credentials);
		if (options?.destination) add(QP.destination, options.destination);

		// specific tracking for sec-fetch-site
		// don't send for the top level controller calling it in go()
		const initiatorOrigin = snapshot
			? snapshot.initiatorOrigin
			: meta.origin.origin;
		const prefix = prefixStrings(context);
		if (initiatorOrigin !== prefix.origin) {
			add(QP.initiatorOrigin, initiatorOrigin);
		}

		return (
			prefix.href + context.interface.codecEncode(href) + params + realHash
		);
	}
}

// application/x-www-form-urlencoded value encoding, identical to what
// URLSearchParams produces. Most values (policies, "module", origins) hit the
// fast paths; anything unusual (lone surrogates) defers to URLSearchParams.
// characters the URL parser leaves untouched in a path and query (no %, so no
// percent-encoded dot segments); "//" would be scheme-relative
const PLAIN_ROOT_PATH = /^\/(?!\/)[\w\-.~/?=&+,:]*$/;
const FORM_SAFE = /^[\w.*-]*$/;
const FORM_EXTRA = /[!'()~]/g;
// the same few values (the page's origin, mostly) repeat on every url
let lastFormInput = "";
let lastFormOutput = "";
function formEncode(value: string): string {
	if (value === lastFormInput) return lastFormOutput;
	lastFormOutput = formEncodeSlow(value);
	lastFormInput = value;
	return lastFormOutput;
}
function formEncodeSlow(value: string): string {
	if (RegExp_exec(FORM_SAFE, value) !== null) return value;
	try {
		return encodeURIComponent(value)
			.replace(/%20/g, "+")
			.replace(
				FORM_EXTRA,
				(c) => "%" + c.charCodeAt(0).toString(16).toUpperCase()
			);
	} catch {
		const sp = new _URLSearchParams();
		sp.set("a", value);
		return sp.toString().slice(2);
	}
}

export function unrewriteUrl(url: string | URL, context: KazeContext) {
	url = String(url);
	if (String_startsWith(url, "javascript:")) {
		//TODO
		return url;
	} else if (String_startsWith(url, "blob:")) {
		// realistically this shouldn't happen
		return url;
	} else if (String_startsWith(url, context.prefix.href + "blob:")) {
		return url.substring(context.prefix.href.length);
	} else if (String_startsWith(url, context.prefix.href + "data:")) {
		return url.substring(context.prefix.href.length);
	} else if (
		String_startsWith(url, "mailto:") ||
		String_startsWith(url, "about:")
	) {
		return url;
	} else if (
		String_startsWith(url, "http:") ||
		String_startsWith(url, "https:")
	) {
		// a url we produced: skip the parse and reserialize
		const prefixHref = prefixStrings(context).href;
		if (String_startsWith(url, prefixHref)) {
			let end = url.length;
			const hashAt = String_indexOf(url, "#");
			if (hashAt !== -1) end = hashAt;
			const queryAt = String_indexOf(url, "?");
			if (queryAt !== -1 && queryAt < end) end = queryAt;
			const decodedHash =
				hashAt === -1
					? ""
					: context.interface.codecDecode(url.slice(hashAt + 1));
			return (
				context.interface.codecDecode(url.slice(prefixHref.length, end)) +
				(decodedHash ? "#" + decodedHash : "")
			);
		}
		const realUrl = tryCanParseURL(url);
		if (!realUrl) return url;
		if (realUrl.protocol != "http:" && realUrl.protocol != "https:") {
			// custom protocol
			return url;
		}
		if (!String_startsWith(realUrl.href, context.prefix.href)) {
			dbg.error("unrewriteurl: unexpected url", url);
			return url;
		}
		const decodedHash = context.interface.codecDecode(realUrl.hash.slice(1));
		const realHash = decodedHash ? "#" + decodedHash : "";
		realUrl.hash = "";
		realUrl.search = "";

		return (
			context.interface.codecDecode(
				realUrl.href.slice(context.prefix.href.length)
			) + realHash
		);
	} else if (url == "") {
		return url;
	} else {
		dbg.error("unrewriteurl: unexpected url", url);
		return url;
	}
}
