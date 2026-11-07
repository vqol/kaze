// Deterministic local "sites" built from real-world bundles, so proxy load
// cost can be measured without network noise.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const PNG_1PX = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
	"base64"
);

type Asset = { type: string; body: string | Buffer };

function heavyDom(): string {
	// ~ a long article/listing page: lots of attributes, links, inline handlers
	// and inline scripts, which is what the html rewriter spends its time on
	const rows: string[] = [];
	for (let i = 0; i < 1500; i++) {
		rows.push(
			`<article class="card c${i % 7}" data-id="${i}" style="background:url(/heavy-dom/img/${i % 40}.png) no-repeat">` +
				`<a href="/heavy-dom/item/${i}?ref=list&amp;p=${i % 13}" title="item ${i}" onclick="window.__clicks=(window.__clicks||0)+1">` +
				`<img src="/heavy-dom/img/${i % 40}.png" srcset="/heavy-dom/img/${i % 40}.png 1x, /heavy-dom/img/${(i + 1) % 40}.png 2x" alt="" loading="lazy" width="1" height="1"></a>` +
				`<h3 onmouseover="this.dataset.h=1">Item ${i}</h3><p>Lorem ipsum dolor sit amet, consectetur adipiscing elit ${i}.</p>` +
				`<form action="/heavy-dom/buy" method="post"><input type="hidden" name="id" value="${i}"><button formaction="/heavy-dom/buy/${i}">Buy</button></form>` +
				`</article>`
		);
		if (i % 75 === 0) {
			rows.push(
				`<script>(function(){var x=${i};var a=[];for(var j=0;j<50;j++){a.push({k:"v"+j,u:location.href,d:document.title})}window.__inline=(window.__inline||0)+a.length+x})();</script>`
			);
		}
	}

	return `<!doctype html><html><head><meta charset="utf-8"><title>heavy-dom</title>
<link rel="stylesheet" href="/heavy-dom/a.css"><link rel="stylesheet" href="/heavy-dom/b.css">
<style>@import url("/heavy-dom/c.css"); .hero{background-image:url('/heavy-dom/img/1.png')}</style>
<script src="/sample/discord.js"></script>
</head><body><header class="hero"><h1>heavy-dom</h1></header><main>${rows.join("\n")}</main></body></html>`;
}

function heavyJs(): string {
	return `<!doctype html><html><head><meta charset="utf-8"><title>heavy-js</title>
<script src="/sample/google.js"></script>
<script src="/sample/discord.js"></script>
<script type="module" src="/heavy-js/main.mjs"></script>
<link rel="stylesheet" href="/heavy-dom/a.css">
</head><body><div id="root">loading</div></body></html>`;
}

function css(n: number): string {
	const rules: string[] = [];
	for (let i = 0; i < 400; i++)
		rules.push(
			`.c${i % 7} .x${n}-${i}{background:url("/heavy-dom/img/${i % 40}.png");border:1px solid #${(i * 997).toString(16).padStart(6, "0").slice(0, 6)}}`
		);
	return rules.join("\n");
}

export function buildFixtures(sampleDir: string): Map<string, Asset> {
	const assets = new Map<string, Asset>();
	const js = "text/javascript; charset=utf-8";
	assets.set("/heavy-dom/", {
		type: "text/html; charset=utf-8",
		body: heavyDom(),
	});
	assets.set("/heavy-js/", {
		type: "text/html; charset=utf-8",
		body: heavyJs(),
	});
	for (const f of ["discord.js", "google.js"])
		assets.set(`/sample/${f}`, {
			type: js,
			body: fs.readFileSync(path.join(sampleDir, f), "utf8"),
		});
	assets.set("/heavy-dom/a.css", { type: "text/css", body: css(1) });
	assets.set("/heavy-dom/b.css", { type: "text/css", body: css(2) });
	assets.set("/heavy-dom/c.css", { type: "text/css", body: css(3) });
	for (let i = 0; i < 40; i++)
		assets.set(`/heavy-dom/img/${i}.png`, { type: "image/png", body: PNG_1PX });

	// a small module graph with a dynamic import and a fetch, like an SPA boot
	const mods: string[] = [];
	for (let i = 0; i < 12; i++) {
		assets.set(`/heavy-js/m${i}.mjs`, {
			type: js,
			body:
				`export const v${i} = ${i};\n` +
				`export function f${i}(x){ const o = { a: x, b: [${Array.from({ length: 200 }, (_, j) => j).join(",")}] }; return o.b.reduce((s, n) => s + n, x); }\n`,
		});
		mods.push(`import { f${i} } from "./m${i}.mjs";`);
	}
	assets.set("/heavy-js/main.mjs", {
		type: js,
		body:
			mods.join("\n") +
			`\nconst data = await (await fetch("/heavy-js/data.json")).json();\n` +
			`const lazy = await import("./m0.mjs");\n` +
			`document.getElementById("root").textContent = "ready " + data.items.length + " " + ${Array.from({ length: 12 }, (_, i) => `f${i}(1)`).join("+")} + lazy.v0;\n`,
	});
	assets.set("/heavy-js/data.json", {
		type: "application/json",
		body: JSON.stringify({
			items: Array.from({ length: 2000 }, (_, i) => ({ id: i, name: "n" + i })),
		}),
	});

	return assets;
}

export function startFixtureServer(sampleDir: string, port: number) {
	const assets = buildFixtures(sampleDir);
	const server = http.createServer((req, res) => {
		const url = new URL(req.url!, "http://x");
		const asset = assets.get(url.pathname);
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

	return new Promise<http.Server>((resolve) =>
		server.listen(port, () => resolve(server))
	);
}
