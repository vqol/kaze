/// <reference lib="WebWorker" />
// Rewrites scripts and stylesheets off the main thread (see rewrite-pool.ts).
// Loads kaze.js itself and instantiates the controller's compiled wasm.
import type {
	RewriteJob,
	RewriteResult,
	RewriteWorkerMessage,
} from "./rewrite-pool";

declare const self: DedicatedWorkerGlobalScope;
declare const $kaze: any;

let kazeConfig: any;
let codec: {
	codecEncode: (s: string) => string;
	codecDecode: (s: string) => string;
};
const contexts = new Map<string, any>();

function contextFor(prefixHref: string) {
	let context = contexts.get(prefixHref);
	if (!context) {
		context = {
			config: kazeConfig,
			prefix: new URL(prefixHref),
			interface: codec,
		};
		contexts.set(prefixHref, context);
	}
	return context;
}

function run(job: RewriteJob): RewriteResult {
	const context = contextFor(job.prefix);
	const meta = {
		origin: new URL(job.meta.origin),
		base: new URL(job.meta.base),
		referrerPolicy: job.meta.referrerPolicy,
		topFrameName: job.meta.topFrameName,
		parentFrameName: job.meta.parentFrameName,
	};
	if (job.kind === "js") {
		return {
			id: job.id,
			output: $kaze.rewriteJs(job.input, job.url, context, meta, job.isModule),
		};
	}
	return {
		id: job.id,
		output: $kaze.rewriteCss(job.input, context, meta),
	};
}

self.onmessage = (e: MessageEvent<RewriteWorkerMessage>) => {
	const msg = e.data;
	if (msg.type === "init") {
		importScripts(msg.kazeUrl);
		$kaze.setWasm(msg.module);
		kazeConfig = msg.config;
		const fn = (src: string) => new Function(`return (${src})`)();
		codec = {
			codecEncode: fn(msg.encode),
			codecDecode: fn(msg.decode),
		};
		return;
	}
	try {
		const result = run(msg.job) as { id: number; output: Uint8Array | string };
		self.postMessage(
			result,
			result.output instanceof Uint8Array ? [result.output.buffer] : []
		);
	} catch {
		// hand the input back; the main thread runs the normal path
		const input = msg.job.input;
		self.postMessage(
			{ id: msg.job.id, failed: true, input } satisfies RewriteResult,
			input instanceof Uint8Array ? [input.buffer] : []
		);
	}
};
