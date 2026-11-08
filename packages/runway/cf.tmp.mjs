import { chromium } from "playwright";
const b = await chromium.launch({ channel: "chrome" });
const paths = [
	"/cdn-cgi/challenge-platform/scripts/jsd/main.js",
	"/cdn-cgi/challenge-platform/scripts/jsd/main.js?ray=a56f5b1ecd6d9b32",
];
const probe = (f) =>
	f.evaluate(async (paths) => {
		const out = [];
		for (const p of paths) {
			try {
				const r = await fetch(p);
				const t = await r.text();
				out.push(
					`${r.status} redirected=${r.redirected} final=${decodeURIComponent(r.url).slice(-110)} len=${t.length} :: ${t.slice(0, 60).replace(/\s+/g, " ")}`
				);
			} catch (e) {
				out.push(`ERR ${p} ${e.message}`);
			}
		}
		return out;
	}, paths);
const c1 = await b.newContext();
const p1 = await c1.newPage();
await p1.goto("https://discord.com/login");
await p1.waitForTimeout(3000);
console.log("BARE:\n " + (await probe(p1.mainFrame())).join("\n "));
const c2 = await b.newContext();
const p2 = await c2.newPage();
await p2.goto("http://localhost:8080/");
await p2.waitForFunction(
	() => document.getElementById("status").textContent === "ready",
	null,
	{ timeout: 30000 }
);
await p2.fill("#home-input", "https://discord.com/login");
await p2.press("#home-input", "Enter");
await p2.waitForTimeout(8000);
console.log(
	"KAZE:\n " +
		(await probe(p2.frames().find((f) => f.url().includes("discord")))).join(
			"\n "
		)
);
await b.close();
