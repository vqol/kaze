// Renders compare.ts results into three PNG reports with different styles.
//   node --experimental-strip-types src/bench/charts.ts <results.json> [outDir]
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { buildModel, type Metric } from "./metrics.ts";

const [inFile, outArg] = process.argv.slice(2);
if (!inFile) throw new Error("usage: charts.ts <results.json> [outDir]");
const R = JSON.parse(fs.readFileSync(inFile, "utf8"));
const outDir = path.resolve(
	outArg ?? path.join(path.dirname(inFile), "charts")
);
fs.mkdirSync(outDir, { recursive: true });

const { PROXIES, NAMES, metrics, winners, wins, counted, advantage, groups } =
	buildModel(R);

// ---------- shared bits ----------
const COLORS = {
	light: {
		kaze: "#2a78d6",
		scramjet1: "#eb6834",
		scramjet2: "#1baf7a",
		uv: "#eda100",
		bare: "#9a9890",
	},
	dark: {
		kaze: "#3987e5",
		scramjet1: "#d95926",
		scramjet2: "#199e70",
		uv: "#c98500",
		bare: "#6f6e68",
	},
};
const date = new Date(R.date).toISOString().slice(0, 10);
const testedOn = `${R.wisp && R.wisp.startsWith("ws") ? "Tested through wisp server " + R.wisp.replace(/^wss?:\/\//, "") : "Tested on a local wisp server (wisp-js, same machine)"} · ${R.chrome ? "Chrome " + R.chrome.split(".")[0] : "Chrome"} · ${R.cpu ?? ""} · median of ${R.runs} cold runs per site · ${date}`;
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
const fontLink = `<link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@500;700&display=swap" rel="stylesheet">`;

// ---------- style 1: dark dashboard, small multiples ----------
function dashboard() {
	const C = COLORS.dark;
	const panelMetrics = (g: string) => metrics.filter((m) => m.group === g);
	const panel = (g: string) => {
		const rows = panelMetrics(g)
			.map((m) => {
				const vals = [...PROXIES, "bare"]
					.map((p) => [p, m.get(p)] as const)
					.filter(([, v]) => v != null && v > 0) as [string, number][];
				if (!vals.length) return "";
				const max = Math.max(...vals.map(([, v]) => v));
				const bars = vals
					.map(([p, v]) => {
						const w = Math.max(1.5, (v / max) * 100);
						const win = winners[m.id] === p;
						return `<div class="bar-row${p === "bare" ? " ref" : ""}"><div class="bar" style="width:${w}%;background:${C[p]}"></div><span class="val${win ? " win" : ""}">${m.fmt!(v)}${win ? " ★" : ""}</span></div>`;
					})
					.join("");
				const missing = PROXIES.filter((p) => m.get(p) == null).map(
					(p) => NAMES[p]
				);
				return `<div class="metric"><div class="mlabel">${esc(m.label)} <span class="dir">${m.dir === "lower" ? "lower is better" : "higher is better"}</span></div>${bars}${missing.length ? `<div class="na">not supported / failed: ${missing.join(", ")}</div>` : ""}</div>`;
			})
			.join("");
		const adv = PROXIES.filter((p) => p !== "kaze")
			.map((p) => {
				const a = advantage(p, panelMetrics(g));
				return a == null
					? ""
					: `<span class="chip"><i style="background:${C[p]}"></i>${a >= 1 ? a.toFixed(2) + "× faster" : (1 / a).toFixed(2) + "× slower"} than ${NAMES[p]}</span>`;
			})
			.join("");
		return `<section class="panel"><h2>${g}</h2><div class="chips">${adv}</div>${rows}</section>`;
	};
	const legend = [...PROXIES, "bare"]
		.map(
			(p) =>
				`<span class="lg"><i style="background:${C[p]}"></i>${NAMES[p]}</span>`
		)
		.join("");
	return `<!doctype html><html><head><meta charset="utf-8">${fontLink}<style>
:root{--bg:#0d0e12;--panel:#15171d;--line:#262932;--t1:#f0efec;--t2:#b7b6ae;--t3:#7d7c76}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--t1);font-family:Inter,system-ui,sans-serif;width:1800px;padding:56px}
header{display:flex;justify-content:space-between;align-items:flex-end;margin-bottom:28px}
h1{font-size:44px;margin:0;letter-spacing:-.02em;font-weight:800}h1 b{color:${C.kaze}}
.sub{color:var(--t2);font-size:17px;margin-top:10px}.wisp{display:inline-block;margin-top:14px;padding:7px 14px;border:1px solid #2f5d93;border-radius:999px;color:#9cc4f5;font-size:15px;font-weight:600;background:#13243a}
.score{text-align:right}.score .big{font-size:64px;font-weight:800;line-height:1;color:${C.kaze}}.score .cap{color:var(--t2);font-size:16px}
.legend{display:flex;gap:22px;margin:0 0 26px;font-size:16px;color:var(--t2)}.lg i,.chip i{display:inline-block;width:12px;height:12px;border-radius:3px;margin-right:8px;vertical-align:-1px}
.grid{columns:3;column-gap:22px}.panel{break-inside:avoid;background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:22px 24px;margin-bottom:22px}
h2{margin:0 0 10px;font-size:20px;font-weight:700}.chips{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:12px}.chip{font-size:13px;color:var(--t2);background:#1d2027;border-radius:999px;padding:4px 10px}
.metric{margin:14px 0 4px}.mlabel{font-size:14px;color:var(--t1);margin-bottom:6px;font-weight:500}.dir{color:var(--t3);font-weight:400;font-size:12px;margin-left:6px}
.bar-row{display:flex;align-items:center;gap:10px;height:20px;margin:3px 0}.bar{height:14px;border-radius:0 4px 4px 0}.ref .bar{opacity:.55}
.val{font:500 13px "JetBrains Mono",monospace;color:var(--t2);white-space:nowrap}.val.win{color:var(--t1);font-weight:700}
.na{font-size:12px;color:var(--t3);margin-top:3px}footer{color:var(--t3);font-size:14px;margin-top:8px}
</style></head><body>
<header><div><h1><b>kaze</b> vs Scramjet vs Ultraviolet</h1><div class="sub">Every category of proxy speed: page loads, first paint, startup, request latency, throughput, JS rewriting, runtime hooks, memory.</div>
<div class="wisp">⚡ ${esc(testedOn)}</div></div>
<div class="score"><div class="big">${wins.kaze}/${counted}</div><div class="cap">metrics won by kaze</div></div></header>
<div class="legend">${legend}<span class="lg">★ fastest proxy</span></div>
<div class="grid">${groups.map(panel).join("")}</div>
<footer>Bars scale per metric. "Chrome, no proxy" is the unproxied reference. Every proxy uses the same libcurl transport family, its own local wisp-js server, and identical local + live test sites.</footer>
</body></html>`;
}

