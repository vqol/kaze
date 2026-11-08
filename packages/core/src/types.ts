/**
 * Version information for the current Kaze build.
 * Contains both the semantic version string and the git commit hash for build identification.
 */
export interface KazeVersionInfo {
	/** The semantic version */
	version: string;
	/** The git commit hash that this build was created from */
	build: string;
	/** The date of the build */
	date: string;
}

/**
 * Kaze Feature Flags, configured at build time
 */
export type KazeFlags = {
	syncxhr: boolean;
	disableComputedWrap: boolean;
	rewriterLogs: boolean;
	captureErrors: boolean;
	cleanErrors: boolean;
	scramitize: boolean;
	sourcemaps: boolean;
	destructureRewrites: boolean;
	allowInvalidJs: boolean;
	allowFailedIntercepts: boolean;
	debugTrampolines: boolean;
	debugSourceURL: boolean;
	streamHtml: boolean;
	encapsulateWorkers: boolean;
};

export interface KazeConfig {
	globals: {
		wrapfn: string;
		wrappropertybase: string;
		wrappropertyfn: string;
		cleanrestfn: string;
		importfn: string;
		rewritefn: string;
		metafn: string;
		wrappostmessagefn: string;
		pushsourcemapfn: string;
		trysetfn: string;
		templocid: string;
		tempunusedid: string;
	};
	flags: KazeFlags;
	siteFlags: Record<string, Partial<KazeFlags>>;
	maskedfiles: string[];
}

/**
 * The config for Kaze initialization.
 */
export interface KazeInitConfig extends Omit<KazeConfig, "codec" | "flags"> {
	flags: Partial<KazeFlags>;
	codec: {
		encode: (url: string) => string;
		decode: (url: string) => string;
	};
}

//eslint-disable-next-line
export type AnyFunction = Function;
