import { KazeConfig, KazeFlags, KazeVersionInfo } from "@/types";
import DomHandler, { Element } from "domhandler";
import { URLMeta } from "@rewriters/url";
import { CookieJar } from "./cookie";
import { TapInstance } from "@/Tap";
import { HtmlContext } from "@/shared/rewriters/html";
import { _RegExp, _WeakMap, Object_keys } from "./snapshot";

export * from "./cookie";
export * from "./psl";
export * from "./headers";
export * from "./htmlRules";
export * from "./mime";
export * from "./rewriters";

type CompiledSiteFlags = [RegExp, Partial<KazeFlags>][];
type ResolvedFlagsCache = { href: string; flags: KazeFlags };

// siteFlags regexes used to be recompiled on every flagEnabled call, and
// flagEnabled runs several times per rewrite. compile once per siteFlags object
const compiledSiteFlags: WeakMap<object, CompiledSiteFlags> = new _WeakMap([]);
// one-entry cache per flags object: rewrites in a document share a base url
const resolvedFlags: WeakMap<object, ResolvedFlagsCache> = new _WeakMap([]);

function getSiteFlags(siteFlags: KazeConfig["siteFlags"]): CompiledSiteFlags {
	let compiled = compiledSiteFlags.get(siteFlags);
	if (!compiled) {
		compiled = [];
		for (const regex in siteFlags) {
			compiled.push([new _RegExp(regex), siteFlags[regex]]);
		}
		compiledSiteFlags.set(siteFlags, compiled);
	}

	return compiled;
}

export function flagEnabled(
	flag: keyof KazeFlags,
	context: KazeContext,
	url: URL
): boolean {
	const { flags, siteFlags } = context.config;
	if (!siteFlags) return flags[flag];
	const compiled = getSiteFlags(siteFlags);
	if (compiled.length === 0) return flags[flag];

	const href = url.href;
	for (const [regex, partialflags] of compiled) {
		regex.lastIndex = 0;
		if (regex.test(href) && flag in partialflags) {
			return partialflags[flag];
		}
	}

	return flags[flag];
}

/**
 * All flags resolved for one url. Same result as calling flagEnabled for each
 * flag, but the url is matched against siteFlags once and the result is cached.
 */
export function resolveFlags(context: KazeContext, url: URL): KazeFlags {
	const { flags, siteFlags } = context.config;
	if (!siteFlags || getSiteFlags(siteFlags).length === 0) return flags;

	const href = url.href;
	const cached = resolvedFlags.get(flags);
	if (cached && cached.href === href) return cached.flags;

	const out = {} as KazeFlags;
	for (const flag of Object_keys(flags)) {
		out[flag] = flagEnabled(flag as keyof KazeFlags, context, url);
	}
	resolvedFlags.set(flags, { href, flags: out });

	return out;
}
export type KazeInterface = {
	codecEncode: (input: string) => string;
	codecDecode: (input: string) => string;

	getInjectScripts(
		meta: URLMeta,
		handler: DomHandler,
		htmlcontext: HtmlContext,
		script: (src: string) => Element
	): Element[];
	getWorkerInjectScripts?(
		meta: URLMeta,
		isModule: boolean,
		script: (src: string) => string
	): string;
};

export type KazeContext = {
	config: KazeConfig;
	prefix: URL;
	prefixStrings?: { href: string; origin: string };
	interface: KazeInterface;
	cookieJar: CookieJar;
	hooks?: {
		rewriter: {
			html: TapInstance<HtmlRewriterHooks>;
		};
	};
};

export type HtmlRewriterHooks = {
	pre: {
		context: {
			handler: DomHandler;
			meta: URLMeta;
			origHtml: string;
			htmlcontext: HtmlContext;
		};
	};
	post: {
		context: {
			handler: DomHandler;
			meta: URLMeta;
			origHtml: string;
			htmlcontext: HtmlContext;
		};
		props: {
			setRawHtml?: string;
		};
	};
};
