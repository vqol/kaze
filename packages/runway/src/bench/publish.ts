// Publishes benchmark results to the website (packages/site/public/benchmarks).
// compare.ts calls this after every run; a partial run (--only kaze) replaces
// just the engines it measured.
//
//   node --experimental-strip-types src/bench/publish.ts <results.json> [--label text] [--reset]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildModel } from "./metrics.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const runwayRoot = path.resolve(here, "../..");
const SITE_DATA = path.resolve(runwayRoot, "../site/public/benchmarks/data");
const MERGED = path.join(runwayRoot, "bench-results/latest-merged.json");
const MAX_HISTORY = 200;

function stripRaw(run: any) {
	const out = structuredClone(run);
	for (const t of Object.values<any>(out.loads ?? {}))
		for (const v of Object.values<any>(t))
			if (v && typeof v === "object") delete v.raw;
	for (const v of Object.values<any>(out.micro ?? {})) delete v.raw;
	return out;
}

function merge(prev: any | null, run: any) {
	if (!prev) {
		const first = stripRaw(run);
		first.ranAt = Object.fromEntries(
			run.proxies.map((p: string) => [p, run.date])
		);
		return first;
	}
	const next = structuredClone(prev);
	const clean = stripRaw(run);
	for (const p of run.proxies) {
		if (clean.micro?.[p]) next.micro[p] = clean.micro[p];
		if (clean.sizes?.[p]) next.sizes[p] = clean.sizes[p];
		for (const [t, v] of Object.entries<any>(clean.loads ?? {})) {
			next.loads[t] ??= { url: v.url, kind: v.kind };
			if (v[p]) next.loads[t][p] = v[p];
		}
		if (!next.proxies.includes(p)) next.proxies.push(p);
		(next.ranAt ??= {})[p] = run.date;
	}
	Object.assign(next, {
		date: run.date,
		chrome: run.chrome,
		cpu: run.cpu,
		runs: run.runs,
	});
	return next;
}

/** 100 = fastest engine on every metric; a test an engine can't run counts as 0.05 */
function categoryScores(model: ReturnType<typeof buildModel>, proxy: string) {
	const out: Record<string, number> = {};
	for (const g of model.groups) {
		const rs: number[] = [];
		for (const m of model.metrics.filter((x) => x.group === g)) {
			const vals = model.PROXIES.filter((q) => !m.incomplete?.(q))
				.map((q) => m.get(q))
				.filter((v): v is number => v != null && v > 0);
			if (!vals.length) continue;
			const v = m.get(proxy);
			if (v == null || v <= 0) {
				rs.push(0.05);
				continue;
			}
			const best = m.dir === "lower" ? Math.min(...vals) : Math.max(...vals);
			rs.push(Math.min(1, m.dir === "lower" ? best / v : v / best));
		}
		if (rs.length)
			out[g] =
				100 * Math.exp(rs.reduce((a, r) => a + Math.log(r), 0) / rs.length);
	}
	return out;
}
const overall = (scores: Record<string, number>) => {
	const xs = Object.values(scores);
	return xs.length
		? Math.exp(xs.reduce((a, v) => a + Math.log(Math.max(v, 1)), 0) / xs.length)
		: 0;
};

function siteData(merged: any) {
	const model = buildModel(merged);
	const engines = [...model.PROXIES, "bare"];
	const NAME: Record<string, string> = {
		...model.NAMES,
		bare: "Chrome (no proxy)",
		scramjet2: "Scramjet 2",
		uv: "Ultraviolet",
	};
	const scores = Object.fromEntries(
		model.PROXIES.map((p) => [p, categoryScores(model, p)])
	);
	return {
		updated: merged.date,
		conditions: {
			wisp: merged.wisp,
			chrome: merged.chrome,
			cpu: merged.cpu,
			runs: merged.runs,
			microSessions: merged.microSessions,
		},
		ranAt: merged.ranAt ?? {},
		engines: engines.map((id) => ({
			id,
			name: NAME[id] ?? id,
			reference: id === "bare",
		})),
		overall: Object.fromEntries(
			model.PROXIES.map((p) => [p, overall(scores[p])])
		),
		wins: model.wins,
		totalMetrics: model.counted,
		categories: model.groups.map((g) => ({
			name: g,
			scores: Object.fromEntries(
				model.PROXIES.map((p) => [p, scores[p][g] ?? null])
			),
			metrics: model.metrics
				.filter((m) => m.group === g)
				.map((m) => ({
					id: m.id,
					label: m.label,
					better: m.dir,
					winner: model.winners[m.id],
					values: Object.fromEntries(
						engines.map((p) => {
							const v = m.get(p);
							return [
								p,
								v != null && v > 0
									? {
											v,
											text: m.fmt!(v),
											incomplete: m.incomplete?.(p) || undefined,
										}
									: null,
							];
						})
					),
				})),
		})),
	};
}

export function publish(
	run: any,
	opts: { label?: string; reset?: boolean } = {}
) {
	fs.mkdirSync(SITE_DATA, { recursive: true });
	const historyFile = path.join(SITE_DATA, "history.json");
	if (opts.reset) {
		fs.rmSync(MERGED, { force: true });
		fs.rmSync(historyFile, { force: true });
	}
	const prev = fs.existsSync(MERGED)
		? JSON.parse(fs.readFileSync(MERGED, "utf8"))
		: null;
	if (prev && prev.wisp !== run.wisp) {
		console.log(
			`not published: run used "${run.wisp}", the site tracks "${prev.wisp}"`
		);
		return;
	}
	const merged = merge(prev, run);
	fs.writeFileSync(MERGED, JSON.stringify(merged));
	const data = siteData(merged);
	fs.writeFileSync(path.join(SITE_DATA, "latest.json"), JSON.stringify(data));

	const history = fs.existsSync(historyFile)
		? JSON.parse(fs.readFileSync(historyFile, "utf8"))
		: [];
	history.push({
		date: run.date,
		label: opts.label,
		overall: data.overall,
		wins: data.wins,
		kaze: Object.fromEntries(
			data.categories.flatMap((c: any) =>
				c.metrics.map((m: any) => [m.id, m.values.kaze?.v ?? null])
			)
		),
	});
	fs.writeFileSync(historyFile, JSON.stringify(history.slice(-MAX_HISTORY)));
	console.log(
		`published to site: kaze ${data.overall.kaze.toFixed(0)} overall, ${data.wins.kaze}/${data.totalMetrics} wins`
	);
}

if (
	process.argv[1] &&
	path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	const args = process.argv.slice(2);
	const flag = (n: string) =>
		args.includes(n) ? args[args.indexOf(n) + 1] : undefined;
	const run = JSON.parse(fs.readFileSync(args[0], "utf8"));
	publish(run, { label: flag("--label"), reset: args.includes("--reset") });
}
