// Head-to-head benchmark: kaze vs Scramjet (1.1 stable + upstream main) vs
// Ultraviolet vs bare Chrome. Every proxy uses its own LOCAL wisp-js server,
// and every site comes from a local lab server (plus a few live sites).
//
//   node --experimental-strip-types src/bench/compare.ts [options]
//     --runs N          cold page-load runs per target (default 5)
//     --micro N         runtime microbenchmark sessions per proxy (default 3)
//     --only a,b        proxies to run (kaze,scramjet1,scramjet2,uv,bare)
//     --no-live         skip live sites
//     --baseline <dir>  upstream scramjet checkout (default ../kaze-baseline)
//     --proxies <dir>   node_modules with UV / scramjet 1.1 / bare-mux (default ~/tools/proxies/node_modules)
//     --kaze-dir <dir>  root holding core/dist + controller/dist for "kaze" (default: this repo's packages)
//     --before <dir>    same layout; adds a "kaze-before" entry (snapshot of an older build)
//     --targets a,b     only these page-load targets, no in-page tests
//     --no-publish     don't update the benchmark website
//     --label <text>   name this run on the website's history
//     --out <file>
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright";
import { startLabServer } from "./lab.ts";
import { publish } from "./publish.ts";
// @ts-expect-error plain js
import { splitLibcurl } from "../../../../scripts/patch-libcurl.mjs";
import {
	controllerSpec,
	scramjet1Spec,
	startProxyServer,
	uvSpec,
	type ProxySpec,
} from "./proxies.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const runwayRoot = path.resolve(here, "../..");
const repoRoot = path.resolve(runwayRoot, "../..");

const args = process.argv.slice(2);
const arg = (n: string) => {
	const i = args.indexOf(n);
	return i === -1 ? undefined : args[i + 1];
};
const RUNS = Number(arg("--runs") ?? 5);
const MICRO = Number(arg("--micro") ?? 3);
const ONLY = arg("--only")?.split(",");
const LIVE = !args.includes("--no-live");
const BASELINE = path.resolve(
	arg("--baseline") ?? path.join(repoRoot, "../kaze-baseline")
);
const NM = path.resolve(
	arg("--proxies") ?? path.join(os.homedir(), "tools/proxies/node_modules")
);
const NAV_TIMEOUT = 45000;
const LAB = 4600;

const KAZE_DIR = path.resolve(
	arg("--kaze-dir") ?? path.join(repoRoot, "packages")
);
const BEFORE = arg("--before");
const libcurl2 = path.dirname(
	fileURLToPath(import.meta.resolve("@mercuryworkshop/libcurl-transport"))
);
// the libcurl kaze actually serves: the patched build with its wasm split
// out (what the site and kaze-embed ship, see scripts/patch-libcurl.mjs)
const kazeLibcurlDist = splitLibcurl(
	libcurl2,
	fs.mkdtempSync(path.join(os.tmpdir(), "kaze-bench-libcurl-"))
);

const allSpecs: ProxySpec[] = [
	controllerSpec({
		label: "kaze",
		coreDist: path.join(KAZE_DIR, "core/dist"),
		controllerDist: path.join(KAZE_DIR, "controller/dist"),
		libcurlDist: kazeLibcurlDist,
		mount: "/kaze/",
		coreFile: "kaze.js",
		global: "$kazeController",
		workerTransport: true,
	}),
	...(process.env.KAZE_EPOXY
		? [
				controllerSpec({
					label: "kaze-epoxy",
					coreDist: path.join(KAZE_DIR, "core/dist"),
					controllerDist: path.join(KAZE_DIR, "controller/dist"),
					libcurlDist: libcurl2,
					epoxyDist: path.dirname(
						fileURLToPath(
							import.meta.resolve("@mercuryworkshop/epoxy-transport")
						)
					),
					mount: "/kaze/",
					coreFile: "kaze.js",
					global: "$kazeController",
					workerTransport: true,
				}),
			]
		: []),
	...(BEFORE
		? [
				controllerSpec({
					label: "kaze-before",
					coreDist: path.join(BEFORE, "core/dist"),
					controllerDist: path.join(BEFORE, "controller/dist"),
					libcurlDist: libcurl2,
					mount: "/kaze/",
					coreFile: "kaze.js",
					global: "$kazeController",
				}),
			]
		: []),
	scramjet1Spec(NM),
	controllerSpec({
		label: "scramjet2",
		coreDist: path.join(BASELINE, "packages/core/dist"),
		controllerDist: path.join(BASELINE, "packages/controller/dist"),
		libcurlDist: libcurl2,
		mount: "/scramjet/",
		coreFile: "scramjet.js",
		global: "$scramjetController",
	}),
	uvSpec(NM),
];
const specs = allSpecs.filter((s) => !ONLY || ONLY.includes(s.label));
const BARE = !ONLY || ONLY.includes("bare");
const port = (i: number) => 4700 + i * 10;

