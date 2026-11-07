import type { Controller } from "@kaze/controller";
declare global {
	function initBootstrap(): Promise<Controller>;
}

export * from "./server";
