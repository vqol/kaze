#!/usr/bin/env node
// kaze-embed copy <public dir>      put kaze into a static site
// kaze-embed migrate [dir] [--write] move a Scramjet site to kaze
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serviceWorkerSource } from "./server.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const [command, ...rest] = process.argv.slice(2);

function usage() {
	console.log(`usage:
  kaze-embed copy <public dir>        copy kaze into a static site
  kaze-embed migrate [dir] [--write]  move a Scramjet site to kaze (dry run without --write)`);
}

function copy(target) {
	const out = path.resolve(target);
	fs.mkdirSync(out, { recursive: true });
	fs.cpSync(path.join(here, "assets"), path.join(out, "kaze-assets"), {
		recursive: true,
	});
	fs.writeFileSync(path.join(out, "kaze-sw.js"), serviceWorkerSource());
	console.log(
		`added ${path.join(out, "kaze-assets")} and ${path.join(out, "kaze-sw.js")}`
	);
}

const SKIP = new Set(["node_modules", ".git", "dist-types", "kaze-assets"]);
function* walk(dir) {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		if (SKIP.has(entry.name)) continue;
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) yield* walk(full);
		else if (/\.(html?|js|mjs|ts|tsx|jsx|astro|vue|svelte)$/.test(entry.name))
			yield full;
	}
}

function migrate(dir, write) {
	const root = path.resolve(dir);
	const COMPAT = "/kaze-assets/scramjet-compat.js";
	// <script src=".../scramjet.all.js"> and importScripts(".../scramjet.all.js")
	const bundle = /["'`]([^"'`\s]*\/)?scramjet\.(all|bundle)\.js["'`]/g;
	const notes = [];
	let changed = 0;
	for (const file of walk(root)) {
		const text = fs.readFileSync(file, "utf8");
		const rel = path.relative(root, file);
		if (!/scramjet|BareMux/i.test(text)) continue;
		if (/\$scramjetController/.test(text)) {
			notes.push(
				`${rel}: Scramjet 2 code. Left unchanged; it's a few renames, see "From Scramjet 2" in the migration guide.`
			);
			continue;
		}
		let next = text.replace(bundle, (m) => `${m[0]}${COMPAT}${m[0]}`);
		if (next !== text) {
			changed++;
			console.log(`${write ? "updated" : "would update"}  ${rel}`);
			if (write) fs.writeFileSync(file, next);
		}
		if (/\.encodeUrl\s*\(/.test(next))
			notes.push(
				`${rel}: uses encodeUrl(). Switch to frame.go(url); kaze urls belong to a frame.`
			);
		if (/\.addEventListener\(\s*["'`]download["'`]/.test(next))
			notes.push(
				`${rel}: listens for "download" events, which the compatibility layer doesn't send.`
			);
		if (/\bscramjet\.wasm\.js|\.wasm\.wasm/.test(next))
			notes.push(
				`${rel}: references Scramjet's wasm file. It's safe to remove; kaze loads its own.`
			);
	}
	console.log(changed ? "" : "no Scramjet script references found");
	for (const n of notes) console.log("note: " + n);
	if (!write && changed) console.log("dry run. Add --write to apply.");
	console.log(
		"\nnext: serve kaze-assets (see the migration guide), then load your site and test it."
	);
}

if (command === "copy" && rest[0]) copy(rest[0]);
else if (command === "migrate")
	migrate(
		rest.find((a) => !a.startsWith("--")) ?? ".",
		rest.includes("--write")
	);
else usage();
