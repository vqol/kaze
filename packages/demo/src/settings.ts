// Demo settings, kept in localStorage. Changing the transport or wisp server
// needs a fresh controller, so saving reloads the page.

export type Transport = "libcurl" | "epoxy";

export const SEARCH_ENGINES = {
	duckduckgo: "https://duckduckgo.com/?q=",
	google: "https://www.google.com/search?q=",
	brave: "https://search.brave.com/search?q=",
} as const;
export type SearchEngine = keyof typeof SEARCH_ENGINES;

export type Settings = {
	transport: Transport;
	wisp: string;
	search: SearchEngine;
};

const KEY = "kaze-demo";

export const defaults: Settings = {
	transport: "libcurl",
	wisp: import.meta.env.VITE_WISP_URL || "wss://anura.pro/",
	search: "duckduckgo",
};

export function load(): Settings {
	try {
		const saved = JSON.parse(localStorage.getItem(KEY) ?? "{}");
		return {
			transport: saved.transport === "epoxy" ? "epoxy" : defaults.transport,
			wisp: typeof saved.wisp === "string" && saved.wisp ? saved.wisp : defaults.wisp,
			search: saved.search in SEARCH_ENGINES ? saved.search : defaults.search,
		};
	} catch {
		return { ...defaults };
	}
}

export function save(settings: Settings) {
	try {
		localStorage.setItem(KEY, JSON.stringify(settings));
	} catch {}
}

/** "anura.pro" -> "wss://anura.pro/"; throws on anything that isn't a ws url */
export function normalizeWisp(input: string): string {
	let value = input.trim();
	if (!value) throw new TypeError("wisp server is required");
	if (!/^wss?:\/\//i.test(value)) value = "wss://" + value;
	const url = new URL(value);
	if (!url.pathname.endsWith("/")) url.pathname += "/";
	return url.href;
}
