# Add kaze to a website

Put a working proxied browser on any page. Moving from Scramjet instead? See [MIGRATING.md](./MIGRATING.md).

## Node sites (Express, Connect, plain `http`)

```sh
npm install @kaze/embed
```

```js
import express from "express";
import { kaze } from "@kaze/embed";

const app = express();
const proxy = kaze();
app.use(proxy);

const server = app.listen(8080);
proxy.attach(server); // handles the wisp websocket at /wisp/
```

Then add this to any page:

```html
<script src="/kaze-assets/kaze-embed.js" defer></script>
<div data-kaze="https://example.com" style="height: 600px"></div>
```

That's the whole integration. kaze runs in the `div`, starting at that URL. Leave the attribute empty (`data-kaze`) to start blank.

## Static sites (no server of your own)

Copy the files into your public folder:

```sh
npx @kaze/embed copy ./public
```

This adds `public/kaze-assets/` and `public/kaze-sw.js`. Keep `kaze-sw.js` at the site root.

A static host can't run wisp, so point kaze at a wisp server you have access to:

```html
<script
	src="/kaze-assets/kaze-embed.js"
	data-wisp="wss://wisp.example.com/"
	defer
></script>
<div data-kaze="https://example.com" style="height: 600px"></div>
```

## Controlling it from JavaScript

```js
const browser = await Kaze.mount("#box", { url: "https://example.com" });

browser.go("wikipedia.org"); // full URLs, bare domains, or search terms
browser.back();
browser.forward();
browser.reload();

browser.url; // the current page
const stop = browser.onUrlChange((url) => console.log(url));
```

`Kaze.mount` also takes `wisp` for a per-frame wisp server, and `title` for the iframe's accessible name. Add as many browsers as you like; they share one engine.

## Server options

`kaze(options)`, all optional:

| Option            | Default         | What it does                              |
| ----------------- | --------------- | ----------------------------------------- |
| `assetsPath`      | `/kaze-assets/` | Where the files are served                |
| `swPath`          | `/kaze-sw.js`   | Where the service worker is served        |
| `wispPath`        | `/wisp/`        | Path that `attach` answers on             |
| `allowPrivateIps` | `false`         | Let proxied sites reach private addresses |
| `allowLoopback`   | `false`         | Let proxied sites reach this machine      |

If you change `swPath`, tell the page: `<script src="…/kaze-embed.js" data-sw="/your-sw.js" defer>`.

Leave `allowPrivateIps` and `allowLoopback` off on anything public. With them on, anyone using your proxy can reach your internal network.

## Requirements

- **HTTPS** in production. Browsers only allow service workers on HTTPS or `localhost`.
- **Same origin.** `kaze-assets` and `kaze-sw.js` must come from your site's own origin, not a CDN. The script tells you if they don't.
- **A Content-Security-Policy, if you have one,** must allow `worker-src 'self'`, `frame-src 'self'`, and `script-src` with `'wasm-unsafe-eval'` and `'unsafe-eval'`.
- **Your own service worker is safe.** kaze's is scoped to `/~/kz/`, so it only sees proxied pages.

## Check that it works

Load the page and open the browser console. Failed setups log a `kaze:` message saying what's wrong, and show it in the `div`.
