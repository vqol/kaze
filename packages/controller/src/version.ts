import { versionInfo as kazeVersionInfo } from "@kaze/core";

declare const KAZE_EXPECTED_VERSION: string;
declare const VERSION: string;
declare const COMMITHASH: string;
declare const BUILDDATE: string;

export const versionInfo = {
	version: VERSION,
	build: COMMITHASH,
	date: BUILDDATE,
};

function assertVersionMatch(
	packageName: string,
	expected: string,
	actual: string
) {
	if (expected !== actual) {
		throw new Error(
			`${packageName} version mismatch: this build expects ${expected}, but the loaded runtime is ${actual}`
		);
	}
}

export function assertRuntimeKazeVersion() {
	if (typeof kazeVersionInfo === "undefined") {
		throw new Error(
			"@kaze/core is not loaded. Load kaze before the controller."
		);
	}

	assertVersionMatch(
		"@kaze/core",
		KAZE_EXPECTED_VERSION,
		kazeVersionInfo.version
	);
}
