// Serves kaze from an existing Node server.
//
//   import { kaze } from "@kaze/embed";
//   const proxy = kaze();
//   app.use(proxy);            // express, connect, or http.createServer(proxy)
//   proxy.attach(server);      // the http.Server: handles wisp websockets
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createFileCache, negotiate } from "./precompress.mjs";

const ASSET_DIR = path.join(
	path.dirname(fileURLToPath(import.meta.url)),
	"assets"
);
const TYPES = {
	".js": "text/javascript; charset=utf-8",
	".wasm": "application/wasm",
	".json": "application/json; charset=utf-8",
};

export function serviceWorkerSource(assetsPath = "/kaze-assets/") {
	return `importScripts(${JSON.stringify(assetsPath + "controller.sw.js")});
addEventListener("install", () => self.skipWaiting());
addEventListener("activate", (e) => e.waitUntil(clients.claim()));
addEventListener("fetch", (e) => {
	if ($kazeController.shouldRoute(e)) e.respondWith($kazeController.route(e));
});
`;
}

export function kaze(options = {}) {
	const assetsPath = options.assetsPath ?? "/kaze-assets/";
	const swPath = options.swPath ?? "/kaze-sw.js";
	const wispPath = options.wispPath ?? "/wisp/";
	const sw = serviceWorkerSource(assetsPath);
	// brotli/gzip copies come from build.mjs (see precompress.mjs)
	const load = createFileCache();

	async function serve(req, res, file, stat) {
		const entry = await load(file, stat);
		const headers = {
			"Content-Type": TYPES[path.extname(file)] ?? "application/octet-stream",
			"Cache-Control": "public, max-age=600, stale-while-revalidate=86400",
			ETag: entry.etag,
			Vary: "Accept-Encoding",
		};
		if (req.headers["if-none-match"] === entry.etag) {
			res.writeHead(304, headers).end();
			return;
		}
		const body = negotiate(req, entry, headers);
		res.writeHead(200, headers);
		res.end(req.method === "HEAD" ? undefined : body);
	}

	function handler(req, res, next) {
		const pathname = decodeURIComponent(new URL(req.url, "http://x").pathname);
		const pass = () => {
			if (next) return next();
			res.writeHead(404, { "Content-Type": "text/plain" }).end("not found");
		};
		if (pathname === swPath) {
			res
				.writeHead(200, {
					"Content-Type": TYPES[".js"],
					"Cache-Control": "no-cache",
				})
				.end(sw);
			return;
		}
		if (!pathname.startsWith(assetsPath)) return pass();
		const file = path.join(ASSET_DIR, pathname.slice(assetsPath.length));
		if (!file.startsWith(ASSET_DIR + path.sep)) return pass();
		fs.promises.stat(file).then(
			(stat) => {
				if (!stat.isFile()) return pass();
				return serve(req, res, file, stat).catch((err) => {
					if (next) return next(err);
					res.writeHead(500, { "Content-Type": "text/plain" }).end();
				});
			},
			// not one of ours
			() => pass()
		);
	}

	/** Handle wisp websockets on an http.Server. Other upgrades are left alone. */
	handler.attach = async function attach(server) {
		const { server: wisp, logging } = await import(
			"@mercuryworkshop/wisp-js/server"
		);
		// proxied sites must not be able to reach this machine's private network
		wisp.options.allow_private_ips = options.allowPrivateIps ?? false;
		wisp.options.allow_loopback_ips = options.allowLoopback ?? false;
		logging.set_level(logging.WARN);
		server.on("upgrade", (req, socket, head) => {
			if (req.url?.startsWith(wispPath)) wisp.routeRequest(req, socket, head);
		});
		return handler;
	};

	return handler;
}

export default kaze;
