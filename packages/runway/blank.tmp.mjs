import { chromium } from "playwright";
const b = await chromium.launch({ channel: "chrome" });
const c = await b.newContext();
const p = await c.newPage();
c.on("response", (r) => {
	if (r.url().includes("blanktest"))
		console.log(
			"  resp",
			r.status(),
			"fromSW=" + r.fromServiceWorker(),
			r.url().slice(-60)
		);
});
await p.goto("http://localhost:8080/");
await p.waitForFunction(
	() => document.getElementById("status").textContent === "ready",
	null,
	{ timeout: 30000 }
);
await p.fill("#home-input", "example.com");
await p.press("#home-input", "Enter");
await p.waitForTimeout(4000);
const f = p.frames().find((f) => f.url().includes("example.com"));
console.log(
	await f.evaluate(async () => {
		const out = { parentControlled: !!navigator.serviceWorker?.controller };
		const ifr = document.createElement("iframe");
		document.body.appendChild(ifr);
		const d = ifr.contentDocument;
		out.blankControlled =
			!!ifr.contentWindow.navigator.serviceWorker?.controller;
		out.blankHasKaze =
			!!ifr.contentWindow.$kaze ||
			Object.getOwnPropertySymbols(ifr.contentWindow).length;
		const s = d.createElement("script");
		s.src = "/blanktest.js";
		d.head.appendChild(s);
		out.scriptSrcAttr = s.getAttribute("src");
		await new Promise((r) => setTimeout(r, 1500));
		return out;
	})
);
await b.close();