const FIXTURES = !process.env.BENCH_WISP; // a remote wisp server can't reach localhost
const targets = [
	...(FIXTURES
		? [
				{
					name: "heavy-dom",
					kind: "fixture",
					url: `http://localhost:${LAB}/heavy-dom/`,
				},
				{
					name: "heavy-js",
					kind: "fixture",
					url: `http://localhost:${LAB}/heavy-js/`,
				},
			]
		: []),
	...(LIVE
		? [
				{
					name: "wikipedia",
					kind: "live",
					url: "https://en.wikipedia.org/wiki/Web_browser",
				},
				{ name: "google", kind: "live", url: "https://www.google.com/" },
				{ name: "github", kind: "live", url: "https://github.com/" },
			]
		: []),
];

const ONLY_TARGETS = arg("--targets")?.split(",");
type Sample = {
	wall?: number;
	dcl?: number;
	load?: number;
	fcp?: number;
	boot?: number;
	heap?: number;
	resources?: number;
	elements?: number;
	error?: string;
};

const median = (xs: number[]) => {
	const s = xs
		.filter((x) => typeof x === "number" && Number.isFinite(x))
		.sort((a, b) => a - b);
	if (!s.length) return null;
	const m = s.length >> 1;
	return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const summarize = (xs: Sample[]) => {
	const ok = xs.filter((s) => !s.error);
	const out: any = { n: ok.length, errors: xs.length - ok.length };
	for (const k of [
		"wall",
		"dcl",
		"load",
		"fcp",
		"boot",
		"heap",
		"resources",
		"elements",
	] as const)
		out[k] = median(ok.map((s) => s[k] as number).filter((x) => x > 0));
	return out;
};

async function heapOf(page: Page) {
	const cdp = await page.context().newCDPSession(page);
	await cdp.send("HeapProfiler.collectGarbage").catch(() => {});
	await cdp.send("Performance.enable");
	const { metrics } = await cdp.send("Performance.getMetrics");
	return metrics.find((m) => m.name === "JSHeapUsedSize")?.value;
}

async function openProxy(browser: Browser, origin: string) {
	const ctx = await browser.newContext({
		viewport: { width: 1280, height: 800 },
	});
	const page = await ctx.newPage();
	await page.goto(origin);
	await page.waitForFunction(
		() => (window as any).__benchReady || (window as any).__benchError,
		null,
		{ timeout: 30000 }
	);
	const err = await page.evaluate(() => (window as any).__benchError);
	if (err) throw new Error(err);
	const boot = await page.evaluate(() => (window as any).__bootMs as number);
	const nav = (u: string): Promise<Sample> =>
		page.evaluate(([u, t]) => (window as any).__benchNav(u, t), [
			u,
			NAV_TIMEOUT,
		] as const);
	return { ctx, page, boot, nav };
}

async function proxiedLoads(browser: Browser, origin: string, url: string) {
	const cold: Sample[] = [];
	const warm: Sample[] = [];
	for (let i = 0; i < RUNS; i++) {
		let ctx;
		try {
			const p = await openProxy(browser, origin);
			ctx = p.ctx;
			const s = await p.nav(url);
			s.boot = p.boot;
			if (!s.error) s.heap = await heapOf(p.page);
			cold.push(s);
			warm.push(await p.nav(url));
		} catch (e) {
			cold.push({ error: String(e).slice(0, 200) });
		} finally {
			await ctx?.close();
		}
	}
	return { cold, warm };
}

async function bareLoads(browser: Browser, url: string) {
	const cold: Sample[] = [];
	const warm: Sample[] = [];
	const measure = async (page: Page): Promise<Sample> => {
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
				resources: performance.getEntriesByType("resource").length,
				elements: document.querySelectorAll("*").length,
			};
		}, wall);
	};
	for (let i = 0; i < RUNS; i++) {
		const ctx = await browser.newContext({
			viewport: { width: 1280, height: 800 },
		});
		const page = await ctx.newPage();
		try {
			const s = await measure(page);
			s.heap = await heapOf(page);
			cold.push(s);
			warm.push(await measure(page));
		} catch (e) {
			cold.push({ error: String(e).slice(0, 200) });
		} finally {
			await ctx.close();
		}
	}
	return { cold, warm };
}

