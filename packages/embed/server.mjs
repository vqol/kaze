// Serves kaze from an existing Node server.
//
//   import { kaze } from "@kaze/embed";
//   const proxy = kaze();
//   app.use(proxy);            // express, connect, or http.createServer(proxy)
//   proxy.attach(server);      // the http.Server: handles wisp websockets
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

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
	const cache = new Map();

	function load(file) {
		let entry = cache.get(file);
		if (entry) return entry;
		const raw = fs.readFileSync(file);
		const stat = fs.statSync(file);
		entry = {
			raw,
			etag: `"${stat.size.toString(36)}-${Math.floor(stat.mtimeMs).toString(36)}"`,
			br: zlib.brotliCompressSync(raw, {
				params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 9 },
			}),
			gzip: zlib.gzipSync(raw, { level: 9 }),
		};
		cache.set(file, entry);
		return entry;
	}

	function serve(req, res, file) {
		const entry = load(file);
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
		const accept = String(req.headers["accept-encoding"] ?? "");
		let body = entry.raw;
		if (/\bbr\b/.test(accept)) {
			body = entry.br;
			headers["Content-Encoding"] = "br";
		} else if (/\bgzip\b/.test(accept)) {
			body = entry.gzip;
			headers["Content-Encoding"] = "gzip";
		}
		headers["Content-Length"] = body.length;
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
		let isFile = false;
		try {
			isFile = fs.statSync(file).isFile();
		} catch {
			// not one of ours
		}
		if (!isFile) return pass();
		serve(req, res, file);
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
