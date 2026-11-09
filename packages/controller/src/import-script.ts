/// <reference lib="WebWorker" />
/**
 * importScripts() for one script, telling it its own url: workers have no
 * document.currentScript, and self.location is the worker's url, not the
 * script's. kaze's libcurl build reads this to find libcurl.wasm next to
 * itself (see scripts/patch-libcurl.mjs).
 */
export function importScriptFrom(url: string) {
	const scope = self as any;
	scope.$kazeImportingScript = url;
	try {
		importScripts(url);
	} finally {
		delete scope.$kazeImportingScript;
	}
}
