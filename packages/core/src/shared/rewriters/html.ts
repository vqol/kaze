import { ElementType, Parser, type Handler } from "htmlparser2";
import {
	ChildNode,
	DomHandler,
	Element,
	Comment,
	Text,
	ProcessingInstruction,
} from "domhandler";
import render from "dom-serializer";
import { URLMeta, rewriteUrl } from "@rewriters/url";
import { rewriteCss } from "@rewriters/css";
import { rewriteJs } from "@rewriters/js";
import { KazeContext } from "@/shared";
import { htmlRules } from "@/shared/htmlRules";
import { parseDeclarativeRefresh } from "@/shared/refresh";
import { bytesToBase64 } from "@/shared/util";
import { Tap } from "@/Tap";
import { RawHeaders } from "@mercuryworkshop/proxy-transports";
import { TrackedHistoryState } from "@/fetch";
import {
	Performance_now,
	atob,
	Object_entries,
	JSON_parse,
	JSON_stringify,
	TextEncoder_encode,
	Array_from,
	String_fromCodePoint,
	btoa,
	_URL,
	_Set,
	_Map,
	_TextDecoder,
	RegExp_exec,
	Object_keys,
} from "@/shared/snapshot";
import { flagEnabled } from "..";
import { sniffEncoding } from "@/shared/sniffEncoding";
import {
	getScriptBlockTypeString,
	isModuleScriptType,
	isScriptType,
} from "@/shared/mime";

export type ForeignContext = "svg" | "math" | "html";

export type HtmlContext = {
	// should we inject kaze scripts at the top of the document?
	loadScripts: boolean;
	// did the document come from the service worker, or from document.write/innerHTML?
	inline: boolean;
	// for worker originating documents, the source URL, otherwise the url of the page that triggered the rewrite
	source: string;
	// for api originating documents, the name of the api that triggered the rewrite
	apisource?: string;
	// response headers for worker originating documents
	headers?: RawHeaders;
	foreignContext?: ForeignContext;
	history?: TrackedHistoryState[];
};

const renderOptions = {
	encodeEntities: "utf8" as const,
	decodeEntities: false,
};
function serializeHtmlNode(node: ChildNode) {
	return render(node, renderOptions);
}

function isElementNode(node: ChildNode): node is Element {
	return (
		node.type === ElementType.Tag ||
		node.type === ElementType.Script ||
		node.type === ElementType.Style
	);
}

export class IncrementalHtmlRewriter {
	private readonly handler: DomHandler;
	private readonly parser: Parser;
	private readonly completedElements = new WeakSet<Element>();
	private readonly emittedLengths = new WeakMap<ChildNode, number>();
	private readonly rewrittenNodes = new WeakMap<ChildNode, string>();
	private ended = false;

	constructor(
		private readonly context: KazeContext,
		private readonly meta: URLMeta,
		private readonly htmlcontext: HtmlContext
	) {
		this.handler = new DomHandler(undefined, undefined, (element) => {
			this.completedElements.add(element);
		});
		this.parser = new Parser(this.handler, {
			startingForeignContext: htmlcontext.foreignContext,
		});
	}

	write(html: string) {
		if (this.ended) {
			throw new Error("IncrementalHtmlRewriter stream already ended");
		}

		this.parser.write(html);

		return this.flush();
	}

	end(html = "") {
		if (this.ended) {
			return "";
		}

		if (html) {
			this.parser.write(html);
		}

		this.parser.end();
		this.ended = true;

		return this.flush();
	}

	private flush() {
		let output = "";

		for (const node of this.handler.root.childNodes) {
			const rewritten = this.getAvailableOutput(node);
			if (rewritten === null) {
				break;
			}

			const emittedLength = this.emittedLengths.get(node) ?? 0;
			if (rewritten.length > emittedLength) {
				output += rewritten.slice(emittedLength);
				this.emittedLengths.set(node, rewritten.length);
			}
		}

		return output;
	}

	private getAvailableOutput(node: ChildNode) {
		if (!isElementNode(node)) {
			return serializeHtmlNode(node);
		}

		if (!this.completedElements.has(node)) {
			return null;
		}

		let rewritten = this.rewrittenNodes.get(node);
		if (rewritten === undefined) {
			rewritten = rewriteHtmlInner(
				node,
				this.context,
				this.meta,
				this.htmlcontext
			);
			this.rewrittenNodes.set(node, rewritten);
		}

		return rewritten;
	}
}

