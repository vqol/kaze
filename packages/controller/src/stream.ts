const NOT_READY: unique symbol = Symbol();
const COALESCE_BYTES = 512 * 1024;
/**
 * Response bodies cross from this page to the service worker as a transferred
 * stream, which costs a cross-thread hop per chunk. Transports hand us 16KB
 * chunks, so batch whatever is already available into larger ones. Never
 * waits for more data than is ready: latency is unchanged.
 */
export function coalesceStream(
	src: ReadableStream<Uint8Array>
): ReadableStream<Uint8Array> {
	const reader = src.getReader();
	let pending: Promise<ReadableStreamReadResult<Uint8Array>> | null = null;
	let done = false;

	return new ReadableStream<Uint8Array>(
		{
			async pull(controller) {
				if (done) {
					controller.close();
					return;
				}
				const first = await (pending ?? reader.read());
				pending = null;
				if (first.done) {
					controller.close();
					return;
				}
				const chunks: Uint8Array[] = [first.value];
				let size = first.value.byteLength;
				while (size < COALESCE_BYTES) {
					const next = reader.read();
					// an already-settled read wins the race, otherwise stop batching
					const r = await Promise.race([next, NOT_READY]);
					if (typeof r === "symbol") {
						pending = next;
						break;
					}
					if (r.done) {
						done = true;
						break;
					}
					chunks.push(r.value);
					size += r.value.byteLength;
				}
				if (chunks.length === 1) {
					controller.enqueue(chunks[0]);
				} else {
					const out = new Uint8Array(size);
					let off = 0;
					for (const c of chunks) {
						out.set(c, off);
						off += c.byteLength;
					}
					controller.enqueue(out);
				}
			},
			cancel(reason) {
				return reader.cancel(reason);
			},
		},
		{ highWaterMark: 0 }
	);
}
