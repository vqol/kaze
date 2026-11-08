// One origin per proxy: bench page, service worker, static files and a local
// wisp-js endpoint at /wisp/. Each page exposes the same tiny API:
//   window.__benchReady / __benchError / __bootMs
//   window.__benchNav(url, timeout) -> { wall, dcl, load, fcp }
//   document.getElementById("f") is the proxied iframe
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { server as wisp, logging } from "@mercuryworkshop/wisp-js/server";

export type ProxySpec = {
	label: string;
	mounts: [string, string][];
	/** script tags + async setup code that must define `go(url)` */
	head: string;
	setup: string;
	sw: string;
};

const TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".wasm": "application/wasm",
	".map": "application/json",
};

const NAV = `
	window.__benchNav = (url, timeout) => new Promise((resolve) => {
		const el = document.getElementById("f");
		const t0 = performance.now();
		const timer = setTimeout(() => resolve({ error: "timeout" }), timeout);
		el.addEventListener("load", () => {
			const wall = performance.now() - t0;
			setTimeout(() => {
				clearTimeout(timer);
				try {
					const w = el.contentWindow;
					const nav = w.performance.getEntriesByType("navigation")[0];
					const fcp = w.performance.getEntriesByName("first-contentful-paint")[0];
					resolve({ wall, dcl: nav && nav.domContentLoadedEventEnd, load: nav && nav.loadEventEnd, fcp: fcp && fcp.startTime, resources: w.performance.getEntriesByType("resource").length, elements: w.document.querySelectorAll("*").length });
				} catch (e) { resolve({ wall, error: String(e) }); }
			}, 500);
		}, { once: true });
		go(url);
	});`;

function page(spec: ProxySpec) {
	return `<!doctype html><html><head><meta charset="utf-8"><title>bench ${spec.label}</title>
${spec.head}
<style>html,body{margin:0;height:100%}iframe{border:0;width:100%;height:100%}</style>
</head><body><iframe id="f"></iframe><script>
(async () => {
	const WISP = ${JSON.stringify(process.env.BENCH_WISP ?? "")} || "ws://" + location.host + "/wisp/";
	let go;
	${spec.setup}
	${NAV}
	window.__bootMs = performance.now();
	window.__benchReady = true;
})().catch((e) => { window.__benchError = String(e && e.stack || e); });
</script></body></html>`;
}

export function startProxyServer(spec: ProxySpec, port: number) {
	const html = page(spec);
	spec.mounts = spec.mounts.map(([p, d]) => [p, path.resolve(d)]);
	const server = http.createServer((req, res) => {
		const pathname = decodeURIComponent(new URL(req.url!, "http://x").pathname);
		if (pathname === "/") {
			res.writeHead(200, { "Content-Type": TYPES[".html"] }).end(html);
			return;
		}
		if (pathname === "/sw.js") {
			res.writeHead(200, { "Content-Type": TYPES[".js"] }).end(spec.sw);
			return;
		}
		for (const [prefix, dir] of spec.mounts) {
			if (!pathname.startsWith(prefix)) continue;
			const file = path.join(dir, pathname.slice(prefix.length));
			if (
				!file.startsWith(dir) ||
				!fs.existsSync(file) ||
				!fs.statSync(file).isFile()
			)
				continue;
			// same caching for every proxy: revalidate-free for the bench session
			res.writeHead(200, {
				"Content-Type": TYPES[path.extname(file)] ?? "application/octet-stream",
				"Cache-Control": "max-age=3600",
			});
			fs.createReadStream(file).pipe(res);
			return;
		}
		res.writeHead(404).end("not found");
	});

	wisp.options.allow_private_ips = true;
	wisp.options.allow_loopback_ips = true;
	logging.set_level(process.env.WISP_DEBUG ? logging.DEBUG : logging.NONE);
	server.on("upgrade", (req, socket, head) => {
		if (req.url?.startsWith("/wisp/")) wisp.routeRequest(req, socket, head);
		else socket.end();
	});
	return new Promise<http.Server>((resolve) =>
		server.listen(port, () => resolve(server))
	);
}

const ROUTE_SW = (g: string) => `
addEventListener("install", () => self.skipWaiting());
addEventListener("activate", (e) => e.waitUntil(clients.claim()));
addEventListener("fetch", (e) => { if (${g}.shouldRoute(e)) e.respondWith(${g}.route(e)); });`;

const WAIT_SW = `
	const reg = await navigator.serviceWorker.register("/sw.js");
	await navigator.serviceWorker.ready;
	if (!navigator.serviceWorker.controller)
		await new Promise((r) => navigator.serviceWorker.addEventListener("controllerchange", r, { once: true }));`;

