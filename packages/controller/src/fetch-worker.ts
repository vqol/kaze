/// <reference lib="WebWorker" />
// Hosts FetchEngine. kaze.js has to be loaded before the engine's modules
// evaluate (they read the $kaze global), so the engine is required lazily.
import type { EngineToMain, FetchEngine, MainToEngine } from "./fetch-engine";

declare const self: DedicatedWorkerGlobalScope;
declare const require: (id: string) => any;

const post = (m: EngineToMain, t: Transferable[] = []) =>
	self.postMessage(m, t);

let engine: FetchEngine | null = null;
const early: MainToEngine[] = [];
let preloaded: string | null = null;

function handle(msg: MainToEngine) {
	switch (msg.type) {
		case "wasm":
			engine!.setWasm(msg.module);
			break;
		case "port":
			engine!.setPort(msg.port);
			break;
		case "frame":
			engine!.addFrame(msg.prefix);
			break;
		case "cookies":
			engine!.applyCookies(msg.cookies, msg.options);
			engine!.schedulePersist();
			void engine!.propagate(msg.cookies, msg.options);
			break;
		case "main":
			engine!.recieveMain(msg.data);
			break;
	}
}

self.onmessage = (e: MessageEvent<MainToEngine>) => {
	const msg = e.data;
	if (msg.type === "preload") {
		// started as soon as controller.api.js loaded: get the slow part done
		try {
			importScripts(msg.kazeUrl);
			require("./fetch-engine");
			preloaded = msg.kazeUrl;
		} catch {
			// init reports it
		}
		return;
	}
	if (msg.type === "warm-transport") {
		if (preloaded)
			void require("./fetch-engine")
				.startTransport(msg.spec)
				.catch(() => {});
		return;
	}
	if (msg.type !== "init") {
		if (engine) handle(msg);
		else early.push(msg);
		return;
	}
	try {
		if (preloaded !== msg.init.kazeUrl) importScripts(msg.init.kazeUrl);
		const { FetchEngine: Engine } = require("./fetch-engine");
		engine = new Engine(msg.init, post) as FetchEngine;
		for (const m of early.splice(0)) handle(m);
		post({ type: "booted" });
	} catch (err) {
		post({ type: "failed", error: String((err as Error)?.stack ?? err) });
	}
};
