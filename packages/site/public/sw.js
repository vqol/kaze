importScripts("/controller/controller.sw.js");

addEventListener("install", () => self.skipWaiting());
addEventListener("activate", (e) => e.waitUntil(clients.claim()));

addEventListener("fetch", (e) => {
	if ($kazeController.shouldRoute(e)) {
		e.respondWith($kazeController.route(e));
	}
});