/** kaze, or upstream scramjet main (same controller architecture) */
export function controllerSpec(o: {
	label: string;
	coreDist: string;
	controllerDist: string;
	libcurlDist: string;
	/** optional epoxy-transport dist; used instead of libcurl when set */
	epoxyDist?: string;
	/** run the transport in kaze's WorkerTransport (kaze's recommended setup) */
	workerTransport?: boolean;
	mount: string;
	coreFile: string;
	global: string;
}): ProxySpec {
	return {
		label: o.label,
		mounts: [
			[o.mount, o.coreDist],
			["/controller/", o.controllerDist],
			["/libcurl/", o.libcurlDist],
			...(o.epoxyDist ? [["/epoxy/", o.epoxyDist] as [string, string]] : []),
		],
		head: `<script src="${o.mount}${o.coreFile}"></script>
<script src="/controller/controller.api.js"></script>
${o.workerTransport ? "" : o.epoxyDist ? `<script src="/epoxy/index.js"></script>` : `<script src="/libcurl/index.js"></script>`}`,
		setup: `
	const transport = ${
		o.workerTransport
			? `new ${o.global}.WorkerTransport(${o.epoxyDist ? `{ scripts: ["/epoxy/index.js"], construct: "EpoxyTransport.default"` : `{ scripts: ["/libcurl/index.js"], construct: "LibcurlTransport.LibcurlClient"`}, options: { wisp: WISP } })`
			: o.epoxyDist
				? `new EpoxyTransport.default({ wisp: WISP })`
				: `new LibcurlTransport.LibcurlClient({ wisp: WISP })`
	};
	${o.workerTransport ? `${o.global}.warmupTransport?.(transport);` : ""}
	${WAIT_SW}
	const controller = new ${o.global}.Controller({
		serviceworker: navigator.serviceWorker.controller ?? reg.active,
		transport,
	});
	await controller.wait();
	const frame = controller.createFrame(document.getElementById("f"));
	go = (u) => frame.go(u);`,
		sw: `importScripts("/controller/controller.sw.js");` + ROUTE_SW(o.global),
	};
}

export function scramjet1Spec(nm: string): ProxySpec {
	return {
		label: "scramjet1",
		mounts: [
			["/scram/", path.join(nm, "@mercuryworkshop/scramjet/dist")],
			["/baremux/", path.join(nm, "@mercuryworkshop/bare-mux/dist")],
			["/libcurl/", path.join(nm, "@mercuryworkshop/libcurl-transport/dist")],
		],
		head: `<script src="/scram/scramjet.all.js"></script><script src="/baremux/index.js"></script>`,
		setup: `
	const { ScramjetController } = $scramjetLoadController();
	const sj = new ScramjetController({
		prefix: "/scramjet/",
		files: { wasm: "/scram/scramjet.wasm.wasm", all: "/scram/scramjet.all.js", sync: "/scram/scramjet.sync.js" },
	});
	await sj.init();
	${WAIT_SW}
	const conn = new BareMux.BareMuxConnection("/baremux/worker.js");
	await conn.setTransport("/libcurl/index.mjs", [{ wisp: WISP }]);
	const frame = sj.createFrame(document.getElementById("f"));
	go = (u) => frame.go(u);`,
		sw: `importScripts("/scram/scramjet.all.js");
const { ScramjetServiceWorker } = $scramjetLoadWorker();
const sj = new ScramjetServiceWorker();
addEventListener("install", () => self.skipWaiting());
addEventListener("activate", (e) => e.waitUntil(clients.claim()));
addEventListener("fetch", (e) => e.respondWith((async () => {
	await sj.loadConfig();
	if (sj.route(e)) return sj.fetch(e);
	return fetch(e.request);
})()));`,
	};
}

export function uvSpec(nm: string): ProxySpec {
	const config = `self.__uv$config = {
	prefix: "/service/",
	encodeUrl: Ultraviolet.codec.xor.encode,
	decodeUrl: Ultraviolet.codec.xor.decode,
	handler: "/uv/uv.handler.js",
	client: "/uv/uv.client.js",
	bundle: "/uv/uv.bundle.js",
	config: "/uvconfig/uv.config.js",
	sw: "/uv/uv.sw.js",
};`;
	const cfgDir = path.join(nm, ".uvconfig");
	fs.mkdirSync(cfgDir, { recursive: true });
	fs.writeFileSync(path.join(cfgDir, "uv.config.js"), config);
	return {
		label: "uv",
		mounts: [
			["/uv/", path.join(nm, "@titaniumnetwork-dev/ultraviolet/dist")],
			["/uvconfig/", cfgDir],
			["/baremux/", path.join(nm, "@mercuryworkshop/bare-mux/dist")],
			["/libcurl/", path.join(nm, "@mercuryworkshop/libcurl-transport/dist")],
		],
		head: `<script src="/uv/uv.bundle.js"></script><script src="/uvconfig/uv.config.js"></script><script src="/baremux/index.js"></script>`,
		setup: `${WAIT_SW}
	const conn = new BareMux.BareMuxConnection("/baremux/worker.js");
	await conn.setTransport("/libcurl/index.mjs", [{ wisp: WISP }]);
	go = (u) => { document.getElementById("f").src = __uv$config.prefix + __uv$config.encodeUrl(u); };`,
		sw: `importScripts("/uv/uv.bundle.js", "/uvconfig/uv.config.js", "/uv/uv.sw.js");
const uv = new UVServiceWorker();
addEventListener("install", () => self.skipWaiting());
addEventListener("activate", (e) => e.waitUntil(clients.claim()));
addEventListener("fetch", (e) => e.respondWith((async () => {
	if (uv.route(e)) return await uv.fetch(e);
	return await fetch(e.request);
})()));`,
	};
}
