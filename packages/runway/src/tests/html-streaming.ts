// Documents stream through the rewriter (kaze's scripts go out before the
// page's first real content) unless they're too odd to place them safely.
import {
	CookieJar,
	Tap,
	defaultConfig,
	rewriteHtmlStream,
} from "@kaze/core/bundled-wasm";
import { directTest, htmlTest, type Test } from "../testcommon.ts";

const INJECT = "/kz-inject-marker.js";
const encoder = new TextEncoder();

function streamContext() {
	const context = {
		config: defaultConfig,
		prefix: new URL("https://proxy.test/~/kz/ctl/frame/"),
		interface: {
			codecEncode: encodeURIComponent,
			codecDecode: decodeURIComponent,
			getInjectScripts: (_meta: any, _handler: any, _ctx: any, script: any) => [
				script(INJECT),
			],
		},
		cookieJar: new CookieJar(),
		hooks: { rewriter: { html: Tap.create() } },
	} as any;
	const meta = {
		origin: new URL("https://example.com/"),
		base: new URL("https://example.com/"),
	} as any;
	return { context, meta };
}

/**
 * Feeds `head` (padded past the 1024 byte charset prescan) and keeps the
 * source open: a streaming rewrite answers now, a buffered one only at the end.
 */
async function firstChunk(head: string) {
	const { context, meta } = streamContext();
	let source!: ReadableStreamDefaultController<Uint8Array>;
	const body = new ReadableStream<Uint8Array>({
		start: (c) => {
			source = c;
		},
	});
	const out = rewriteHtmlStream(body, "text/html", context, meta, {
		loadScripts: true,
		inline: true,
		source: meta.origin.href,
		history: [],
	});
	const reader = out.getReader();
	source.enqueue(encoder.encode(head + `<p>${"x".repeat(1100)}</p>`));
	const pending = reader
		.read()
		.then((r) => (r.done ? "" : new TextDecoder().decode(r.value)));
	const first = await Promise.race([
		pending,
		new Promise<null>((r) => setTimeout(() => r(null), 1000)),
	]);
	source.enqueue(encoder.encode("<p>tail</p>"));
	source.close();
	// a buffered rewrite answers that first read only now
	let rest = first === null ? await pending : "";
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		rest += new TextDecoder().decode(value);
	}
	return { first, all: (first ?? "") + rest };
}

function streamTest(props: {
	name: string;
	head: string;
	/** markup that must come before kaze's scripts, in order */
	before: string[];
	/** the first markup that must come after them */
	after: string;
}): Test {
	return directTest({
		name: props.name,
		fn: async ({ assert, assertEqual }) => {
			const { first, all } = await firstChunk(props.head);
			assert(first !== null, "the document was buffered instead of streamed");
			const at = all.indexOf(INJECT);
			assert(at !== -1, "kaze's scripts weren't injected:\n" + all);
			assertEqual(
				all.indexOf(INJECT, at + 1),
				-1,
				"kaze's scripts were injected twice"
			);
			let from = 0;
			for (const piece of props.before) {
				const i = all.indexOf(piece, from);
				assert(i !== -1 && i < at, `"${piece}" should come before kaze:\n${all}`);
				from = i + piece.length;
			}
			const after = all.indexOf(props.after);
			assert(after > at, `"${props.after}" should come after kaze:\n${all}`);
		},
	});
}

// the page's first script must see kaze's hooks; with a doctype the
// document must stay in standards mode (scripts ahead of the doctype would
// switch it to quirks mode)
const pageScript = (mode: string) =>
	`<script>runTest(() => {
		checkglobal(top);
		checkglobal(location);
		assertEqual(location.pathname, "/", "page sees its own url");
		assertEqual(document.compatMode, "${mode}", "rendering mode");
		assertEqual(document.querySelectorAll("script[kaze-injected]").length, 0, "kaze removed its script tags");
	}, true);</script>`;

export default [
	streamTest({
		name: "htmlstream-explicit-html-head",
		head: "<!DOCTYPE html><html><head><script>page()</script>",
		before: ["<!DOCTYPE html>", "<html>", "<head>"],
		after: "<script>",
	}),
	streamTest({
		name: "htmlstream-omitted-html",
		head: "<!DOCTYPE html><head><title>t</title><script>page()</script>",
		before: ["<!DOCTYPE html>", "<head>"],
		after: "<title>",
	}),
	streamTest({
		name: "htmlstream-omitted-head",
		head: "<!DOCTYPE html><html lang=en><meta charset=utf-8><script>page()</script>",
		before: ["<!DOCTYPE html>", '<html lang="en">'],
		after: "<meta",
	}),
	streamTest({
		name: "htmlstream-leading-comments",
		head: "<!-- a --><!DOCTYPE html>\n<!-- b -->\n<html><!-- c --><body><script>page()</script>",
		before: ["<!-- a -->", "<!DOCTYPE html>", "<!-- b -->", "<html>", "<!-- c -->"],
		after: "<body>",
	}),
	streamTest({
		name: "htmlstream-doctype-only-preamble",
		head: "<!DOCTYPE html>\n<script>page()</script><p>hi</p>",
		before: ["<!DOCTYPE html>"],
		after: "<script>",
	}),
	streamTest({
		name: "htmlstream-text-first",
		head: "hello <b>world</b>",
		before: [],
		after: "hello",
	}),
	directTest({
		name: "htmlstream-quirky-input-buffers",
		fn: async ({ assert }) => {
			// </html> before any content: left to the tree-based rewriter
			// (htmlparser2 drops most stray end tags and turns </p> and </br>
			// into elements, so those just stream)
			const { first, all } = await firstChunk(
				"<html></html><head><script>page()</script>"
			);
			assert(first === null, "expected the buffered fallback");
			assert(all.includes(INJECT), "the fallback still injects kaze");
		},
	}),

	htmlTest({
		name: "htmlstream-page-omitted-html",
		kazeOnly: true,
		html: `<!DOCTYPE html><head><meta charset="utf-8"><title>t</title>${pageScript("CSS1Compat")}</head><body><p>x</p></body>`,
	}),
	htmlTest({
		name: "htmlstream-page-omitted-head",
		kazeOnly: true,
		html: `<!DOCTYPE html><html><title>t</title>${pageScript("CSS1Compat")}<p>x</p></html>`,
	}),
	htmlTest({
		name: "htmlstream-page-leading-comments",
		kazeOnly: true,
		html: `<!-- one --><!DOCTYPE html>\n<!-- two -->\n${pageScript("CSS1Compat")}<p>x</p>`,
	}),
	htmlTest({
		name: "htmlstream-page-doctype-only",
		kazeOnly: true,
		html: `<!DOCTYPE html>\n${pageScript("CSS1Compat")}<p>x</p>`,
	}),
	htmlTest({
		name: "htmlstream-page-no-doctype",
		kazeOnly: true,
		html: `${pageScript("BackCompat")}<p>x</p>`,
	}),
];
