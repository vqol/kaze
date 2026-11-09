// Generates kaze's libcurl.js scheduling patch (patches/@mercuryworkshop__libcurl-transport*.patch).
// libcurl.js drives curl with setInterval(fn, 0), which browsers clamp to 4ms:
// every request completion and every websocket message waited for a 4ms tick
// (100 parallel fetches ~430ms, websocket RTT >= 4ms, ~15MB/s ws throughput).
// The patch runs curl as soon as a wisp packet arrives (coalesced through a
// MessageChannel) and keeps the interval only as a fallback for curl timers.
//
// It also lets libcurl load its wasm as a separate file. Upstream inlines the
// 1.4MB wasm as a base64 data URI (1.9MB of script to download and parse, then
// decode, before compiling can start). With these edits a dist whose data URI is
// replaced by a file name loads that file with WebAssembly.instantiateStreaming,
// resolved next to the script, in a window or a worker. The patched dist still
// works unchanged with the data URI; `--split` produces the separate files.
//
// usage (inside a `pnpm patch` checkout): node scripts/patch-libcurl.mjs <dist file>...
//        node scripts/patch-libcurl.mjs --split <patched dist dir> <out dir>
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const edits = [
	[
		"  const _wisp_connections = {};\n",
		`  const _wisp_connections = {};
  // kaze: event-driven scheduling (see kaze scripts/patch-libcurl.mjs)
  const _kz_kickables = new Set();
  const _kz_deferred = [];
  let _kz_kick_pending = false;
  const _kz_kick_channel = typeof MessageChannel !== "undefined" ? new MessageChannel() : null;
  if (_kz_kick_channel) {
    _kz_kick_channel.port1.onmessage = () => {
      _kz_kick_pending = false;
      for (const run of _kz_deferred.splice(0)) {
        try {
          run();
        } catch (e) {
          console.error(e);
        }
      }
      for (const kick of _kz_kickables) {
        try {
          kick();
        } catch (e) {
          console.error(e);
        }
      }
    };
  }
  function _kz_kick() {
    if (_kz_kick_pending || !_kz_kick_channel) return;
    _kz_kick_pending = true;
    _kz_kick_channel.port2.postMessage(null);
  }
`,
	],
	["    on_ws_msg(event) {\n", "    on_ws_msg(event) {\n      _kz_kick();\n"],
	[
		`      this.event_loop = setInterval(() => {
        this.event_loop_func();
      }, 0);
    }
    event_loop_func() {
      let libcurl_active = _session_get_active(this.session_ptr);
      if (libcurl_active || this.active_requests) {
        _session_perform(this.session_ptr);
      } else {
        clearInterval(this.event_loop);
        this.event_loop = null;
      }
    }`,
		`      this.event_loop = setInterval(() => {
        this.event_loop_func();
      }, 0);
      this._kz_kick = () => {
        if (this.event_loop) this.event_loop_func();
      };
      _kz_kickables.add(this._kz_kick);
    }
    event_loop_func() {
      let libcurl_active = _session_get_active(this.session_ptr);
      if (libcurl_active || this.active_requests) {
        _session_perform(this.session_ptr);
      } else {
        clearInterval(this.event_loop);
        this.event_loop = null;
        _kz_kickables.delete(this._kz_kick);
      }
    }`,
	],
	[
		`          this.recv_loop = setInterval(() => {
            let data = this.recv();
            if (data !== null) this.onmessage(data);
          }, 0);`,
		`          // drain every queued message per tick, not one per 4ms tick
          const drain = () => {
            for (let i = 0; i < 1024; i++) {
              if (!this.connected) {
                _kz_kickables.delete(drain);
                return;
              }
              const buffered = this.recv_buffer.length;
              const data = this.recv();
              if (data !== null) this.onmessage(data);
              else if (this.recv_buffer.length === buffered) return;
            }
          };
          this.recv_loop = setInterval(drain, 0);
          _kz_kickables.add(drain);`,
	],
	// a finished transfer holds its connection until it's removed: waiting on a
	// timer stalled every queued request behind it
	[
		`      setTimeout(() => {
        this.remove_request_now(request_ptr);
      }, 1);`,
		`      if (typeof MessageChannel === "undefined") {
        setTimeout(() => {
          this.remove_request_now(request_ptr);
        }, 1);
        return;
      }
      _kz_deferred.push(() => this.remove_request_now(request_ptr));
      _kz_kick();`,
	],
	// new Response(stream, {status: 304}) throws, which left every 304 hanging
	[
		"if (response_info.status === 204 || response_info.status === 205) {",
		"if (response_info.status === 204 || response_info.status === 205 || response_info.status === 304) {",
	],
	// separate wasm (see --split): start loading at once, like the inline one.
	// Upstream only auto-starts for a data URI and otherwise waits for
	// load_wasm(url), which LibcurlClient never calls.
	[
		"  if (wasmBinaryFile && isDataURI(wasmBinaryFile)) var asm = createWasm();\n",
		"  // kaze: a separate wasm file loads right away too (instantiateStreaming)\n  if (wasmBinaryFile) var asm = createWasm();\n",
	],
	[
		"  if (wasmBinaryFile && isDataURI(wasmBinaryFile)) run();\n",
		"  if (wasmBinaryFile) run();\n",
	],
	[
		"    if (!wasmBinaryFile || !isDataURI(wasmBinaryFile)) {\n      wasmBinaryFile = url;",
		"    if (!wasmBinaryFile) {\n      wasmBinaryFile = url;",
	],
	// resolve the wasm next to this script. A worker's importScripts() has no
	// currentScript and self.location is the worker's own url, so kaze's
	// loaders name the script being imported in self.$kazeImportingScript.
	[
		"    if (ENVIRONMENT_IS_WORKER) {\n      scriptDirectory = self.location.href;\n",
		'    if (ENVIRONMENT_IS_WORKER) {\n      // kaze: importScripts() has no currentScript\n      scriptDirectory = typeof self.$kazeImportingScript == "string" ? self.$kazeImportingScript : self.location.href;\n',
		"index.js",
	],
	// the module build knows its own url, in a window or a worker
	[
		'  var scriptDirectory = "";\n',
		"  var scriptDirectory = import.meta.url;\n",
		"index.mjs",
	],
	[
		"    if (ENVIRONMENT_IS_WORKER) {\n      scriptDirectory = self.location.href;\n",
		"    if (ENVIRONMENT_IS_WORKER) {\n      scriptDirectory = import.meta.url;\n",
		"index.mjs",
	],
];

