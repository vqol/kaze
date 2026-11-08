import { KazeClient } from "@client/index";

export default function (client: KazeClient, self: Self) {
	client.Trap("Document.prototype.cookie", {
		get() {
			return client.context.cookieJar.getCookies(client.url, true);
		},
		set(ctx, value: string) {
			value = String(value);
			const url = client.url;
			// rejected writes (HttpOnly, bad Domain, ...) must not reach the
			// controller, which would apply them as if they came from a server
			if (!client.context.cookieJar.setCookies(value, url, true)) return;
			client.init.sendSetCookie([
				{
					url,
					cookie: value,
					fromJs: true,
				},
			]);
		},
	});

	// @ts-ignore
	delete self.cookieStore;
}
