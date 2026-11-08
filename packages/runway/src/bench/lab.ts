// Local "internet" for the comparison benchmark: fixture sites, a runtime
// microbenchmark page, tiny/download/upload endpoints and a websocket echo.
// Every proxy reaches it through its own local wisp-js server.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { WebSocketServer } from "ws";
import { buildFixtures } from "./fixtures.ts";

// Runs inside the proxied page, so the proxy rewrites it like any site script.
// Results land on window.__micro (and window.__microDone = true).
const MICRO_SCRIPT = String.raw`
(function () {
	var R = (window.__micro = {});
	// ?only=a,b runs a subset (profiling); ?reps=N repeats it
	var ONLY = new URLSearchParams(location.search).get("only");
	var skip = function (name) { return ONLY && ONLY.split(",").indexOf(name) === -1; };
	var median = function (xs) { xs = xs.slice().sort(function (a, b) { return a - b; }); return xs[xs.length >> 1]; };
	// ns per op, best of 3 rounds (rounds absorb JIT warmup and GC noise)
	function time(name, n, f) {
		if (skip(name)) return;
		R.stage = name;
		try {
			var best = Infinity;
			for (var round = 0; round < 3; round++) {
				var t = performance.now();
				for (var i = 0; i < n; i++) f(i);
				best = Math.min(best, ((performance.now() - t) * 1e6) / n);
			}
			R[name] = best;
		} catch (e) { R[name] = null; R[name + "_err"] = String(e).slice(0, 120); }
	}
	// each network test gets 30s; a hang in one proxy feature must not sink the rest
	async function atime(name, f) {
		if (skip(name)) return;
		R.stage = name;
		try {
			R[name] = await Promise.race([f(), new Promise(function (_, rej) { setTimeout(function () { rej(new Error("timeout")); }, 30000); })]);
		} catch (e) { R[name] = null; R[name + "_err"] = String(e).slice(0, 120); }
	}
	async function run() {
		// ---- runtime / DOM hook overhead ----
		time("locationHref", 20000, function () { return location.href; });
		time("cookieWrite", 1000, function (i) { document.cookie = "k" + (i % 20) + "=v" + i + "; path=/"; });
		time("cookieRead", 1000, function () { return document.cookie; });
		var a = document.createElement("a");
		time("setAttribute", 10000, function (i) { a.setAttribute("href", "/p/" + i); });
		time("getAttribute", 10000, function () { return a.getAttribute("href"); });
		time("anchorHref", 10000, function () { return a.href; });
		var d = document.createElement("div");
		var html = new Array(26).join('<a href="/x/y">x</a><img src="/i.png" alt="">');
		time("innerHTMLSet", 200, function () { d.innerHTML = html; });
		time("innerHTMLGet", 200, function () { return d.innerHTML; });
		time("eval", 1000, function (i) { return eval("1+" + i); });
		time("newFunction", 500, function (i) { return new Function("return " + i)(); });
		time("localStorage", 5000, function (i) { localStorage.setItem("k" + (i % 50), "v"); return localStorage.getItem("k" + (i % 50)); });
		time("replaceState", 300, function (i) { history.replaceState(null, "", "?s=" + i); });
		time("createScript", 300, function (i) { var s = document.createElement("script"); s.src = "/s" + i + ".js"; return s.src; });
		time("windowProp", 50000, function () { return window.document; });

		// ---- network ----
		await atime("fetchLatency", async function () {
			var xs = [];
			for (var i = 0; i < 40; i++) { var t = performance.now(); await (await fetch("/tiny?i=" + i + "&r=" + Math.random())).text(); xs.push(performance.now() - t); }
			return median(xs);
		});
		await atime("xhrLatency", async function () {
			var xs = [];
			for (var i = 0; i < 20; i++) {
				var t = performance.now();
				await new Promise(function (res, rej) { var x = new XMLHttpRequest(); x.open("GET", "/tiny?x=" + i + "&r=" + Math.random()); x.onload = res; x.onerror = rej; x.send(); });
				xs.push(performance.now() - t);
			}
			return median(xs);
		});
		await atime("fetchParallel100", async function () {
			var t = performance.now();
			await Promise.all(Array.from({ length: 100 }, function (_, i) { return fetch("/tiny?p=" + i + "&r=" + Math.random()).then(function (r) { return r.text(); }); }));
			return performance.now() - t;
		});
		await atime("downloadMBps", async function () {
			var bytes = 32 * 1024 * 1024;
			var t = performance.now();
			var b = await (await fetch("/dl?bytes=" + bytes + "&r=" + Math.random())).arrayBuffer();
			if (b.byteLength !== bytes) throw new Error("short body " + b.byteLength);
			return bytes / 1048576 / ((performance.now() - t) / 1000);
		});
		await atime("uploadMBps", async function () {
			var bytes = 8 * 1024 * 1024;
			var body = new Uint8Array(bytes);
			var t = performance.now();
			var n = await (await fetch("/up", { method: "POST", body: body })).text();
			if (Number(n) !== bytes) throw new Error("server got " + n);
			return bytes / 1048576 / ((performance.now() - t) / 1000);
		});
		await atime("wsRtt", async function () {
			var ws = new WebSocket("ws://" + location.hostname + ":" + (Number(location.port) + 1) + "/ws");
			await new Promise(function (res, rej) { ws.onopen = res; ws.onerror = rej; });
			var xs = [];
			for (var i = 0; i < 100; i++) {
				var t = performance.now();
				await new Promise(function (res) { ws.onmessage = res; ws.send("ping" + i); });
				xs.push(performance.now() - t);
			}
			var payload = new Uint8Array(64 * 1024);
			var t2 = performance.now();
			var got = 0;
			await new Promise(function (res) {
				ws.onmessage = function () { if (++got === 64) res(); };
				for (var j = 0; j < 64; j++) ws.send(payload);
			});
			R.wsMBps = (64 * 64 * 1024 * 2) / 1048576 / ((performance.now() - t2) / 1000);
			ws.close();
			return median(xs);
		});

		// ---- rewrite throughput: 2.6MB script, unique bytes each time ----
		await atime("bigScript", async function () {
			var xs = [];
			for (var i = 0; i < 3; i++) {
				var t = performance.now();
				await new Promise(function (res, rej) {
					var s = document.createElement("script");
					s.src = "/big.js?n=" + Math.random();
					s.onload = res; s.onerror = rej;
					document.head.appendChild(s);
				});
				xs.push(performance.now() - t);
			}
			return median(xs);
		});
		await atime("bigModule", async function () {
			var t = performance.now();
			await import("/big.mjs?n=" + Math.random());
			return performance.now() - t;
		});
		window.__microDone = true;
	}
	var REPS = Number(new URLSearchParams(location.search).get("reps") || 1);
	addEventListener("load", function () {
		setTimeout(async function () {
			for (var i = 0; i < REPS; i++) { window.__microDone = false; await run(); }
		}, 200);
	});
})();
`;

