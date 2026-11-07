// Page-load benchmark: proxied loads through one or more builds vs bare Chrome.
//
//   node --experimental-strip-types src/bench/index.ts [options]
//     --runs N            cold runs per target (default 5); warm = 1 extra nav each
//     --only fixtures|live
//     --baseline <root>   also bench an upstream scramjet checkout at <root>
//     --no-bare           skip the no-proxy reference
//     --out <file>        results json (default bench-results/<timestamp>.json)
//   env RUNWAY_CHANNEL=chrome to use installed Chrome.
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium, type Browser } from "playwright";
import { startFixtureServer } from "./fixtures.ts";
import { startBuildServer, type BuildSpec } from "./buildserver.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const runwayRoot = path.resolve(here, "../..");
const repoRoot = path.resolve(runwayRoot, "../..");

const args = process.argv.slice(2);
const arg = (name: string) => {
	const i = args.indexOf(name);
	return i === -1 ? undefined : args[i + 1];
};
const RUNS = Number(arg("--runs") ?? 5);
const ONLY = arg("--only");
const BASELINE = arg("--baseline");
const BARE = !args.includes("--no-bare");
const NAV_TIMEOUT = 45000;

const FIXTURE_PORT = 4600;
const fixtures = ["heavy-js", "heavy-dom"].map((n) => ({
	name: n,
	url: `http://localhost:${FIXTURE_PORT}/${n}/`,
}));
const live = [
	["google", "https://www.google.com/"],
	["wikipedia", "https://en.wikipedia.org/wiki/Web_browser"],
	["youtube", "https://www.youtube.com/"],
	["discord", "https://discord.com/login"],
	["reddit", "https://www.reddit.com/r/programming/"],
].map(([name, url]) => ({ name, url }));
const targets = [
	...(ONLY === "live" ? [] : fixtures.map((t) => ({ ...t, kind: "fixture" }))),
	...(ONLY === "fixtures" ? [] : live.map((t) => ({ ...t, kind: "live" }))),
];

const libcurlDist = path.dirname(
	fileURLToPath(import.meta.resolve("@mercuryworkshop/libcurl-transport"))
);

const builds: BuildSpec[] = [
	{
		label: "kaze",
		coreDist: path.join(repoRoot, "packages/core/dist"),
		controllerDist: path.join(repoRoot, "packages/controller/dist"),
		mount: "/kaze/",
		coreFile: "kaze.js",
		controllerGlobal: "$kazeController",
		prefix: "/~/kz/",
	},
];
if (BASELINE) {
	builds.push({
		label: "baseline",
		coreDist: path.join(BASELINE, "packages/core/dist"),
		controllerDist: path.join(BASELINE, "packages/controller/dist"),
		mount: "/scramjet/",
		coreFile: "scramjet.js",
		controllerGlobal: "$scramjetController",
		prefix: "/~/sj/",
	});
}

type Sample = {
	wall?: number;
	dcl?: number;
	load?: number;
	fcp?: number;
	error?: string;
};

async function proxiedRuns(
	browser: Browser,
	origin: string,
	url: string
): Promise<{ cold: Sample[]; warm: Sample[] }> {
	const cold: Sample[] = [];
	const warm: Sample[] = [];
	for (let i = 0; i < RUNS; i++) {
		// fresh context: new service worker, controller boot, wasm compile
		const ctx = await browser.newContext({
			viewport: { width: 1280, height: 800 },
		});
		const page = await ctx.newPage();
		try {
			await page.goto(origin);
			await page.waitForFunction(
				() => (window as any).__benchReady || (window as any).__benchError,
				null,
				{ timeout: 30000 }
			);
			const err = await page.evaluate(() => (window as any).__benchError);
			if (err) throw new Error(err);
			const nav = (u: string) =>
				page.evaluate(([u, t]) => (window as any).__benchNav(u, t), [
					u,
					NAV_TIMEOUT,
				] as const);
			cold.push(await nav(url));
			// warm: same session, same url again (sw + wasm + connections hot)
			if (i === 0 || i === RUNS - 1) warm.push(await nav(url));
		} catch (e) {
			cold.push({ error: String(e).slice(0, 200) });
		} finally {
			await ctx.close();
		}
	}

	return { cold, warm };
}

