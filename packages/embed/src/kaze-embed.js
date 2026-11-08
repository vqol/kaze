// Adds a proxied browser to any page.
//
//   <script src="/kaze-assets/kaze-embed.js" defer></script>
//   <div data-kaze="https://example.com" style="height: 600px"></div>
//
// or from script:
//
//   const browser = await Kaze.mount("#box", { url: "https://example.com" });
//   browser.go("wikipedia.org");
(() => {
	const script = document.currentScript;
	const ASSETS = new URL(".", script.src).href;
	const options = script.dataset;
	const SEARCH = "https://duckduckgo.com/?q=";

	const defaultWisp = () =>
		`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/wisp/`;

	function loadScript(src) {
		return new Promise((resolve, reject) => {
			const el = document.createElement("script");
			el.src = src;
			el.onload = resolve;
			el.onerror = () => reject(new Error(`kaze: could not load ${src}`));
			document.head.append(el);
		});
	}

	function whenActive(reg) {
		if (reg.active) return Promise.resolve(reg.active);
		const worker = reg.installing || reg.waiting;
		return new Promise((resolve) => {
			worker.addEventListener("statechange", () => {
				if (worker.state === "activated") resolve(worker);
			});
		});
	}

	let started = null;
	function start(wisp) {
		return (started ??= (async () => {
			if (!("serviceWorker" in navigator))
				throw new Error(
					"kaze: needs service workers (https, or localhost during development)"
				);
			if (new URL(ASSETS).origin !== location.origin)
				throw new Error(
					"kaze: serve kaze-assets from this site's own origin; browsers don't allow service workers or workers from another origin"
				);

			await loadScript(ASSETS + "kaze.js");
			await loadScript(ASSETS + "controller.api.js");

			const api = window.$kazeController;
			const transport = new api.WorkerTransport({
				scripts: [ASSETS + "libcurl/index.js"],
				construct: "LibcurlTransport.LibcurlClient",
				options: { wisp },
			});
			// starts loading now, in parallel with service worker registration
			api.warmupTransport(transport);

			// scoped to the proxy's own path, so it can't interfere with the site
			const reg = await navigator.serviceWorker.register(
				options.sw || "/kaze-sw.js",
				{ scope: "/~/kz/", updateViaCache: "none" }
			);
			reg.update().catch(() => {});
			const controller = new api.Controller({
				serviceworker: await whenActive(reg),
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

	function toUrl(input) {
		const text = String(input).trim();
		if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return text;
		if (/^[^\s]+\.[^\s]{2,}$/.test(text)) return "https://" + text;
		return SEARCH + encodeURIComponent(text);
	}

	async function mount(target, opts = {}) {
		const host =
			typeof target === "string" ? document.querySelector(target) : target;
		if (!host) throw new Error(`kaze: nothing matches ${target}`);
		const wisp =
			opts.wisp || host.dataset.wisp || options.wisp || defaultWisp();
		const iframe = document.createElement("iframe");
		iframe.title = opts.title || "kaze";
		iframe.style.cssText = "display:block;width:100%;height:100%;border:0";
		host.append(iframe);
		if (host.clientHeight === 0) host.style.height = "600px";

		const controller = await start(wisp);
		const frame = controller.createFrame(iframe);
		const listeners = new Set();
		let lastHref = null;

		const currentUrl = () => {
			try {
				const href = iframe.contentWindow.location.href;
				const at = href.indexOf(frame.prefix);
				return at === -1
					? null
					: decodeURIComponent(href.slice(at + frame.prefix.length));
			} catch {
				return null;
			}
		};
		const check = () => {
			const url = currentUrl();
			if (url && url !== lastHref) {
				lastHref = url;
				for (const fn of listeners) fn(url);
			}
		};
		iframe.addEventListener("load", check);
		setInterval(check, 300);

		const browser = {
			iframe,
			controller,
			frame,
			go: (url) => frame.go(toUrl(url)),
			back: () => frame.back(),
			forward: () => frame.forward(),
			reload: () => frame.reload(),
			get url() {
				return currentUrl();
			},
			/** calls fn with the proxied page's url each time it changes */
			onUrlChange(fn) {
				listeners.add(fn);
				return () => listeners.delete(fn);
			},
		};
		if (opts.url) browser.go(opts.url);
		return browser;
	}

	window.Kaze = { mount };

	const auto = () => {
		for (const el of document.querySelectorAll("[data-kaze]")) {
			mount(el, { url: el.dataset.kaze || undefined }).catch((e) => {
				console.error(e);
				el.textContent = e.message;
			});
		}
	};
	if (document.readyState === "loading")
		document.addEventListener("DOMContentLoaded", auto);
	else auto();
})();