const DATA_URI =
	/(\n {2}wasmBinaryFile = )"data:application\/octet-stream;base64,([A-Za-z0-9+/=]+)";\n/;
export const WASM_FILE = "libcurl.wasm";

/**
 * Writes index.js and index.mjs from a patched libcurl-transport dist to
 * `outDir` with the inline wasm moved to libcurl.wasm. Returns the out paths.
 */
export function splitLibcurl(distDir, outDir) {
	fs.mkdirSync(outDir, { recursive: true });
	let wasm = null;
	for (const name of ["index.js", "index.mjs"]) {
		const src = fs.readFileSync(path.join(distDir, name), "utf8");
		if (!src.includes("if (wasmBinaryFile) var asm = createWasm();"))
			throw new Error(
				`${name}: not patched for a separate wasm (pnpm install applies kaze's patch)`
			);
		const m = DATA_URI.exec(src);
		if (!m) throw new Error(`${name}: inline wasm not found`);
		const bytes = Buffer.from(m[2], "base64");
		if (wasm && Buffer.compare(wasm, bytes) !== 0)
			throw new Error("index.js and index.mjs inline different wasm");
		wasm = bytes;
		fs.writeFileSync(
			path.join(outDir, name),
			src.replace(DATA_URI, () => `${m[1]}${JSON.stringify(WASM_FILE)};\n`)
		);
	}
	fs.writeFileSync(path.join(outDir, WASM_FILE), wasm);
	for (const extra of ["index.d.ts"]) {
		const from = path.join(distDir, extra);
		if (fs.existsSync(from)) fs.copyFileSync(from, path.join(outDir, extra));
	}
	return outDir;
}

function patchFiles(files) {
	for (const file of files) {
		let src = fs.readFileSync(file, "utf8");
		for (const [from, to, only] of edits) {
			if (only && path.basename(file) !== only) continue;
			if (src.includes(to)) continue;
			const n = src.split(from).length - 1;
			if (n !== 1)
				throw new Error(
					`${file}: expected 1 match, got ${n} for:\n${from.slice(0, 120)}`
				);
			src = src.replace(from, () => to);
		}
		fs.writeFileSync(file, src);
		console.log(`${file}: patched`);
	}
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const args = process.argv.slice(2);
	if (args[0] === "--split") {
		if (args.length !== 3)
			throw new Error("usage: patch-libcurl.mjs --split <dist dir> <out dir>");
		console.log(`libcurl split into ${splitLibcurl(args[1], args[2])}`);
	} else patchFiles(args);
}
