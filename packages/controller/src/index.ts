import { type MethodsDefinition, RpcHelper } from "@kaze/rpc";
import {
	BareResponse,
	type ProxyTransport,
} from "@mercuryworkshop/proxy-transports";
import { deepmerge } from "@fastify/deepmerge";
import {
	CookieJar,
	defaultConfig as kazeDefaultConfig,
	rewriteUrl,
	KazeFetchHandler,
	KazeHeaders,
	setWasm,
	getWasmModule,
	Tap,
	type CookieSyncOptions,
	type FetchHooks,
	type KazeConfig,
	type KazeContext,
	registrableDomain,
	type KazeInterface,
	type TrackedHistoryState,
	Plugin,
} from "@kaze/core";
import { CONTROLLERFRAME } from "./symbols";
import type {
	FrameInitHooks,
	SerializedCookieSyncEntry,
	TransportToController,
	Controllerbound,
	ControllerToTransport,
	SWbound,
	WebSocketMessage,
	FrameErrorHooks,
} from "./types";
import { assertRuntimeKazeVersion } from "./version";
import { coalesceStream } from "./stream";
import { ProxyHttpCache } from "./http-cache";
import { RewritePool } from "./rewrite-pool";
import { WorkerTransport } from "./worker-transport";
import {
	BROADCASTCHANNEL_NAME,
	readCookieState,
	writeCookieState,
} from "./cookie-store";
import { workerInjectScripts, yieldGetInjectScripts } from "./inject-scripts";
import type { EngineMainRpc, EngineToMain, MainToEngine } from "./fetch-engine";
export { WorkerTransport, type WorkerTransportInit } from "./worker-transport";

export { versionInfo } from "./version";
export type Config = {
	prefix: string;
	kazePath: string;
	injectPath: string;
	wasmPath: string;
	virtualWasmPath: string;
	codec: Record<"encode" | "decode", (input: string) => string>;
};

export const config: Config = {
	prefix: "/~/kz/",
	kazePath: "/kaze/kaze.js",
	injectPath: "/controller/controller.inject.js",
	wasmPath: "/kaze/kaze.wasm",
	virtualWasmPath: "kaze.wasm.js",
	codec: {
		encode: (url: string) => {
			if (!url) return url;

			return encodeURIComponent(url);
		},
		decode: (url: string) => {
			if (!url) return url;

			return decodeURIComponent(url);
		},
	},
};

const kazeConfig: Partial<KazeConfig> = {
	flags: {
		...kazeDefaultConfig.flags,
		allowFailedIntercepts: true,
	},
	maskedfiles: ["inject.js", "kaze.wasm.js"],
};

export class ManagedPlugin extends Plugin {
	frame: Frame = null!;
	dependencies: string[] = [];
	constructor(name: string, dependencies: string[]) {
		super(name);
		this.dependencies = dependencies;
	}

	install(frame: Frame): void {
		this.frame = frame;
	}
}

function makeId(): string {
	return Math.random().toString(36).substring(2, 10);
}

const deepMerge = deepmerge();

type ControllerInit = {
	serviceworker: ServiceWorker;
	transport: ProxyTransport;
	config?: Partial<Config>;
	kazeConfig?: Partial<KazeConfig>;
	/** cache proxied subresources (default true) */
	httpCache?: boolean;
	/** workers for rewriting scripts and styles (default: based on core count, 0 disables) */
	rewriteWorkers?: number;
	/** run requests in a worker when the transport is a WorkerTransport (default true) */
	fetchWorker?: boolean;
	/** ms between keepalive pings to the service worker (default 20000, false disables) */
	serviceWorkerKeepalive?: number | false;
};

type FrameOptions = {
	plugins?: ManagedPlugin[];
};

/** download and compile the rewriter, streaming when the server allows it */
async function compileRewriterWasm(url: string): Promise<WebAssembly.Module> {
	// compile off the main thread while the download streams in; pages
	// reuse this module (inject.ts) instead of compiling their own copy
	const resp = await fetch(url);
	if (!resp.ok) throw new Error(`kaze: ${url} returned ${resp.status}`);
	try {
		return await WebAssembly.compileStreaming(resp.clone());
	} catch {
		// wrong content-type from the host's static server
		return await WebAssembly.compile(await resp.arrayBuffer());
	}
}

