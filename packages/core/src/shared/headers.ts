import { RawHeaders } from "@mercuryworkshop/proxy-transports";

export class KazeHeaders {
	headers = {};

	set(key: string, v: string) {
		this.headers[key.toLowerCase()] = v;
	}

	get(key: string): string | null {
		const lk = key.toLowerCase();
		if (lk in this.headers) {
			return this.headers[lk];
		}

		return null;
	}

	delete(key: string) {
		delete this.headers[key.toLowerCase()];
	}

	has(key: string): boolean {
		return key.toLowerCase() in this.headers;
	}

	toRawHeaders(): RawHeaders {
		const raw: RawHeaders = [];
		for (const k in this.headers) {
			raw.push([k, this.headers[k]]);
		}

		return raw;
	}

	toNativeHeaders(): Headers {
		const native = new Headers();
		for (const k in this.headers) {
			native.set(k, this.headers[k]);
		}

		return native;
	}

	static fromRawHeaders(raw: RawHeaders): KazeHeaders {
		const h = new KazeHeaders();
		for (const [k, v] of raw) {
			if (h.has(k)) {
				// console.debug(
				// 	`Duplicate header "${k}" found in raw headers, overwriting previous value.`
				// );
			}
			h.set(k, v);
		}

		return h;
	}

	static fromNativeHeaders(native: Headers): KazeHeaders {
		const h = new KazeHeaders();
		for (const [k, v] of native.entries()) {
			h.set(k, v);
		}

		return h;
	}

	clone(): KazeHeaders {
		const newh = new KazeHeaders();
		for (const k in this.headers) {
			newh.set(k, this.headers[k]);
		}

		return newh;
	}
}
