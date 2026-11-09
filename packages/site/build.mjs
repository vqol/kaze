// Compresses everything server.mjs serves (brotli 11 + gzip 9), once, instead
// of per request. Re-run after rebuilding kaze; until then the server notices
// the changed files and compresses them in the background.
import fs from "node:fs";
import path from "node:path";
import { precompress } from "../embed/precompress.mjs";
import { mounts, compressedBase } from "./mounts.mjs";

const started = Date.now();
let count = 0;
const jobs = [];
for (const [prefix, dir] of mounts) {
	for (const rel of fs.readdirSync(dir, { recursive: true })) {
		const file = path.join(dir, rel);
		// source maps only load with devtools open: compressed on demand
		if (!fs.statSync(file).isFile() || file.endsWith(".map")) continue;
		jobs.push(
			precompress(file, compressedBase(prefix, file)).then((done) => {
				if (done) count++;
			})
		);
	}
}
await Promise.all(jobs);
console.log(
	`precompressed ${count} files in ${((Date.now() - started) / 1000).toFixed(1)}s`
);
