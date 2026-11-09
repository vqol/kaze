// A few workers that rewrite large scripts and stylesheets. Proxied pages are
// same-origin with the controller and share its main thread, so rewriting
// there stalls the very page being loaded; here it also runs in parallel.
import type { RewriteOffload, URLMeta } from "@kaze/core";

export type RewriteJob = {
	id: number;
	kind: "js" | "css";
	input: Uint8Array | string;
	url: string;
	prefix: string;
	isModule: boolean;
	meta: {
		origin: string;
		base: string;
		referrerPolicy?: string;
		topFrameName?: string;
		parentFrameName?: string;
	};
};

export type RewriteResult =
	| { id: number; output: Uint8Array | string; failed?: undefined }
	| { id: number; failed: true; input: Uint8Array | string };

/** what a worker sends back: a result, or that it finished booting */
export type RewriteWorkerReply = RewriteResult | { ready: true };

export type RewriteWorkerMessage =
	| {
			type: "init";
			kazeUrl: string;
			module: WebAssembly.Module;
			config: unknown;
			encode: string;
			decode: string;
	  }
	| { type: "job"; job: RewriteJob };

type Pending = {
	resolve: (v: Uint8Array | string | null) => void;
	job: RewriteJob;
	worker: PoolWorker;
};
type PoolWorker = { worker: Worker; busy: number; ready: boolean };

/**
 * Workers start on demand, not with the controller: each one loads the
 * rewriter and instantiates the wasm, which competed with startup for CPU
 * whether or not a page ever had a script big enough to offload. Until a
 * worker has booted, jobs run on the calling thread as they would without
 * a pool; the pool grows (up to `size`) while every booted worker is busy.
 */
export class RewritePool implements RewriteOffload {
	private workers: PoolWorker[] = [];
	private pending = new Map<number, Pending>();
	private nextId = 1;
	private broken = false;

	constructor(
		private size: number,
		private workerUrl: string,
		private init: Omit<Extract<RewriteWorkerMessage, { type: "init" }>, "type">
	) {}

	private spawn() {
		if (this.broken || this.workers.length >= this.size) return;
		try {
			const worker = new Worker(this.workerUrl, { name: "kaze-rewrite" });
			const slot: PoolWorker = { worker, busy: 0, ready: false };
			worker.postMessage({ type: "init", ...this.init });
			worker.onmessage = (e: MessageEvent<RewriteWorkerReply>) => {
				if ("ready" in e.data) slot.ready = true;
				else this.done(e.data);
			};
			worker.onerror = () => this.retire(slot);
			this.workers.push(slot);
		} catch {
			// no workers here (CSP etc.): everything stays on this thread
			this.broken = true;
		}
	}

	private done(result: RewriteResult) {
		const p = this.pending.get(result.id);
		if (!p) return;
		this.pending.delete(result.id);
		p.worker.busy--;
		if ("input" in result) {
			p.job.input = result.input;
			p.resolve(null);
		} else p.resolve(result.output);
	}

	/** a dead worker (blocked script, CSP): its jobs go back to the main thread */
	private retire(slot: PoolWorker) {
		// one that never booted won't boot next time either
		if (!slot.ready) this.broken = true;
		this.workers = this.workers.filter((w) => w !== slot);
		for (const [id, p] of this.pending) {
			if (p.worker !== slot) continue;
			this.pending.delete(id);
			p.resolve(null);
		}
	}

	private submit(
		job: Omit<RewriteJob, "id">,
		transfer: boolean
	): Promise<{
		output: Uint8Array | string | null;
		input: Uint8Array | string;
	}> {
		const slot = this.workers.reduce<PoolWorker | null>(
			(best, w) => (w.ready && (!best || w.busy < best.busy) ? w : best),
			null
		);
		const booting = this.workers.some((w) => !w.ready);
		if ((!slot || slot.busy > 0) && !booting) this.spawn();
		if (!slot) return Promise.resolve({ output: null, input: job.input });
		const full: RewriteJob = { ...job, id: this.nextId++ };
		slot.busy++;
		return new Promise((resolve) => {
			this.pending.set(full.id, {
				job: full,
				worker: slot,
				resolve: (output) => resolve({ output, input: full.input }),
			});
			slot.worker.postMessage(
				{ type: "job", job: full } satisfies RewriteWorkerMessage,
				transfer && full.input instanceof Uint8Array ? [full.input.buffer] : []
			);
		});
	}

	private metaFields(meta: URLMeta) {
		return {
			origin: meta.origin.href,
			base: meta.base.href,
			referrerPolicy: meta.referrerPolicy,
			topFrameName: meta.topFrameName,
			parentFrameName: meta.parentFrameName,
		};
	}

	js(
		input: Uint8Array,
		url: string,
		prefix: string,
		meta: URLMeta,
		isModule: boolean
	) {
		return this.submit(
			{ kind: "js", input, url, prefix, isModule, meta: this.metaFields(meta) },
			true
		);
	}

	css(input: string, url: string, prefix: string, meta: URLMeta) {
		return this.submit(
			{
				kind: "css",
				input,
				url,
				prefix,
				isModule: false,
				meta: this.metaFields(meta),
			},
			false
		);
	}
}