// The engine worker starts the moment this script loads, so it finishes booting
// while the page is still registering its service worker.
let warmEngine: { url: string; worker: Worker } | null = null;
// Same for the rewriter wasm: the controller used to fetch it only after the
// service worker was ready. kaze.wasm sits next to kaze.js in every layout kaze
// ships; a controller configured with another wasmPath fetches its own.
let warmWasm: { url: string; module: Promise<WebAssembly.Module> } | null =
	null;
try {
	const script = document.currentScript as HTMLScriptElement | null;
	const kazeScript = [...document.scripts].find((s) =>
		/\/kaze(\.\w+)?\.js(\?|$)/.test(s.src)
	);
	if (kazeScript?.src && typeof WebAssembly !== "undefined") {
		const url = new URL("kaze.wasm", kazeScript.src).href;
		const module = compileRewriterWasm(url);
		module.catch(() => {}); // loadKazeWasm retries and reports
		warmWasm = { url, module };
	}
	if (script?.src && kazeScript && typeof Worker !== "undefined") {
		const url = new URL("controller.fetchworker.js", script.src).href;
		const worker = new Worker(url, { name: "kaze-fetch" });
		worker.postMessage({ type: "preload", kazeUrl: kazeScript.src });
		warmEngine = { url, worker };
	}
} catch {
	// the controller starts it later, or falls back to the main thread
}

/**
 * Start loading a WorkerTransport now, before the Controller exists. Call it
 * as early as possible (before registering the service worker): the transport
 * then finishes loading in parallel instead of after startup.
 */
export function warmupTransport(transport: WorkerTransport) {
	if (!warmEngine) return;
	const absolute = (p: string) => new URL(p, location.href).href;
	const { scripts, construct, options, module } = transport.init_;
	warmEngine.worker.postMessage({
		type: "warm-transport",
		spec: { scripts: scripts.map(absolute), construct, options, module },
	});
}

export class Controller {
	id: string;
	config: Config;
	kazeConfig: KazeConfig;
	prefix: string;
	cookieJar = new CookieJar();
	frames: Frame[] = [];
	serviceWorkerController: ServiceWorker;
	guardServiceWorkerRevive = true;

	private ready: Promise<void>;
	private readyResolve!: () => void;
	public isReady: boolean = false;
	rpc: RpcHelper<Controllerbound, SWbound>;
	private port: MessagePort | null = null;

	transport: ProxyTransport;
	httpCache: ProxyHttpCache | null = null;
	rewritePool: RewritePool | null = null;
	private cookieUpdatedAt = 0;
	private cookieSyncPromise: Promise<void> | null = null;
	private cookieSyncDirty = true;
	private cookieSyncChannel = new BroadcastChannel(BROADCASTCHANNEL_NAME);

	private wasmAlreadyFetched = false;
	private wasmPayload: string | null = null;
	private onTabChannelMessage: (e: MessageEvent) => void = (e) => {
		this.rpc.recieve(e.data);
	};
	private onCookieSyncMessage = (event: MessageEvent) => {
		const updatedAt =
			typeof event.data === "object" && event.data !== null
				? (event.data as { updatedAt?: unknown }).updatedAt
				: undefined;
		if (typeof updatedAt !== "number" || updatedAt <= this.cookieUpdatedAt) {
			return;
		}

		this.cookieSyncDirty = true;
		void this.loadSavedCookies();
	};

	private async loadKazeWasm() {
		if (this.wasmAlreadyFetched) {
			return;
		}

		const url = new URL(this.config.wasmPath, location.href).href;
		let mod: WebAssembly.Module | null = null;
		if (warmWasm?.url === url) {
			// one download per page: later controllers share it too
			mod = await warmWasm.module.catch(() => null);
		}
		mod ??= await compileRewriterWasm(url);
		setWasm(mod);
		this.wasmAlreadyFetched = true;
		if (this.engine) this.toEngine({ type: "wasm", module: mod });
		else this.startRewritePool();
	}

