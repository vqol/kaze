// The scripts injected into proxied documents and workers. Generated on the
// page thread or in the fetch worker, so nothing here may touch the window.
import type { CookieJar, KazeConfig, KazeInterface } from "@kaze/core";
import type { Config } from "./index";

export function base64Encode(text: string) {
	const bytes = new TextEncoder().encode(text);
	let bin = "";
	for (let i = 0; i < bytes.length; i += 0x8000)
		bin += String.fromCharCode.apply(
			null,
			bytes.subarray(i, i + 0x8000) as unknown as number[]
		);
	return btoa(bin);
}

export function yieldGetInjectScripts(
	config: Config,
	kzconfig: KazeConfig,
	prefix: URL,
	cookieJar: CookieJar,
	codecEncode: (input: string) => string,
	codecDecode: (input: string) => string
) {
	const getInjectScripts: KazeInterface["getInjectScripts"] = (
		meta,
		handler,
		htmlcontext,
		script
	) => {
		// serialized into every page via toString(): must stay self-contained
		function base64Encode(text: string) {
			const bytes = new TextEncoder().encode(text);
			let bin = "";
			for (let i = 0; i < bytes.length; i += 0x8000)
				bin += String.fromCharCode.apply(
					null,
					bytes.subarray(i, i + 0x8000) as unknown as number[]
				);
			return btoa(bin);
		}
		return [
			script(config.kazePath),
			// no wasm script: inject.ts reuses the controller's compiled module
			script(config.injectPath),
			script(
				"data:text/javascript;charset=utf-8;base64," +
					base64Encode(`
					document.querySelectorAll("script[kaze-injected]").forEach(script => script.remove());
					$kazeController.load({
						config: ${JSON.stringify(config)},
						kzconfig: ${JSON.stringify(kzconfig)},
						prefix: new URL("${prefix.href}"),
						cookies: ${JSON.stringify(
							// only this page's host chain: the page jar serves document.cookie;
							// requests and websockets use the controller's jar
							typeof cookieJar.dumpFor === "function"
								? cookieJar.dumpFor(meta.origin)
								: cookieJar.dump()
						)},
						yieldGetInjectScripts: ${yieldGetInjectScripts.toString()},
						codecEncode: ${codecEncode.toString()},
						codecDecode: ${codecDecode.toString()},
						initHeaders: ${JSON.stringify(htmlcontext.headers ?? [])},
						history: ${JSON.stringify(htmlcontext.history ?? [])},
					})
				`)
			),
		];
	};
	return getInjectScripts;
}

export function workerInjectScripts(
	config: Config,
	kzconfig: KazeConfig,
	prefix: string,
	encodeSrc: string,
	decodeSrc: string,
	script: (src: string) => string
): string {
	let str = "";

	str += script(config.kazePath);
	str += script(
		"data:text/javascript;charset=utf-8;base64," +
			base64Encode(`
					(()=>{
						const { KazeClient, CookieJar, setWasm } = $kaze;

						// workers may sync-xhr binary; served from http cache after the first
						const xhr = new XMLHttpRequest();
						xhr.open("GET", ${JSON.stringify(config.wasmPath)}, false);
						xhr.responseType = "arraybuffer";
						xhr.send();
						setWasm(new Uint8Array(xhr.response));

						const kzconfig = ${JSON.stringify(kzconfig)};
						const prefix = new URL("${prefix}", location.href);

						const context = {
							config: kzconfig,
							prefix,
							interface: {
								codecEncode: ${encodeSrc},
								codecDecode: ${decodeSrc},
							},
						};

						const client = new KazeClient(globalThis, {
							context,
							transport: null,
						});

						client.hook();
					})();
					`)
	);

	return str;
}
