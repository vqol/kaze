# Migrating from Scramjet to kaze

kaze is a fork of Scramjet. Most sites only need to swap which script they load.

## From Scramjet 1.x

### 1. Serve kaze's files

On a Node server:

```js
import { kaze } from "@kaze/embed";
const proxy = kaze();
app.use(proxy); // serves /kaze-assets/
```

Keep your existing wisp server. Only call `proxy.attach(server)` if you want kaze to host wisp too.

On a static host, run `npx @kaze/embed copy ./public` and delete the generated `public/kaze-sw.js`, since you already have a service worker.

### 2. Swap the scripts

Run this from your project. It shows what it would change, and changes nothing until you add `--write`:

```sh
npx @kaze/embed migrate .
npx @kaze/embed migrate . --write
```

To do it by hand, change two lines:

```diff
  <!-- your page -->
- <script src="/scram/scramjet.all.js"></script>
+ <script src="/kaze-assets/scramjet-compat.js"></script>
```

```diff
  // your service worker
- importScripts("/scram/scramjet.all.js");
+ importScripts("/kaze-assets/scramjet-compat.js");
```

If `kaze-assets` isn't at `/kaze-assets/`, set `self.KAZE_ASSETS = "/your/path/";` before that `importScripts`.

The rest of your code keeps working: `$scramjetLoadController`, `ScramjetController`, `init()`, `createFrame()`, `frame.go()`, `back()`, `forward()`, `reload()`, the `urlchange` and `navigate` events, `$scramjetLoadWorker`, `ScramjetServiceWorker`, and your `BareMux.BareMuxConnection` `setTransport()` call. kaze reads your wisp URL from that call.

### 3. What needs changing

| If you use                                                         | Do this                                                               |
| ------------------------------------------------------------------ | --------------------------------------------------------------------- |
| `scramjet.encodeUrl(url)`                                          | Use `frame.go(url)`. kaze URLs belong to a frame, so this one throws. |
| The `download` event                                               | Not sent by the compatibility layer yet.                              |
| `frame.client`                                                     | Not available. Use the iframe's `contentWindow`.                      |
| `flags`, `prefix`, `codec`, `files` passed to `ScramjetController` | Ignored. kaze uses its own.                                           |
| Saved links to old proxied URLs                                    | They won't resolve. kaze's URLs are under `/~/kz/`.                   |

### 4. Test it

Load your site and open a few pages. Requests should appear under `/~/kz/` in the network panel. You can then remove the old `/scram/` and bare-mux files.

### Optional: drop the compatibility layer

Replace your setup code with the one-liner in the [README](./README.md):

```html
<script src="/kaze-assets/kaze-embed.js" defer></script>
<div data-kaze="https://example.com" style="height: 600px"></div>
```

| Scramjet 1.x                                  | kaze                                |
| --------------------------------------------- | ----------------------------------- |
| `new ScramjetController(...)`, `await init()` | not needed                          |
| `createFrame(iframe)`                         | `await Kaze.mount(element)`         |
| `frame.go(url)`                               | `browser.go(url)`                   |
| `frame.back()`, `forward()`, `reload()`       | same names on `browser`             |
| `frame.addEventListener("urlchange", …)`      | `browser.onUrlChange(url => …)`     |
| `frame.frame`                                 | `browser.iframe`                    |
| `BareMux...setTransport(..., [{ wisp }])`     | `data-wisp="wss://…"` on the script |
| Your service worker file                      | `kaze-sw.js`, generated for you     |

## From Scramjet 2 (alpha)

kaze has the same controller design, so this is a set of renames. `migrate` leaves these files alone and tells you which ones they are.

| Scramjet 2                                  | kaze                     |
| ------------------------------------------- | ------------------------ |
| `$scramjetController`                       | `$kazeController`        |
| `$scramjet`                                 | `$kaze`                  |
| `config.scramjetPath`                       | `config.kazePath`        |
| `scramjetConfig`                            | `kazeConfig`             |
| `scramjet.js`, `scramjet.wasm`              | `kaze.js`, `kaze.wasm`   |
| `/~/sj/`                                    | `/~/kz/`                 |
| `scramjet-attr-*`, `$scramjet$*` in plugins | `kaze-attr-*`, `$kaze$*` |

To get kaze's speed, also switch your transport so requests leave the page's thread:

```diff
- transport: new LibcurlTransport.LibcurlClient({ wisp }),
+ transport: new $kazeController.WorkerTransport({
+   scripts: ["/libcurl/index.js"],
+   construct: "LibcurlTransport.LibcurlClient",
+   options: { wisp },
+ }),
```

Frames created with `plugins` keep running on the page's thread so plugin hooks still work.