	private engine: Worker | null = null;
	private engineRpc: RpcHelper<EngineMainRpc, Record<string, never>> | null =
		null;
	private toEngine(m: MainToEngine, transfer: Transferable[] = []) {
		this.engine?.postMessage(m, transfer);
	}

	/** Move the request pipeline off this thread, when the transport can move too */
	private startEngine() {
		const transport = this.init.transport;
		if (
			this.init.fetchWorker === false ||
			!(transport instanceof WorkerTransport) ||
			typeof Worker === "undefined"
		)
			return;
		const absolute = (p: string) => new URL(p, location.href).href;
		const workerFile = (name: string) =>
			new URL(name, absolute(this.config.injectPath)).href;
		try {
			const fileUrl = workerFile("controller.fetchworker.js");
			const worker =
				warmEngine?.url === fileUrl
					? warmEngine.worker
					: new Worker(fileUrl, { name: "kaze-fetch" });
			if (warmEngine?.url === fileUrl) warmEngine = null;
			this.engine = worker;
			this.engineRpc = new RpcHelper<EngineMainRpc, Record<string, never>>(
				{ request: (data) => this.methods.request(data) as any },
				"engine-main",
				(data, t) => this.toEngine({ type: "main", data }, t)
			);
			worker.onmessage = (e: MessageEvent<EngineToMain>) => {
				const m = e.data;
				if (m.type === "sw-ready") void this.methods.ready();
				else if (m.type === "main") this.engineRpc!.recieve(m.data);
				else if (m.type === "failed") this.abandonEngine(m.error);
			};
			worker.onerror = (e) => this.abandonEngine(e.message);
			const { codec, ...config } = this.config;
			this.toEngine({
				type: "init",
				init: {
					id: this.id,
					config,
					encode: codec.encode.toString(),
					decode: codec.decode.toString(),
					kazeConfig: JSON.parse(JSON.stringify(this.kazeConfig)),
					transport: {
						scripts: transport.init_.scripts.map(absolute),
						construct: transport.init_.construct,
						options: transport.init_.options,
						module: transport.init_.module,
					},
					httpCache: this.init.httpCache !== false,
					rewriteWorkers: this.rewriteWorkerCount(),
					rewriteWorkerUrl: workerFile("controller.rewriteworker.js"),
					kazeUrl: absolute(this.config.kazePath),
					origin: location.origin,
					crossOriginIsolated: self.crossOriginIsolated,
				},
			});
		} catch (e) {
			this.engine = null;
			console.warn("kaze: fetch worker unavailable:", e);
		}
	}

	/** the worker couldn't start (CSP etc.): handle requests on this thread */
	private abandonEngine(reason: string) {
		if (!this.engine) return;
		console.warn("kaze: fetch worker failed, using the main thread:", reason);
		this.engine.terminate();
		this.engine = null;
		if (this.init.httpCache !== false) this.httpCache = new ProxyHttpCache();
		for (const frame of this.frames) {
			this.httpCache?.attach(frame.fetchHandler);
		}
		if (this.wasmAlreadyFetched) this.startRewritePool();
		this.setupMessagePort();
	}

	/** tell the engine about a frame it should serve */
	registerFrame(prefix: string) {
		this.toEngine({ type: "frame", prefix });
	}

	/** cookies set by a frame that stayed on this thread */
	forwardCookies(
		cookies: SerializedCookieSyncEntry[],
		options?: CookieSyncOptions
	): boolean {
		if (!this.engine) return false;
		this.toEngine({ type: "cookies", cookies, options });
		return true;
	}

	get usesEngine() {
		return this.engine !== null;
	}

	private rewriteWorkerCount() {
		return (
			this.init.rewriteWorkers ??
			Math.min(4, Math.max(1, (navigator.hardwareConcurrency || 2) - 2))
		);
	}

