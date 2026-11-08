// End-to-end check of both integration paths in a real browser:
// 1. kaze-embed.js with data-kaze  2. an unmodified Scramjet 1.x integration on the compat layer.
import http from "node:http";
import assert from "node:assert";
import { chromium } from "playwright";
import { kaze, serviceWorkerSource } from "../server.mjs";

// the "internet"
const origin = http
	.createServer((req, res) => {
		res.writeHead(200, { "Content-Type": "text/html" });
		res.end(
			`<!doctype html><html><head><title>hello from origin</title></head><body><h1>origin ${req.url}</h1></body></html>`
		);
	})
	.listen(5701);

const pages = {
	"/embed": `<!doctype html><script src="/kaze-assets/kaze-embed.js" defer></script>
		<div id="auto" data-kaze="http://localhost:5701/auto" style="height:400px"></div>`,
	// the Scramjet 1.x docs integration with only the script path swapped
	"/scramjet": `<!doctype html>
		<script src="/kaze-assets/scramjet-compat.js"></script>
		<script src="/baremux/index.js"></script>
		<iframe id="f" style="width:800px;height:400px"></iframe>
		<script>
		(async () => {
			const { ScramjetController } = $scramjetLoadController();
			const scramjet = new ScramjetController({
				files: { wasm: "/scram/scramjet.wasm.wasm", all: "/scram/scramjet.all.js", sync: "/scram/scramjet.sync.js" },
			});
			await scramjet.init();
			await navigator.serviceWorker.register("/sw.js");
			const connection = new BareMux.BareMuxConnection("/baremux/worker.js");
			await connection.setTransport("/libcurl/index.mjs", [{ wisp: "ws://" + location.host + "/wisp/" }]);
			const frame = scramjet.createFrame(document.getElementById("f"));
			window.urlEvents = [];
			frame.addEventListener("urlchange", (e) => window.urlEvents.push(e.url));
			frame.go("http://localhost:5701/scramjet");
		})();
		</script>`,
};
const legacySw = `self.KAZE_ASSETS = "/kaze-assets/";
importScripts("/kaze-assets/scramjet-compat.js");
const { ScramjetServiceWorker } = $scramjetLoadWorker();
const scramjet = new ScramjetServiceWorker();
async function handle(event) {
	await scramjet.loadConfig();
	if (scramjet.route(event)) return scramjet.fetch(event);
	return fetch(event.request);
}
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(clients.claim()));
self.addEventListener("fetch", (event) => event.respondWith(handle(event)));
`;

const proxy = kaze({ allowLoopback: true, allowPrivateIps: true });
const app = http.createServer((req, res) => {
	const url = new URL(req.url, "http://x");
	if (pages[url.pathname])
		return res
			.writeHead(200, { "Content-Type": "text/html" })
			.end(pages[url.pathname]);
	if (url.pathname === "/sw.js")
		return res
			.writeHead(200, { "Content-Type": "text/javascript" })
			.end(legacySw);
	if (url.pathname === "/baremux/index.js")
		return res
			.writeHead(200, { "Content-Type": "text/javascript" })
			.end("window.BareMux = { replaced: true };");
	proxy(req, res);
});
await proxy.attach(app);
await new Promise((r) => app.listen(5700, r));

const browser = await chromium.launch({
	channel: process.env.RUNWAY_CHANNEL || "chrome",
});
const frameTitle = (page, sel) =>
	page.evaluate((s) => {
		const el = document.querySelector(s);
		try {
			return el.contentWindow.document.title;
		} catch (e) {
			return String(e);
		}
	}, sel);
const waitTitle = async (page, sel) => {
	for (let i = 0; i < 100; i++) {
		if ((await frameTitle(page, sel)) === "hello from origin") return;
		await page.waitForTimeout(100);
	}
	assert.fail(`no proxied page in ${sel}: "${await frameTitle(page, sel)}"`);
};

// 1. one script tag and one attribute
{
	const ctx = await browser.newContext();
	const page = await ctx.newPage();
	page.on("pageerror", (e) => console.log("pageerror", String(e)));
	await page.goto("http://localhost:5700/embed");
	await waitTitle(page, "#auto iframe");
	const scope = await page.evaluate(
		async () => (await navigator.serviceWorker.getRegistration("/~/kz/")).scope
	);
	assert.ok(
		scope.endsWith("/~/kz/"),
		"service worker stays on the proxy's own path"
	);
	const controlled = await page.evaluate(
		() => navigator.serviceWorker.controller === null
	);
	assert.ok(
		controlled,
		"the host page is not controlled by the service worker"
	);
	console.log("ok  data-kaze embed");

	// the script api, and navigating
	const url = await page.evaluate(async () => {
		const box = document.createElement("div");
		box.id = "api";
		box.style.height = "300px";
		document.body.append(box);
		const b = await Kaze.mount(box, { url: "http://localhost:5701/first" });
		const seen = [];
		b.onUrlChange((u) => seen.push(u));
		await new Promise((r) => setTimeout(r, 1500));
		b.go("http://localhost:5701/second");
		await new Promise((r) => setTimeout(r, 1500));
		return { current: b.url, seen };
	});
	assert.equal(url.current, "http://localhost:5701/second");
	assert.ok(
		url.seen.includes("http://localhost:5701/second"),
		JSON.stringify(url)
	);
	console.log("ok  Kaze.mount, go, onUrlChange");
	await ctx.close();
}

// 2. Scramjet site with the script path swapped
{
	const ctx = await browser.newContext();
	const page = await ctx.newPage();
	page.on("pageerror", (e) => console.log("pageerror", String(e)));
	await page.goto("http://localhost:5700/scramjet");
	await waitTitle(page, "#f");
	const events = await page.evaluate(() => window.urlEvents);
	assert.ok(
		events.includes("http://localhost:5701/scramjet"),
		JSON.stringify(events)
	);
	console.log("ok  Scramjet 1.x integration on the compatibility layer");
	await ctx.close();
}

await browser.close();
origin.close();
app.close();
console.log("all passed");
process.exit(0);
