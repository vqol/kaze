// Runs existing Scramjet 1.x integrations on kaze. Load this instead of
// scramjet.all.js, in the page and in the service worker.
//
// In a service worker, set self.KAZE_ASSETS first if kaze-assets isn't at /kaze-assets/.
(() => {
	const scope = globalThis;
	const isPage = typeof document !== "undefined";
	const ASSETS = isPage
		? new URL(".", document.currentScript.src).href
		: new URL(scope.KAZE_ASSETS || "/kaze-assets/", scope.location.href).href;

	// ---- service worker ----
	if (!isPage) {
		importScripts(ASSETS + "controller.sw.js");
		const api = scope.$kazeController;
		class ScramjetServiceWorker extends EventTarget {
			config = {};
			async loadConfig() {}
			route(event) {
				return api.shouldRoute(event);
			}
			fetch(event) {
				return api.route(event);
			}
		}
		scope.$scramjetLoadWorker = () => ({ ScramjetServiceWorker });
		return;
	}

	// ---- page ----
	const defaultWisp = () =>
		`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/wisp/`;

	// Scramjet sites pick their wisp server through bare-mux. kaze has its own
	// transport, so remember the url and ignore the rest.
	let announceWisp;
	const wispKnown = new Promise((resolve) => (announceWisp = resolve));
	class BareMuxConnection {
		constructor() {}
		async setTransport(_path, args) {
			const opts = args?.[0] ?? {};
			const url =
				typeof opts === "string" ? opts : opts.wisp || opts.websocket;
			// a transport without a wisp url (bare, a custom one) can't carry
			// over: use this site's /wisp/ now instead of after the 3s wait
			announceWisp(/^wss?:\/\//i.test(url ?? "") ? url : defaultWisp());
		}
		async getTransport() {
			return "kaze";
		}
		async setManualTransport() {}
	}
	const bareMux = { BareMuxConnection };
	// a later <script src=".../bare-mux/index.js"> mustn't replace this
	Object.defineProperty(window, "BareMux", {
		get: () => bareMux,
		set() {},
		configurable: true,
	});

	// Downloads every script at once but runs them in the order given:
	// script-inserted scripts with async = false keep insertion order.
	function loadScripts(...srcs) {
		return Promise.all(
			srcs.map(
				(src) =>
					new Promise((resolve, reject) => {
						const el = document.createElement("script");
						el.src = src;
						el.async = false;
						el.onload = resolve;
						el.onerror = () =>
							reject(new Error(`kaze: could not load ${src}`));
						document.head.append(el);
					})
			)
		);
	}

	let started = null;
	function start() {
		return (started ??= (async () => {
			await loadScripts(ASSETS + "kaze.js", ASSETS + "controller.api.js");
			const api = window.$kazeController;
			// setTransport normally comes right after init; don't wait forever
			// for sites that never call it
			const wisp = await Promise.race([
				wispKnown,
				new Promise((r) => setTimeout(() => r(defaultWisp()), 3000)),
			]);
			const transport = new api.WorkerTransport({
				scripts: [ASSETS + "libcurl/index.js"],
				construct: "LibcurlTransport.LibcurlClient",
				options: { wisp },
			});
			api.warmupTransport(transport);
			const reg = await navigator.serviceWorker.ready;
			const controller = new api.Controller({
				serviceworker: reg.active,
				transport,
				config: {
					kazePath: ASSETS + "kaze.js",
					injectPath: ASSETS + "controller.inject.js",
					wasmPath: ASSETS + "kaze.wasm",
				},
			});
			await controller.wait();
			return controller;
		})());
	}

	class ScramjetFrame extends EventTarget {
		frame;
		real = null;
		#ready;
		#last = null;
		constructor(iframe) {
			super();
			this.frame = iframe;
			this.#ready = start().then((controller) => {
				this.real = controller.createFrame(iframe);
				return this.real;
			});
			iframe.addEventListener("load", () => this.#check());
			setInterval(() => this.#check(), 300);
		}
		get #current() {
			try {
				const href = this.frame.contentWindow.location.href;
				const at = href.indexOf(this.real.prefix);
				return at === -1
					? null
					: decodeURIComponent(href.slice(at + this.real.prefix.length));
			} catch {
				return null;
			}
		}
		#check() {
			if (!this.real) return;
			const url = this.#current;
			if (url && url !== this.#last) {
				this.#last = url;
				const event = new Event("urlchange");
				event.url = url;
				this.dispatchEvent(event);
			}
		}
		get url() {
			return this.#current ? new URL(this.#current) : new URL("about:blank");
		}
		go(url) {
			const href = String(url);
			const event = new Event("navigate");
			event.url = href;
			this.dispatchEvent(event);
			return this.#ready.then((f) => f.go(href));
		}
		back() {
			return this.#ready.then((f) => f.back());
		}
		forward() {
			return this.#ready.then((f) => f.forward());
		}
		reload() {
			return this.#ready.then((f) => f.reload());
		}
	}

	class ScramjetController extends EventTarget {
		config;
		constructor(config = {}) {
			super();
			this.config = config;
		}
		// the service worker is often registered after init(), so this can't wait for it
		async init() {
			void start();
		}
		createFrame(iframe) {
			iframe ??= document.createElement("iframe");
			return new ScramjetFrame(iframe);
		}
		encodeUrl() {
			throw new Error(
				"kaze: encodeUrl isn't available in the Scramjet compatibility layer, because kaze's urls belong to a frame. Use frame.go(url) instead."
			);
		}
		decodeUrl(url) {
			const text = String(url);
			const at = text.indexOf("/~/kz/");
			if (at === -1) return text;
			return decodeURIComponent(
				text
					.slice(at + 6)
					.split("/")
					.slice(2)
					.join("/")
			);
		}
		async modifyConfig() {}
		async openIDB() {
			throw new Error("kaze: Scramjet's config database doesn't exist on kaze");
		}
	}
	window.$scramjetLoadController = () => ({
		ScramjetController,
		ScramjetFrame,
	});
})();
