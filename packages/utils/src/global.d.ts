import type * as KazeController from "@kaze/controller";

declare global {
	const $kaze: typeof import("@kaze/core");
	const $kazeController: typeof KazeController;
}

export {};
