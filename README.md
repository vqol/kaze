<h1 align="center">kaze</h1>

kaze is an interception-based web proxy: it sandboxes arbitrary web content in the browser by intercepting requests in a service worker and rewriting HTML, CSS and JavaScript on the fly. Traffic goes through a [wisp](https://github.com/MercuryWorkshop/wisp-protocol) server.

kaze is a fork of [Scramjet](https://github.com/MercuryWorkshop/scramjet) by Mercury Workshop, renamed and tuned for page-load speed. It is licensed under the AGPL-3.0, like the original.

## Packages

| Package                                                          | What it is                                                      |
| ---------------------------------------------------------------- | --------------------------------------------------------------- |
| `packages/core` (`@kaze/core`)                                   | Rewriter (Rust/oxc → wasm), fetch handler and client runtime    |
| `packages/controller` (`@kaze/controller`)                       | Service worker + controller that wires frames to a transport    |
| `packages/site` (`@kaze/site`)                                   | Minimal black-and-white search page with a built-in wisp server |
| `packages/runway`                                                | Playwright correctness suite (and load benchmark)               |
| `packages/utils`, `bootstrap`, `rpc`, `demo`, `create-proxy-app` | Supporting packages and the full demo                           |

## Development

### Dependencies

- Node.js 23 or later and `pnpm`
- `rustup` (the nightly toolchain is selected automatically)
- `wasm-bindgen` 0.2.105
- [Binaryen's `wasm-opt`](https://github.com/WebAssembly/binaryen)
- [this `wasm-snip` fork](https://github.com/r58Playz/wasm-snip)

### Building

```sh
pnpm i
cd packages/core && RELEASE=1 pnpm rewriter:build && cd ../..
pnpm build   # or: npx rspack build --mode production
```

`RELEASE=1` builds an optimized rewriter (tuned for speed; `OPTIMIZE_FOR_SIZE=1` for a smaller wasm).

### Running

The search page with its wisp server:

```sh
cd packages/site && pnpm start   # http://localhost:8080
```

The full demo with live rebuilds:

```sh
pnpm dev   # http://localhost:4141
```

### Tests

```sh
cd packages/runway
OMIT_WPT=1 node --experimental-strip-types src/index.ts [test-name-filter]
```

Set `RUNWAY_CHANNEL=chrome` to use an installed Chrome instead of Playwright's Chromium.