// ---------- style 2: light editorial dot plot, relative to kaze ----------
function rel(p: string) {
	const a = advantage(p, metrics);
	if (a == null) return "n/a vs";
	return a >= 1
		? `<b>${a.toFixed(2)}×</b> faster than`
		: `<b>${(1 / a).toFixed(2)}×</b> slower than`;
}
function editorial() {
	const C = COLORS.light;
	const others = [...PROXIES.filter((p) => p !== "kaze"), "bare"];
	// log scale: ratio other/kaze oriented so that >1 = other is slower
	const lo = 1 / 4,
		hi = 40;
	const x = (r: number) =>
		((Math.log(Math.min(hi, Math.max(lo, r))) - Math.log(lo)) /
			(Math.log(hi) - Math.log(lo))) *
		100;
	const ticks = [0.25, 0.5, 1, 2, 4, 10, 40];
	const rows = groups
		.map((g) => {
			const ms_ = metrics.filter((m) => m.group === g);
			const lines = ms_
				.map((m) => {
					const k = m.get("kaze");
					if (k == null) return "";
					const dots = others
						.map((p) => {
							const v = m.get(p);
							if (v == null || v <= 0) return "";
							const r = m.dir === "lower" ? v / k : k / v;
							const clipped = r > hi ? "▶" : r < lo ? "◀" : "";
							return `<span class="dot${p === "bare" ? " ref" : ""}" style="left:${x(r)}%;background:${C[p]}" title="${NAMES[p]}"></span>${clipped ? `<span class="clip" style="left:${x(r)}%">${clipped}</span>` : ""}`;
						})
						.join("");
					const worst = Math.max(
						...PROXIES.filter((p) => p !== "kaze").map((p) => {
							const v = m.get(p);
							return v == null ? 0 : m.dir === "lower" ? v / k : k / v;
						})
					);
					const best = Math.min(
						...PROXIES.filter((p) => p !== "kaze").map((p) => {
							const v = m.get(p);
							return v == null ? Infinity : m.dir === "lower" ? v / k : k / v;
						})
					);
					const note =
						best >= 1
							? `<b class="good">${best.toFixed(best >= 10 ? 0 : 1)}×</b> ahead of next best`
							: `<b class="bad">${(1 / best).toFixed(1)}×</b> behind best`;
					return `<div class="row"><div class="rl">${esc(m.label)}<span class="kv">kaze ${m.fmt!(k)}</span></div><div class="track"><span class="one" style="left:${x(1)}%"></span>${dots}<span class="kz" style="left:${x(1)}%"></span></div><div class="note">${worst > 0 ? note : ""}</div></div>`;
				})
				.join("");
			return `<div class="g"><h3>${g}</h3>${lines}</div>`;
		})
		.join("");
	const legend = others
		.map((p) => `<span><i style="background:${C[p]}"></i>${NAMES[p]}</span>`)
		.join("");
	return `<!doctype html><html><head><meta charset="utf-8">${fontLink}<style>
:root{--bg:#fbfaf7;--t1:#141413;--t2:#55544f;--t3:#8a8983;--rule:#e4e2dc}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--t1);font-family:Inter,system-ui,sans-serif;width:1600px;padding:64px 72px}
.kicker{font-size:14px;letter-spacing:.14em;text-transform:uppercase;color:${C.kaze};font-weight:700}
h1{font-size:46px;line-height:1.08;margin:10px 0 12px;letter-spacing:-.02em;max-width:1200px}
.dek{font-size:19px;color:var(--t2);max-width:1150px;line-height:1.45}.dek b{color:var(--t1)}
.wisp{margin:18px 0 26px;font-size:15px;color:var(--t2);border-left:4px solid ${C.kaze};padding:8px 14px;background:#eef4fc}
.legend{display:flex;gap:26px;font-size:15px;color:var(--t2);margin-bottom:6px;align-items:center}.legend i{display:inline-block;width:12px;height:12px;border-radius:50%;margin-right:8px;vertical-align:-1px}
.axis{position:relative;margin-left:420px;margin-right:220px;height:34px;border-bottom:1px solid var(--rule)}.axis span{position:absolute;bottom:6px;transform:translateX(-50%);font:500 13px "JetBrains Mono",monospace;color:var(--t3)}
.dirs{position:relative;margin-left:420px;margin-right:220px;height:22px;font:600 12px Inter;color:var(--t3);text-transform:uppercase;letter-spacing:.08em}.dirs span{position:absolute;top:5px;white-space:nowrap}
.g h3{font-size:15px;text-transform:uppercase;letter-spacing:.1em;color:var(--t3);margin:22px 0 4px;font-weight:700}
.row{display:grid;grid-template-columns:420px 1fr 220px;align-items:center;height:30px;border-bottom:1px solid #efede7}
.rl{font-size:15px;display:flex;justify-content:space-between;padding-right:18px}.kv{font:500 13px "JetBrains Mono",monospace;color:var(--t3)}
.track{position:relative;height:100%}.one{position:absolute;top:0;bottom:0;width:2px;background:${C.kaze};opacity:.35}
.kz{position:absolute;top:50%;width:14px;height:14px;margin:-7px 0 0 -7px;border-radius:50%;background:${C.kaze};box-shadow:0 0 0 2px var(--bg)}
.dot{position:absolute;top:50%;width:12px;height:12px;margin:-6px 0 0 -6px;border-radius:50%;box-shadow:0 0 0 2px var(--bg)}.dot.ref{width:10px;height:10px;margin:-5px 0 0 -5px;opacity:.8}
.clip{position:absolute;top:50%;transform:translate(6px,-50%);font-size:10px;color:var(--t3)}
.note{font-size:14px;color:var(--t2);padding-left:16px}.good{color:#0b6b46}.bad{color:#b4332f}
footer{margin-top:26px;font-size:13px;color:var(--t3);line-height:1.5}
</style></head><body>
<div class="kicker">Proxy performance report</div>
<h1>${PROXIES.filter((p) => p !== "kaze").every((p) => (advantage(p, metrics) ?? 0) > 1) ? "How much slower is everything else than kaze?" : "kaze vs Scramjet vs Ultraviolet, metric by metric"}</h1>
<div class="dek">Each row is one measurement. The blue dot is kaze, fixed at <b>1×</b>. Dots to the right are proxies that took longer (or moved less data per second); the further right, the slower. Across all ${counted} metrics (geometric mean) kaze is ${rel("uv")} Ultraviolet, ${rel("scramjet1")} Scramjet 1.1 and ${rel("scramjet2")} Scramjet 2.</div>
<div class="wisp"><b>${esc(testedOn)}</b></div>
<div class="legend"><span><i style="background:${C.kaze}"></i>kaze (1×)</span>${legend}</div>
<div class="axis">${ticks.map((t) => `<span style="left:${x(t)}%">${t < 1 ? "1/" + 1 / t : t}×</span>`).join("")}</div>
<div class="dirs"><span style="right:${100 - x(1) + 1.2}%">← faster than kaze</span><span style="left:${x(1) + 1.2}%">slower than kaze →</span></div>
${rows}
<footer>Log scale, ratio = other ÷ kaze (inverted for throughput, so right is always worse). Values beyond 1/4× or 40× are clipped (◀ ▶). "Chrome, no proxy" is the unproxied reference and is excluded from the "next best" column. Missing dots: the proxy could not run that test (e.g. Ultraviolet has no dynamic import support).</footer>
</body></html>`;
}

