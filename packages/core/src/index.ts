// NOTE: this is the entrypoint for kaze.bundle.js
// as such it exports everything in kaze
// the entry point for kaze.all.js (what most sites wil use) is entry.ts

import "./global.d";
import { atob } from "@/shared/snapshot";
import { setWasm } from "@rewriters/wasm";
import { KazeVersionInfo, KazeConfig } from "./types";

declare const VERSION: string;
declare const COMMITHASH: string;
declare const BUILDDATE: string;
export const versionInfo: KazeVersionInfo = {
	version: VERSION,
	build: COMMITHASH,
	date: BUILDDATE,
};

export const defaultConfig: KazeConfig = {
	globals: {
		wrapfn: "$kaze$wrap",
		wrappropertybase: "$kaze__",
		wrappropertyfn: "$kaze$prop",
		cleanrestfn: "$kaze$clean",
		importfn: "$kaze$import",
		rewritefn: "$kaze$rewrite",
		metafn: "$kaze$meta",
		wrappostmessagefn: "$kaze$wrappostmessage",
		pushsourcemapfn: "$kaze$pushsourcemap",
		trysetfn: "$kaze$tryset",
		templocid: "$kaze$temploc",
		tempunusedid: "$kaze$tempunused",
	},
	flags: {
		syncxhr: false,
		disableComputedWrap: false,
		rewriterLogs: false,
		captureErrors: false,
		cleanErrors: false,
		scramitize: false,
		sourcemaps: false,
		destructureRewrites: true,
		allowInvalidJs: true,
		debugTrampolines: false,
		allowFailedIntercepts: false,
		encapsulateWorkers: true,
		debugSourceURL: false,
	},
	siteFlags: {},
	maskedfiles: [],
};

export const defaultConfigDev: KazeConfig = {
	...defaultConfig,
	flags: {
		...defaultConfig.flags,
		rewriterLogs: false,
		captureErrors: true,
		cleanErrors: false,
		debugTrampolines: true,
		debugSourceURL: true,
		allowInvalidJs: false,
	},
};

declare const REWRITERWASM: string | undefined;
// bundled build will have the wasm binary inlined as a base64 string
if (REWRITERWASM) {
	setWasm(Uint8Array.from(atob(REWRITERWASM), (c) => c.charCodeAt(0)));
}

export * from "./symbols";
export * from "./types";
export * from "./Tap";
export * from "./shared";
export * from "./fetch";
export * from "./client";
