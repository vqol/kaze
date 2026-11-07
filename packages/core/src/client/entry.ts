// entrypoint for kaze.client.js

import { KazeContext, KazeInterface } from "@/shared/index";
import { KAZECLIENT } from "@/symbols";
import { KazeClient } from "@client/index";
import { KazeConfig } from "@/types";

export const iswindow = "window" in globalThis && window instanceof Window;
export const isworker = "WorkerGlobalScope" in globalThis;
export const issw = "ServiceWorkerGlobalScope" in globalThis;
export const isdedicated = "DedicatedWorkerGlobalScope" in globalThis;
export const isshared = "SharedWorkerGlobalScope" in globalThis;
