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

						// fetched on the first rewrite instead of at startup: most workers
						// never rewrite anything. That runs after client.hook() (with page
						// code around), so take the native XHR and the url now. Workers
						// may sync-xhr binary; served from http cache after the first.
						const wasmUrl = new URL(${JSON.stringify(config.wasmPath)}, location.href).href;
						const apply = Reflect.apply;
						const XHR = XMLHttpRequest;
						const U8 = Uint8Array;
						const xhrOpen = XHR.prototype.open;
						const xhrSend = XHR.prototype.send;
						const setResponseType = Object.getOwnPropertyDescriptor(XHR.prototype, "responseType").set;
						const getResponse = Object.getOwnPropertyDescriptor(XHR.prototype, "response").get;
						setWasm(() => {
							const xhr = new XHR();
							apply(xhrOpen, xhr, ["GET", wasmUrl, false]);
							apply(setResponseType, xhr, ["arraybuffer"]);
							apply(xhrSend, xhr, []);
							return new U8(apply(getResponse, xhr, []));
						});

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
