import { firefox as chromium } from "playwright";
const b = await chromium.launch();
const c = await b.newContext();
const p = await c.newPage();
c.on("response", async (r) => {
	if (r.url().includes("challenge-platform")) {
		const body = await r.text().catch(() => "?");
		console.log(
			r.status(),
			"fromSW=" + r.fromServiceWorker(),
			decodeURIComponent(r.url())
				.replace(/.*\/~\/kz\/[^/]+\/[^/]+\//, "")
				.slice(0, 120),
			"::",
			body.slice(0, 50).replace(/\s+/g, " ")
		);
	}
});
await p.goto("http://localhost:8080/");
await p.waitForFunction(
	() => document.getElementById("status").textContent === "ready",
	null,
	{ timeout: 30000 }
);
await p.fill("#home-input", "https://discord.com/login");
await p.press("#home-input", "Enter");
await p.waitForTimeout(12000);
await b.close();