// ---------- style 3: scorecard ----------
function scorecard() {
	// category score: 100 = best proxy on every metric; geometric mean of best/value
	const score = (p: string, g: string) => {
		const rs: number[] = [];
		for (const m of metrics.filter((m) => m.group === g)) {
			const vals = PROXIES.map((q) => m.get(q)).filter(
				(v): v is number => v != null && v > 0
			);
			const v = m.get(p);
			if (!vals.length) continue;
			if (v == null || v <= 0) {
				rs.push(0.05);
				continue;
			}
			const best = m.dir === "lower" ? Math.min(...vals) : Math.max(...vals);
			rs.push(m.dir === "lower" ? best / v : v / best);
		}
		if (!rs.length) return null;
		return 100 * Math.exp(rs.reduce((a, r) => a + Math.log(r), 0) / rs.length);
	};
	const scores = Object.fromEntries(
		PROXIES.map((p) => [
			p,
			Object.fromEntries(groups.map((g) => [g, score(p, g)])),
		])
	);
	const overall = (p: string) => {
		const xs = groups
			.map((g) => scores[p][g])
			.filter((v): v is number => v != null);
		return Math.exp(
			xs.reduce((a, v) => a + Math.log(Math.max(v, 1)), 0) / xs.length
		);
	};
	// sequential blue ramp for cells (magnitude)
	const ramp = [
		"#0d366b",
		"#104281",
		"#184f95",
		"#1c5cab",
		"#256abf",
		"#2a78d6",
		"#3987e5",
		"#5598e7",
		"#6da7ec",
	];
	const cell = (v: number | null, top: boolean) => {
		if (v == null) return `<td class="na">—</td>`;
		const i = Math.min(
			ramp.length - 1,
			Math.max(0, Math.round((v / 100) * (ramp.length - 1)))
		);
		return `<td style="background:${ramp[i]}"><span>${Math.round(v)}</span>${top ? "<em>best</em>" : ""}</td>`;
	};
	const rows = groups
		.map((g) => {
			const best = Math.max(...PROXIES.map((p) => scores[p][g] ?? 0));
			return `<tr><th>${g}</th>${PROXIES.map((p) => cell(scores[p][g], (scores[p][g] ?? -1) === best)).join("")}</tr>`;
		})
		.join("");
	const hero = (p: string, label: string) => {
		const pl = metrics.filter((m) => m.group === "Page load (cold)");
		const a = advantage(p, pl);
		if (a == null) return "";
		return a >= 1
			? `<div class="hero"><div class="n">${a.toFixed(2)}×</div><div class="c">faster cold page loads than <b>${label}</b></div></div>`
			: `<div class="hero"><div class="n">${(1 / a).toFixed(2)}×</div><div class="c">slower cold page loads than <b>${label}</b></div></div>`;
	};
	const heroRatio = (a: number | null, good: string, bad: string) =>
		a == null
			? ""
			: `<div class="hero"><div class="n">${(a >= 1 ? a : 1 / a).toFixed(1)}×</div><div class="c">${a >= 1 ? good : bad} <b>Ultraviolet</b></div></div>`;
	const rt = advantage(
		"uv",
		metrics.filter((m) => m.group === "Runtime hook overhead")
	);
	const net = advantage(
		"uv",
		metrics.filter(
			(m) => m.group === "Request latency" || m.group === "Throughput"
		)
	);
	return `<!doctype html><html><head><meta charset="utf-8">${fontLink}<style>
*{box-sizing:border-box}body{margin:0;width:1600px;padding:60px;font-family:Inter,system-ui,sans-serif;color:#f3f4f8;background:radial-gradient(1200px 700px at 10% -10%,#1f3b72 0%,transparent 60%),radial-gradient(900px 600px at 110% 0%,#3a1f5c 0%,transparent 55%),#090a10}
.top{display:flex;justify-content:space-between;align-items:flex-start}h1{font-size:52px;margin:0;font-weight:800;letter-spacing:-.03em}h1 span{background:linear-gradient(90deg,#6da7ec,#b7d3f6);-webkit-background-clip:text;color:transparent}
.sub{color:#b9bccb;font-size:18px;margin-top:10px}.badge{margin-top:16px;display:inline-flex;gap:10px;align-items:center;padding:10px 16px;border-radius:12px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.14);font-size:15px;color:#dfe6f5}
.badge b{color:#fff}.pulse{width:9px;height:9px;border-radius:50%;background:#3ddc97;box-shadow:0 0 0 4px rgba(61,220,151,.18)}
.heroes{display:grid;grid-template-columns:repeat(5,1fr);gap:16px;margin:34px 0 30px}.hero{background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.1);border-radius:18px;padding:20px 22px}
.hero .n{font-size:46px;font-weight:800;letter-spacing:-.02em}.hero .c{color:#b9bccb;font-size:15px;margin-top:4px;line-height:1.35}.hero b{color:#fff}
table{width:100%;border-collapse:separate;border-spacing:6px;table-layout:fixed}col.lead{width:300px}th{font-size:16px;font-weight:600;text-align:left;color:#dfe2ec;padding:0 10px;white-space:nowrap}
thead th{font-size:15px;color:#b9bccb;text-align:center;padding-bottom:6px}thead th i{display:block;height:4px;border-radius:2px;margin:8px auto 0;width:60%}
td{height:52px;border-radius:10px;text-align:center;font:700 22px "JetBrains Mono",monospace;color:#fff;position:relative}td em{position:absolute;right:8px;top:6px;font:700 10px Inter;letter-spacing:.08em;text-transform:uppercase;color:#cde2fb}
td.na{background:rgba(255,255,255,.04);color:#6c6f7d}tr.overall th,tr.overall td{font-size:24px}tr.overall td{outline:2px solid rgba(255,255,255,.35)}
.scale{display:flex;align-items:center;gap:10px;color:#9ea2b3;font-size:13px;margin-top:14px}.scale div{display:flex;height:10px;width:260px;border-radius:5px;overflow:hidden}.scale div i{flex:1}
footer{color:#8c90a2;font-size:13px;margin-top:18px;line-height:1.5}
</style></head><body>
<div class="top"><div><h1><span>kaze</span> performance scorecard</h1><div class="sub">Category scores out of 100. 100 means fastest proxy on every metric in that category.</div>
<div class="badge"><span class="pulse"></span><b>Local wisp server</b> · ${esc(testedOn.replace("Tested on a local wisp server (wisp-js, same machine) · ", ""))}</div></div></div>
<div class="heroes">${hero("uv", "Ultraviolet")}${hero("scramjet1", "Scramjet 1.1")}${hero("scramjet2", "Scramjet 2")}
${heroRatio(rt, "less runtime hook overhead than", "more runtime hook overhead than")}
${heroRatio(net, "better request latency + throughput than", "worse request latency + throughput than")}</div>
<table><colgroup><col class="lead">${PROXIES.map(() => "<col>").join("")}</colgroup><thead><tr><th></th>${PROXIES.map((p) => `<th>${NAMES[p]}<i style="background:${COLORS.dark[p]}"></i></th>`).join("")}</tr></thead>
<tbody>${rows}<tr class="overall"><th>Overall</th>${PROXIES.map((p) => cell(overall(p), overall(p) === Math.max(...PROXIES.map(overall)))).join("")}</tr></tbody></table>
<div class="scale">score 0<div>${ramp.map((c) => `<i style="background:${c}"></i>`).join("")}</div>100</div>
<footer>Score per category = 100 × geometric mean over its metrics of (best proxy ÷ this proxy), inverted for throughput; a test the proxy can't run scores 5. Metrics: ${counted} across ${groups.length} categories. Same machine, same Chrome, each proxy with its own local wisp-js server; live sites fetched from the internet through that local wisp server.</footer>
</body></html>`;
}