	private startRewritePool() {
		const size = this.rewriteWorkerCount();
		if (size <= 0) return;
		try {
			const absolute = (p: string) => new URL(p, location.href).href;
			this.rewritePool = new RewritePool(
				size,
				new URL(
					"controller.rewriteworker.js",
					absolute(this.config.injectPath)
				).href,
				{
					kazeUrl: absolute(this.config.kazePath),
					module: getWasmModule(),
					config: JSON.parse(JSON.stringify(this.kazeConfig)),
					encode: this.config.codec.encode.toString(),
					decode: this.config.codec.decode.toString(),
				}
			);
			for (const frame of this.frames)
				frame.fetchHandler.rewriteOffload = this.rewritePool;
		} catch (e) {
			console.warn("kaze: rewrite workers unavailable:", e);
		}
	}

	private methods: MethodsDefinition<Controllerbound> = {
		ready: async () => {
			this.readyResolve();
			setTimeout(() => {
				this.guardServiceWorkerRevive = false;
			}, 5000);
		},
		request: async (data) => {
			const path = new URL(data.rawUrl).pathname;
			const frame = this.frames.find((f) => path.startsWith(f.prefix));
			if (!frame) throw new Error("No frame found for request");
			try {
				// doesn't actually *load* every request, but hold u requests until the promise finishes
				await this.loadSavedCookies();

				if (path === frame.prefix + this.config.virtualWasmPath) {
					if (!this.wasmPayload) {
						const resp = await fetch(this.config.wasmPath);
						const buf = await resp.arrayBuffer();
						const b64 = btoa(
							new Uint8Array(buf)
								.reduce(
									(data, byte) => (data.push(String.fromCharCode(byte)), data),
									[] as any
								)
								.join("")
						);

						this.wasmPayload = `self.WASM = '${b64}';`;
					}

					return [
						{
							body: this.wasmPayload,
							status: 200,
							statusText: "OK",
							headers: [["Content-Type", "application/javascript"]],
						},
						[],
					];
				}

				const kzheaders = KazeHeaders.fromRawHeaders(data.initialHeaders);

				const fetchresponse = await frame.fetchHandler.handleFetch({
					initialHeaders: kzheaders,
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

				let body = fetchresponse.body;
				if (body instanceof ReadableStream) {
					body = coalesceStream(body);
				} else if (ArrayBuffer.isView(body)) {
					// rewritten js comes back as a Uint8Array: transfer, don't copy
					const view = body as unknown as Uint8Array;
					body =
						view.byteOffset === 0 && view.byteLength === view.buffer.byteLength
							? (view.buffer as ArrayBuffer)
							: (view.slice().buffer as ArrayBuffer);
				}

				return [
					{
						body,
						status: fetchresponse.status,
						statusText: fetchresponse.statusText,
						headers: fetchresponse.headers.toRawHeaders(),
					},
					body instanceof ReadableStream || body instanceof ArrayBuffer
						? [body]
						: [],
				];
			} catch (e) {
				const reqcontext: typeof frame.hooks.error.request.context = {
					rawrequest: data,
					error: e,
				};
				const reqprops: typeof frame.hooks.error.request.props = {
					setResponse: undefined,
					suppressError: false,
				};
				await Tap.dispatch(frame.hooks.error.request, reqcontext, reqprops);
				if (!reqprops.suppressError) {
					console.error("Error in controller request handler:", e);
				}
				if (reqprops.setResponse) {
					return [reqprops.setResponse, []];
				}
				throw e;
			}
		},
		initRemoteTransport: async (port) => {
			const rpc = new RpcHelper<TransportToController, ControllerToTransport>(
				{
					request: async ({ remote, method, body, headers }) => {
						const response = await this.transport.request(
							new URL(remote),
							method,
							body,
							headers,
							undefined
						);
						return [response, [response.body]];
					},
					sendSetCookie: async ({ cookies, options }) => {
						await this.loadSavedCookies(true);
						if (options?.clear) {
							this.cookieJar.clear();
						}
						this.applyCookieSyncEntries(cookies);
						this.schedulePersistCookies();
						await this.propagateCookieSync(cookies, options);
					},
					connect: async ({ url, protocols, requestHeaders, port }) => {
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
							(protocol, extensions) => {
								resolve({
									result: "success",
									protocol: protocol,
									extensions: extensions,
								});
							},
							(data) => {
								port.postMessage(
									{
										type: "data",
										data: data,
									} as WebSocketMessage,
									data instanceof ArrayBuffer ? [data] : []
								);
							},
							(close, reason) => {
								port.postMessage({
									type: "close",
									code: close,
									reason: reason,
								} as WebSocketMessage);
							},
							(error) => {
								resolve({
									result: "failure",
									error: error,
								});
							}
						);
						port.onmessageerror = (ev) => {
							console.error(
								"Transport port messageerror (this should never happen!)",
								ev
							);
						};
						port.onmessage = ({ data }: { data: WebSocketMessage }) => {
							if (data.type === "data") {
								send(data.data);
							} else if (data.type === "close") {
								close(data.code, data.reason);
							}
						};

						return [await promise, []];
					},
				},
				"transport",
				(data, transfer) => port.postMessage(data, transfer)
			);
			port.onmessageerror = (ev) => {
				console.error(
					"Transport port messageerror (this should never happen!)",
					ev
				);
			};
			port.onmessage = (e) => {
				rpc.recieve(e.data);
			};
			rpc.call("ready", undefined, []);
		},
	};

	constructor(public init: ControllerInit) {
		assertRuntimeKazeVersion();
		this.id = makeId();
		this.config = deepMerge(config, init.config || {}) as Config;
		this.kazeConfig = deepMerge(kazeConfig, kazeDefaultConfig);
		this.kazeConfig = deepMerge(
			this.kazeConfig,
			init.kazeConfig || {}
		) as KazeConfig;
		this.prefix = this.config.prefix + this.id + "/";
		this.serviceWorkerController = init.serviceworker;
		this.startEngine();
		if (init.httpCache !== false && !this.engine)
			this.httpCache = new ProxyHttpCache();

		this.ready = Promise.all([
			new Promise<void>((resolve) => {
				this.readyResolve = resolve;
			}),
			this.loadKazeWasm(),
			// the engine owns the jar; this thread only mirrors it
			this.engine ? undefined : this.loadSavedCookies(true),
		]).then(() => undefined);

		this.rpc = new RpcHelper<Controllerbound, SWbound>(
			this.methods,
			"tabchannel-" + this.id,
			(data, transfer) => {
				if (!this.port) {
					throw new Error("Port not found");
				}
				this.port.postMessage(data, transfer);
			}
		);
		this.transport = init.transport;

		this.cookieSyncChannel.addEventListener(
			"message",
			this.onCookieSyncMessage
		);
		this.setupMessagePort();

		// don't lose a debounced cookie write when the tab goes away
		addEventListener("pagehide", () => {
			this.stopKeepalive();
			if (this.persistTimer !== null) {
				clearTimeout(this.persistTimer);
				this.persistTimer = null;
				void this.persistCookies();
			}
		});
		// back from the back/forward cache
		addEventListener("pageshow", (e) => {
			if (e.persisted) this.startKeepalive();
		});
		this.startKeepalive();

		navigator.serviceWorker.addEventListener("message", (e) => {
			if (
				e.data?.$controller$setCookie &&
				typeof e.data.$controller$setCookie === "object"
			) {
				const payload = e.data.$controller$setCookie as {
					cookies?: SerializedCookieSyncEntry[];
					options?: CookieSyncOptions;
					id?: string;
				};

				if (payload.options?.clear) {
					this.cookieJar.clear();
				}
				this.applyCookieSyncEntries(payload.cookies);

				if (typeof payload.id === "string") {
					this.serviceWorkerController.postMessage({
						$sw$setCookieDone: {
							id: payload.id,
						},
					});
				}

				return;
			}

			if (e.data.$controller$swrevive) {
				// if we just spawned the service worker, it will send this even though it's not actually dead
				// TODO: pretty jank, fix at some point
				if (this.guardServiceWorkerRevive) {
					return;
				}
				this.setupMessagePort();
			}
		});
	}

	private keepaliveTimer: ReturnType<typeof setInterval> | null = null;
	/**
	 * Browsers stop a service worker after ~30s without events, and the next
	 * proxied navigation then waits for it to start again and for this page
	 * to hand it a new port (the revive broadcast). A message every 20s keeps
	 * it running while this page is open. The worker ignores the message: it
	 * doesn't touch the ports, so it can't trigger a revive by itself (if the
	 * worker did die anyway, waking it runs the normal revive).
	 */
	private startKeepalive() {
		const every = this.init.serviceWorkerKeepalive ?? 20000;
		if (every === false || this.keepaliveTimer !== null) return;
		this.keepaliveTimer = setInterval(() => {
			try {
				// not navigator.serviceWorker.controller: with kaze-embed that can
				// be the host site's own worker
				this.serviceWorkerController.postMessage({ $sw$keepalive: true });
			} catch {
				// worker gone: the revive logic handles it on the next request
			}
		}, every);
	}

	private stopKeepalive() {
		if (this.keepaliveTimer === null) return;
		clearInterval(this.keepaliveTimer);
		this.keepaliveTimer = null;
	}

	private setupMessagePort() {
		if (this.port) {
			this.port.removeEventListener("message", this.onTabChannelMessage);
			try {
				this.port.close();
			} catch {
				// ignore
			}
			this.port = null;
		}

		const channel = new MessageChannel();
		if (this.engine) {
			// the service worker talks straight to the engine
			this.toEngine({ type: "port", port: channel.port1 }, [channel.port1]);
		} else {
			this.port = channel.port1;
			this.port.addEventListener("message", this.onTabChannelMessage);
			this.port.start();
		}

		this.serviceWorkerController.postMessage(
			{
				$controller$init: {
					prefix: this.prefix,
					id: this.id,
				},
			},
			[channel.port2]
		);
	}

	// TODO: should this be a method on the cookie jar?
	private applyCookieSyncEntries(
		cookies: SerializedCookieSyncEntry[] | undefined
	) {
		if (!Array.isArray(cookies)) {
			return;
		}

		for (const entry of cookies) {
			if (typeof entry?.url !== "string" || typeof entry.cookie !== "string") {
				continue;
			}

			this.cookieJar.setCookies(
				entry.cookie,
				new URL(entry.url),
				entry.fromJs === true
			);
		}
	}

	async propagateCookieSync(
		cookies: SerializedCookieSyncEntry[],
		options: CookieSyncOptions = {}
	): Promise<void> {
		if (!this.port) {
			return;
		}

		await this.rpc.call("sendSetCookie", {
			cookies,
			options,
		});
	}

	private async loadSavedCookies(force = false): Promise<void> {
		if (!force && !this.cookieSyncDirty) {
			return;
		}

		if (this.cookieSyncPromise) {
			return this.cookieSyncPromise;
		}

		this.cookieSyncPromise = (async () => {
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

	private persistTimer: ReturnType<typeof setTimeout> | null = null;
	/** coalesce IndexedDB writes: bursts of Set-Cookie become one write */
	schedulePersistCookies() {
		if (this.persistTimer !== null) return;
		this.persistTimer = setTimeout(() => {
			this.persistTimer = null;
			void this.persistCookies();
		}, 30);
	}

	async persistCookies(): Promise<void> {
		const updatedAt = await writeCookieState(
			this.cookieJar.dump(),
			this.cookieUpdatedAt
		);
		if (updatedAt <= this.cookieUpdatedAt) {
			return;
		}

		this.cookieUpdatedAt = updatedAt;
		this.cookieSyncDirty = false;
		this.cookieSyncChannel.postMessage({
			updatedAt,
		});
	}

	setTransport(transport: ProxyTransport) {
		this.transport = transport;
		for (const frame of this.frames) {
			frame.controller.transport = transport;
			frame.fetchHandler.client.transport = transport;
		}
	}

	createFrame(element?: HTMLIFrameElement, options: FrameOptions = {}): Frame {
		if (!this.ready) {
			throw new Error(
				"Controller is not ready! Try awaiting controller.wait()"
			);
		}
		element ??= document.createElement("iframe");
		const frame = new Frame(this, element, options);
		this.frames.push(frame);
		return frame;
	}

	async wait(): Promise<void> {
		await this.ready;
	}
}

export class Frame {
	id: string;
	prefix: string;
	fetchHandler: KazeFetchHandler;
	hooks: {
		fetch: FetchHooks;
		init: FrameInitHooks;
		error: FrameErrorHooks;
	};

	get context(): KazeContext {
		return {
			config: this.controller.kazeConfig,
			prefix: new URL(this.prefix, location.href),
			cookieJar: this.controller.cookieJar,
			interface: {
				getInjectScripts: yieldGetInjectScripts(
					this.controller.config,
					this.controller.kazeConfig,
					new URL(this.prefix, location.href),
					this.controller.cookieJar,
					this.controller.config.codec.encode,
					this.controller.config.codec.decode
				),
				getWorkerInjectScripts: (_meta, _type, script) =>
					workerInjectScripts(
						this.controller.config,
						this.controller.kazeConfig,
						this.prefix,
						this.controller.config.codec.encode.toString(),
						this.controller.config.codec.decode.toString(),
						script
					),
				codecEncode: this.controller.config.codec.encode,
				codecDecode: this.controller.config.codec.decode,
			},
		};
	}

	public plugins: ManagedPlugin[] = [];
	constructor(
		public controller: Controller,
		public element: HTMLIFrameElement,
		public options: FrameOptions = {}
	) {
		this.id = makeId();
		this.prefix = this.controller.prefix + this.id + "/";

		this.fetchHandler = new KazeFetchHandler({
			crossOriginIsolated: self.crossOriginIsolated,
			context: this.context,
			transport: controller.transport,
			async sendSetCookie(cookies, options) {
				const entries = cookies.map(({ url, cookie, fromJs }) => ({
					url: url.href,
					cookie,
					fromJs,
				}));
				if (controller.forwardCookies(entries, options)) return;
				// persisting is for other tabs / reloads; the response only has
				// to wait until the requesting page's jar has the cookies
				controller.schedulePersistCookies();
				await controller.propagateCookieSync(entries, options);
			},
			async fetchBlobUrl(url) {
				return BareResponse.fromNativeResponse(await fetch(url));
			},
			async fetchDataUrl(url) {
				return BareResponse.fromNativeResponse(await fetch(url));
			},
		});

		this.hooks = {
			fetch: this.fetchHandler.hooks.fetch,
			init: Tap.create<FrameInitHooks>(),
			error: Tap.create<FrameErrorHooks>(),
		};

		element[CONTROLLERFRAME] = this;

		this.plugins = options.plugins ?? [];
		if (controller.rewritePool)
			this.fetchHandler.rewriteOffload = controller.rewritePool;
		// a plugin that brings its own cache (utils' HttpCachePlugin) wins
		//@ts-ignore dumb hack, fix later (this fails in ci due to types not being available first build)
		if (!this.plugins.some((p) => p.name === "kaze-http-cache"))
			controller.httpCache?.attach(this.fetchHandler);
		// plugins hook this thread's handler, so those frames stay here
		if (this.plugins.length === 0) controller.registerFrame(this.prefix);
		for (const plugin of this.plugins) {
			for (const dependency of plugin.dependencies) {
				const dependencyPlugin = this.plugins.find(
					//@ts-ignore dumb hack, fix later (this fails in ci due to types not being available first build)
					(p) => p.name === dependency
				);
				if (!dependencyPlugin) {
					throw new Error(
						//@ts-ignore dumb hack, fix later (this fails in ci due to types not being available first build)
						`Dependency ${dependency} not found for plugin ${plugin.name}`
					);
				}
			}
			plugin.install(this);
		}
	}

	getPlugin<T extends ManagedPlugin>(name: string): T {
		//@ts-ignore dumb hack, fix later (this fails in ci due to types not being available first build)
		const plugin = this.plugins.find((p) => p.name === name) as T;
		if (!plugin) {
			throw new Error(`Plugin ${name} not found`);
		}
		return plugin;
	}

	back() {
		this.element.contentWindow?.history.back();
	}

	forward() {
		this.element.contentWindow?.history.forward();
	}

	reload() {
		this.element.contentWindow?.location.reload();
	}

	go(url: string) {
		const encoded = rewriteUrl(url, this.context, {
			//@ts-ignore dumb hack, fix later (this fails in ci due to types not being available first build)
			origin: new URL(location.href),
			//@ts-ignore dumb hack, fix later (this fails in ci due to types not being available first build)
			base: new URL(location.href),
		});
		this.element.src = encoded;
	}
}
