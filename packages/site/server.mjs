// kaze: tiny static server + wisp endpoint on one port
// usage: node server.mjs   (PORT env to change, default 8080)
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { server as wisp, logging } from "@mercuryworkshop/wisp-js/server";
import { createFileCache, negotiate } from "../embed/precompress.mjs";
import { mounts, compressedBase } from "./mounts.mjs";

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
// brotli/gzip copies come from `pnpm build` (build.mjs, see
// ../embed/precompress.mjs); anything missing is compressed off the event loop
const load = createFileCache();

async function serveFile(req, res, prefix, file, stat) {
	const entry = await load(file, stat, compressedBase(prefix, file));
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
	const body = negotiate(req, entry, headers);
	res.writeHead(200, headers);
	res.end(req.method === "HEAD" ? undefined : body);
}

async function findFile(pathname) {
	for (const [prefix, dir] of mounts) {
		if (!pathname.startsWith(prefix)) continue;
		const file = path.join(dir, pathname.slice(prefix.length));
		if (!file.startsWith(dir)) return null; // no traversal
		const stat = await fs.promises.stat(file).catch(() => null);
		if (stat?.isFile()) return { prefix, file, stat };
	}
	return null;
}

const server = http.createServer(async (req, res) => {
	const url = new URL(req.url, "http://x");
	let pathname = decodeURIComponent(url.pathname);
	if (pathname === "/benchmarks") {
		res.writeHead(301, { Location: "/benchmarks/" }).end();
		return;
	}
	if (pathname.endsWith("/")) pathname += "index.html";

	try {
		const found = await findFile(pathname);
		if (found) {
			await serveFile(req, res, found.prefix, found.file, found.stat);
			return;
		}
	} catch (err) {
		console.error(err);
		res.writeHead(500, { "Content-Type": "text/plain" }).end("error");
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
