importScripts("/controller/controller.sw.js");

addEventListener("fetch", (e) => {
	if ($kazeController.shouldRoute(e)) {
		e.respondWith($kazeController.route(e));
	}
});
