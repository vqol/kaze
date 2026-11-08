import { firefox as chromium } from "playwright";
const b = await chromium.launch();
// bare chrome
const c1 = await b.newContext();
const p1 = await c1.newPage();
await p1.goto("https://discord.com/login");
await p1.waitForTimeout(10000);
const bare = (await c1.cookies())
	.filter((c) => /discord/.test(c.domain))
	.map((c) => `${c.name}@${c.domain}${c.httpOnly ? " httponly" : ""}`)
	.sort();
console.log("BARE cookies:", bare.join(", "));
// kaze
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
await p2.waitForTimeout(12000);
const jar = await p2.evaluate(
	() =>
		new Promise((res) => {
			const r = indexedDB.open("__kaze_controller", 1);
			r.onsuccess = () => {
				const tx = r.result.transaction("state", "readonly");
				const g = tx.objectStore("state").get("cookies");
				g.onsuccess = () => res(g.result);
				g.onerror = () => res(null);
			};
			r.onerror = () => res(null);
		})
);
let parsed = jar?.cookies;
try {
	parsed = JSON.parse(parsed);
} catch {}
const names = parsed
	? Object.values(parsed)
			.map((c) => `${c.name}@${c.domain}`)
			.sort()
	: [];
console.log(
	"KAZE jar:",
	names.join(", ") || JSON.stringify(jar)?.slice(0, 300)
);
const docCookie = await p2
	.frames()
	.find((f) => f.url().includes("discord"))
	?.evaluate(() => document.cookie);
console.log("KAZE document.cookie:", docCookie);
await b.close();
