// i am a cat. i like to be petted. i like to be fed. i like to be
import { initSync, Rewriter } from "../../../rewriter/wasm/out/wasm.js";
import type { JsRewriterOutput } from "../../../rewriter/wasm/out/wasm.js";
import { flagEnabled, KazeContext } from "@/shared";

export type { JsRewriterOutput, Rewriter };

import { URLMeta } from "@rewriters/url";
import {
	ArrayBuffer_isView,
	Error,
	isArrayBuffer,
	TextDecoder_decode,
	WebAssembly_Module,
	Uint8Array_ctor,
} from "@/shared/snapshot";

type WasmSource = Uint8Array | ArrayBuffer | WebAssembly.Module;

let wasm_u8: Uint8Array | undefined;
let wasm_module: WebAssembly.Module | undefined;
let wasm_loader: (() => WasmSource) | undefined;
// set once the wasm instance exists; initWasm is called on every rewrite so
// this must stay a cheap early return (compiling the module is tens of ms)
let wasm_ready = false;

/**
 * Provide the rewriter wasm, either as raw bytes or as an already compiled
 * WebAssembly.Module (preferred: modules can be shared between same-origin
 * realms/workers via postMessage and skip recompilation entirely), or as a
 * synchronous loader that returns either, called on the first rewrite: a
 * realm that never rewrites anything never downloads the wasm.
 */
export function setWasm(wasm: WasmSource | (() => WasmSource)) {
	if (wasm_ready) return;
	if (typeof wasm === "function") {
		wasm_loader = wasm;
		wasm_u8 = undefined;
		wasm_module = undefined;
		return;
	}
	wasm_loader = undefined;
	if (ArrayBuffer_isView(wasm)) {
		wasm_u8 = wasm as Uint8Array;
		wasm_module = undefined;
	} else if (isArrayBuffer(wasm)) {
		wasm_u8 = new Uint8Array_ctor(wasm);
		wasm_module = undefined;
	} else {
		wasm_module = wasm as WebAssembly.Module;
		wasm_u8 = undefined;
	}
}

/** The compiled rewriter module, compiling it if needed. */
export function getWasmModule(): WebAssembly.Module {
	if (wasm_module) return wasm_module;
	if (!wasm_u8 && wasm_loader) {
		const load = wasm_loader;
		wasm_loader = undefined;
		setWasm(load());
		if (wasm_module) return wasm_module;
	}
	if (!wasm_u8)
		throw new Error("rewriter wasm not found (was setWasm called?)");

	if (
		wasm_u8[0] !== 0x00 ||
		wasm_u8[1] !== 0x61 ||
		wasm_u8[2] !== 0x73 ||
		wasm_u8[3] !== 0x6d
	)
		throw new Error(
			"rewriter wasm does not have wasm magic (was it fetched correctly?)\nrewriter wasm contents: " +
				TextDecoder_decode(wasm_u8)
		);

	wasm_module = new WebAssembly_Module(wasm_u8 as unknown as BufferSource);
	// the module holds its own copy; drop the bytes
	wasm_u8 = undefined;
	return wasm_module;
}

function initWasm() {
	if (wasm_ready) return;
	initSync({ module: getWasmModule() });
	wasm_ready = true;
}

type RewriterBox = { rewriter: Rewriter; inUse: boolean };
const rewriters: RewriterBox[] = [];
export function getRewriter(
	context: KazeContext,
	meta: URLMeta
): [Rewriter, () => void] {
	initWasm();

	let obj: RewriterBox;
	const index = rewriters.findIndex((x) => !x.inUse);
	const len = rewriters.length;

	if (index === -1) {
		if (flagEnabled("rewriterLogs", context, meta.base))
			dbg.log(`creating new rewriter, ${len} rewriters made already`);

		const rewriter = new Rewriter();
		obj = { rewriter, inUse: false };
		rewriters.push(obj);
	} else {
		obj = rewriters[index];
	}
	obj.inUse = true;

	return [obj.rewriter, () => (obj.inUse = false)];
}
