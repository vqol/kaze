// Runs any ProxyTransport inside a dedicated worker (transport-worker.ts).
//
//   new WorkerTransport({
//     scripts: ["/libcurl/index.js"],
//     construct: "LibcurlTransport.LibcurlClient",
//     options: { wisp: "wss://example.com/wisp/" },
//   })
//
// If the worker can't start (CSP, old browser), it falls back to building the
// same transport on the main thread, so it is always safe to use.
import type {
	ProxyTransport,
	RawHeaders,
	TransferrableResponse,
	WebSocketDataType,
} from "@mercuryworkshop/proxy-transports";

export type WorkerTransportInit = {
	/** classic scripts (or ES modules with `module: true`) that define the transport */
	scripts: string[];
	/** dotted global path of the transport constructor, e.g. "LibcurlTransport.LibcurlClient" */
	construct: string;
	/** passed to the constructor; must be structured-cloneable */
	options?: unknown;
	module?: boolean;
	/** url of controller.transportworker.js (default: next to controller.api.js) */
	workerUrl?: string;
};

export type TransportWorkerInbound =
	| {
			type: "init";
			scripts: string[];
			construct: string;
			options: unknown;
			module?: boolean;
	  }
	| {
			type: "request";
			id: number;
			remote: string;
			method: string;
			body: BodyInit | null;
			headers: RawHeaders;
	  }
	| { type: "abort"; id: number }
	| {
			type: "connect";
			url: string;
			protocols: string[];
			headers: RawHeaders;
			port: MessagePort;
	  };

export type TransportWorkerOutbound =
	| { type: "ready"; error?: string }
	| {
			type: "response";
			id: number;
			response?: TransferrableResponse;
			error?: string;
	  };

export type TransportSocketOutbound =
	| { t: "open"; protocol: string; extensions: string }
	| { t: "data"; data: WebSocketDataType }
	| { t: "close"; code: number; reason: string }
	| { t: "error"; error: string };

export type TransportSocketInbound =
	| { t: "send"; data: WebSocketDataType }
	| { t: "close"; code: number; reason: string };

// controller.api.js is a classic script; remember where it was loaded from
const scriptBase =
	typeof document !== "undefined" &&
	document.currentScript instanceof HTMLScriptElement
		? document.currentScript.src
		: undefined;

export class WorkerTransport implements ProxyTransport {
	ready = false;
	private worker: Worker | null = null;
	private fallback: ProxyTransport | null = null;
	private nextId = 1;
	private pending = new Map<
		number,
		{
			resolve: (r: TransferrableResponse) => void;
			reject: (e: Error) => void;
		}
	>();

	constructor(public init_: WorkerTransportInit) {}

	async init(): Promise<void> {
		const absolute = (u: string) => new URL(u, location.href).href;
		const scripts = this.init_.scripts.map(absolute);
		try {
			const url =
				this.init_.workerUrl ??
				new URL("controller.transportworker.js", scriptBase ?? location.href)
					.href;
			const worker = new Worker(absolute(url), { name: "kaze-transport" });
			await new Promise<void>((resolve, reject) => {
				worker.onerror = (e) => reject(new Error(e.message || "worker error"));
				worker.onmessage = (e: MessageEvent<TransportWorkerOutbound>) => {
					const msg = e.data;
					if (msg.type === "ready") {
						if (msg.error) reject(new Error(msg.error));
						else resolve();
					}
				};
				worker.postMessage({
					type: "init",
					scripts,
					construct: this.init_.construct,
					options: this.init_.options,
					module: this.init_.module,
				} satisfies TransportWorkerInbound);
			});
			worker.onerror = (e) => console.error("kaze transport worker:", e);
			worker.onmessage = (e: MessageEvent<TransportWorkerOutbound>) =>
				this.onWorkerMessage(e.data);
			this.worker = worker;
		} catch (err) {
			console.warn(
				"kaze: transport worker unavailable, running the transport on the main thread:",
				err
			);
			this.fallback = await this.buildInWindow(scripts);
		}
		this.ready = true;
	}

	private async buildInWindow(scripts: string[]): Promise<ProxyTransport> {
		const resolve = () => {
			let obj: any = globalThis;
			for (const key of this.init_.construct.split(".")) obj = obj?.[key];
			return obj;
		};
		if (typeof resolve() !== "function") {
			for (const src of scripts) {
				if (this.init_.module) {
					await import(/* webpackIgnore: true */ src);
				} else {
					await new Promise<void>((res, rej) => {
						const s = document.createElement("script");
						s.src = src;
						s.onload = () => res();
						s.onerror = () => rej(new Error("failed to load " + src));
						document.head.appendChild(s);
					});
				}
			}
		}
		const ctor = resolve();
		const t = new ctor(this.init_.options) as ProxyTransport;
		await t.init();
		return t;
	}

	private onWorkerMessage(msg: TransportWorkerOutbound) {
		if (msg.type !== "response") return;
		const p = this.pending.get(msg.id);
		if (!p) return;
		this.pending.delete(msg.id);
		if (msg.error !== undefined || !msg.response)
			p.reject(new Error(msg.error ?? "transport worker: no response"));
		else p.resolve(msg.response);
	}

	request(
		remote: URL,
		method: string,
		body: BodyInit | null,
		headers: RawHeaders,
		signal: AbortSignal | undefined
	): Promise<TransferrableResponse> {
		if (this.fallback)
			return this.fallback.request(remote, method, body, headers, signal);
		const worker = this.worker!;
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			if (signal) {
				if (signal.aborted) {
					this.pending.delete(id);
					reject(signal.reason ?? new Error("aborted"));
					return;
				}
				signal.addEventListener(
					"abort",
					() => {
						worker.postMessage({ type: "abort", id });
						if (this.pending.delete(id))
							reject(signal.reason ?? new Error("aborted"));
					},
					{ once: true }
				);
			}
			worker.postMessage(
				{
					type: "request",
					id,
					remote: remote.href,
					method,
					body,
					headers,
				} satisfies TransportWorkerInbound,
				// request bodies are fresh copies made by the fetch handler
				body instanceof ArrayBuffer ? [body] : []
			);
		});
	}

	connect(
		url: URL,
		protocols: string[],
		requestHeaders: RawHeaders,
		onopen: (protocol: string, extensions: string) => void,
		onmessage: (data: WebSocketDataType) => void,
		onclose: (code: number, reason: string) => void,
		onerror: (error: string) => void
	): [
		(data: WebSocketDataType) => void,
		(code: number, reason: string) => void,
	] {
		if (this.fallback)
			return this.fallback.connect(
				url,
				protocols,
				requestHeaders,
				onopen,
				onmessage,
				onclose,
				onerror
			);
		const { port1, port2 } = new MessageChannel();
		port1.onmessage = (e: MessageEvent<TransportSocketOutbound>) => {
			const d = e.data;
			if (d.t === "open") onopen(d.protocol, d.extensions);
			else if (d.t === "data") onmessage(d.data);
			else if (d.t === "close") {
				onclose(d.code, d.reason);
				port1.close();
			} else onerror(d.error);
		};
		this.worker!.postMessage(
			{
				type: "connect",
				url: url.href,
				protocols,
				headers: requestHeaders,
				port: port2,
			} satisfies TransportWorkerInbound,
			[port2]
		);
		return [
			(data) =>
				port1.postMessage({ t: "send", data } satisfies TransportSocketInbound),
			(code, reason) =>
				port1.postMessage({
					t: "close",
					code,
					reason,
				} satisfies TransportSocketInbound),
		];
	}
}
