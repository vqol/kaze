// What the site serves, shared by server.mjs and build.mjs.
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = (pkg) =>
	path.join(path.dirname(fileURLToPath(import.meta.resolve(pkg))));
const pkgRoot = (name) => path.join(here, "node_modules", name);

// url prefix -> directory on disk
export const mounts = [
	["/kaze/", path.join(pkgRoot("@kaze/core"), "dist")],
	["/controller/", path.join(pkgRoot("@kaze/controller"), "dist")],
	["/libcurl/", dist("@mercuryworkshop/libcurl-transport")],
	["/", path.join(here, "public")],
];

// build.mjs writes the brotli/gzip copies here, never into the packages it serves
export const compressedDir = path.join(here, ".compressed");
export function compressedBase(prefix, file) {
	const dir = mounts.find(([p]) => p === prefix)[1];
	const mount = prefix === "/" ? "public" : prefix.replace(/\//g, "");
	return path.join(compressedDir, mount, path.relative(dir, file));
}
