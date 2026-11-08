// The request pipeline, off the page's thread. Proxied iframes are same-origin
// with the controller page and share its main thread, so handling requests
// there means every request waits behind the page's own parsing and scripts.
// This runs in a dedicated worker (fetch-worker.ts) with a direct port to the
// service worker; the page thread only runs the page.
import { type MethodsDefinition, RpcHelper } from "@kaze/rpc";
import {
	BareResponse,
	type ProxyTransport,
} from "@mercuryworkshop/proxy-transports";
import {
	CookieJar,
	KazeFetchHandler,
	KazeHeaders,
	registrableDomain,
	setWasm,
	getWasmModule,
	type CookieSyncOptions,
	type KazeConfig,
	type KazeContext,
} from "@kaze/core";
import { coalesceStream } from "./stream";
import { ProxyHttpCache } from "./http-cache";
import { RewritePool } from "./rewrite-pool";
import {
	BROADCASTCHANNEL_NAME,
	readCookieState,
	writeCookieState,
} from "./cookie-store";
import { workerInjectScripts, yieldGetInjectScripts } from "./inject-scripts";
import type {
	Controllerbound,
	ControllerToTransport,
	SerializedCookieSyncEntry,
	SWbound,
	TransportToController,
	WebSocketMessage,
} from "./types";

export type EngineInit = {
	id: string;
	config: any;
	encode: string;
	decode: string;
	kazeConfig: KazeConfig;
	transport: {
		scripts: string[];
		construct: string;
		options: unknown;
		module?: boolean;
	};
	httpCache: boolean;
	rewriteWorkers: number;
	rewriteWorkerUrl: string;
	kazeUrl: string;
	origin: string;
	crossOriginIsolated: boolean;
};

export type MainToEngine =
	| { type: "preload"; kazeUrl: string }
	| { type: "warm-transport"; spec: EngineInit["transport"] }
	| { type: "init"; init: EngineInit }
	| { type: "wasm"; module: WebAssembly.Module }
	| { type: "port"; port: MessagePort }
	| { type: "frame"; prefix: string }
	| {
			type: "cookies";
			cookies: SerializedCookieSyncEntry[];
			options?: CookieSyncOptions;
	  }
	| { type: "main"; data: any };

export type EngineToMain =
	| { type: "booted" }
	| { type: "failed"; error: string }
	| { type: "sw-ready" }
	| { type: "main"; data: any };

/** requests for frames kept on the page thread (they use plugins) */
export type EngineMainRpc = { request: Controllerbound["request"] };

const SMALL_BODY_BYTES = 64 * 1024;

type TransportSpec = EngineInit["transport"];
const warm = new Map<string, Promise<ProxyTransport>>();
const specKey = (spec: TransportSpec) => JSON.stringify(spec);

/** loads and starts a transport once; warmup and the engine share the result */
export function startTransport(spec: TransportSpec): Promise<ProxyTransport> {
	const key = specKey(spec);
	let started = warm.get(key);
	if (!started) {
		started = (async () => {
			for (const script of spec.scripts) {
				if (spec.module) await import(/* webpackIgnore: true */ script);
				else importScripts(script);
			}
			let ctor: any = self;
			for (const part of spec.construct.split(".")) ctor = ctor?.[part];
			const real = new ctor(spec.options) as ProxyTransport;
			await real.init();
			return real;
		})();
		warm.set(key, started);
	}
	return started;
}

/** builds the transport on first use so startup never waits on a 2MB script */
class LazyTransport implements ProxyTransport {
	ready = false;
	private real: ProxyTransport | null = null;
	private starting: Promise<void> | null = null;
	constructor(private spec: EngineInit["transport"]) {}

	init(): Promise<void> {
		this.starting ??= (async () => {
			this.real = await startTransport(this.spec);
			this.ready = true;
		})();
		return this.starting;
	}
	request: ProxyTransport["request"] = (...args) => this.real!.request(...args);
	connect: ProxyTransport["connect"] = (...args) => this.real!.connect(...args);
}

export class FetchEngine {
	cookieJar = new CookieJar();
	transport: LazyTransport;
	private frames: { prefix: string; handler: KazeFetchHandler }[] = [];
	private cache: ProxyHttpCache | null = null;
	private pool: RewritePool | null = null;
	private rpc: RpcHelper<Controllerbound, SWbound>;
	private port: MessagePort | null = null;
	private mainRpc: RpcHelper<Record<string, never>, EngineMainRpc>;
	private config: any;

