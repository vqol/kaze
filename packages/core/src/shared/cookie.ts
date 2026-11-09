// thnank you node unblocker guy
import { JSON_parse, JSON_stringify } from "@/shared/snapshot";
import { _Date } from "./snapshot";
import parse from "./set-cookie-parser";
import { isPublicSuffix } from "./psl";

// Chrome's "Lax-allowing-unsafe": cookies that got SameSite=Lax by default
// (no attribute) are still sent on cross-site top-level POST navigations for
// two minutes after creation. OAuth/OIDC form_post callbacks (Apple, Microsoft,
// many SSO providers) depend on it to get their state/nonce cookie back.
const LAX_ALLOWING_UNSAFE_MS = 2 * 60 * 1000;

/**
 * "strict"      same-site: everything allowed
 * "lax"         cross-site top-level GET navigation: Strict blocked
 * "lax-unsafe"  cross-site top-level POST navigation: like cross-site, plus
 *               recently created default-Lax cookies
 * "cross-site"  cross-site subresource / frame: only SameSite=None
 */
export type SameSiteContext = "strict" | "lax" | "lax-unsafe" | "cross-site";

export type Cookie = {
	name: string;
	value: string;
	path?: string;
	expires?: number;
	maxAge?: number;
	domain?: string;
	hostOnly?: boolean;
	secure?: boolean;
	httpOnly?: boolean;
	sameSite?: string; // "strict"|"lax"|"none" or titlecase variants from parsers
	/** SameSite came from the default, not an attribute */
	sameSiteDefault?: boolean;
	/** creation time (kept when a cookie is overwritten, per RFC 6265) */
	creation?: number;
	/** tie-breaker for equal creation times */
	seq?: number;
};

let cookieSeq = 0;

export class CookieJar {
	private cookies: Record<string, Cookie> = {};
	// Index by domain (without leading dot)
	private byDomain: Map<string, Cookie[]> = new Map();

	private defaultPath(url: URL): string {
		const pathname = url.pathname;
		if (!pathname || !pathname.startsWith("/")) return "/";
		const lastSlash = pathname.lastIndexOf("/");
		if (lastSlash <= 0) return "/";
		return pathname.slice(0, lastSlash);
	}

	private pathMatches(requestPath: string, cookiePath: string): boolean {
		if (requestPath === cookiePath) return true;
		if (!requestPath.startsWith(cookiePath)) return false;
		if (cookiePath.endsWith("/")) return true;
		return requestPath.charAt(cookiePath.length) === "/";
	}

	private indexCookie(c: Cookie) {
		const key = c.domain!.slice(1);
		let bucket = this.byDomain.get(key);
		if (!bucket) {
			bucket = [];
			this.byDomain.set(key, bucket);
		}
		bucket.push(c);
	}

	private unindexCookie(c: Cookie) {
		const key = c.domain!.slice(1);
		const bucket = this.byDomain.get(key);
		if (!bucket) return;
		const i = bucket.indexOf(c);
		if (i >= 0) bucket.splice(i, 1);
		if (bucket.length === 0) this.byDomain.delete(key);
	}

	private removeById(id: string) {
		const prev = this.cookies[id];
		if (prev) this.unindexCookie(prev);
		delete this.cookies[id];
	}

	/**
	 * Store cookies from a Set-Cookie header value (or a document.cookie write
	 * when `fromJs`). Returns how many cookies were accepted.
	 */
	setCookies(cookieString: string, url: URL, fromJs = false): number {
		return this.apply(cookieString, url, fromJs, null).accepted;
	}

