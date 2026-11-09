/// <reference lib="WebWorker" />
/// <reference types="@types/serviceworker" />
import { RpcHelper } from "@kaze/rpc";
import type { Controllerbound, SWbound } from "./types";
import type { RawHeaders } from "@mercuryworkshop/proxy-transports";

function makeId(): string {
	return Math.random().toString(36).substring(2, 10);
}

const cookieResolvers: Record<string, (value: void) => void> = {};
addEventListener("message", (e) => {
	if (!e.data) return;
	if (typeof e.data != "object") return;
	// the controller page's keepalive (Controller.startKeepalive): receiving it
	// is the point; it must not touch ports or tabs
	if (e.data.$sw$keepalive) return;
	if (e.data.$sw$setCookieDone && typeof e.data.$sw$setCookieDone == "object") {
		const done = e.data.$sw$setCookieDone;

		const resolver = cookieResolvers[done.id];
		if (resolver) {
			resolver();
			delete cookieResolvers[done.id];
		}
	}

	if (
		e.data.$sw$initRemoteTransport &&
		typeof e.data.$sw$initRemoteTransport == "object"
	) {
		const { port, prefix } = e.data.$sw$initRemoteTransport;

		const relevantcontroller = tabs.find((tab) =>
			new URL(prefix).pathname.startsWith(tab.prefix)
		);
		if (!relevantcontroller) {
			console.error("No relevant controller found for transport init");
			return;
		}
		relevantcontroller.rpc.call("initRemoteTransport", port, [port]);
	}
});

class ControllerReference {
	rpc: RpcHelper<SWbound, Controllerbound>;

	constructor(
		public prefix: string,
		public id: string,
		port: MessagePort
	) {
		this.rpc = new RpcHelper(
			{
				sendSetCookie: async ({ cookies, options }) => {
					const clients = await self.clients.matchAll({
						includeUncontrolled: true,
					});

					// Navigation fetches (document/iframe) deliver cookies via the inject
					// script's embedded cookieJar dump — the destination page doesn't have
					// inject.ts loaded yet to ack, so awaiting would deadlock. Broadcast
					// so any already-loaded clients can update their jars, but don't wait.
					const isNavigation =
						options?.destination === "document" ||
						options?.destination === "iframe";

					// Only the page that made the request has to see the cookies before
					// its fetch()/XHR resolves (document.cookie right after a response).
					// Waiting for "any" client used to resolve on the controller window's
					// ack, which raced the requesting page. Cookies that page can't read
					// (HttpOnly, another host's) can't be observed early, so they don't
					// hold the response either.
					const pageCanRead = options?.visibleToPage !== false;
					let waitFor: Promise<void> | null = null;
					let waitId: string | null = null;
					for (const client of clients) {
						const id = makeId();
						const mustAck =
							!isNavigation &&
							pageCanRead &&
							!!options?.clientId &&
							client.id === options.clientId;
						if (mustAck) {
							waitId = id;
							waitFor = new Promise<void>((resolve) => {
								cookieResolvers[id] = resolve;
							});
						}
						client.postMessage({
							$controller$setCookie: {
								cookies,
								options,
								// only ask for an ack where someone waits for it
								id: mustAck ? id : undefined,
							},
						});
					}

					if (waitFor) {
						let timeoutId: ReturnType<typeof setTimeout> | undefined;
						await Promise.race([
							waitFor,
							new Promise<void>((resolve) => {
								timeoutId = setTimeout(() => {
									console.error(
										"timed out waiting for the requesting page to apply cookies"
									);
									resolve();
								}, 250);
							}),
						]);
						clearTimeout(timeoutId);
						// resolved or abandoned: either way nobody waits any more
						if (waitId) delete cookieResolvers[waitId];
					}
				},
			},
			"tabchannel-" + id,
			(data, transfer) => {
				port.postMessage(data, transfer);
			}
		);
		port.onmessage = (e: MessageEvent) => {
			this.rpc.recieve(e.data);
		};
		port.onmessageerror = console.error;

		this.rpc.call("ready", undefined);
	}
}

const tabs: ControllerReference[] = [];

addEventListener("message", (e) => {
	if (!e.data) return;
	if (typeof e.data != "object") return;
	if (!e.data.$controller$init) return;
	if (typeof e.data.$controller$init != "object") return;
	const init = e.data.$controller$init;

	const existing = tabs.findIndex((t) => t.id === init.id);
	if (existing !== -1) {
		tabs.splice(existing, 1);
	}
	tabs.push(new ControllerReference(init.prefix, init.id, e.ports[0]));
	for (const waiter of tabWaiters.splice(0)) waiter();
});

