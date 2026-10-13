# Vendored: Stockfish 19 (Stockfish.js 19.0.1, lite, single-threaded)

`stockfish-19-src.js` holds **Stockfish.js 19.0.1**, the build published on npm as
`stockfish@19.0.1`, in its "lite, single-threaded" flavour: the one its README recommends
("fast and does not require any complicated setup"), and the one that needs no cross-origin
isolation. Two files of the package, both unmodified:

| file in the package | bytes | sha256 | shipped as |
|---|---|---|---|
| `bin/stockfish-19-lite-single.js` (emscripten glue, the UCI front end) | 28,230 | `ccb130d7ff29408531c47d859a49f91d59d4f482d05a53eb1a3231a4f624c91a` | a string, `window.STOCKFISH_SOURCE` |
| `bin/stockfish-19-lite-single.wasm` (the engine, with its small NNUE net) | 1,845,971 | `ee4f115bdb2d32cadf96cada104a05b5ec257d7ad6f57582190b49bc71f096de` | base64, `window.STOCKFISH_WASM` |
| `stockfish-19-src.js` (generated, the file in this folder) | 2,490,755 | `4b81224de91bf43e3b786b188cad3ed0831fab5d21ad2198584d0a4dd754e195` | an ordinary `<script>` |

The tarball, <https://registry.npmjs.org/stockfish/-/stockfish-19.0.1.tgz> (161,366,858 bytes; it
holds all five flavours), is checked against the registry's `dist.integrity`,
`sha512-bTwsO4e9HAwPBKls1+szcfibmaWRNzTF20rQE/XPdB3LOSoT6XTZDr1zYwriwSRRFT5MkvqrglPmJrKEVXGnyQ==`,
before either file is taken from it.

| | |
|---|---|
| engine | Stockfish 19, by the Stockfish developers (`STOCKFISH-AUTHORS.txt`: the `AUTHORS` file of tag `sf_19`, sha256 `59c7a457…1a1eb6`); it answers `id name Stockfish 19 Lite WASM` |
| WebAssembly build | Stockfish.js by Nathan Rugg (the package's author), with Chess.com (its listed contributor); the lite net `nn-61e7af4bb97d` is by Chris Bao (sscg13) |
| licence | GNU GPL v3: `STOCKFISH-COPYING.txt`, identical to the package's `Copying.txt`; the package says `"license": "GPL-3.0"` |
| source | Stockfish.js: <https://github.com/nmrugg/stockfish.js> (v19.0.1); Stockfish: <https://github.com/official-stockfish/Stockfish> (tag `sf_19`) |
| UCI | `Threads` is fixed at 1 (min 1, max 1), so it is never set; no `SyzygyPath` (tablebase probing is left out of the WebAssembly builds); `Hash` 16 MB |

**Why embedded.** The app runs by double-clicking `index.html`. A `file://` page cannot start a
worker from a script URL, and cannot `fetch()` a `.wasm` file, but it can run a `<script>` tag
and build a worker from a `Blob`. So both files ship inside one script, and
`js/stockfish-reader.js` builds the worker from three parts: the base64, a few lines that decode
it and answer the glue's one `fetch()` of `stockfish-19-lite-single.wasm` (the name it reads after
the `#` of the worker's URL) with those bytes as `application/wasm`, and then the glue, untouched.
Nothing is fetched: not from `file://`, not on GitHub Pages, not in the single-file build. (In a
worker the glue always installs its own `instantiateWasm`, which fetches, so `Module.wasmBinary`
cannot be reached from outside without editing the glue; answering its fetch leaves the glue byte
for byte as published.) The old Stockfish.js 10.0.2 was an asm.js build, one file of plain
JavaScript, for the same reason; this is about 2.6 times its size and far stronger.

**Regenerate** (it downloads the tarball, or takes one already downloaded, and refuses one that
does not match):

```bash
python js/vendor/make_stockfish_src.py                         # downloads from the npm registry
curl -sLO https://registry.npmjs.org/stockfish/-/stockfish-19.0.1.tgz
python js/vendor/make_stockfish_src.py stockfish-19.0.1.tgz    # or from a copy you have
```

Either way the output is the same `stockfish-19-src.js`, byte for byte (the sha256 above).
`test/stockfish19.js` checks the two embedded files against the hashes pinned in the script.

Stockfish runs as a separate program in its own worker and is spoken to only through UCI text
messages. Its licence travels with it here; the rest of this project is unchanged by it.