// ---------- plain style: one column, four tests, 5 labelled bars each ----------
const SHORT: Record<string, string> = {
	kaze: "kaze",
	scramjet1: "Scramjet 1.1",
	scramjet2: "Scramjet 2",
	uv: "Ultraviolet",
	bare: "Chrome (no proxy)",
};
function plain(title: string, tests: [string, string][]) {
	const blocks = tests
		.map(([id, label]) => {
			const m = metrics.find((x) => x.id === id);
			if (!m) throw new Error("unknown metric " + id);
			const order = [...PROXIES, "bare"];
			const max = Math.max(...order.map((p) => m.get(p) ?? 0));
			const rows = order
				.map((p) => {
					const v = m.get(p);
					const name = `<div class="name${p === "kaze" ? " me" : ""}">${SHORT[p]}</div>`;
					if (v == null || v <= 0)
						return `<div class="row">${name}<div class="none">${p === "bare" ? "n/a" : "failed"}</div></div>`;
					return `<div class="row">${name}<div class="track"><div class="bar ${p === "kaze" ? "me" : p === "bare" ? "ref" : ""}" style="width:${(v / max) * 100}%">${m.fmt!(v)}</div></div></div>`;
				})
				.join("");
			return `<section><h2>${esc(label)}</h2>${rows}</section>`;
		})
		.join("");
	const where =
		R.wisp && R.wisp.startsWith("ws")
			? "Tested through " + esc(R.wisp)
			: "Tested on a local wisp server";
	const chrome = R.chrome ? "Chrome " + R.chrome.split(".")[0] : "Chrome";
	return `<!doctype html><html><head><meta charset="utf-8">${fontLink}<style>
*{box-sizing:border-box}html,body{background:#fff}
body{margin:0;width:1200px;padding:72px 80px;color:#000;font-family:Inter,Arial,sans-serif}
h1{font-size:44px;font-weight:800;margin:0;letter-spacing:-.01em}
.sub{font-size:20px;margin-top:12px}
section{margin-top:56px}
h2{font-size:24px;font-weight:700;margin:0 0 16px}
.row{display:grid;grid-template-columns:200px 1fr;align-items:center;height:46px}
.name{font-size:19px}.name.me{font-weight:800}
.track{height:38px}
.bar{height:38px;line-height:38px;padding:0 12px;min-width:max-content;background:#d4d4d0;font-size:19px;font-weight:600;font-variant-numeric:tabular-nums}
.bar.me{background:#5a9df0;font-weight:800}.bar.ref{background:#ececE8}
.none{font-size:19px}
</style></head><body>
<h1>${title}</h1>
<div class="sub">${where} · ${chrome} · shorter is better unless noted</div>
${blocks}
</body></html>`;
}