function rewriteHtmlInner(
	html: string | ChildNode,
	context: KazeContext,
	meta: URLMeta,
	htmlcontext: HtmlContext
) {
	if (typeof html !== "string") {
		html = serializeHtmlNode(html);
	}

	const handler = new DomHandler((err, dom) => dom);
	const parser = new Parser(handler, {
		startingForeignContext: htmlcontext.foreignContext,
	});

	parser.write(html);
	parser.end();
	Tap.dispatch(
		context.hooks!.rewriter.html.pre,
		{
			handler,
			meta,
			htmlcontext,
			origHtml: html,
		},
		undefined
	);
	traverseParsedHtml(handler.root, context, meta);

	let htmlRoot: Element | undefined;
	let headElement: Element | undefined;
	let bodyElement: Element | undefined;

	function detectQuirks() {
		for (const child of handler.root.childNodes) {
			if (
				child.type === ElementType.Directive ||
				child.type === ElementType.Comment ||
				child.type === ElementType.Text
			) {
				continue;
			}

			if (child.type === ElementType.Tag && child.name === "html") {
				htmlRoot = child as Element;
			} else {
				// there's a child of the root that isn't an html element or a doctype/comment/text
				return true;
			}
		}

		if (!htmlRoot) return true; // no html tag or it's somewhere else other than first child

		for (const child of htmlRoot.childNodes) {
			if (
				child.type === ElementType.Directive ||
				child.type === ElementType.Comment ||
				child.type === ElementType.Text
			) {
				continue;
			}

			if (child.type === ElementType.Tag && child.name === "head") {
				if (bodyElement) {
					// head comes after body
					return true;
				}
				headElement = child as Element;
			} else if (child.type === ElementType.Tag && child.name === "body") {
				bodyElement = child as Element;
			} else {
				// there's a child of html that isn't head or body
				// fine if head already exists, bad if it doesn't
				if (!headElement) {
					return true;
				}
			}

			return false;
		}
	}

	const isQuirky = detectQuirks();

	if (htmlcontext.loadScripts) {
		const script = (src: string) =>
			new Element("script", { src, "kaze-injected": "true" });
		const injectScripts = context.interface.getInjectScripts(
			meta,
			handler,
			htmlcontext,
			script
		);

		if (isQuirky) {
			dbg.warn(
				`detected quirky document structure parsing @ ${meta.origin.href}!`
			);
			// there's weird stuff going on with the document that could result in page scripts being loaded before our inject scripts
			// so inject them at position 0
			handler.root.children.unshift(...injectScripts);
		} else {
			if (!headElement) {
				headElement = new Element("head", {}, []);
				htmlRoot.children.unshift(headElement);
			}

			headElement.children.unshift(...injectScripts);
		}
	}

	const props: typeof context.hooks.rewriter.html.post.props = {};
	Tap.dispatch(
		context.hooks!.rewriter.html.post,
		{
			handler,
			meta,
			htmlcontext,
			origHtml: html,
		},
		props
	);

	if (props.setRawHtml !== undefined) {
		return props.setRawHtml;
	}

	return render(handler.root, renderOptions);
}

export function rewriteHtml(
	html: string,
	context: KazeContext,
	meta: URLMeta,
	htmlcontext: HtmlContext
) {
	const before = Performance_now();
	let ret: string;
	if (!htmlcontext.loadScripts && canStreamHtml(context)) {
		// fragments (innerHTML etc.) need no document structure: no tree to build
		const rewriter = new StreamingHtmlRewriter(
			context,
			meta,
			htmlcontext,
			true
		);
		ret = rewriter.write(html) + rewriter.end();
	} else {
		ret = rewriteHtmlInner(html, context, meta, htmlcontext);
	}
	if (flagEnabled("rewriterLogs", context, meta.base)) {
		dbg.time(meta, before, "html rewrite");
	}

	return ret;
}

// type ParseState = {
// 	base: string;
// 	origin?: URL;
// };

// elements and comments whose contents aren't escaped when serialized
const RAW_TEXT_MARKUP =
	/<(?:!|script|style|xmp|iframe|noembed|noframes|noscript|plaintext|textarea|title)/i;

/**
 * Restores kaze-attr-* in markup the browser serialized. Without raw-text
 * elements every "<" starts a tag and every attribute value is double quoted
 * with its quotes escaped, so tags can be walked directly: no parser needed.
 */
