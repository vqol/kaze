// Inline scripts read back as the page wrote them, whether or not the
// rewriter changed them (unchanged ones don't carry a copy of their source).
import { htmlTest } from "../testcommon.ts";

const unchanged = "var kzA = 1 + 2; // nothing to rewrite";
const changed = "var kzB = location.href;";
const nonAscii = "var kzD = 'héllo ✓';";

export default [
	htmlTest({
		name: "inline-script-source-reads",
		kazeOnly: true,
		html: `<!DOCTYPE html><html><head></head><body>
<div id="wrap"><script id="a">${unchanged}</script></div>
<script id="b">${changed}</script>
<script id="d">${nonAscii}</script>
<script>runTest(() => {
	const cases = ${JSON.stringify({ a: unchanged, b: changed, d: nonAscii }).replace(/</g, "\\u003c")};
	for (const [id, source] of Object.entries(cases)) {
		const el = document.getElementById(id);
		assertEqual(el.textContent, source, id + " textContent");
		assertEqual(el.innerHTML, source, id + " innerHTML");
		assert(el.outerHTML.includes(source), id + " outerHTML: " + el.outerHTML);
	}
	assert(
		document.getElementById("wrap").innerHTML.includes(cases.a),
		"parent innerHTML"
	);
	assertEqual(kzA, 3, "unchanged script ran");
	assertEqual(kzB, location.href, "rewritten script ran");
}, true);</script>
</body></html>`,
	}),
];
