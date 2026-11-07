// Serves one proxy build (kaze or an upstream/baseline build) on its own
// origin: bench page, service worker, dist files, and a wisp endpoint.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { server as wisp, logging } from "@mercuryworkshop/wisp-js/server";

export type BuildSpec = {
	label: string;
	/** dir served at `mount` (core dist: <name>.js, <name>.wasm) */
	coreDist: string;
	controllerDist: string;
	/** url dir the controller expects core at, e.g. "/kaze/" or "/scramjet/" */
	mount: string;
	coreFile: string;
	controllerGlobal: string;
	prefix: string;
};

const TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".wasm": "application/wasm",
	".map": "application/json",
};

function benchPage(spec: BuildSpec) {
	return `<!doctype html><html><head><meta charset="utf-8"><title>bench ${spec.label}</title>
<script src="${spec.mount}${spec.coreFile}"></script>
<script src="/controller/controller.api.js"></script>
<script src="/libcurl/index.js"></script>
<style>html,body{margin:0;height:100%}iframe{border:0;width:100%;height:100%}</style>
</head><body><iframe id="f"></iframe><script>
(async () => {
	const reg = await navigator.serviceWorker.register("/sw.js");
	await navigator.serviceWorker.ready;
	if (!navigator.serviceWorker.controller)
		await new Promise((r) => navigator.serviceWorker.addEventListener("controllerchange", r, { once: true }));
	const { Controller } = ${spec.controllerGlobal};
	const controller = new Controller({
		serviceworker: navigator.serviceWorker.controller ?? reg.active,
		transport: new LibcurlTransport.LibcurlClient({ wisp: "ws://" + location.host + "/wisp/" }),
	});
	await controller.wait();
	const el = document.getElementById("f");
	const frame = controller.createFrame(el);
	window.__benchNav = (url, timeout) => new Promise((resolve) => {
		const t0 = performance.now();
		const timer = setTimeout(() => resolve({ error: "timeout" }), timeout);
		el.addEventListener("load", () => {
			const wall = performance.now() - t0;
			// let paint entries land
			setTimeout(() => {
				clearTimeout(timer);
				try {
					const w = el.contentWindow;
					const nav = w.performance.getEntriesByType("navigation")[0];
					const fcp = w.performance.getEntriesByName("first-contentful-paint")[0];
					resolve({ wall, dcl: nav && nav.domContentLoadedEventEnd, load: nav && nav.loadEventEnd, fcp: fcp && fcp.startTime, title: w.document.title, root: (w.document.getElementById("root") || {}).textContent, inline: w.__inline });
				} catch (e) { resolve({ wall, error: String(e) }); }
			}, 500);
		}, { once: true });
		frame.go(url);
	});
	window.__benchReady = true;
})().catch((e) => { window.__benchError = String(e && e.stack || e); });
</script></body></html>`;
}

export function startBuildServer(
	spec: BuildSpec,
	libcurlDist: string,
	port: number
) {
	const page = benchPage(spec);
	const sw = `importScripts("/controller/controller.sw.js");
addEventListener("install", () => self.skipWaiting());
addEventListener("activate", (e) => e.waitUntil(clients.claim()));
addEventListener("fetch", (e) => { if (${spec.controllerGlobal}.shouldRoute(e)) e.respondWith(${spec.controllerGlobal}.route(e)); });`;

	const mounts: [string, string][] = [
		[spec.mount, spec.coreDist],
		["/controller/", spec.controllerDist],
		["/libcurl/", libcurlDist],
	];

	const server = http.createServer((req, res) => {
		const pathname = decodeURIComponent(new URL(req.url!, "http://x").pathname);
		if (pathname === "/") {
			res.writeHead(200, { "Content-Type": TYPES[".html"] }).end(page);
			return;
		}
		if (pathname === "/sw.js") {
			res.writeHead(200, { "Content-Type": TYPES[".js"] }).end(sw);
			return;
		}
		for (const [prefix, dir] of mounts) {
			if (!pathname.startsWith(prefix)) continue;
			const file = path.join(dir, pathname.slice(prefix.length));
			if (
				!file.startsWith(dir) ||
				!fs.existsSync(file) ||
				!fs.statSync(file).isFile()
			)
				continue;
			res.writeHead(200, {
				"Content-Type": TYPES[path.extname(file)] ?? "application/octet-stream",
			});
			fs.createReadStream(file).pipe(res);
			return;
		}
		res.writeHead(404).end("not found");
	});

	wisp.options.allow_private_ips = true;
	wisp.options.allow_loopback_ips = true;
	logging.set_level(logging.NONE);
	server.on("upgrade", (req, socket, head) => {
		if (req.url?.startsWith("/wisp/")) wisp.routeRequest(req, socket, head);
		else socket.end();
	});

	return new Promise<http.Server>((resolve) =>
		server.listen(port, () => resolve(server))
	);
}
