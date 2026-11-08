<h1 align="center">kaze</h1>

a web proxy that runs in ur browser. its a fork of [scramjet](https://github.com/MercuryWorkshop/scramjet) by mercury workshop, renamed and tuned to be stupid fast.

## speed

fastest in 34 of 39 tests vs scramjet and ultraviolet, including every page load test. 91 overall (uv 51, scramjet 2 47, scramjet 1.1 37).

all tested on a local wisp server btw, so ur numbers will be diffrent on a real one.

![page load](assets/benchmarks/kaze-bench-1-page-loads.png)

![network](assets/benchmarks/kaze-bench-2-network.png)

![runtime](assets/benchmarks/kaze-bench-3-runtime.png)

still loses on download size (it ships a full js parser), memory, startup and `replaceState`. working on it.

live results are at `/benchmarks/` on the site, it updates every time u run a benchmark.

## add it to ur site

```html
<script src="/kaze-assets/kaze-embed.js" defer></script>
<div data-kaze="https://example.com" style="height: 600px"></div>
```

thats it for the page. setup for ur server is in [packages/embed](packages/embed/README.md).

not on npm yet btw, so build it from here for now:

```sh
cd packages/embed && pnpm build
```

## coming from scramjet

most sites just swap one script. run `node packages/embed/cli.mjs migrate ur-site/` and it shows u what it would change, add `--write` to do it. full guide [here](packages/embed/MIGRATING.md).

## whats in here

| package               | what                                     |
| --------------------- | ---------------------------------------- |
| `packages/core`       | rewriter (rust to wasm), hooks, fetching |
| `packages/controller` | service worker and the fetch engine      |
| `packages/embed`      | one line site setup, scramjet migration  |
| `packages/site`       | search page, wisp server, benchmark site |
| `packages/runway`     | tests and benchmarks                     |

## building

u need node 23+, pnpm, rustup, `wasm-bindgen` 0.2.105, [wasm-opt](https://github.com/WebAssembly/binaryen) and [this wasm-snip fork](https://github.com/r58Playz/wasm-snip).

```sh
pnpm i
cd packages/core && RELEASE=1 pnpm rewriter:build && cd ../..
pnpm build
```

## running

```sh
cd packages/site && pnpm start   # localhost:8080
```

## tests and benchmarks

```sh
cd packages/runway
OMIT_WPT=1 node --experimental-strip-types src/index.ts [filter]
node --experimental-strip-types src/bench/compare.ts
```

add `RUNWAY_CHANNEL=chrome` if u dont have playwright's chromium. the benchmark needs uv and scramjet installed, check the top of `compare.ts`.

## license

AGPL-3.0, same as scramjet. definately go look at their stuff too.