	private cookieUpdatedAt = 0;
	private cookieSyncPromise: Promise<void> | null = null;
	private cookieSyncDirty = true;
	private cookieChannel = new BroadcastChannel(BROADCASTCHANNEL_NAME);
	private persistTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(
		private init: EngineInit,
		private toMain: (m: EngineToMain, t?: Transferable[]) => void
	) {
		const fn = (src: string) => new Function(`return (${src})`)();
		this.config = {
			...init.config,
			codec: { encode: fn(init.encode), decode: fn(init.decode) },
		};
		this.transport = new LazyTransport(init.transport);
		if (init.httpCache) this.cache = new ProxyHttpCache();
		this.rpc = new RpcHelper<Controllerbound, SWbound>(
			this.methods,
			"tabchannel-" + init.id,
			(data, transfer) => this.port?.postMessage(data, transfer)
		);
		this.mainRpc = new RpcHelper<Record<string, never>, EngineMainRpc>(
			{} as any,
			"engine-main",
			(data, transfer) => toMain({ type: "main", data }, transfer)
		);
		this.cookieChannel.addEventListener("message", (event) => {
			const updatedAt = (event.data as { updatedAt?: unknown })?.updatedAt;
			if (typeof updatedAt !== "number" || updatedAt <= this.cookieUpdatedAt)
				return;
			this.cookieSyncDirty = true;
			void this.loadSavedCookies();
		});
		void this.loadSavedCookies(true);
	}

	setWasm(module: WebAssembly.Module) {
		setWasm(module);
		const { rewriteWorkers: size } = this.init;
		if (size > 0) {
			this.pool = new RewritePool(size, this.init.rewriteWorkerUrl, {
				kazeUrl: this.init.kazeUrl,
				module: getWasmModule(),
				config: this.init.kazeConfig,
				encode: this.init.encode,
				decode: this.init.decode,
			});
			for (const f of this.frames) f.handler.rewriteOffload = this.pool;
		}
	}

	setPort(port: MessagePort) {
		this.port?.close();
		this.port = port;
		port.onmessage = (e) => this.rpc.recieve(e.data);
		port.onmessageerror = console.error;
	}

	recieveMain(data: any) {
		this.mainRpc.recieve(data);
	}

	addFrame(prefix: string) {
		const absolute = new URL(prefix, this.init.origin);
		const { kazeConfig } = this.init;
		const { config } = this;
		const encodeSrc = this.init.encode;
		const decodeSrc = this.init.decode;
		const context: KazeContext = {
			config: kazeConfig,
			prefix: absolute,
			cookieJar: this.cookieJar,
			interface: {
				getInjectScripts: yieldGetInjectScripts(
					config,
					kazeConfig,
					absolute,
					this.cookieJar,
					config.codec.encode,
					config.codec.decode
				),
				getWorkerInjectScripts: (_meta, _type, script) =>
					workerInjectScripts(
						config,
						kazeConfig,
						prefix,
						encodeSrc,
						decodeSrc,
						script
					),
				codecEncode: config.codec.encode,
				codecDecode: config.codec.decode,
			},
		};
		const engine = this;
		const handler = new KazeFetchHandler({
			crossOriginIsolated: this.init.crossOriginIsolated,
			context,
			transport: this.transport,
			async sendSetCookie(cookies, options) {
				engine.schedulePersist();
				await engine.propagate(
					cookies.map(({ url, cookie, fromJs }) => ({
						url: url.href,
						cookie,
						fromJs,
					})),
					options
				);
			},
			async fetchBlobUrl(url) {
				return BareResponse.fromNativeResponse(await fetch(url));
			},
			async fetchDataUrl(url) {
				return BareResponse.fromNativeResponse(await fetch(url));
			},
		});
		if (this.pool) handler.rewriteOffload = this.pool;
		this.cache?.attach(handler);
		this.frames.push({ prefix, handler });
	}

	private methods: MethodsDefinition<Controllerbound> = {
		ready: async () => {
			this.toMain({ type: "sw-ready" });
			// after replying: loading the transport blocks this thread for a moment
			setTimeout(() => void this.transport.init().catch(() => {}), 0);
		},
		request: async (data) => {
			const path = new URL(data.rawUrl).pathname;
			const frame = this.frames.find((f) => path.startsWith(f.prefix));
			if (!frame) {
				// a frame that stayed on the page thread
				const response = await this.mainRpc.call(
					"request",
					data,
					data.body instanceof ArrayBuffer ? [data.body] : undefined
				);
				return [
					response,
					response.body instanceof ReadableStream ||
					response.body instanceof ArrayBuffer
						? [response.body]
						: [],
				];
			}
			await this.loadSavedCookies();
			const result = await frame.handler.handleFetch({
				initialHeaders: KazeHeaders.fromRawHeaders(data.initialHeaders),
				rawClientUrl: data.rawClientUrl
					? new URL(data.rawClientUrl)
					: undefined,
				rawUrl: new URL(data.rawUrl),
				rawReferrer: data.rawReferrer,
				rawDestination: data.destination,
				method: data.method,
				mode: data.mode,
				referrer: data.referrer,
				body: data.body,
				cache: data.cache,
				clientId: data.clientId,
			});

			let body = result.body;
			if (body instanceof ReadableStream) {
				const length = result.headers.get("content-length");
				if (length != null && Number(length) <= SMALL_BODY_BYTES)
					body = await new Response(body).arrayBuffer();
				else body = coalesceStream(body);
			} else if (ArrayBuffer.isView(body)) {
				const view = body as unknown as Uint8Array;
				body =
					view.byteOffset === 0 && view.byteLength === view.buffer.byteLength
						? (view.buffer as ArrayBuffer)
						: (view.slice().buffer as ArrayBuffer);
			}
			return [
				{
					body,
					status: result.status,
					statusText: result.statusText,
					headers: result.headers.toRawHeaders(),
				},
				body instanceof ReadableStream || body instanceof ArrayBuffer
					? [body]
					: [],
			];
		},
		initRemoteTransport: async (port) => this.serveRemoteTransport(port),
	};