function restoreAttributes(html: string): string {
	let out = "";
	let copied = 0;
	let at = html.indexOf("<");
	while (at !== -1) {
		let i = at + 1;
		if (html[i] === "/") {
			at = html.indexOf("<", i);
			continue;
		}
		while (
			i < html.length &&
			html[i] !== " " &&
			html[i] !== ">" &&
			html[i] !== "/"
		)
			i++;
		const attrsStart = i;
		// name, value pairs for this tag, only built if it has something to restore
		let names: string[] = [];
		let values: (string | null)[] = [];
		let restore = false;
		while (i < html.length && html[i] !== ">") {
			if (html[i] === " " || html[i] === "/") {
				i++;
				continue;
			}
			const nameStart = i;
			while (
				i < html.length &&
				html[i] !== "=" &&
				html[i] !== " " &&
				html[i] !== ">" &&
				html[i] !== "/"
			)
				i++;
			const name = html.slice(nameStart, i);
			let value: string | null = null;
			if (html[i] === "=" && html[i + 1] === '"') {
				const end = html.indexOf('"', i + 2);
				if (end === -1) return out + html.slice(copied);
				value = html.slice(i + 2, end);
				i = end + 1;
			}
			names.push(name);
			values.push(value);
			if (name.startsWith("kaze-attr-")) restore = true;
		}
		if (restore) {
			const final = new _Map<string, string | null>();
			names.forEach((name, n) => {
				if (!name.startsWith("kaze-attr-")) final.set(name, values[n]);
			});
			names.forEach((name, n) => {
				if (name.startsWith("kaze-attr-"))
					final.set(name.slice("kaze-attr-".length), values[n]);
			});
			out += html.slice(copied, attrsStart);
			for (const [name, value] of final)
				out += value === null ? " " + name : " " + name + '="' + value + '"';
			copied = i;
		}
		at = html.indexOf("<", i);
	}
	return out + html.slice(copied);
}

export function unrewriteHtml(html: string, foreignContext?: ForeignContext) {
	// only kaze-attr-* attributes are restored; without any, the markup is
	// already what the page wrote (and skipping the reparse keeps it verbatim)
	if (html.indexOf("kaze-attr-") === -1) return html;
	if (RegExp_exec(RAW_TEXT_MARKUP, html) === null)
		return restoreAttributes(html);
	const rewriter = new StreamingHtmlRewriter(
		null!,
		null!,
		{ foreignContext } as HtmlContext,
		true,
		true
	);
	return rewriter.write(html) + rewriter.end();
}

