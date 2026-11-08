// Turns compare.ts results into the metric model shared by the PNG charts and
// the benchmark website.
export type Dir = "lower" | "higher";
export type Metric = {
	id: string;
	label: string;
	unit: string;
	dir: Dir;
	get: (p: string) => number | null;
	group: string;
	fmt?: (v: number) => string;
	incomplete?: (p: string) => boolean;
};

export function buildModel(R: any) {
	// ---------- data model ----------

	const PROXIES = ["kaze", "scramjet1", "scramjet2", "uv"].filter((p) =>
		R.proxies.includes(p)
	);
	const NAMES: Record<string, string> = {
		kaze: "kaze",
		scramjet1: "Scramjet 1.1",
		scramjet2: "Scramjet 2 (main)",
		uv: "Ultraviolet 3.2",
		bare: "Chrome, no proxy",
	};
	const num = (v: any) =>
		typeof v === "number" && Number.isFinite(v) ? v : null;
	const load = (t: string, p: string, k: "cold" | "warm", f: string) =>
		num(R.loads?.[t]?.[p]?.[k]?.[f]);
	const micro = (p: string, k: string) => num(R.micro?.[p]?.summary?.[k]);
	const median = (xs: number[]) => {
		const s = xs
			.filter((x) => x != null && Number.isFinite(x))
			.sort((a, b) => a - b);
		if (!s.length) return null;
		const m = s.length >> 1;
		return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
	};
	// a load that rendered well under what plain Chrome renders didn't finish the
	// page; being fast at that can't count as winning
	const incomplete = (t: string, p: string, k: "cold" | "warm") => {
		const els = num(R.loads?.[t]?.[p]?.[k]?.elements);
		const bare = num(R.loads?.[t]?.bare?.[k]?.elements);
		return els != null && bare != null && p !== "bare" && els < bare * 0.95;
	};
	const TARGETS = Object.keys(R.loads);
	const TNAME: Record<string, string> = {
		"heavy-dom": "Heavy DOM page",
		"heavy-js": "JS-heavy SPA",
		wikipedia: "Wikipedia",
		google: "Google",
		github: "GitHub",
	};

	const ms = (v: number) =>
		v >= 1000
			? (v / 1000).toFixed(2) + " s"
			: v < 10
				? v.toFixed(1) + " ms"
				: Math.round(v) + " ms";
	const ns = (v: number) =>
		v >= 1e6
			? (v / 1e6).toFixed(2) + " ms"
			: v >= 1000
				? (v / 1000).toFixed(1) + " µs"
				: Math.round(v) + " ns";
	const mbps = (v: number) =>
		(v >= 100 ? Math.round(v) : v.toFixed(1)) + " MB/s";
	const kb = (v: number) =>
		v >= 1024 ? (v / 1024).toFixed(2) + " MB" : Math.round(v) + " KB";

	const metrics: Metric[] = [
		...TARGETS.map((t) => ({
			id: "load-" + t,
			label: (TNAME[t] ?? t) + " — cold load",
			unit: "ms",
			dir: "lower" as Dir,
			group: "Page load (cold)",
			get: (p: string) => load(t, p, "cold", "load"),
			fmt: ms,
			incomplete: (p: string) => incomplete(t, p, "cold"),
		})),
		...TARGETS.map((t) => ({
			id: "fcp-" + t,
			label: (TNAME[t] ?? t) + " — first paint",
			unit: "ms",
			dir: "lower" as Dir,
			group: "First contentful paint",
			get: (p: string) => load(t, p, "cold", "fcp"),
			fmt: ms,
			incomplete: (p: string) => incomplete(t, p, "cold"),
		})),
		...TARGETS.map((t) => ({
			id: "warm-" + t,
			label: (TNAME[t] ?? t) + " — warm reload",
			unit: "ms",
			dir: "lower" as Dir,
			group: "Warm reload",
			get: (p: string) => load(t, p, "warm", "load"),
			fmt: ms,
			incomplete: (p: string) => incomplete(t, p, "warm"),
		})),
		{
			id: "boot",
			label: "Proxy startup (SW + init)",
			unit: "ms",
			dir: "lower",
			group: "Startup",
			get: (p) => median(TARGETS.map((t) => load(t, p, "cold", "boot")!)),
			fmt: ms,
		},
		{
			id: "fetchLatency",
			label: "fetch() round trip",
			unit: "ms",
			dir: "lower",
			group: "Request latency",
			get: (p) => micro(p, "fetchLatency"),
			fmt: ms,
		},
		{
			id: "xhrLatency",
			label: "XHR round trip",
			unit: "ms",
			dir: "lower",
			group: "Request latency",
			get: (p) => micro(p, "xhrLatency"),
			fmt: ms,
		},
		{
			id: "fetchParallel100",
			label: "100 parallel requests",
			unit: "ms",
			dir: "lower",
			group: "Request latency",
			get: (p) => micro(p, "fetchParallel100"),
			fmt: ms,
		},
		{
			id: "wsRtt",
			label: "WebSocket echo round trip",
			unit: "ms",
			dir: "lower",
			group: "Request latency",
			get: (p) => micro(p, "wsRtt"),
			fmt: ms,
		},
		{
			id: "downloadMBps",
			label: "Download (32 MB)",
			unit: "MB/s",
			dir: "higher",
			group: "Throughput",
			get: (p) => micro(p, "downloadMBps"),
			fmt: mbps,
		},
		{
			id: "uploadMBps",
			label: "Upload (8 MB POST)",
			unit: "MB/s",
			dir: "higher",
			group: "Throughput",
			get: (p) => micro(p, "uploadMBps"),
			fmt: mbps,
		},
		{
			id: "wsMBps",
			label: "WebSocket binary",
			unit: "MB/s",
			dir: "higher",
			group: "Throughput",
			get: (p) => micro(p, "wsMBps"),
			fmt: mbps,
		},
		{
			id: "bigScript",
			label: "Load + rewrite 2.6 MB script",
			unit: "ms",
			dir: "lower",
			group: "JS rewriting",
			get: (p) => micro(p, "bigScript"),
			fmt: ms,
		},
		{
			id: "bigModule",
			label: "Load + rewrite 2.6 MB module",
			unit: "ms",
			dir: "lower",
			group: "JS rewriting",
			get: (p) => micro(p, "bigModule"),
			fmt: ms,
		},
		...(
			[
				["locationHref", "location.href read"],
				["cookieRead", "document.cookie read"],
				["cookieWrite", "document.cookie write"],
				["setAttribute", "setAttribute(href)"],
				["anchorHref", "a.href read"],
				["innerHTMLSet", "innerHTML = 50 elements"],
				["innerHTMLGet", "innerHTML read"],
				["eval", "eval(code)"],
				["newFunction", "new Function(code)"],
				["localStorage", "localStorage set+get"],
				["replaceState", "history.replaceState"],
				["createScript", "script.src = …"],
			] as const
		).map(([k, label]) => ({
			id: k,
			label,
			unit: "ns/op",
			dir: "lower" as Dir,
			group: "Runtime hook overhead",
			get: (p: string) => micro(p, k),
			fmt: ns,
		})),
		{
			id: "heap",
			label: "JS heap after heavy page",
			unit: "MB",
			dir: "lower",
			group: "Memory & size",
			get: (p) => {
				const v = load(TARGETS[0], p, "cold", "heap");
				return v == null ? null : v / 1048576;
			},
			fmt: (v) => v.toFixed(1) + " MB",
		},
		{
			id: "payload",
			label: "Runtime download (gzip)",
			unit: "KB",
			dir: "lower",
			group: "Memory & size",
			get: (p) => (R.sizes?.[p]?.gzip ? R.sizes[p].gzip / 1024 : null),
			fmt: kb,
		},
	];

	// winner per metric among proxies
	const winners: Record<string, string | null> = {};
	for (const m of metrics) {
		let best: string | null = null;
		let bv = 0;
		// nobody wins unopposed (an outage or block can take out the other engines)
		const eligible = PROXIES.filter((p) => {
			const v = m.get(p);
			return v != null && v > 0 && !m.incomplete?.(p);
		});
		if (eligible.length < 2) {
			winners[m.id] = null;
			continue;
		}
		for (const p of PROXIES) {
			const v = m.get(p);
			if (v == null || v <= 0 || m.incomplete?.(p)) continue;
			if (best == null || (m.dir === "lower" ? v < bv : v > bv))
				((best = p), (bv = v));
		}
		winners[m.id] = best;
	}
	const wins = Object.fromEntries(
		PROXIES.map((p) => [p, metrics.filter((m) => winners[m.id] === p).length])
	);
	const counted = metrics.filter((m) => winners[m.id]).length;

	/** geometric-mean ratio (other / kaze, oriented so >1 means kaze is better) over a metric set */
	function advantage(other: string, ms_: Metric[]) {
		const rs: number[] = [];
		for (const m of ms_) {
			const k = m.get("kaze");
			const o = m.get(other);
			if (k == null || o == null || k <= 0 || o <= 0) continue;
			rs.push(m.dir === "lower" ? o / k : k / o);
		}
		if (!rs.length) return null;
		return Math.exp(rs.reduce((a, r) => a + Math.log(r), 0) / rs.length);
	}
	const groups = [...new Set(metrics.map((m) => m.group))];

	return {
		PROXIES,
		NAMES,
		TARGETS,
		metrics,
		winners,
		wins,
		counted,
		advantage,
		groups,
	};
}
