import { URLMeta, rewriteUrl } from "@rewriters/url";
import { KazeContext } from "@/shared";
import { JSON_parse, JSON_stringify } from "@/shared/snapshot";

// a specifier-map key is a URL (and so lives in the proxied url space, like the
// specifiers kaze rewrites in module source) when it starts with / ./ ../ or a
// scheme. anything else is a bare specifier and must be left alone
const urlLikeKey = (key: string) =>
	key[0] === "/" ||
	key.startsWith("./") ||
	key.startsWith("../") ||
	/^[a-z][a-z0-9+.-]*:/i.test(key);

/**
 * Rewrite the JSON of a `<script type="importmap">` so its targets resolve to
 * the proxy. Used by the html rewriter and by scripts created from the dom.
 *
 * Returns the input untouched when it is not a valid import map: the browser
 * reports that itself, and we must not turn a warning into a different error.
 */
export function rewriteImportMap(
	json: string,
	context: KazeContext,
	meta: URLMeta
): string {
	let map: any;
	try {
		map = JSON_parse(json);
	} catch {
		return json;
	}
	if (typeof map !== "object" || map === null || Array.isArray(map)) {
		return json;
	}

	const rewriteSpecifierMap = (specifiers: any) => {
		if (typeof specifiers !== "object" || specifiers === null) return;
		for (const key of Object.keys(specifiers)) {
			const target = specifiers[key];
			if (typeof target === "string") {
				specifiers[key] = rewriteUrl(target, context, meta, {
					isModule: true,
				});
			}
			if (urlLikeKey(key)) {
				// module specifiers are rewritten with isModule, so keys must match
				const rewrittenKey = rewriteUrl(key, context, meta, {
					isModule: true,
				});
				if (rewrittenKey !== key) {
					specifiers[rewrittenKey] = specifiers[key];
					delete specifiers[key];
				}
			}
		}
	};

	rewriteSpecifierMap(map.imports);

	if (typeof map.scopes === "object" && map.scopes !== null) {
		const scopes: Record<string, unknown> = {};
		for (const scope of Object.keys(map.scopes)) {
			rewriteSpecifierMap(map.scopes[scope]);
			// KNOWN LIMIT: a scope key only works as a url *prefix* when it ends in a
			// literal "/", and kaze's url codec encodes every "/" as %2F. So a
			// rewritten scope key can only ever match one exact module url, never a
			// directory of them. We still rewrite the targets so a scoped mapping
			// can't point outside the proxy, and strip the query rewriteUrl appends
			// (initiator origin ...) so the key at least has a chance of matching.
			const rewrittenScope = rewriteUrl(scope, context, meta);
			scopes[rewrittenScope.replace(/[?#].*$/s, "")] = map.scopes[scope];
		}
		map.scopes = scopes;
	}

	// proxied modules are rewritten, so their bytes never match the original hash
	delete map.integrity;

	return JSON_stringify(map);
}