// Elements dom-serializer writes without a closing tag.
const VOID_ELEMENTS: Set<string> = new _Set([
	"area",
	"base",
	"basefont",
	"br",
	"col",
	"command",
	"embed",
	"frame",
	"hr",
	"img",
	"input",
	"isindex",
	"keygen",
	"link",
	"meta",
	"param",
	"source",
	"track",
	"wbr",
]);
// what the html parser skips before content (\s would also take U+00A0,
// which is text to the parser)
const ONLY_WHITESPACE = /^[\t\n\f\r ]*$/;
const TEXT_NEEDS_ESCAPE = /[&<>\u00a0]/;
const ATTR_NEEDS_ESCAPE = /["&\u00a0]/;
const ATTR_ESCAPE = /["&\u00a0]/g;
const escapeAttrChar = (c: string) =>
	c === '"' ? "&quot;" : c === "&" ? "&amp;" : "&nbsp;";
const STREAM_SLICE = 32 * 1024;

/**
 * Rewrites a document as it arrives, one tag at a time: rewriting only ever
 * looks at an element's own attributes and text, so nothing needs a tree.
 * Kaze's scripts go out right after <head>, or, when the page leaves out
 * <html> or <head> (both optional), just before its first real content: the
 * first tag or text after the doctype, comments and whitespace. The browser
 * then opens the implied <html> and <head> for kaze's scripts, so they still
 * run before any page script, and the doctype still comes first.
 *
 * Input whose start the parser can't place that way (an end tag before any
 * content) is buffered and goes through rewriteHtml.
 */
class StreamingHtmlRewriter implements Partial<Handler> {
	private mode: "preamble" | "html" | "streaming" | "buffer" = "preamble";
	private parser: Parser;
	private input: string[] = [];
	private out: string[] = [];
	private held: string[] = [];
	private stack: string[] = [];
	private capture: Element | null = null;
	private captureText: string[] = [];

	constructor(
		private readonly context: KazeContext,
		private readonly meta: URLMeta,
		private readonly htmlcontext: HtmlContext,
		fragment = false,
		private readonly unrewriting = false
	) {
		if (fragment) this.mode = "streaming";
		this.parser = new Parser(this, {
			startingForeignContext: htmlcontext.foreignContext,
		});
	}

	write(html: string): string {
		if (this.mode !== "streaming") this.input.push(html);
		if (this.mode !== "buffer") this.parser.write(html);
		return this.drain();
	}

	end(): string {
		if (this.mode === "streaming") {
			this.parser.end();
			return this.drain();
		}
		return rewriteHtml(
			this.input.join(""),
			this.context,
			this.meta,
			this.htmlcontext
		);
	}

	private drain(): string {
		if (this.out.length === 0) return "";
		const s = this.out.join("");
		this.out = [];
		return s;
	}

	private sink(s: string) {
		if (this.mode === "streaming") this.out.push(s);
		else this.held.push(s);
	}

	private fallback() {
		this.mode = "buffer";
		this.held = [];
	}

	/** the element as the rewriter leaves it, or as the page wrote it */
	private process(el: Element): any {
		if (!this.unrewriting)
			return traverseParsedHtml(el, this.context, this.meta);
		for (const key in el.attribs) {
			if (key === "kaze-attr-script-source-src") {
				const child = el.children[0];
				if (child && "data" in child) child.data = atob(el.attribs[key]);
				continue;
			}
			if (key.startsWith("kaze-attr-")) {
				el.attribs[key.slice("kaze-attr-".length)] = el.attribs[key];
				delete el.attribs[key];
			}
		}
		return el;
	}

	private openTag(name: string, attribs: Record<string, string>): string {
		const node = this.process(new Element(name, attribs));
		if (
			node.type !== ElementType.Comment &&
			name !== "svg" &&
			name !== "math"
		) {
			// same bytes as dom-serializer for an html element, without its options walk
			let tag = "<" + name;
			const attrs = node.attribs;
			for (const key of Object_keys(attrs)) {
				const value = attrs[key] ?? "";
				tag += " " + key;
				if (value !== "")
					tag +=
						'="' +
						(RegExp_exec(ATTR_NEEDS_ESCAPE, value) === null
							? value
							: value.replace(ATTR_ESCAPE, escapeAttrChar)) +
						'"';
			}
			return tag + ">";
		}
		const s = render(node, renderOptions);
		if (VOID_ELEMENTS.has(name) || node.type === ElementType.Comment) return s;
		// render() closed the empty element; children are still to come
		if (s.endsWith("/>")) return s.slice(0, -2).trimEnd() + ">";
		return s.slice(0, -(name.length + 3));
	}

	private commit(head: string) {
		const script = (src: string) =>
			new Element("script", { src, "kaze-injected": "true" });
		const inject = this.htmlcontext.loadScripts
			? this.context.interface.getInjectScripts(
					this.meta,
					new DomHandler(),
					this.htmlcontext,
					script
				)
			: [];
		this.mode = "streaming";
		this.out.push(...this.held, head, render(inject, renderOptions));
		this.held = [];
		this.input = [];
	}

	onopentag(name: string, attribs: Record<string, string>) {
		if (this.mode === "buffer") return;
		if (this.mode === "preamble" && name === "html") {
			this.sink(this.openTag(name, attribs));
			this.mode = "html";
			this.stack.push(name);
			return;
		}
		if (this.mode === "preamble" || this.mode === "html") {
			if (name === "head") {
				this.stack.push(name);
				this.commit(this.openTag(name, attribs));
				return;
			}
			// the first real content: kaze goes in the head it implies
			this.commit("");
		}
		if (name === "script" || name === "style") {
			this.capture = new Element(name, attribs, []);
			this.captureText = [];
			this.stack.push(name);
			return;
		}
		this.sink(this.openTag(name, attribs));
		if (!VOID_ELEMENTS.has(name)) this.stack.push(name);
	}

	onclosetag(name: string) {
		if (this.mode === "buffer") return;
		// an end tag before any content: let the tree-based rewriter place kaze
		if (this.mode !== "streaming") return this.fallback();
		if (this.capture && name === this.capture.name) {
			const el = this.capture;
			this.capture = null;
			if (this.captureText.length) {
				const child = new Text(this.captureText.join(""));
				child.parent = el;
				el.children.push(child);
			}
			this.stack.pop();
			this.sink(render(this.process(el), renderOptions));
			return;
		}
		if (VOID_ELEMENTS.has(name)) return;
		this.stack.pop();
		this.sink(`</${name}>`);
	}

	ontext(data: string) {
		if (this.mode === "buffer") return;
		if (this.capture) {
			this.captureText.push(data);
			return;
		}
		if (this.mode !== "streaming") {
			// whitespace before content is dropped by the parser: keep holding
			if (RegExp_exec(ONLY_WHITESPACE, data) !== null) {
				this.sink(data);
				return;
			}
			this.commit("");
		}
		// nothing dom-serializer would escape
		if (RegExp_exec(TEXT_NEEDS_ESCAPE, data) === null) {
			this.sink(data);
			return;
		}
		const text = new Text(data);
		// script-like parents decide whether dom-serializer escapes the text
		const top = this.stack[this.stack.length - 1];
		if (top) text.parent = { name: top } as unknown as Element;
		this.sink(render(text, renderOptions));
	}

	oncomment(data: string) {
		if (this.mode === "buffer" || this.capture) return;
		this.sink(render(new Comment(data), renderOptions));
	}

	onprocessinginstruction(name: string, data: string) {
		if (this.mode === "buffer") return;
		this.sink(render(new ProcessingInstruction(name, data), renderOptions));
	}

	oncdatastart() {
		if (this.mode !== "buffer") this.sink("<![CDATA[");
	}

	oncdataend() {
		if (this.mode !== "buffer") this.sink("]]>");
	}
}

export function canStreamHtml(context: KazeContext): boolean {
	const html = context.hooks?.rewriter.html;
	return (
		!!html &&
		!html.pre.tap.callbacks[html.pre.key]?.length &&
		!html.post.tap.callbacks[html.post.key]?.length
	);
}

export function rewriteHtmlStream(
	body: ReadableStream<Uint8Array>,
	contentType: string | null,
	context: KazeContext,
	meta: URLMeta,
	htmlcontext: HtmlContext
): ReadableStream<Uint8Array> {
	const reader = body.getReader();
	const rewriter = new StreamingHtmlRewriter(context, meta, htmlcontext);
	let decoder: TextDecoder | null = null;
	let head: Uint8Array[] = [];
	let headSize = 0;
	let queued = "";
	let sourceDone = false;

	const startDecoder = () => {
		const all = new Uint8Array(headSize);
		let off = 0;
		for (const c of head) {
			all.set(c, off);
			off += c.byteLength;
		}
		head = [];
		decoder = new _TextDecoder(sniffEncoding(all, contentType));
		return decoder!.decode(all, { stream: true });
	};

	// eslint-disable-next-line kaze-core/no-globals
	return new ReadableStream<Uint8Array>(
		{
			async pull(controller) {
				for (;;) {
					if (queued) {
						// bounded slices keep the main thread free for the page
						const slice = queued.slice(0, STREAM_SLICE);
						queued = queued.slice(STREAM_SLICE);
						const out = rewriter.write(slice);
						if (out) {
							controller.enqueue(TextEncoder_encode(out));
							return;
						}
						continue;
					}
					if (sourceDone) {
						const out = rewriter.end();
						if (out) controller.enqueue(TextEncoder_encode(out));
						controller.close();
						return;
					}
					const { done, value } = await reader.read();
					if (done) {
						sourceDone = true;
						queued = decoder
							? decoder.decode()
							: startDecoder() + decoder!.decode();
						continue;
					}
					if (decoder) {
						queued = decoder.decode(value, { stream: true });
						continue;
					}
					// the charset prescan looks at the first 1024 bytes
					head.push(value);
					headSize += value.byteLength;
					if (headSize >= 1024) queued = startDecoder();
				}
			},
			cancel(reason) {
				return reader.cancel(reason);
			},
		},
		{ highWaterMark: 0 }
	);
}

// attribute name -> [rule index, tags] for every rule that mentions it,
// in rule order (rules apply in that order, like the original nested loop)
type AttrRule = { order: number; tags: "*" | string[] };
let attrRuleIndex: Map<string, AttrRule[]> | null = null;
function getAttrRuleIndex() {
	if (attrRuleIndex) return attrRuleIndex;
	const index: Map<string, AttrRule[]> = new _Map();
	htmlRules.forEach((rule, order) => {
		for (const attr in rule) {
			const sel = rule[attr.toLowerCase()];
			if (typeof sel === "function" || sel === undefined) continue;
			let list = index.get(attr);
			if (!list) index.set(attr, (list = []));
			list.push({ order, tags: sel });
		}
	});
	attrRuleIndex = index;
	return index;
}

/** flat [attr, fn, attr, fn, ...] in rule order, or null when nothing applies */
function rulesForAttribs(
	tag: string,
	attribs: Record<string, string>
): unknown[] | null {
	const index = getAttrRuleIndex();
	let hits: [number, string][] | null = null;
	for (const attr in attribs) {
		const rules = index.get(attr);
		if (!rules) continue;
		for (const r of rules) {
			if (r.tags === "*" || r.tags.includes(tag))
				(hits ??= []).push([r.order, attr]);
		}
	}
	if (!hits) return null;
	if (hits.length > 1) hits.sort((a, b) => a[0] - b[0]);
	const out: unknown[] = [];
	for (const [order, attr] of hits) out.push(attr, htmlRules[order].fn);
	return out;
}

// i need to add the attributes in during rewriting

function traverseParsedHtml(node: any, context: KazeContext, meta: URLMeta) {
	if (node.name === "base" && node.attribs.href !== undefined) {
		meta.base = new _URL(node.attribs.href, meta.origin);
	}

	if (node.attribs) {
		// same semantics as walking every rule x attribute, but only touches the
		// rules for attributes this element actually has
		const matched = rulesForAttribs(node.name, node.attribs);
		if (matched) {
			for (let i = 0; i < matched.length; i += 2) {
				const attr = matched[i] as string;
				const fn = matched[i + 1] as (typeof htmlRules)[number]["fn"];
				if (node.attribs[attr] === undefined) continue;
				const value = node.attribs[attr];
				const v = fn(value, context, meta, node.attribs);

				if (v === null) delete node.attribs[attr];
				else {
					node.attribs[attr] = v;
				}
				node.attribs[`kaze-attr-${attr}`] = value;
			}
		}
		for (const [attr, value] of Object_entries(node.attribs)) {
			if (eventAttributeSet.has(attr)) {
				node.attribs[`kaze-attr-${attr}`] = value;
				node.attribs[attr] = rewriteJs(
					value as string,
					`(inline ${attr} on element)`,
					context,
					meta
				);
			}
		}
	}

	if (node.name === "style" && node.children[0] !== undefined)
		node.children[0].data = rewriteCss(node.children[0].data, context, meta);

	if (
		node.name === "script" &&
		node.attribs.type?.toLowerCase() === "importmap" &&
		node.children[0] !== undefined
	) {
		const json = node.children[0].data;
		try {
			const map = JSON_parse(json);
			if (map.imports) {
				for (const key in map.imports) {
					let url = map.imports[key];
					if (typeof url === "string") {
						url = rewriteUrl(url, context, meta, { isModule: true });
						map.imports[key] = url;
					}
				}
			}

			node.children[0].data = JSON_stringify(map);
		} catch (e) {
			dbg.error("Failed to parse importmap JSON:", e);
		}
	}
	if (
		node.name === "script" &&
		node.attribs &&
		node.children[0] !== undefined
	) {
		const scriptBlockType = getScriptBlockTypeString(
			"type" in node.attribs ? node.attribs.type : undefined,
			"language" in node.attribs ? node.attribs.language : undefined,
			"type" in node.attribs,
			"language" in node.attribs
		);
		if (isScriptType(scriptBlockType)) {
			const source: string = node.children[0].data;
			const module = isModuleScriptType(scriptBlockType);
			const htmlcomment = /<!--[\s\S]*?-->/g;
			const rewritten = rewriteJs(
				source.replace(htmlcomment, ""),
				"(inline script element)",
				context,
				meta,
				module
			);
			node.children[0].data = rewritten;
			// textContent / innerHTML / outerHTML read the original back from this
			// attribute. When rewriting changed nothing the element's own text is
			// the original, so don't ship every inline script twice (+33% base64).
			if (rewritten === source) {
				delete node.attribs["kaze-attr-script-source-src"];
			} else {
				node.attribs["kaze-attr-script-source-src"] = bytesToBase64(
					TextEncoder_encode(source)
				);
			}
		}
	}

	if (node.name === "meta" && node.attribs["http-equiv"] !== undefined) {
		if (
			node.attribs["http-equiv"].toLowerCase() === "content-security-policy"
		) {
			// just delete it. this needs to be emulated eventually but like
			node = new Comment(node.attribs.content);
		} else if (node.attribs["http-equiv"].toLowerCase() === "refresh") {
			const refresh = parseDeclarativeRefresh(node.attribs.content || "");
			if (refresh && refresh.url !== null && refresh.url.length > 0) {
				const rewritten = rewriteUrl(refresh.url.trim(), context, meta);
				node.attribs.content =
					node.attribs.content.slice(0, refresh.urlStart) +
					rewritten +
					node.attribs.content.slice(refresh.urlEnd);
			}
		}
	}

	if (node.childNodes) {
		for (const childNode in node.childNodes) {
			node.childNodes[childNode] = traverseParsedHtml(
				node.childNodes[childNode],
				context,
				meta
			);
		}
	}

	return node;
}

export function rewriteSrcset(
	srcset: string,
	context: KazeContext,
	meta: URLMeta
) {
	const sources = srcset.split(/ .*,/).map((src) => src.trim());
	const rewrittenSources = sources.map((source) => {
		// Split into URLs and descriptors (if any)
		// e.g. url0, url1 1.5x, url2 2x
		const [url, ...descriptors] = source.split(/\s+/);

		// Rewrite the URLs and keep the descriptors (if any)
		const rewrittenUrl = rewriteUrl(url.trim(), context, meta);

		return descriptors.length > 0
			? `${rewrittenUrl} ${descriptors.join(" ")}`
			: rewrittenUrl;
	});

	return rewrittenSources.join(", ");
}

// function base64ToBytes(base64) {
// 	const binString = atob(base64);

// 	return Uint8Array.from(binString, (m) => m.codePointAt(0));
// }

const eventAttributes = [
	"onbeforexrselect",
	"onabort",
	"onbeforeinput",
	"onbeforematch",
	"onbeforetoggle",
	"onblur",
	"oncancel",
	"oncanplay",
	"oncanplaythrough",
	"onchange",
	"onclick",
	"onclose",
	"oncontentvisibilityautostatechange",
	"oncontextlost",
	"oncontextmenu",
	"oncontextrestored",
	"oncuechange",
	"ondblclick",
	"ondrag",
	"ondragend",
	"ondragenter",
	"ondragleave",
	"ondragover",
	"ondragstart",
	"ondrop",
	"ondurationchange",
	"onemptied",
	"onended",
	"onerror",
	"onfocus",
	"onformdata",
	"oninput",
	"oninvalid",
	"onkeydown",
	"onkeypress",
	"onkeyup",
	"onload",
	"onloadeddata",
	"onloadedmetadata",
	"onloadstart",
	"onmousedown",
	"onmouseenter",
	"onmouseleave",
	"onmousemove",
	"onmouseout",
	"onmouseover",
	"onmouseup",
	"onmousewheel",
	"onpause",
	"onplay",
	"onplaying",
	"onprogress",
	"onratechange",
	"onreset",
	"onresize",
	"onscroll",
	"onsecuritypolicyviolation",
	"onseeked",
	"onseeking",
	"onselect",
	"onslotchange",
	"onstalled",
	"onsubmit",
	"onsuspend",
	"ontimeupdate",
	"ontoggle",
	"onvolumechange",
	"onwaiting",
	"onwebkitanimationend",
	"onwebkitanimationiteration",
	"onwebkitanimationstart",
	"onwebkittransitionend",
	"onwheel",
	"onauxclick",
	"ongotpointercapture",
	"onlostpointercapture",
	"onpointerdown",
	"onpointermove",
	"onpointerrawupdate",
	"onpointerup",
	"onpointercancel",
	"onpointerover",
	"onpointerout",
	"onpointerenter",
	"onpointerleave",
	"onselectstart",
	"onselectionchange",
	"onanimationend",
	"onanimationiteration",
	"onanimationstart",
	"ontransitionrun",
	"ontransitionstart",
	"ontransitionend",
	"ontransitioncancel",
	"oncopy",
	"oncut",
	"onpaste",
	"onscrollend",
	"onscrollsnapchange",
	"onscrollsnapchanging",
];

const eventAttributeSet: Set<string> = new _Set(eventAttributes);
