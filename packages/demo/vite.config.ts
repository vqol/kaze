import { viteStaticCopy } from "vite-plugin-static-copy";

// BASE_PATH lets the demo live under a subpath, e.g. a GitHub project page
// at /<repo>/. Defaults to the domain root.
export default {
	base: process.env.BASE_PATH || "/",
	plugins: [
		viteStaticCopy({
			structured: false,
			targets: [
				{
					src: "node_modules/@kaze/core/dist/*",
					dest: "kaze",
				},
				{
					src: "node_modules/@kaze/controller/dist/*",
					dest: "controller",
				},
			],
			watch: {
				reloadPageOnChange: true,
			},
		}),
	],
};
