import { loadScript, registerSw } from "./clientcommon";
import { BootstrapOptions } from "./common";
import type { ProxyTransport } from "@mercuryworkshop/proxy-transports";
import type EpoxyClient from "@mercuryworkshop/epoxy-transport";
import type LibcurlClient from "@mercuryworkshop/libcurl-transport";
import * as ControllerApi from "@kaze/controller";

export async function init(cfg: BootstrapOptions) {
	const sw = await registerSw(cfg.swPath);
	return await loadRest(sw, cfg);
}

export async function loadRest(sw: ServiceWorker, cfg: BootstrapOptions) {
	await loadScript(cfg.kazeBundlePath);
	await loadScript(cfg.kazeControllerApiPath);
	await loadScript(cfg.kazeUtilsBundlePath);

	const resolvedWispPath = `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}${cfg.wispPath}`;

	let transport!: ProxyTransport;
	if (cfg.transport === "epoxy") {
		await loadScript(cfg.epoxyClientPath);
		const EpoxyCtor: typeof EpoxyClient = (window as any).EpoxyTransport
			.EpoxyClient;
		transport = new EpoxyCtor({ wisp: resolvedWispPath });
	} else if (cfg.transport === "libcurl") {
		await loadScript(cfg.libcurlClientPath);
		const LibcurlCtor: typeof LibcurlClient = (window as any).LibcurlTransport
			.LibcurlClient;
		transport = new LibcurlCtor({ wisp: resolvedWispPath });
	} else if (cfg.transport === "bare") {
		throw new Error("Bare transport not implemented yet");
		//...
	}
	const { Controller, config } = (window as any)
		.$kazeController as typeof ControllerApi;
	config.injectPath = cfg.kazeControllerInjectPath;
	config.wasmPath = cfg.kazeWasmPath;
	config.kazePath = cfg.kazeBundlePath;

	const controller = new Controller({
		serviceworker: sw,
		transport,
	});

	return controller;
}
