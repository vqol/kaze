import "./style.css";
import LibcurlClient from "@mercuryworkshop/libcurl-transport";
import EpoxyClient from "@mercuryworkshop/epoxy-transport";
import { defaultConfigDev, versionInfo } from "@kaze/core";
import { Controller, type Frame } from "@kaze/controller";
import { CatchEscapedLinksPlugin, UrlWatcherPlugin } from "@kaze/utils";
import {
	SEARCH_ENGINES,
	load,
	normalizeWisp,
	save,
	type Settings,
} from "./settings";
import { Wire, diffHeaders, kindOf, type WireEntry } from "./wire";

const BASE = import.meta.env.BASE_URL;
const settings = load();
const $ = <T extends HTMLElement>(id: string) =>
	document.getElementById(id) as T;

function h<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	attrs: Record<string, string> | null = null,
	...children: (Node | string | null | undefined | false)[]
): HTMLElementTagNameMap[K] {
	const el = document.createElement(tag);
	if (attrs) for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
	for (const child of children) if (child) el.append(child);
	return el;
}

// ---------- boot ----------

const readout = $("readout");
const wisp = (() => {
	try {
		return new URL(settings.wisp).host;
	} catch {
		return settings.wisp;
	}
})();
function setState(state: string, failed = false) {
	readout.textContent = `${settings.transport} · ${wisp} · ${state}`;
	readout.classList.toggle("failed", failed);
}
setState("starting");
$("version").textContent = `v${versionInfo.version} · ${versionInfo.build}`;

const frameEl = $<HTMLIFrameElement>("frame");
const wire = new Wire();
let frame: Frame | undefined;

const ready = boot().then(
	() => setState("ready"),
	(err) => {
		setState(`failed: ${err?.message ?? err}`, true);
		console.error(err);
		throw err;
	}
);

async function boot() {
	if (!("serviceWorker" in navigator))
		throw new Error("this browser has no service workers");
	const registration = await navigator.serviceWorker.register(`${BASE}sw.js`, {
		updateViaCache: "none",
	});
	await navigator.serviceWorker.ready;
	if (!navigator.serviceWorker.controller)
		await new Promise((resolve) =>
			navigator.serviceWorker.addEventListener("controllerchange", resolve, {
				once: true,
			})
		);

	const transport =
		settings.transport === "epoxy"
			? new EpoxyClient({ wisp: settings.wisp })
			: new LibcurlClient({ wisp: settings.wisp });
	const controller = new Controller({
		serviceworker: navigator.serviceWorker.controller ?? registration.active!,
		transport,
		kazeConfig: defaultConfigDev,
		config: {
			prefix: `${BASE}~/kz/`,
			kazePath: `${BASE}kaze/kaze.js`,
			injectPath: `${BASE}controller/controller.inject.js`,
			wasmPath: `${BASE}kaze/kaze.wasm`,
		},
	});
	await controller.wait();
	frame = controller.createFrame(frameEl, {
		plugins: [
			wire,
			new UrlWatcherPlugin((url) => showUrl(url)),
			// a link that would leave the proxy comes back here instead
			new CatchEscapedLinksPlugin(
				(url) =>
					new URL(`${BASE}?goto=${encodeURIComponent(url.href)}`, location.origin)
			),
		],
	});
}

// ---------- navigation ----------

const address = $<HTMLInputElement>("address");
const progress = $("progress");

