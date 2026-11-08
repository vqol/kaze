import { KazeClient } from "@client/index";
import { Tap } from "@/Tap";
import { String, _URL } from "@/shared/snapshot";

export default function (client: KazeClient, _self: Self) {
	client.Proxy(
		["History.prototype.pushState", "History.prototype.replaceState"],
		{
			apply(ctx) {
				const relevantclient = client.box.histories.get(ctx.this);
				const url = ctx.args[2] ? String(ctx.args[2]) : undefined;

				// relative urls (most of them) can't change the origin
				const first = url?.[0];
				if (
					url &&
					first !== "/" &&
					first !== "?" &&
					first !== "#" &&
					_URL.canParse(url)
				) {
					const parsedUrl = new _URL(url);
					if (parsedUrl.origin !== relevantclient.url.origin) {
						// TODO: we want to emulate the proper security error here. right now this will leak the origin in the error message
						return ctx.return(undefined);
					}
				}

				if (url || url === "") ctx.args[2] = relevantclient.rewriteUrl(url);
				ctx.call();
				const navigate = relevantclient.hooks.lifecycle.navigate as any;
				if (navigate.tap.callbacks[navigate.key]?.length)
					Tap.dispatch(
						relevantclient.hooks.lifecycle.navigate,
						{
							type: "history",
						},
						{
							url: relevantclient.url.href,
						}
					);
			},
		}
	);
}
