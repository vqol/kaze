// What the site serves, shared by server.mjs and build.mjs.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = (pkg) =>
	path.join(path.dirname(fileURLToPath(import.meta.resolve(pkg))));
const pkgRoot = (name) => path.join(here, "node_modules", name);

export const libcurlDist = dist("@mercuryworkshop/libcurl-transport");
// build.mjs moves libcurl's inline wasm into its own file here (see
// scripts/patch-libcurl.mjs); without a build the inline version is served
export const libcurlSplit = path.join(here, ".libcurl");

/** url prefix -> directory on disk */
export function currentMounts() {
	const libcurl = fs.existsSync(path.join(libcurlSplit, "libcurl.wasm"))
		? libcurlSplit
		: libcurlDist;
	return [
		["/kaze/", path.join(pkgRoot("@kaze/core"), "dist")],
		["/controller/", path.join(pkgRoot("@kaze/controller"), "dist")],
		["/libcurl/", libcurl],
		["/", path.join(here, "public")],
	];
}
export const mounts = currentMounts();

// build.mjs writes the brotli/gzip copies here, never into the packages it serves
export const compressedDir = path.join(here, ".compressed");
export function compressedBase(prefix, dir, file) {
	const mount = prefix === "/" ? "public" : prefix.replace(/\//g, "");
	return path.join(compressedDir, mount, path.relative(dir, file));
}
