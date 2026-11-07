/// <reference types="@rspack/core/module" />

declare global {
	interface Window {
		WASM: string;
		REAL_WASM: Uint8Array;

		/**
		 * The kaze client belonging to a window.
		 */
		[import("./symbols").KAZECLIENT]: import("./client").KazeClient;
	}

	interface Document {
		/**
		 * Should be the same as window.
		 */
		[import("./symbols").KAZECLIENT]: import("./client").KazeClient;
	}
}

declare const dbg: {
	log: (message: string, ...args: any[]) => void;
	warn: (message: string, ...args: any[]) => void;
	error: (message: string, ...args: any[]) => void;
	debug: (message: string, ...args: any[]) => void;
	time: (meta: URLMeta, before: number, type: string) => void;
};

// eslint-disable-next-line kaze-core/no-globals
declare type GlobalThis = typeof globalThis;
declare type Self = Window & GlobalThis;