const readMicro = (page: Page, inFrame: boolean) =>
	page
		.waitForFunction(
			(inFrame) => {
				const w: any = inFrame
					? (document.getElementById("f") as HTMLIFrameElement).contentWindow
					: window;
				return w && w.__microDone
					? JSON.parse(JSON.stringify(w.__micro))
					: false;
			},
			inFrame,
			{ timeout: 180000, polling: 250 }
		)
		.then((h) => h.jsonValue());

async function microRuns(browser: Browser, origin: string | null) {
	const out: any[] = [];
	for (let i = 0; i < MICRO; i++) {
		let ctx;
		try {
			if (origin) {
				const p = await openProxy(browser, origin);
				ctx = p.ctx;
				await p.nav(`http://localhost:${LAB}/micro/`);
				out.push(await readMicro(p.page, true));
			} else {
				ctx = await browser.newContext();
				const page = await ctx.newPage();
				await page.goto(`http://localhost:${LAB}/micro/`);
				out.push(await readMicro(page, false));
			}
		} catch (e) {
			out.push({ error: String(e).slice(0, 300) });
		} finally {
			await ctx?.close();
		}
	}
	const keys = new Set(out.flatMap((o) => Object.keys(o)));
	const summary: any = {};
	for (const k of keys) {
		if (k.endsWith("_err") || k === "error") {
			summary[k] = out.map((o) => o[k]).find(Boolean);
			continue;
		}
		summary[k] = median(out.map((o) => o[k]));
	}
	return { raw: out, summary };
}

// First-visit bytes: everything a fresh visitor downloads before the first
// proxied page can load, transport included (kaze loads libcurl.js in a worker
// before its first request, so leaving it out made kaze look ~2MB lighter
// than it is). `br` is brotli 11, what kaze's servers send.
function payloadSizes() {
	const read = (f: string) => (fs.existsSync(f) ? fs.readFileSync(f) : null);
	const sum = (fs_: string[]) => {
		const out = { raw: 0, gzip: 0, br: 0 };
		for (const f of fs_) {
			const b = read(f);
			if (!b) continue;
			out.raw += b.length;
			out.gzip += zlib.gzipSync(b).length;
			out.br += zlib.brotliCompressSync(b, {
				params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 },
			}).length;
		}
		return out;
	};
	// a split libcurl build ships its wasm next to the script
	const libcurl = (dir: string, file: string) => [
		`${dir}/${file}`,
		`${dir}/libcurl.wasm`,
	];
	const core = path.join(KAZE_DIR, "core/dist");
	const ctl = path.join(KAZE_DIR, "controller/dist");
	const base = path.join(BASELINE, "packages");
	const nmLibcurl = `${NM}/@mercuryworkshop/libcurl-transport/dist`;
	const kazeRuntime = [
		`${core}/kaze.js`,
		`${core}/kaze.wasm`,
		`${ctl}/controller.api.js`,
		`${ctl}/controller.inject.js`,
		`${ctl}/controller.sw.js`,
		`${ctl}/controller.fetchworker.js`,
		`${ctl}/controller.rewriteworker.js`,
	];
	const kazeLibcurl = libcurl(kazeLibcurlDist, "index.js");
	return {
		kaze: sum([...kazeRuntime, ...kazeLibcurl]),
		// the same split, for comparing against older results
		kazeRuntime: sum(kazeRuntime),
		kazeTransport: sum(kazeLibcurl),
		scramjet2: sum([
			`${base}/core/dist/scramjet.js`,
			`${base}/core/dist/scramjet.wasm`,
			`${base}/controller/dist/controller.api.js`,
			`${base}/controller/dist/controller.inject.js`,
			`${base}/controller/dist/controller.sw.js`,
			...libcurl(libcurl2, "index.js"),
		]),
		scramjet1: sum([
			`${NM}/@mercuryworkshop/scramjet/dist/scramjet.all.js`,
			`${NM}/@mercuryworkshop/scramjet/dist/scramjet.wasm.wasm`,
			...libcurl(nmLibcurl, "index.mjs"),
		]),
		uv: sum([
			...["uv.bundle.js", "uv.client.js", "uv.handler.js", "uv.sw.js"].map(
				(f) => `${NM}/@titaniumnetwork-dev/ultraviolet/dist/${f}`
			),
			...libcurl(nmLibcurl, "index.mjs"),
		]),
	};
}

