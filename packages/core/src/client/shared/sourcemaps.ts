import {
	Object_defineProperty,
	Number_isSafeInteger,
	Error,
	ArrayBuffer_isView,
	_Uint8Array,
} from "@/shared/snapshot";
import { KAZECLIENT, KAZECLIENTNAME } from "@/symbols";
import { base64ToBytes } from "@/shared/util";
import { ProxyCtx, KazeClient } from "@client/index";

enum RewriteType {
	Insert = 0,
	Replace = 1,
}

type Rewrite = {
	start: number;
} & (
	| {
			type: RewriteType.Insert;
			size: number;
	  }
	| {
			type: RewriteType.Replace;
			end: number;
			str: string;
	  }
);

// raw maps are stored as pushed (base64 string / bytes) and only parsed the
// first time Function.prototype.toString needs them, which is rare
type RawSourceMap = string | Uint8Array | Array<number>;
export type SourceMaps = Record<string, Rewrite[] | RawSourceMap>;

function getEnd(rewrite: Rewrite): number {
	if (rewrite.type === RewriteType.Insert) {
		return rewrite.start + rewrite.size;
	} else if (rewrite.type === RewriteType.Replace) {
		return rewrite.end;
	}
	throw "unreachable";
}

function getRewrites(client: KazeClient, tag: string): Rewrite[] | undefined {
	const entry = client.box.sourcemaps[tag];
	if (entry === undefined) return undefined;
	if (
		typeof entry === "string" ||
		ArrayBuffer_isView(entry) ||
		(entry.length > 0 && typeof entry[0] === "number")
	) {
		const rewrites = parseRewrites(entry as RawSourceMap);
		client.box.sourcemaps[tag] = rewrites;

		return rewrites;
	}

	return entry as Rewrite[];
}

function parseRewrites(raw: RawSourceMap): Rewrite[] {
	const sourcemap =
		typeof raw === "string"
			? base64ToBytes(raw)
			: ArrayBuffer_isView(raw)
				? (raw as Uint8Array)
				: _Uint8Array.from(raw as Array<number>);
	const view = new DataView(
		sourcemap.buffer,
		sourcemap.byteOffset,
		sourcemap.byteLength
	);
	const decoder = new TextDecoder("utf-8");

	const rewrites: Rewrite[] = [];

	const rewritelen = view.getUint32(0, true);
	let cursor = 4;
	for (let i = 0; i < rewritelen; i++) {
		const start = view.getUint32(cursor, true);
		cursor += 4;
		const size = view.getUint32(cursor, true);
		cursor += 4;

		const type = view.getUint8(cursor) as RewriteType;
		cursor += 1;

		if (type == RewriteType.Insert) {
			rewrites.push({ type, start, size });
		} else if (type == RewriteType.Replace) {
			const end = start + size;

			const oldLen = view.getUint32(cursor, true);
			cursor += 4;

			const oldStr = decoder.decode(
				sourcemap.subarray(cursor, cursor + oldLen)
			);

			rewrites.push({ type, start, end, str: oldStr });
			cursor += oldLen;
		}
	}

	return rewrites;
}

const SCRAMTAG = "/*scramtag ";

function extractTag(fn: string): [string, number, number] | null {
	// every function rewritten will have a scramtag comment
	// it will look like this:
	// function name()[possible whitespace]/*scramtag [index] [tag]*/[possible whitespace]{ ... }

	const start = fn.indexOf(SCRAMTAG);
	// no scramtag, probably native function or stolen from kaze
	if (start === -1) return null;

	const end = fn.indexOf("*/", start);
	if (end === -1) {
		dbg.error("unreachable", fn, start, end);
		throw new Error("unreachable");
	}

	const tag = fn.substring(start + 2, end).split(" ");

	if (
		tag.length !== 3 ||
		tag[0] !== "scramtag" ||
		!Number_isSafeInteger(+tag[1])
	) {
		dbg.error("invalid tag", fn, start, end, tag);
		throw new Error("invalid tag");
	}

	return [tag[2], start, +tag[1]];
}

function doUnrewrite(
	client: KazeClient,
	ctx: ProxyCtx<"Function.prototype.toString", "apply">
) {
	const stringified: string = ctx.fn.call(ctx.this);

	const extracted = extractTag(stringified);
	if (!extracted) return ctx.return(stringified);
	const [tag, tagOffset, tagStart] = extracted;

	const fnStart = tagStart - tagOffset;
	const fnEnd = fnStart + stringified.length;
	const rewrites = getRewrites(client, tag);

	if (!rewrites) {
		dbg.warn("failed to get rewrites for tag", tag);

		return ctx.return(stringified);
	}

	let i = 0;
	// skip all rewrites in the file before the fn
	while (i < rewrites.length) {
		if (rewrites[i].start < fnStart) i++;
		else break;
	}

	let end = i;
	while (end < rewrites.length) {
		if (getEnd(rewrites[end]) < fnEnd) end++;
		else break;
	}
	const fnrewrites = rewrites.slice(i, end);

	let newString = "";
	let lastpos = 0;

	for (const rewrite of fnrewrites) {
		newString += stringified.slice(lastpos, rewrite.start - fnStart);

		if (rewrite.type === RewriteType.Insert) {
			lastpos = rewrite.start + rewrite.size - fnStart;
		} else if (rewrite.type === RewriteType.Replace) {
			newString += rewrite.str;
			lastpos = rewrite.end - fnStart;
		} else {
			throw "unreachable";
		}
	}

	newString += stringified.slice(lastpos);
	newString = newString.replace(`${SCRAMTAG}${tagStart} ${tag}*/`, "");

	return ctx.return(newString);
}

// always installed: besides unrewriting, the toString trap below is what keeps
// kaze's proxies of native functions stringifying as native code
export default function (client: KazeClient, self: Self) {
	const sourcemaps = client.flagEnabled("sourcemaps");
	// every script will push a sourcemap
	Object_defineProperty(self, client.config.globals.pushsourcemapfn, {
		value: (buf: RawSourceMap, tag: string) => {
			// parsed lazily in getRewrites
			client.box.sourcemaps[tag] = buf;
		},
		enumerable: false,
		writable: false,
		configurable: false,
	});

	// when we rewrite javascript it will make function.toString leak internals
	// this can lead to double rewrites which is bad
	client.Proxy("Function.prototype.toString", {
		apply(ctx) {
			if (client.box.unproxy.has(ctx.this)) {
				// toString is being called on a proxy of a native function
				// `this` will then be the proxy, which has the wrong [[SourceText]]
				// unproxy so it passes through
				ctx.this = client.box.unproxy.get(ctx.this)!;
				// since we know it's a native function, no need to unrewrite
				return;
			}
			// without sourcemaps no scramtags are emitted, nothing to unrewrite
			if (!sourcemaps) return;
			// const before = performance.now();
			doUnrewrite(client, ctx);
			// dbg.time(client.meta, before, `scramtag unrewrite for ${ctx.fn.name}`);
		},
	});
}