	/**
	 * setCookies for a response, also reporting whether the change can show up
	 * in document.cookie of a page on `pageUrl`: a cookie that isn't HttpOnly
	 * and domain-matches the page's host, or a replaced/deleted cookie that
	 * was. Unknown or non-http(s) pages always count as affected.
	 */
	setCookiesFromResponse(
		cookieString: string,
		url: URL,
		pageUrl: URL | undefined
	): { accepted: number; visibleToPage: boolean } {
		const host =
			pageUrl &&
			(pageUrl.protocol === "http:" || pageUrl.protocol === "https:") &&
			pageUrl.hostname
				? pageUrl.hostname.toLowerCase()
				: null;
		const { accepted, touched } = this.apply(cookieString, url, false, []);
		if (host === null) return { accepted, visibleToPage: accepted > 0 };
		const visible = (c: Cookie) => {
			if (c.httpOnly) return false;
			const d = c.domain!.slice(1);
			return c.hostOnly ? d === host : d === host || host.endsWith("." + d);
		};
		return { accepted, visibleToPage: touched!.some(visible) };
	}

	/** `touched` collects every cookie added, replaced or removed */
	private apply(
		cookieString: string,
		url: URL,
		fromJs: boolean,
		touched: Cookie[] | null
	): { accepted: number; touched: Cookie[] | null } {
		const parsedCookies = parse(cookieString);
		const hostname = url.hostname.toLowerCase();
		const now = _Date.now();
		let accepted = 0;

		for (const parsedCookie of parsedCookies) {
			const lowerName = parsedCookie.name.toLowerCase();

			if (lowerName.startsWith("__secure-")) {
				if (!parsedCookie.secure) continue;
			} else if (lowerName.startsWith("__host-")) {
				if (!parsedCookie.secure) continue;
				if (parsedCookie.domain) continue;
				if (parsedCookie.path !== "/") continue;
			}

			// scripts can't create HttpOnly cookies
			if (fromJs && parsedCookie.httpOnly) continue;

			// Domain attribute: must domain-match the host and not be a public
			// suffix, otherwise any site could plant cookies on any other
			let domain = hostname;
			let hostOnly = true;
			if (typeof parsedCookie.domain === "string" && parsedCookie.domain) {
				let d = parsedCookie.domain.toLowerCase();
				while (d.startsWith(".")) d = d.slice(1);
				if (d.endsWith(".")) d = d.slice(0, -1);
				if (d) {
					if (isPublicSuffix(d)) {
						// allowed only as the host itself, and then host-only
						if (d !== hostname) continue;
					} else {
						if (d !== hostname && !hostname.endsWith("." + d)) continue;
						hostOnly = false;
					}
					domain = d;
				}
			}

			const expiresTime = parsedCookie.expires?.getTime();
			const expires = Number.isFinite(expiresTime) ? expiresTime : undefined;
			const sameSiteRaw =
				typeof parsedCookie.sameSite === "string"
					? parsedCookie.sameSite.toLowerCase()
					: undefined;
			// unknown values behave like a missing attribute (default Lax)
			const sameSiteValid =
				sameSiteRaw === "strict" ||
				sameSiteRaw === "lax" ||
				sameSiteRaw === "none";
			const cookie: Cookie = {
				...parsedCookie,
				domain: "." + domain,
				hostOnly,
				expires,
				sameSite: sameSiteValid ? sameSiteRaw : "lax",
				sameSiteDefault: !sameSiteValid,
			};

			if (!cookie.path || !cookie.path.startsWith("/")) {
				cookie.path = this.defaultPath(url);
			}

			const id = `${cookie.domain}@${cookie.path}@${cookie.name}`;
			const prev = this.cookies[id];

			// scripts can't overwrite (or delete) HttpOnly cookies either
			if (fromJs && prev?.httpOnly) continue;

			if (touched) {
				touched.push(cookie);
				if (prev) touched.push(prev);
			}

			if (typeof cookie.maxAge === "number") {
				if (!Number.isFinite(cookie.maxAge)) {
					delete cookie.maxAge;
				} else if (cookie.maxAge <= 0) {
					this.removeById(id);
					accepted++;
					continue;
				} else {
					cookie.expires = now + cookie.maxAge * 1000;
				}
			}
			// an expiry in the past is how sites delete cookies
			if (cookie.expires !== undefined && cookie.expires <= now) {
				this.removeById(id);
				accepted++;
				continue;
			}

			cookie.creation = prev?.creation ?? now;
			cookie.seq = prev?.seq ?? ++cookieSeq;
			if (prev) this.unindexCookie(prev);
			this.cookies[id] = cookie;
			this.indexCookie(cookie);
			accepted++;
		}

		return { accepted, touched };
	}