async function main() {
	const lab = await startLabServer(
		path.join(repoRoot, "packages/core/rewriter/native/sample"),
		LAB
	);
	const servers = await Promise.all(
		specs.map((s, i) => startProxyServer(s, port(i)))
	);
	const browser = await chromium.launch({
		// a chromium playwright didn't download, e.g. a preinstalled one
		executablePath: process.env.RUNWAY_CHROMIUM || undefined,
		channel: process.env.RUNWAY_CHANNEL || undefined,
		headless: process.env.HEADED !== "1",
	});
	const results: any = {
		date: new Date().toISOString(),
		wisp:
			process.env.BENCH_WISP ??
			"local wisp-js server (one per proxy, same machine)",
		chrome: browser.version(),
		cpu: os.cpus()[0]?.model,
		runs: RUNS,
		microSessions: MICRO,
		proxies: [...(BARE ? ["bare"] : []), ...specs.map((s) => s.label)],
		loads: {},
		micro: {},
		sizes: payloadSizes(),
	};
	const out =
		arg("--out") ??
		path.join(
			runwayRoot,
			"bench-results",
			`compare-${results.date.replace(/[:.]/g, "-")}.json`
		);
	fs.mkdirSync(path.dirname(out), { recursive: true });
	const save = () => fs.writeFileSync(out, JSON.stringify(results, null, "\t"));

	for (const [i, s] of [null, ...specs].entries()) {
		if (!FIXTURES || ONLY_TARGETS) break; // microbenchmarks live on the local lab server
		if (!s && !BARE) continue;
		const label = s?.label ?? "bare";
		process.stdout.write(`${label.padEnd(10)} micro ... `);
		results.micro[label] = await microRuns(
			browser,
			s ? `http://localhost:${port(i - 1)}/` : null
		);
		const m = results.micro[label].summary;
		console.log(
			`fetch ${m.fetchLatency?.toFixed(2)}ms  dl ${m.downloadMBps?.toFixed(0)}MB/s  big.js ${m.bigScript?.toFixed(0)}ms  loc ${m.locationHref?.toFixed(0)}ns`
		);
		save();
	}
	for (const t of targets) {
		if (ONLY_TARGETS && !ONLY_TARGETS.includes(t.name)) continue;
		results.loads[t.name] = { url: t.url, kind: t.kind };
		for (const [i, s] of [null, ...specs].entries()) {
			if (!s && !BARE) continue;
			const label = s?.label ?? "bare";
			process.stdout.write(`${label.padEnd(10)} ${t.name.padEnd(10)} ... `);
			const r = s
				? await proxiedLoads(browser, `http://localhost:${port(i - 1)}/`, t.url)
				: await bareLoads(browser, t.url);
			const sum = { raw: r, cold: summarize(r.cold), warm: summarize(r.warm) };
			results.loads[t.name][label] = sum;
			console.log(
				`load ${sum.cold.load?.toFixed(0)}ms fcp ${sum.cold.fcp?.toFixed(0)}ms warm ${sum.warm.load?.toFixed(0)}ms boot ${sum.cold.boot?.toFixed(0) ?? "-"}ms (err ${sum.cold.errors})`
			);
			save();
		}
	}
	await browser.close();
	lab.close();
	for (const s of servers) s.close();
	save();
	console.log(`wrote ${out}`);
	if (!args.includes("--no-publish"))
		publish(results, { label: arg("--label") });
	process.exit(0);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
