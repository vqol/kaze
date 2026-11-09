// Collects everything a website needs into assets/. The libcurl copy here is the
// patched one from this workspace; a pnpm patch doesn't reach package consumers.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { precompress } from "./precompress.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, "assets");
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, "libcurl"), { recursive: true });

const packages = path.resolve(here, "..");
const copy = (from, to) => fs.copyFileSync(from, path.join(out, to));

for (const f of ["kaze.js", "kaze.wasm"])
	copy(path.join(packages, "core/dist", f), f);
for (const name of [
	"api",
	"inject",
	"sw",
	"fetchworker",
	"rewriteworker",
	"transportworker",
])
	copy(
		path.join(packages, "controller/dist", `controller.${name}.js`),
		`controller.${name}.js`
	);
const libcurl = path.dirname(
	fileURLToPath(import.meta.resolve("@mercuryworkshop/libcurl-transport"))
);
copy(path.join(libcurl, "index.js"), "libcurl/index.js");
for (const f of ["kaze-embed.js", "scramjet-compat.js"])
	copy(path.join(here, "src", f), f);

const files = fs
	.readdirSync(out, { recursive: true })
	.map((f) => path.join(out, f))
	.filter((p) => fs.statSync(p).isFile());
const size = files.reduce((sum, p) => sum + fs.statSync(p).size, 0);
// brotli 11 + gzip 9 copies, served by server.mjs instead of compressing per request
await Promise.all(files.map((p) => precompress(p)));
console.log(`assets ready: ${(size / 1048576).toFixed(1)} MB`);