const MICRO_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>micro</title></head>
<body><h1>runtime microbenchmarks</h1><script>${MICRO_SCRIPT}</script></body></html>`;

export function startLabServer(sampleDir: string, port: number) {
	const assets = buildFixtures(sampleDir);
	const bigJs = fs.readFileSync(path.join(sampleDir, "discord.js"), "utf8");
	const chunk = Buffer.alloc(1 << 20, 97);

	const server = http.createServer((req, res) => {
		const url = new URL(req.url!, "http://x");
		const p = url.pathname;
		const cors = {
			"Access-Control-Allow-Origin": "*",
			"Cache-Control": "no-store",
		};
		if (p === "/micro/") {
			res
				.writeHead(200, { ...cors, "Content-Type": "text/html; charset=utf-8" })
				.end(MICRO_HTML);
			return;
		}
		if (p === "/tiny") {
			res.writeHead(200, { ...cors, "Content-Type": "text/plain" }).end("ok");
			return;
		}
		if (p === "/big.js" || p === "/big.mjs") {
			// unique trailing comment => no proxy can serve it from a content cache
			res.writeHead(200, { ...cors, "Content-Type": "text/javascript" });
			const body =
				p === "/big.mjs"
					? "(function(){" + bigJs + "\n}).call(globalThis);\nexport default 1;"
					: bigJs;
			res.end(body + "\n//" + url.searchParams.get("n"));
			return;
		}
		if (p === "/dl") {
			let left = Number(url.searchParams.get("bytes") ?? 1048576);
			res.writeHead(200, {
				...cors,
				"Content-Type": "application/octet-stream",
				"Content-Length": String(left),
			});
			const pump = () => {
				while (left > 0) {
					const n = Math.min(left, chunk.length);
					left -= n;
					if (!res.write(n === chunk.length ? chunk : chunk.subarray(0, n))) {
						res.once("drain", pump);
						return;
					}
				}
				res.end();
			};
			pump();
			return;
		}
		if (p === "/up") {
			let n = 0;
			req.on("data", (c) => (n += c.length));
			req.on("end", () =>
				res
					.writeHead(200, { ...cors, "Content-Type": "text/plain" })
					.end(String(n))
			);
			return;
		}
		const asset = assets.get(p);
		if (!asset) {
			res.writeHead(404).end("not found");
			return;
		}
		res.writeHead(200, {
			"Content-Type": asset.type,
			"Cache-Control": "no-store",
		});
		res.end(asset.body);
	});

	// websocket echo lives on port+1: libcurl sends "Upgrade: h2c" on plain
	// http requests, which node would route to an upgrade handler on this server
	const wss = new WebSocketServer({ port: port + 1 });
	wss.on("connection", (ws) => {
		if (process.env.WS_DEBUG) console.log("ws conn");
		ws.on("message", (data, isBinary) => {
			if (process.env.WS_DEBUG)
				console.log("ws msg", isBinary, String(data).slice(0, 20));
			ws.send(data, { binary: isBinary });
		});
	});
	server.on("close", () => wss.close());

	return new Promise<http.Server>((resolve) =>
		server.listen(port, () => resolve(server))
	);
}
