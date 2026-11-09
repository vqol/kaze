// "The wire": records every request a proxied page makes, with the headers
// as the page and the server sent them and as kaze passed them on.
import { ManagedPlugin, type Frame } from "@kaze/controller";

type RawHeaders = [string, string][];

export type WireEntry = {
	id: number;
	method: string;
	url: URL;
	destination: string;
	started: number;
	/** ms until the response reached the page; undefined while pending */
	ms?: number;
	status?: number;
	statusText?: string;
	/** answered by kaze's http cache, never hit the network */
	cached: boolean;
	/** headers the page asked for */
	requestFromPage: RawHeaders;
	/** headers kaze sent upstream */
	requestSent?: RawHeaders;
	/** headers the server answered with */
	responseFromServer?: RawHeaders;
	/** headers the page got */
	responseToPage?: RawHeaders;
};

const MAX_ENTRIES = 500;

function raw(headers: unknown): RawHeaders {
	if (!headers) return [];
	if (typeof (headers as any).toRawHeaders === "function")
		return (headers as any).toRawHeaders();
	if (headers instanceof Headers) return [...headers.entries()];
	if (Array.isArray(headers)) return headers as RawHeaders;
	return Object.entries(headers as Record<string, string>);
}

export class Wire extends ManagedPlugin {
	entries: WireEntry[] = [];
	private byRequest = new WeakMap<object, WireEntry>();
	private sent = new WeakMap<object, { headers?: unknown }>();
	private seq = 0;
	private listeners = new Set<() => void>();
	private scheduled = false;

	constructor() {
		super("demo-wire", []);
	}

	/** called at most once per frame with batched changes */
	subscribe(fn: () => void) {
		this.listeners.add(fn);
		return () => this.listeners.delete(fn);
	}

	clear() {
		this.entries = [];
		this.changed();
	}

	private changed() {
		if (this.scheduled) return;
		this.scheduled = true;
		requestAnimationFrame(() => {
			this.scheduled = false;
			for (const fn of this.listeners) fn();
		});
	}

	install(frame: Frame): void {
		super.install(frame);
		const hooks = frame.hooks.fetch;

		this.tap(hooks.request, (ctx, props) => {
			const entry: WireEntry = {
				id: ++this.seq,
				method: ctx.request.method,
				url: new URL(props.url.href),
				destination: ctx.parsed.destination || "fetch",
				started: performance.now(),
				cached: false,
				requestFromPage: raw(ctx.request.initialHeaders),
			};
			this.byRequest.set(ctx.request, entry);
			// read back once the request is out, after every plugin had its turn
			this.sent.set(ctx.request, props.init);
			this.entries.push(entry);
			if (this.entries.length > MAX_ENTRIES)
				this.entries.splice(0, this.entries.length - MAX_ENTRIES);
			this.changed();
		});

		this.tap(hooks.preresponse, (ctx, props) => {
			const entry = this.byRequest.get(ctx.request);
			if (!entry) return;
			entry.requestSent = raw(this.sent.get(ctx.request)?.headers);
			entry.responseFromServer = raw(props.response.rawHeaders);
		});

		this.tap(hooks.response, (ctx, props) => {
			const entry = this.byRequest.get(ctx.request);
			if (!entry) return;
			entry.ms = performance.now() - entry.started;
			entry.status = props.response.status;
			entry.statusText = props.response.statusText;
			entry.responseToPage = raw(props.response.headers);
			// no server headers seen: the cache plugin answered it
			entry.cached = !entry.responseFromServer;
			this.changed();
		});
	}
}

export type HeaderDiff = {
	name: string;
	kind: "same" | "added" | "removed" | "changed";
	before?: string;
	after?: string;
};

function group(headers: RawHeaders) {
	const map = new Map<string, { name: string; value: string }>();
	for (const [name, value] of headers) {
		const key = name.toLowerCase();
		const prev = map.get(key);
		if (prev) prev.value += ", " + value;
		else map.set(key, { name: key, value });
	}
	return map;
}

/** header-by-header comparison, changes first */
export function diffHeaders(before: RawHeaders, after: RawHeaders): HeaderDiff[] {
	const a = group(before);
	const b = group(after);
	const out: HeaderDiff[] = [];
	for (const [key, { name, value }] of a) {
		const next = b.get(key);
		if (!next) out.push({ name, kind: "removed", before: value });
		else if (next.value !== value)
			out.push({ name, kind: "changed", before: value, after: next.value });
		else out.push({ name, kind: "same", before: value, after: value });
	}
	for (const [key, { name, value }] of b)
		if (!a.has(key)) out.push({ name, kind: "added", after: value });
	const rank = { changed: 0, removed: 1, added: 2, same: 3 };
	return out.sort((x, y) => rank[x.kind] - rank[y.kind] || x.name.localeCompare(y.name));
}

const KINDS: Record<string, string> = {
	document: "doc",
	iframe: "doc",
	frame: "doc",
	script: "js",
	worker: "js",
	sharedworker: "js",
	serviceworker: "js",
	style: "css",
	image: "img",
	font: "font",
	audio: "media",
	video: "media",
	track: "media",
	manifest: "json",
};
export function kindOf(entry: WireEntry) {
	return KINDS[entry.destination] ?? "xhr";
}