async function main() {
	const pages: [string, string][] = [
		[
			"kaze-bench-1-page-loads",
			plain("Page load", [
				["load-google", "Google"],
				["load-wikipedia", "Wikipedia"],
				["load-github", "GitHub"],
				["load-heavy-dom", "Heavy page (local test site)"],
			]),
		],
		[
			"kaze-bench-2-network",
			plain("Network", [
				["fetchLatency", "fetch() round trip"],
				["fetchParallel100", "100 parallel requests"],
				["wsRtt", "WebSocket round trip"],
				["downloadMBps", "Download speed (longer is better)"],
			]),
		],
		[
			"kaze-bench-3-runtime",
			plain("Startup, scripts and memory", [
				["boot", "Proxy startup"],
				["bigScript", "Load and rewrite a 2.6 MB script"],
				["setAttribute", "setAttribute()"],
				["heap", "JS memory after a heavy page"],
			]),
		],
	];
	const browser = await chromium.launch({
		// a chromium playwright didn't download, e.g. a preinstalled one
		executablePath: process.env.RUNWAY_CHROMIUM || undefined,
		channel: process.env.RUNWAY_CHANNEL || undefined,
	});
	for (const [name, html] of pages) {
		const htmlPath = path.join(outDir, name + ".html");
		fs.writeFileSync(htmlPath, html);
		// 3x device scale: crisp text and edges when zoomed
		const page = await browser.newPage({
			viewport: { width: 1200, height: 900 },
			deviceScaleFactor: 3,
		});
		await page.goto("file:///" + htmlPath.split(path.sep).join("/"));
		await page.evaluate(() => document.fonts.ready);
		await page.waitForTimeout(300);
		await page.screenshot({
			path: path.join(outDir, name + ".png"),
			fullPage: true,
			type: "png",
		});
		await page.close();
		console.log("wrote", path.join(outDir, name + ".png"));
	}
	await browser.close();
}
main();
