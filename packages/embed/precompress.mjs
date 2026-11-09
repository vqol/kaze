// Static file serving with build-time compression.
//
// The build writes brotli 11 and gzip 9 copies of every compressible file,
// named after a hash of the source: <name>.<hash>.br / .gz. A copy is only
// served when its hash matches the file being served, so a stale copy (a
// rebuilt kaze.js, a hand-edited asset) is never sent. Missing copies are made
// on zlib's thread pool, never on the event loop: the first request gets a
// quick brotli 5 version and the brotli 11 one replaces it once it's ready.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";
import { promisify } from "node:util";

const brotli = promisify(zlib.brotliCompress);
const gzip = promisify(zlib.gzip);

export const COMPRESSIBLE = new Set([
	".html",
	".js",
	".mjs",
	".wasm",
	".map",
	".css",
	".svg",
	".json",
]);
const MIN_SIZE = 1024;

export const shouldCompress = (file, size) =>
	size > MIN_SIZE && COMPRESSIBLE.has(path.extname(file));

export const hashOf = (buf) =>
	crypto.createHash("sha256").update(buf).digest("base64url").slice(0, 16);

const brotliAt = (raw, quality) =>
	brotli(raw, {
		params: {
			[zlib.constants.BROTLI_PARAM_QUALITY]: quality,
			[zlib.constants.BROTLI_PARAM_SIZE_HINT]: raw.length,
		},
	});

/**
 * Build step: write <base>.<hash>.br and .gz for one file, removing copies of
 * older versions. Returns false when the file isn't worth compressing.
 */
export async function precompress(file, base = file) {
	const raw = await fs.promises.readFile(file);
	if (!shouldCompress(file, raw.length)) return false;
	const hash = hashOf(raw);
	const prefix = path.basename(base) + ".";
	const dir = path.dirname(base);
	await fs.promises.mkdir(dir, { recursive: true });
	for (const old of await fs.promises.readdir(dir)) {
		if (!old.startsWith(prefix)) continue;
		const rest = old.slice(prefix.length);
		if (/^[\w-]{16}\.(br|gz)$/.test(rest) && !rest.startsWith(hash))
			await fs.promises.rm(path.join(dir, old), { force: true });
	}
	const [br, gz] = await Promise.all([
		fs.promises
			.access(`${base}.${hash}.br`)
			.then(() => null)
			.catch(() => brotliAt(raw, 11)),
		fs.promises
			.access(`${base}.${hash}.gz`)
			.then(() => null)
			.catch(() => gzip(raw, { level: 9 })),
	]);
	if (br) await fs.promises.writeFile(`${base}.${hash}.br`, br);
	if (gz) await fs.promises.writeFile(`${base}.${hash}.gz`, gz);
	return true;
}

const readIfExists = (file) =>
	fs.promises.readFile(file).catch((e) => {
		if (e.code === "ENOENT") return null;
		throw e;
	});

/**
 * Request-time side. `load(file, stat, base)` resolves to
 * { etag, raw, br, gzip }, cached until the file's size or mtime changes.
 * `base` is where precompress() wrote the copies (default: next to the file).
 */
export function createFileCache({ writeMissing = true } = {}) {
	const cache = new Map();

	async function build(file, base) {
		const raw = await fs.promises.readFile(file);
		const hash = hashOf(raw);
		const entry = { etag: `"${hash}"`, raw, br: null, gzip: null };
		if (!shouldCompress(file, raw.length)) return entry;
		const [br, gz] = await Promise.all([
			readIfExists(`${base}.${hash}.br`),
			readIfExists(`${base}.${hash}.gz`),
		]);
		entry.br = br;
		entry.gzip = gz;
		if (!br || !gz) {
			// not built (or built for another version): fast copies now, on the
			// thread pool, and the full-strength ones in the background
			const [fastBr, fastGz] = await Promise.all([
				br ?? brotliAt(raw, 5),
				gz ?? gzip(raw, { level: 6 }),
			]);
			entry.br = fastBr;
			entry.gzip = fastGz;
			void (async () => {
				const [fullBr, fullGz] = await Promise.all([
					br ?? brotliAt(raw, 11),
					gz ?? gzip(raw, { level: 9 }),
				]);
				entry.br = fullBr;
				entry.gzip = fullGz;
				if (!writeMissing) return;
				await fs.promises.mkdir(path.dirname(base), { recursive: true });
				if (!br) await fs.promises.writeFile(`${base}.${hash}.br`, fullBr);
				if (!gz) await fs.promises.writeFile(`${base}.${hash}.gz`, fullGz);
			})().catch(() => {
				// read-only deploy: keep serving from memory
			});
		}
		return entry;
	}

	return function load(file, stat, base = file) {
		const hit = cache.get(file);
		if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size)
			return hit.entry;
		const entry = build(file, base);
		cache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, entry });
		entry.catch(() => cache.delete(file));
		return entry;
	};
}

/** picks the body for a request's Accept-Encoding; sets the headers to match */
export function negotiate(req, entry, headers) {
	const accept = String(req.headers["accept-encoding"] ?? "");
	let body = entry.raw;
	if (entry.br && /\bbr\b/.test(accept)) {
		body = entry.br;
		headers["Content-Encoding"] = "br";
	} else if (entry.gzip && /\bgzip\b/.test(accept)) {
		body = entry.gzip;
		headers["Content-Encoding"] = "gzip";
	}
	headers["Content-Length"] = body.length;
	return body;
}
