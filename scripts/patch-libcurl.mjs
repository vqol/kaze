// Generates kaze's libcurl.js scheduling patch (patches/@mercuryworkshop__libcurl-transport*.patch).
// libcurl.js drives curl with setInterval(fn, 0), which browsers clamp to 4ms:
// every request completion and every websocket message waited for a 4ms tick
// (100 parallel fetches ~430ms, websocket RTT >= 4ms, ~15MB/s ws throughput).
// The patch runs curl as soon as a wisp packet arrives (coalesced through a
// MessageChannel) and keeps the interval only as a fallback for curl timers.
//
// usage (inside a `pnpm patch` checkout): node scripts/patch-libcurl.mjs <dist file>...
import fs from "node:fs";

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
];

for (const file of process.argv.slice(2)) {
	let src = fs.readFileSync(file, "utf8");
	for (const [from, to] of edits) {
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
