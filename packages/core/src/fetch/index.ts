import {
	BareCompatibleClient,
	BareResponse,
	ProxyTransport,
	BareRequestInit,
} from "@mercuryworkshop/proxy-transports";

import { type URLMeta } from "@rewriters/url";
import { type KazeRequestMode } from "./parse";
import { KazeHeaders } from "@/shared/headers";
import { HtmlRewriterHooks, KazeContext } from "@/shared";
import { Tap, TapInstance } from "@/Tap";
import { doHandleFetch } from "./fetch";
import { _URL, _Map } from "@/shared/snapshot";

export interface KazeFetchRequest {
	rawUrl: URL;
	rawReferrer: string | null;
	// use parsed.destination instead
	rawDestination: RequestDestination;
	mode: RequestMode;
	referrer: string;
	method: string;
	body: BodyType | null;
	cache: RequestCache;

	initialHeaders: KazeHeaders;

	rawClientUrl?: URL;

	/** The service worker FetchEvent.clientId that originated this request. */
	clientId: string;
}

export interface KazeFetchParsed {
	url: _URL;
	clientUrl?: _URL;
	referrerSourceUrl?: _URL | null;
	hadExtraParams: boolean;
	crossSiteRedirect: boolean;

	// track the worst case Sec-Fetch-Site classification through redirects
	fetchSiteState?: "same-origin" | "same-site" | "cross-site";

	// origin of the page that initialized the request
	// specifically for tracking Sec-Fetch-Site, don't use for anything else, it will diverge from clientUrl in some cases
	fetchInitiatorOrigin?: string;

	// was the request made with credentials=include?
	fetchCredentialsInclude?: boolean;

	// tracks RequestInit.mode if set
	fetchMode?: KazeRequestMode;

	// was this request made by an iframe? (kaze's definition of an iframe, not the browser's)
	isIframe?: boolean;

	// request.destination, but is overridden by $dest
	destination: RequestDestination;

	meta: URLMeta;
	isModule: boolean;
	isFakeDataURL: boolean;
	referrerPolicy?: string;
	trackedClient?: KazeFetchTrackedClient;
}

export interface KazeFetchResponse {
	body: BodyType;
	headers: KazeHeaders;
	status: number;
	statusText: string;
}

export type CookieSyncEntry = {
	url: URL;
	cookie: string;
	/** a document.cookie write: may not create or replace HttpOnly cookies */
	fromJs?: boolean;
};

export type CookieSyncOptions = {
	clear?: boolean;
	destination?: RequestDestination;
	/** service worker client that made the request; its jar must be updated before the response resolves */
	clientId?: string;
};

export type FetchHandlerInit = {
	transport: ProxyTransport;
	context: KazeContext;
	crossOriginIsolated?: boolean;

	sendSetCookie: (
		cookies: CookieSyncEntry[],
		options?: CookieSyncOptions
	) => Promise<void>;
	fetchDataUrl(dataUrl: string): Promise<BareResponse>;
	fetchBlobUrl(blobUrl: string): Promise<BareResponse>;
};

/** Where large rewrites can run instead of the thread the page renders on. */
export interface RewriteOffload {
	js(
		input: Uint8Array,
		url: string,
		prefix: string,
		meta: URLMeta,
		isModule: boolean
	): Promise<{
		output: Uint8Array | string | null;
		input: Uint8Array | string;
	}>;
	css(
		input: string,
		url: string,
		prefix: string,
		meta: URLMeta
	): Promise<{
		output: Uint8Array | string | null;
		input: Uint8Array | string;
	}>;
}

export type TrackedHistoryState = {
	url: string;
	refererPolicy?: string;
};
export class KazeFetchTrackedClient {
	history: TrackedHistoryState[] = [];
	constructor(public clientId: string) {}
}

// eslint-disable-next-line kaze-core/no-globals
export class KazeFetchHandler extends EventTarget {
	public client: BareCompatibleClient;
	public crossOriginIsolated: boolean = false;
	public context: KazeContext;

	public trackedClients: _Map<string, KazeFetchTrackedClient> = new _Map<
		string,
		KazeFetchTrackedClient
	>();

	public hooks: {
		rewriter: {
			html: TapInstance<HtmlRewriterHooks>;
		};
		fetch: TapInstance<FetchHooks>;
	};

	public rewriteOffload?: RewriteOffload;

	/** rewritten scripts for responses served from the http cache */
	public rewriteCache: _Map<string, Uint8Array | string> = new _Map();
	public rewriteCacheBytes = 0;

	public fetchDataUrl: (dataUrl: string) => Promise<Response>;
	public fetchBlobUrl: (blobUrl: string) => Promise<Response>;
	public sendSetCookie: (
		cookies: CookieSyncEntry[],
		options?: CookieSyncOptions
	) => Promise<void>;

	constructor(init: FetchHandlerInit) {
		super();
		this.client = new BareCompatibleClient(init.transport);
		this.context = init.context;
		this.crossOriginIsolated = init.crossOriginIsolated || false;
		this.sendSetCookie = init.sendSetCookie;
		this.fetchDataUrl = init.fetchDataUrl;
		this.fetchBlobUrl = init.fetchBlobUrl;
		this.hooks = {
			rewriter: {
				html: Tap.create<HtmlRewriterHooks>(),
			},
			fetch: Tap.create<FetchHooks>(),
		};
		this.context.hooks = {
			rewriter: this.hooks.rewriter,
		};
	}

	async handleFetch(request: KazeFetchRequest): Promise<KazeFetchResponse> {
		return doHandleFetch(this, request);
	}
}
export type FetchHooks = {
	intercept: {
		context: {
			request: KazeFetchRequest;
			parsed: KazeFetchParsed;
		};
		props: {
			response?: KazeFetchResponse;
		};
	};
	request: {
		context: {
			request: KazeFetchRequest;
			parsed: KazeFetchParsed;
			client: BareCompatibleClient;
		};
		props: {
			init: BareRequestInit;
			url: URL;
			earlyResponse?: BareResponse;
		};
	};
	preresponse: {
		context: {
			request: KazeFetchRequest;
			parsed: KazeFetchParsed;
		};
		props: {
			response: BareResponse;
		};
	};
	response: {
		context: {
			request: KazeFetchRequest;
			parsed: KazeFetchParsed;
		};
		props: {
			response: KazeFetchResponse;
		};
	};
};

export type BodyType = string | ArrayBuffer | Blob | ReadableStream<any>;