function toUrl(input: string): string | null {
	const q = input.trim();
	if (!q) return null;
	if (/^https?:\/\//i.test(q)) return q;
	// example.com, localhost:8080, 10.0.0.1/x: a host, optional port and path
	const host = /^(localhost|[\w-]+(\.[\w-]+)*\.[a-z]{2,}|\d{1,3}(\.\d{1,3}){3})(:\d+)?([/?#]\S*)?$/i;
	if (host.test(q)) return (/^(localhost|[\d.]+)[:/]?/i.test(q) ? "http://" : "https://") + q;
	return SEARCH_ENGINES[settings.search] + encodeURIComponent(q);
}

function showUrl(url: string) {
	if (document.activeElement !== address) address.value = url;
}

async function go(input: string) {
	const url = toUrl(input);
	if (!url) return;
	document.body.classList.add("browsing");
	address.value = url;
	address.blur();
	progress.className = "";
	void progress.offsetWidth;
	progress.className = "on";
	await ready;
	frame!.go(url);
}

frameEl.addEventListener("load", () => {
	progress.className = "done";
});

for (const id of ["home-form", "bar-form"]) {
	const form = $<HTMLFormElement>(id);
	form.addEventListener("submit", (e) => {
		e.preventDefault();
		go(form.querySelector("input")!.value);
	});
}

$("mark").addEventListener("click", () => {
	document.body.classList.remove("browsing");
	frameEl.src = "about:blank";
	$<HTMLInputElement>("home-input").value = "";
	$("home-input").focus();
});
$("back").addEventListener("click", () => frame?.back());
$("forward").addEventListener("click", () => frame?.forward());
$("reload").addEventListener("click", () => frame?.reload());

addEventListener("keydown", (e) => {
	const typing = (e.target as HTMLElement).closest("input, textarea");
	if (e.key === "/" && !typing) {
		e.preventDefault();
		(document.body.classList.contains("browsing")
			? address
			: $("home-input")
		).focus();
	}
	if (e.key === "Escape") {
		if (!settingsDialog.hidden) closeSettings();
		else if (selected !== undefined) select(undefined);
	}
});

const goto = new URLSearchParams(location.search).get("goto");
if (goto) {
	history.replaceState(null, "", location.pathname);
	go(goto);
}

// ---------- the wire ----------

const wireToggle = $("wire-toggle");
const wireCount = $("wire-count");
const list = $("wire-list");
const detail = $("wire-detail");
const filter = $<HTMLInputElement>("wire-filter");
let selected: number | undefined;
let stickToBottom = true;

wireToggle.addEventListener("click", () => {
	const open = document.body.classList.toggle("wire-open");
	wireToggle.setAttribute("aria-pressed", String(open));
	if (open) render();
});
$("wire-clear").addEventListener("click", () => {
	select(undefined);
	wire.clear();
});
filter.addEventListener("input", () => render());
list.addEventListener("scroll", () => {
	stickToBottom = list.scrollTop + list.clientHeight >= list.scrollHeight - 4;
});
list.addEventListener("click", (e) => {
	const row = (e.target as HTMLElement).closest<HTMLElement>("[data-id]");
	if (row) select(Number(row.dataset.id));
});
wire.subscribe(() => {
	wireCount.textContent = String(wire.entries.length);
	if (document.body.classList.contains("wire-open")) render();
});

function ms(entry: WireEntry) {
	if (entry.cached) return "cache";
	if (entry.ms === undefined) return "…";
	return entry.ms < 1000 ? `${Math.round(entry.ms)}` : `${(entry.ms / 1000).toFixed(1)}s`;
}

function statusClass(status?: number) {
	if (!status) return "pending";
	if (status >= 400) return "error";
	if (status >= 300) return "redirect";
	return "";
}

function changes(entry: WireEntry) {
	let n = 0;
	for (const [a, b] of [
		[entry.requestFromPage, entry.requestSent],
		[entry.responseFromServer, entry.responseToPage],
	] as const) {
		if (!a || !b) continue;
		for (const d of diffHeaders(a, b)) if (d.kind !== "same") n++;
	}
	return n;
}

function render() {
	if (selected !== undefined) return renderDetail();
	const q = filter.value.trim().toLowerCase();
	const rows = wire.entries.filter((e) => !q || e.url.href.toLowerCase().includes(q));
	list.replaceChildren(
		...rows.map((e) => {
			const path = e.url.pathname + e.url.search;
			return h(
				"button",
				{ class: "row", "data-id": String(e.id), type: "button" },
				h("span", { class: `status ${statusClass(e.status)}` }, String(e.status ?? "")),
				h("span", { class: "kind" }, kindOf(e)),
				h(
					"span",
					{ class: "where" },
					e.method !== "GET" ? h("b", null, e.method + " ") : null,
					h("span", { class: "host" }, e.url.host),
					h("span", { class: "path" }, path === "/" ? "" : path)
				),
				h("span", { class: `ms${e.cached ? " cached" : ""}` }, ms(e))
			);
		})
	);
	if (!rows.length)
		list.append(
			h(
				"p",
				{ class: "empty" },
				wire.entries.length
					? "nothing matches"
					: "requests show up here as the page loads"
			)
		);
	if (stickToBottom) list.scrollTop = list.scrollHeight;
}

function select(id: number | undefined) {
	selected = id;
	document.body.classList.toggle("wire-detail", id !== undefined);
	if (id === undefined) {
		detail.replaceChildren();
		render();
	} else renderDetail();
}

function headerTable(title: string, from: string, to: string, a?: [string, string][], b?: [string, string][]) {
	const section = h("section", null, h("h3", null, title));
	if (!a || !b) {
		section.append(h("p", { class: "dim" }, "not available yet"));
		return section;
	}
	const diff = diffHeaders(a, b);
	const changed = diff.filter((d) => d.kind !== "same").length;
	section.append(
		h(
			"p",
			{ class: changed ? "summary changed" : "summary" },
			changed
				? `kaze changed ${changed} header${changed === 1 ? "" : "s"} between ${from} and ${to}`
				: `passed through unchanged from ${from} to ${to}`
		)
	);
	const table = h("dl", null);
	for (const d of diff) {
		const sign = { same: "", added: "+", removed: "−", changed: "~" }[d.kind];
		table.append(
			h("dt", { class: d.kind }, h("span", { class: "sign" }, sign), d.name),
			h(
				"dd",
				{ class: d.kind },
				d.kind === "changed"
					? h("span", null, h("s", null, d.before!), h("br"), d.after!)
					: (d.after ?? d.before)!
			)
		);
	}
	section.append(table);
	return section;
}

function renderDetail() {
	const e = wire.entries.find((x) => x.id === selected);
	if (!e) return select(undefined);
	const n = changes(e);
	detail.replaceChildren(
		h(
			"header",
			null,
			h("button", { class: "back", type: "button", "aria-label": "Back to the list" }, "←"),
			h("span", { class: `status ${statusClass(e.status)}` }, `${e.status ?? "…"} ${e.statusText ?? ""}`),
			h("span", { class: "dim" }, `${e.method} · ${kindOf(e)} · ${ms(e)}${e.cached ? "" : " ms"}`)
		),
		h("p", { class: "url" }, e.url.href),
		e.cached
			? h("p", { class: "summary changed" }, "served from kaze's http cache, no network request")
			: h("p", { class: n ? "summary changed" : "summary" }, n ? `${n} header changes in total` : "kaze changed nothing on this request"),
		headerTable("request headers", "the page", "the server", e.requestFromPage, e.requestSent),
		headerTable("response headers", "the server", "the page", e.responseFromServer, e.responseToPage)
	);
	detail.querySelector(".back")!.addEventListener("click", () => select(undefined));
}

// ---------- settings ----------

const settingsDialog = $("settings");
const settingsForm = $<HTMLFormElement>("settings-form");
const settingsError = $("settings-error");

function openSettings() {
	(settingsForm.elements.namedItem("wisp") as HTMLInputElement).value = settings.wisp;
	for (const name of ["transport", "search"] as const)
		for (const input of settingsForm.querySelectorAll<HTMLInputElement>(`[name=${name}]`))
			input.checked = input.value === settings[name];
	settingsError.textContent = "";
	settingsDialog.hidden = false;
	(settingsForm.elements.namedItem("wisp") as HTMLInputElement).focus();
}
function closeSettings() {
	settingsDialog.hidden = true;
}

$("settings-toggle").addEventListener("click", () =>
	settingsDialog.hidden ? openSettings() : closeSettings()
);
readout.addEventListener("click", openSettings);
$("settings-cancel").addEventListener("click", closeSettings);
settingsDialog.addEventListener("click", (e) => {
	if (e.target === settingsDialog) closeSettings();
});
settingsForm.addEventListener("submit", (e) => {
	e.preventDefault();
	const data = new FormData(settingsForm);
	try {
		const next: Settings = {
			wisp: normalizeWisp(String(data.get("wisp"))),
			transport: data.get("transport") === "epoxy" ? "epoxy" : "libcurl",
			search: (String(data.get("search")) in SEARCH_ENGINES
				? data.get("search")
				: "duckduckgo") as Settings["search"],
		};
		save(next);
		location.reload();
	} catch (err: any) {
		settingsError.textContent = err?.message ?? String(err);
	}
});
