import { rewriteCss } from "@rewriters/css";
import { KazeClient } from "@client/index";

export default function (client: KazeClient, _self: Self) {
	client.Proxy("FontFace", {
		construct(ctx) {
			if (typeof ctx.args[1] !== "string") return;
			ctx.args[1] = rewriteCss(ctx.args[1], client.context, client.meta);
		},
	});
}