	getCookies(
		url: URL,
		fromJs: boolean,
		sameSiteContext: SameSiteContext = "strict"
	): string {
		const now = _Date.now();
		const hostname = url.hostname.toLowerCase();
		const pathname = url.pathname;
		const validCookies: Cookie[] = [];

		// Walk the hostname's domain suffix chain
		let key: string | undefined = hostname;
		while (key !== undefined) {
			const bucket = this.byDomain.get(key);
			if (bucket) {
				for (const cookie of bucket) {
					if (cookie.expires !== undefined && cookie.expires < now) continue;

					if (cookie.hostOnly && key !== hostname) continue;

					// Kaze proxies all origins as HTTPS (including those served over HTTP),
					// so we don't enforce the Secure attribute based on protocol here.
					if (cookie.httpOnly && fromJs) continue;
					if (!this.pathMatches(pathname, cookie.path!)) continue;

					// compare case-insensitively: jars persisted by older builds
					// may hold "Strict"/"Lax"/"None"
					const cs = (cookie.sameSite ?? "lax").toLowerCase();
					if (sameSiteContext === "cross-site") {
						if (cs !== "none") continue;
					} else if (sameSiteContext === "lax-unsafe") {
						if (
							cs !== "none" &&
							!(
								cookie.sameSiteDefault &&
								now - (cookie.creation ?? 0) < LAX_ALLOWING_UNSAFE_MS
							)
						)
							continue;
					} else if (sameSiteContext === "lax") {
						if (cs === "strict") continue;
					}

					validCookies.push(cookie);
				}
			}
			const dot = key.indexOf(".");
			key = dot === -1 ? undefined : key.slice(dot + 1);
		}

		// RFC 6265 5.4: longer paths first, then earlier creation
		if (validCookies.length > 1)
			validCookies.sort(
				(a, b) =>
					b.path!.length - a.path!.length ||
					(a.creation ?? 0) - (b.creation ?? 0) ||
					(a.seq ?? 0) - (b.seq ?? 0)
			);

		let out = "";
		for (const cookie of validCookies) {
			if (out) out += "; ";
			out += cookie.name ? `${cookie.name}=${cookie.value}` : cookie.value;
		}
		return out;
	}

	/**
	 * The jar as JSON, limited to cookies a page on `url`'s host can see
	 * (its own domain chain). Injected pages only need these.
	 */
	dumpFor(url: URL): string {
		const out: Record<string, Cookie> = {};
		const now = _Date.now();
		let key: string | undefined = url.hostname.toLowerCase();
		while (key !== undefined) {
			const bucket = this.byDomain.get(key);
			if (bucket) {
				for (const c of bucket) {
					if (c.expires !== undefined && c.expires < now) continue;
					out[`${c.domain}@${c.path}@${c.name}`] = c;
				}
			}
			const dot = key.indexOf(".");
			key = dot === -1 ? undefined : key.slice(dot + 1);
		}
		return JSON_stringify(out);
	}

	load(cookies: string | Record<string, Cookie>) {
		if (typeof cookies === "object") {
			console.error("??");
			return;
		}
		const parsed: Record<string, Cookie> = JSON_parse(cookies);
		this.cookies = {};
		this.byDomain.clear();
		const ids = Object.keys(parsed);
		for (let i = 0; i < ids.length; i++) {
			const id = ids[i];
			const c = parsed[id];
			if (typeof c.expires === "string") {
				const t = Date.parse(c.expires as unknown as string);
				c.expires = Number.isFinite(t) ? t : undefined;
			}
			this.cookies[id] = c;
			this.indexCookie(c);
		}
	}

	clear() {
		this.cookies = {};
		this.byDomain.clear();
	}

	dump(): string {
		return JSON_stringify(this.cookies);
	}
}
