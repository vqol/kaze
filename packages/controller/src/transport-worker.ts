/// <reference lib="WebWorker" />
// Dedicated worker that hosts a ProxyTransport (libcurl, epoxy, ...) off the
// controller page's main thread. Proxied iframes are same-origin with the
// controller, so they share its main thread: TLS-in-wasm and wisp framing used
// to compete with the page's own parsing and scripts. See worker-transport.ts.
import type { ProxyTransport } from "@mercuryworkshop/proxy-transports";
import type {
	TransportWorkerInbound,
	TransportWorkerOutbound,
	TransportSocketInbound,
	TransportSocketOutbound,
} from "./worker-transport";
import { coalesceStream } from "./stream";
import { importScriptFrom } from "./import-script";

declare const self: DedicatedWorkerGlobalScope;

const SMALL_BODY_BYTES = 64 * 1024;
let transport: ProxyTransport | null = null;
let ready: Promise<void> | null = null;
const aborts = new Map<number, AbortController>();

const post = (msg: TransportWorkerOutbound, transfer: Transferable[] = []) =>
	self.postMessage(msg, transfer);

function resolvePath(path: string): any {
	let obj: any = self;
	for (const key of path.split(".")) obj = obj?.[key];
	return obj;
}

self.onmessage = async (e: MessageEvent<TransportWorkerInbound>) => {
	const msg = e.data;
	switch (msg.type) {
		case "init": {
			ready = (async () => {
				for (const script of msg.scripts) {
					if (msg.module) await import(/* webpackIgnore: true */ script);
					else importScriptFrom(script);
				}
				const ctor = resolvePath(msg.construct);
				if (typeof ctor !== "function")
					throw new Error(
						`transport worker: ${msg.construct} is not a constructor`
					);
				transport = new ctor(msg.options) as ProxyTransport;
				await transport.init();
			})();
			try {
				await ready;
				post({ type: "ready" });
			} catch (err) {
				post({ type: "ready", error: String((err as Error)?.stack ?? err) });
			}
			break;
		}
		case "request": {
			const ctl = new AbortController();
			aborts.set(msg.id, ctl);
			try {
				await ready;
				const r = await transport!.request(
					new URL(msg.remote),
					msg.method,
					msg.body,
					msg.headers,
					ctl.signal
				);
				let body = r.body;
				const transfer: Transferable[] = [];
				// a small body arrives with its headers: a plain buffer skips the
				// chain of transferred streams (worker -> page -> service worker)
				if (body instanceof ReadableStream) {
					const length = r.headers.find(
						([k]) => k.toLowerCase() === "content-length"
					)?.[1];
					if (length !== undefined && Number(length) <= SMALL_BODY_BYTES)
						body = await new Response(body).arrayBuffer();
				}
				if (body instanceof ReadableStream) {
					body = coalesceStream(body);
					transfer.push(body);
				} else if (body instanceof ArrayBuffer) {
					transfer.push(body);
				}
				post(
					{
						type: "response",
						id: msg.id,
						response: {
							body,
							headers: r.headers,
							status: r.status,
							statusText: r.statusText,
						},
					},
					transfer
				);
			} catch (err) {
				post({
					type: "response",
					id: msg.id,
					error: String((err as Error)?.message ?? err),
				});
			} finally {
				aborts.delete(msg.id);
			}
			break;
		}
		case "abort":
			aborts.get(msg.id)?.abort();
			break;
		case "connect": {
			const port = msg.port;
			const send = (
				m: TransportSocketOutbound,
				transfer: Transferable[] = []
			) => port.postMessage(m, transfer);
			try {
				await ready;
				const [sendData, close] = transport!.connect(
					new URL(msg.url),
					msg.protocols,
					msg.headers,
					(protocol, extensions) => send({ t: "open", protocol, extensions }),
					(data) =>
						send(
							{ t: "data", data },
							data instanceof ArrayBuffer ? [data] : []
						),
					(code, reason) => send({ t: "close", code, reason }),
					(error) => send({ t: "error", error: String(error) })
				);
				port.onmessage = (ev: MessageEvent<TransportSocketInbound>) => {
					const d = ev.data;
					if (d.t === "send") sendData(d.data);
					else close(d.code, d.reason);
				};
			} catch (err) {
				send({ t: "error", error: String((err as Error)?.message ?? err) });
			}
			break;
		}
	}
};