	applyCookies(
		cookies: SerializedCookieSyncEntry[] | undefined,
		options?: CookieSyncOptions
	) {
		if (options?.clear) this.cookieJar.clear();
		for (const entry of cookies ?? []) {
			if (typeof entry?.url !== "string" || typeof entry.cookie !== "string")
				continue;
			this.cookieJar.setCookies(
				entry.cookie,
				new URL(entry.url),
				entry.fromJs === true
			);
		}
	}

	async propagate(
		cookies: SerializedCookieSyncEntry[],
		options: CookieSyncOptions = {}
	) {
		if (this.port) await this.rpc.call("sendSetCookie", { cookies, options });
	}

	schedulePersist() {
		if (this.persistTimer !== null) return;
		this.persistTimer = setTimeout(() => {
			this.persistTimer = null;
			void this.persist();
		}, 30);
	}

	private async persist() {
		const updatedAt = await writeCookieState(
			this.cookieJar.dump(),
			this.cookieUpdatedAt
		);
		if (updatedAt <= this.cookieUpdatedAt) return;
		this.cookieUpdatedAt = updatedAt;
		this.cookieSyncDirty = false;
		this.cookieChannel.postMessage({ updatedAt });
	}

	private loadSavedCookies(force = false): Promise<void> | void {
		if (!force && !this.cookieSyncDirty) return;
		this.cookieSyncPromise ??= (async () => {
			const persisted = await readCookieState();
			if (persisted && persisted.updatedAt > this.cookieUpdatedAt) {
				this.cookieJar.load(persisted.cookies);
				this.cookieUpdatedAt = persisted.updatedAt;
			}
			this.cookieSyncDirty = false;
		})().finally(() => {
			this.cookieSyncPromise = null;
		});
		return this.cookieSyncPromise;
	}

	/** transport for page-side clients: websockets, sync xhr, document.cookie */
	private serveRemoteTransport(port: MessagePort) {
		const rpc = new RpcHelper<TransportToController, ControllerToTransport>(
			{
				request: async ({ remote, method, body, headers }) => {
					await this.transport.init();
					const response = await this.transport.request(
						new URL(remote),
						method,
						body,
						headers,
						undefined
					);
					return [response, [response.body as ReadableStream]];
				},
				sendSetCookie: async ({ cookies, options }) => {
					await this.loadSavedCookies(true);
					this.applyCookies(cookies, options);
					this.schedulePersist();
					await this.propagate(cookies, options);
				},
				connect: async ({ url, protocols, requestHeaders, port }) => {
					await this.transport.init();
					// handshake cookies come from the authoritative jar, for the
					// socket's own host (pages only hold their own site's cookies)
					try {
						const target = new URL(url.replace(/^ws/, "http"));
						const origin = requestHeaders.find(
							([k]) => k.toLowerCase() === "origin"
						)?.[1];
						const sameSite =
							origin &&
							registrableDomain(new URL(origin).hostname) !==
								registrableDomain(target.hostname)
								? "cross-site"
								: "strict";
						const cookie = this.cookieJar.getCookies(target, false, sameSite);
						requestHeaders = requestHeaders.filter(
							([k]) => k.toLowerCase() !== "cookie"
						);
						if (cookie) requestHeaders.push(["Cookie", cookie]);
					} catch {
						// keep whatever the page sent
					}
					let resolve: (arg: TransportToController["connect"][1]) => void;
					const promise = new Promise<TransportToController["connect"][1]>(
						(res) => (resolve = res)
					);
					const [send, close] = this.transport.connect(
						new URL(url),
						protocols,
						requestHeaders,
						(protocol, extensions) =>
							resolve({ result: "success", protocol, extensions }),
						(data) =>
							port.postMessage(
								{ type: "data", data } as WebSocketMessage,
								data instanceof ArrayBuffer ? [data] : []
							),
						(code, reason) =>
							port.postMessage({
								type: "close",
								code,
								reason,
							} as WebSocketMessage),
						(error) => resolve({ result: "failure", error })
					);
					port.onmessageerror = (ev) =>
						console.error("Transport port messageerror", ev);
					port.onmessage = ({ data }: { data: WebSocketMessage }) => {
						if (data.type === "data") send(data.data);
						else if (data.type === "close") close(data.code, data.reason);
					};
					return [await promise, []];
				},
			},
			"transport",
			(data, transfer) => port.postMessage(data, transfer)
		);
		port.onmessageerror = (ev) =>
			console.error("Transport port messageerror", ev);
		port.onmessage = (e) => rpc.recieve(e.data);
		rpc.call("ready", undefined, []);
	}
}
