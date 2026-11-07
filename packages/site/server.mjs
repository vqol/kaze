// kaze: tiny static server + wisp endpoint on one port
// usage: node server.mjs   (PORT env to change, default 8080)
import http from "node:http";
import fs from "node:fs";
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
	".map": "application/json",
	".css": "text/css; charset=utf-8",
	".svg": "image/svg+xml",
};

const server = http.createServer((req, res) => {
	const url = new URL(req.url, "http://x");
	let pathname = decodeURIComponent(url.pathname);
	if (pathname === "/") pathname = "/index.html";

	for (const [prefix, dir] of mounts) {
		if (!pathname.startsWith(prefix)) continue;
		const file = path.join(dir, pathname.slice(prefix.length));
		if (!file.startsWith(dir)) break; // no traversal
		if (!fs.existsSync(file) || !fs.statSync(file).isFile()) continue;
		res.writeHead(200, {
			"Content-Type": types[path.extname(file)] ?? "application/octet-stream",
			"Cache-Control": "no-cache",
		});
		fs.createReadStream(file).pipe(res);
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
