import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import http from "http";
import fs from "fs";
import os from "os";
// @ts-expect-error plain js
import { splitLibcurl } from "../../../../../scripts/patch-libcurl.mjs";
import { server as wisp, logging } from "@mercuryworkshop/wisp-js/server";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Resolve paths relative to the package root (runway/)
const packageRoot = path.resolve(__dirname, "../../..");

export const PORT = 4500;
export const WISP_PORT = 4501;

export async function startHarness() {
	const app = express();

	app.use(
		"/kaze",
		express.static(path.join(packageRoot, "node_modules/@kaze/core/dist"))
	);

	app.use(
		"/controller",
		express.static(path.join(packageRoot, "node_modules/@kaze/controller/dist"))
	);

	// the same libcurl build the site and kaze-embed ship: wasm split out of
	// the script (see scripts/patch-libcurl.mjs)
	app.use(
		"/libcurl",
		express.static(
			splitLibcurl(
				path.join(
					packageRoot,
					"node_modules/@mercuryworkshop/libcurl-transport/dist"
				),
				fs.mkdtempSync(path.join(os.tmpdir(), "runway-libcurl-"))
			)
		)
	);

	app.use(express.static(path.join(__dirname, "public")));

	app.listen(PORT, () => {
		console.log(`    Harness server listening on port ${PORT}`);
	});

	const wispServer = http.createServer((req, res) => {
		res.writeHead(200, { "Content-Type": "text/plain" });
		res.end("wisp server");
	});
	wisp.options.allow_private_ips = true;
	wisp.options.allow_loopback_ips = true;
	logging.set_level(logging.NONE);

	wispServer.on("upgrade", (req, socket, head) => {
		wisp.routeRequest(req, socket, head);
	});

	wispServer.listen(WISP_PORT, () => {
		console.log(`    Wisp server listening on port ${WISP_PORT}`);
	});
}
