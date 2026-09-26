# Vendored: Stockfish.js 10.0.2

`stockfish-src.js` holds **Stockfish.js 10.0.2**, the asm.js build published on npm as
`stockfish@10.0.2` (`src/stockfish.asm.js`), unmodified and wrapped in a JavaScript string.
It is the Stockfish 10 chess engine compiled to plain JavaScript by Nathan Rugg; the engine is
by the Stockfish developers listed in `STOCKFISH-AUTHORS.txt`.

| | |
|---|---|
| wrapped file | `stockfish.asm.js`, 957,535 bytes |
| sha256 | `90e3c0639d41282e6f4cc99c3d3eb0afb67c27910d6d7546cd4f1803134258e4` |
| licence | GNU GPL v3 — `STOCKFISH-COPYING.txt` |
| source | Stockfish.js: <https://github.com/nmrugg/stockfish.js> (tag `v10.0.2`); Stockfish: <https://github.com/official-stockfish/Stockfish> (tag `sf_10`) |

**Why a string.** The app runs by double-clicking `index.html`. A `file://` page cannot load a
worker script by URL or fetch one, but it can build a worker from a `Blob` — so the engine ships
as a string (`window.STOCKFISH_SOURCE`) and `js/stockfish-reader.js` turns it into a worker.
The asm.js build is used rather than a newer WebAssembly one because it is a single file:
WebAssembly builds need a separate `.wasm` fetched at runtime, which `file://` also blocks.

**Regenerate** (and check against the published file):

```bash
curl -sLO https://cdn.jsdelivr.net/npm/stockfish@10.0.2/src/stockfish.asm.js
python js/vendor/make_stockfish_src.py stockfish.asm.js   # prints the sha256 above
```

Stockfish runs as a separate program in its own worker and is spoken to only through UCI text
messages. Its licence travels with it here; the rest of this project is unchanged by it.
