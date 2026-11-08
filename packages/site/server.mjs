// kaze: tiny static server + wisp endpoint on one port
// usage: node server.mjs   (PORT env to change, default 8080)
import http from "node:http";
import fs from "node:fs";
import zlib from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { server as wisp, logging } from "@mercuryworkshop/wisp-js/server";

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = (pkg) =>
	path.join(path.dirname(fileURLToPath(import.meta.resolve(pkg))));
const pkgRoot = (name) => path.join(here, "node_modules", name);

// url prefix -> directory on disk
const mounts = [
	["/kaze/", path.join(pkgRoot("@kaze/core"), "dist")],
	["/controller/", path.join(pkgRoot("@kaze/controller"), "dist")],
	["/libcurl/", dist("@mercuryworkshop/libcurl-transport")],
	["/", path.join(here, "public")],
];

const types = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".wasm": "application/wasm",
	".json": "application/json; charset=utf-8",
	".map": "application/json",
	".css": "text/css; charset=utf-8",
	".svg": "image/svg+xml",
};

// runtime files (kaze, controller, libcurl) are loaded by every proxied page
// as blocking scripts: let the browser keep them briefly instead of
// re-downloading them per navigation. html and sw.js always revalidate.
const RUNTIME_CACHE = "public, max-age=600, stale-while-revalidate=86400";
const COMPRESSIBLE = new Set([
	".html",
	".js",
	".mjs",
	".wasm",
	".map",
	".css",
	".svg",
	".json",
]);

// path -> { mtimeMs, size, etag, raw, br, gzip }; compressed once per file version
const fileCache = new Map();
function loadFile(file, stat) {
	let entry = fileCache.get(file);
	if (entry && entry.mtimeMs === stat.mtimeMs && entry.size === stat.size)
		return entry;
	const raw = fs.readFileSync(file);
	entry = {
		mtimeMs: stat.mtimeMs,
		size: stat.size,
		etag: `"${stat.size.toString(36)}-${Math.floor(stat.mtimeMs).toString(36)}"`,
		raw,
		br: null,
		gzip: null,
	};
	if (COMPRESSIBLE.has(path.extname(file)) && raw.length > 1024) {
		entry.br = zlib.brotliCompressSync(raw, {
			params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 9 },
		});
		entry.gzip = zlib.gzipSync(raw, { level: 9 });
	}
	fileCache.set(file, entry);
	return entry;
}

const server = http.createServer((req, res) => {
	const url = new URL(req.url, "http://x");
	let pathname = decodeURIComponent(url.pathname);
	if (pathname === "/benchmarks") {
		res.writeHead(301, { Location: "/benchmarks/" }).end();
		return;
	}
	if (pathname.endsWith("/")) pathname += "index.html";

	for (const [prefix, dir] of mounts) {
		if (!pathname.startsWith(prefix)) continue;
		const file = path.join(dir, pathname.slice(prefix.length));
		if (!file.startsWith(dir)) break; // no traversal
		let stat;
		try {
			stat = fs.statSync(file);
		} catch {
			continue;
		}
		if (!stat.isFile()) continue;

		const entry = loadFile(file, stat);
		const ext = path.extname(file);
		const headers = {
			"Content-Type": types[ext] ?? "application/octet-stream",
			"Cache-Control": prefix === "/" ? "no-cache" : RUNTIME_CACHE,
			ETag: entry.etag,
			Vary: "Accept-Encoding",
		};
		if (req.headers["if-none-match"] === entry.etag) {
			res.writeHead(304, headers).end();
			return;
		}
		const accept = String(req.headers["accept-encoding"] ?? "");
		let body = entry.raw;
		if (entry.br && /\bbr\b/.test(accept)) {
			body = entry.br;
			headers["Content-Encoding"] = "br";
		} else if (entry.gzip && /\bgzip\b/.test(accept)) {
			body = entry.gzip;
			headers["Content-Encoding"] = "gzip";
		}
		headers["Content-Length"] = body.length;
		res.writeHead(200, headers);
		res.end(req.method === "HEAD" ? undefined : body);
		return;
	}

	res.writeHead(404, { "Content-Type": "text/plain" });
	res.end("not found");
});

wisp.options.allow_private_ips = false;
wisp.options.allow_loopback_ips = false;
logging.set_level(logging.WARN);

server.on("upgrade", (req, socket, head) => {
	if (req.url.startsWith("/wisp/")) wisp.routeRequest(req, socket, head);
	else socket.end();
});

const PORT = Number(process.env.PORT ?? 8080);
server.listen(PORT, () => {
	console.log(`kaze running at http://localhost:${PORT}`);
});
