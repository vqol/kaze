import { versionInfo as kazeVersionInfo } from "@kaze/core";
import { versionInfo as controllerVersionInfo } from "@kaze/controller";

declare const KAZE_EXPECTED_VERSION: string;
declare const CONTROLLER_EXPECTED_VERSION: string;
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

export function assertDependencyVersions() {
	if (typeof kazeVersionInfo === "undefined") {
		console.error("@kaze/core is not loaded. Load kaze before kaze-utils.");
	}

	assertVersionMatch(
		"@kaze/core",
		KAZE_EXPECTED_VERSION,
		kazeVersionInfo.version
	);

	if (typeof controllerVersionInfo === "undefined") {
		console.error(
			"@kaze/controller is not loaded. Load the controller before kaze-utils."
		);
	}

	assertVersionMatch(
		"@kaze/controller",
		CONTROLLER_EXPECTED_VERSION,
		controllerVersionInfo.version
	);
}
