// relative, so it works wherever the demo is hosted
importScripts("controller/controller.sw.js");

// the controller prefix lives under this worker's own path
const base = new URL("./", self.location.href).pathname;
$kazeController.addPrefixBase(base + "~/kz/");

addEventListener("install", () => self.skipWaiting());
addEventListener("activate", (e) => e.waitUntil(clients.claim()));

addEventListener("fetch", (e) => {
	if ($kazeController.shouldRoute(e)) {
		e.respondWith($kazeController.route(e));
	}
});