// Base path every controller prefix lives under (Controller config.prefix).
// Needed because browsers kill idle service workers: after a restart `tabs` is
// empty until the pages answer the revive broadcast, and the fetch that woke
// the worker would otherwise fall through to the network (404).
const prefixBases = ["/~/kz/"];
export function addPrefixBase(base: string) {
	if (!prefixBases.includes(base)) prefixBases.push(base);
}

const tabWaiters: (() => void)[] = [];
let lastRevive = 0;
async function broadcastRevive() {
	// at most one broadcast per second
	if (Date.now() - lastRevive < 1000) return;
	lastRevive = Date.now();
	// the controller page can sit outside a narrowly scoped service worker
	for (const client of await clients.matchAll({ includeUncontrolled: true })) {
		client.postMessage({ $controller$swrevive: {} });
	}
}

async function findTab(pathname: string, timeout = 5000) {
	const deadline = Date.now() + timeout;
	for (;;) {
		const tab = tabs.find((tab) => pathname.startsWith(tab.prefix));
		if (tab) return tab;
		const left = deadline - Date.now();
		if (left <= 0) return undefined;
		void broadcastRevive();
		await new Promise<void>((resolve) => {
			const timer = setTimeout(resolve, Math.min(left, 1000));
			tabWaiters.push(() => {
				clearTimeout(timer);
				resolve();
			});
		});
	}
}

export function shouldRoute(event: FetchEvent): boolean {
	const pathname = new URL(event.request.url).pathname;
	return (
		tabs.some((tab) => pathname.startsWith(tab.prefix)) ||
		prefixBases.some((base) => pathname.startsWith(base))
	);
}

// clients.get is a round trip to the browser process per call. A page's burst
// of subresource requests shares one lookup; the short lifetime keeps the url
// current across pushState.
const CLIENT_LOOKUP_MS = 50;
const clientLookups = new Map<
	string,
	{ at: number; client: Promise<Client | undefined> }
>();
function lookupClient(id: string): Promise<Client | undefined> {
	const now = Date.now();
	const hit = clientLookups.get(id);
	if (hit && now - hit.at < CLIENT_LOOKUP_MS) return hit.client;
	if (clientLookups.size > 64) clientLookups.clear();
	const client = clients.get(id);
	clientLookups.set(id, { at: now, client });
	return client;
}

export async function route(event: FetchEvent): Promise<Response> {
	try {
		const url = new URL(event.request.url);
		const tab = await findTab(url.pathname);
		if (!tab) {
			return new Response(
				"kaze: no controller for this page (was the tab closed?)",
				{ status: 503 }
			);
		}
		const client = await lookupClient(event.clientId);

		const rawheaders: RawHeaders = [...event.request.headers];

		// Firefox doesn't implement Request.body, so forwarding the stream sent
		// every POST/PUT upstream with an empty body (youtube get_watch 400,
		// discord remote-auth ticket exchange). Buffer it instead; works everywhere.
		const method = event.request.method;
		const body: ArrayBuffer | null =
			method === "GET" || method === "HEAD"
				? null
				: await event.request.arrayBuffer();

		const response = await tab.rpc.call(
			"request",
			{
				rawUrl: event.request.url,
				rawReferrer: event.request.referrer,
				destination: event.request.destination,
				mode: event.request.mode,
				referrer: event.request.referrer,
				method: event.request.method,
				body,
				cache: event.request.cache,
				forceCrossOriginIsolated: false,
				initialHeaders: rawheaders,
				rawClientUrl: client ? client.url : undefined,
				clientId: event.clientId || event.resultingClientId,
			},
			body && body.byteLength > 0 ? [body] : undefined
		);

		return new Response(response.body, {
			status: response.status,
			statusText: response.statusText,
			headers: response.headers,
		});
	} catch (e) {
		console.error("Service Worker error:", e);
		return new Response(
			"Internal Service Worker Error: " + (e as Error).message,
			{
				status: 500,
			}
		);
	}
}

addEventListener("install", () => {
	self.skipWaiting();
});

addEventListener("activate", (event: ExtendableEvent) => {
	event.waitUntil(clients.claim());
});

// the only way to know if a service worker has suddenly died is if this code runs again
// notify all clients to send over their messageports again
// (shares broadcastRevive's rate limit: each revive makes the page replace its
// message port, which would drop any request already in flight on the old one)
setTimeout(() => {
	if (tabs.length > 0) return; // a fetch already triggered the revive
	console.log("service worker activated, notifying clients to revive");
	void broadcastRevive();
	// short delay is apparently needed
}, 100);