async function bareRuns(browser: Browser, url: string) {
	const cold: Sample[] = [];
	const warm: Sample[] = [];
	const measure = async (page: import("playwright").Page): Promise<Sample> => {
		const t0 = Date.now();
		await page.goto(url, { waitUntil: "load", timeout: NAV_TIMEOUT });
		const wall = Date.now() - t0;
		await page.waitForTimeout(500);
		return page.evaluate((wall) => {
			const nav = performance.getEntriesByType(
				"navigation"
			)[0] as PerformanceNavigationTiming;
			const fcp = performance.getEntriesByName("first-contentful-paint")[0];
			return {
				wall,
				dcl: nav?.domContentLoadedEventEnd,
				load: nav?.loadEventEnd,
				fcp: fcp?.startTime,
			};
		}, wall);
	};
	for (let i = 0; i < RUNS; i++) {
		const ctx = await browser.newContext({
			viewport: { width: 1280, height: 800 },
		});
		const page = await ctx.newPage();
		try {
			cold.push(await measure(page));
			if (i === 0 || i === RUNS - 1) warm.push(await measure(page));
		} catch (e) {
			cold.push({ error: String(e).slice(0, 200) });
		} finally {
			await ctx.close();
		}
	}

	return { cold, warm };
}

const median = (xs: number[]) => {
	if (!xs.length) return NaN;
	const s = [...xs].sort((a, b) => a - b);
	const m = s.length >> 1;
	return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const summarize = (samples: Sample[]) => {
	const ok = samples.filter((s) => !s.error && s.load);
	const pick = (k: keyof Sample) =>
		median(
			ok
				.map((s) => s[k] as number)
				.filter((x) => typeof x === "number" && x > 0)
		);
	return {
		n: ok.length,
		errors: samples.length - ok.length,
		wall: pick("wall"),
		dcl: pick("dcl"),
		load: pick("load"),
		fcp: pick("fcp"),
	};
};

async function main() {
	const fixtureServer = await startFixtureServer(
		path.join(repoRoot, "packages/core/rewriter/native/sample"),
		FIXTURE_PORT
	);
	const servers = await Promise.all(
		builds.map((b, i) => startBuildServer(b, libcurlDist, 4610 + i * 10))
	);
	const browser = await chromium.launch({
		channel: process.env.RUNWAY_CHANNEL || undefined,
		headless: process.env.HEADED !== "1",
	});

	const results: any = {
		date: new Date().toISOString(),
		runs: RUNS,
		builds: builds.map((b) => b.label),
		targets: {},
	};
	for (const t of targets) {
		results.targets[t.name] = { url: t.url, kind: t.kind };
		if (BARE) {
			process.stdout.write(`bare     ${t.name} ... `);
			const r = await bareRuns(browser, t.url);
			results.targets[t.name].bare = {
				raw: r,
				cold: summarize(r.cold),
				warm: summarize(r.warm),
			};
			console.log(
				`load ${results.targets[t.name].bare.cold.load.toFixed(0)}ms`
			);
		}
		for (const [i, b] of builds.entries()) {
			process.stdout.write(`${b.label.padEnd(8)} ${t.name} ... `);
			const r = await proxiedRuns(
				browser,
				`http://localhost:${4610 + i * 10}/`,
				t.url
			);
			const s = { raw: r, cold: summarize(r.cold), warm: summarize(r.warm) };
			results.targets[t.name][b.label] = s;
			console.log(`load ${s.cold.load.toFixed(0)}ms (errors ${s.cold.errors})`);
		}
	}
	await browser.close();
	fixtureServer.close();
	for (const s of servers) s.close();

	const outDir = path.join(runwayRoot, "bench-results");
	fs.mkdirSync(outDir, { recursive: true });
	const out =
		arg("--out") ??
		path.join(outDir, `${results.date.replace(/[:.]/g, "-")}.json`);
	fs.writeFileSync(out, JSON.stringify(results, null, "\t"));

	// table: median cold load / fcp per build, and speedup vs baseline
	const cols = [...(BARE ? ["bare"] : []), ...builds.map((b) => b.label)];
	console.log("\nmedian cold load (ms) / FCP (ms); warm load in brackets");
	console.log(
		[
			"target".padEnd(12),
			...cols.map((c) => c.padStart(22)),
			BASELINE ? "  speedup" : "",
		].join("")
	);
	for (const [name, t] of Object.entries<any>(results.targets)) {
		const cell = (c: string) =>
			t[c]
				? `${t[c].cold.load.toFixed(0)}/${t[c].cold.fcp.toFixed(0)} [${t[c].warm.load.toFixed(0)}]`.padStart(
						22
					)
				: "-".padStart(22);
		const speed =
			BASELINE && t.baseline && t.kaze
				? `  ${(t.baseline.cold.load / t.kaze.cold.load).toFixed(2)}x`
				: "";
		console.log([name.padEnd(12), ...cols.map(cell), speed].join(""));
	}
	console.log(`\nwrote ${out}`);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
