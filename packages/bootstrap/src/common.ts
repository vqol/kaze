export const REGISTRY_URL = "https://registry.npmjs.org/";
export const KAZE_PACKAGE_NAME = "@kaze/core";

export const KAZE_CONTROLLER_PACKAGE_NAME = "@kaze/controller";
export const KAZE_CONTROLLER_PINNED_MAJOR_VERSION = "0";

export const KAZE_UTILS_PACKAGE_NAME = "@kaze/utils";
export const KAZE_UTILS_PINNED_MAJOR_VERSION = "0";

export const EPOXY_TRANSPORT_PACKAGE_NAME = "@mercuryworkshop/epoxy-transport";
export const EPOXY_TRANSPORT_PINNED_MAJOR_VERSION = "3";

export const LIBCURL_TRANSPORT_PACKAGE_NAME =
	"@mercuryworkshop/libcurl-transport";
export const LIBCURL_TRANSPORT_PINNED_MAJOR_VERSION = "2";

export type TransportOptions = "epoxy" | "libcurl" | "bare";

export type BootstrapOptions = {
	transport: TransportOptions;
	swPath: string;

	wispPath: string;

	kazeBundlePath: string;
	kazeWasmPath: string;
	kazeUtilsBundlePath: string;

	epoxyClientPath: string;
	libcurlClientPath: string;
	bareClientPath: string;
	kazeControllerApiPath: string;
	kazeControllerInjectPath: string;
	kazeControllerSwPath: string;

	bootstrapApiPath: string;
	bootstrapInitPath: string;

	kazeVersionPin?: string;
	kazeControllerVersionPin?: string;
	kazeUtilsVersionPin?: string;
	epoxyTransportVersionPin?: string;
	libcurlTransportVersionPin?: string;
	bareTransportVersionPin?: string;
};

export const defaultConfig: Partial<BootstrapOptions> = {
	transport: "libcurl",
	swPath: "/sw.js",
	wispPath: "/wisp/",

	epoxyClientPath: "/clients/epoxy-client.js",
	libcurlClientPath: "/clients/libcurl-client.js",
	bareClientPath: "/clients/bare-client.js",
	bootstrapInitPath: "/bootstrap-init.js",

	kazeControllerApiPath: "/controller/controller.api.js",
	kazeControllerInjectPath: "/controller/controller.inject.js",
	kazeControllerSwPath: "/controller/controller.sw.js",
	kazeBundlePath: "/scram/kaze.js",
	kazeWasmPath: "/scram/kaze.wasm",
	kazeUtilsBundlePath: "/scram/kaze-utils.js",
};
