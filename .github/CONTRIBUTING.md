# Contributing

## Setup

There is nothing to install to run it: open `index.html`. To run the tests:

```bash
export TZ=America/Toronto                       # two clock-change checks need a zone with daylight saving
for t in test/*.js; do [ "$t" = test/tactics.js ] || node "$t" || break; done   # as CI runs them
pip install playwright==1.62.0 && playwright install chromium
python test/ui_check.py                         # drives index.html in Chromium
python tools/build_single_file.py && python test/dist_check.py   # the single-file build, on its own
python test/coverage_report.py --out coverage.html               # exits 1 if any suite failed

pip install chess==1.11.2                           # the engine from the outside, over UCI
python test/engine_gauntlet.py legality             # 1,000 positions: legal, and within movetime + 150 ms
python test/engine_gauntlet.py mates --min-mate1 100 --min-mate2 100   # test/epd/mate1.epd and mate2.epd
python test/engine_gauntlet.py random               # 100 games vs random, 50 vs greedy
python test/engine_gauntlet.py stockfish --stockfish path/to/stockfish   # 20 games at 0.1 s
```

CI runs the gauntlet with `mates --movetime 1000 --min-mate1 100 --min-mate2 95` (100 of
100 for both here, about five minutes; 95 leaves room for a slower runner) and the quicker
`random --games 20`.

`TZ` set from a Unix shell reaches Node. On Windows, a `TZ` exported in Git Bash does not
reach a Node that is not an MSYS program (VS Code's `Code.exe` run as Node, for one), which
reads the system zone instead; in a zone without daylight saving the two clock-change
checks print SKIP (and fail under `CI`). `tactics.js`, `tools/bench.js`
and `tools/acpl.js` measure strength and speed by the clock, so they are run by hand, not in
CI: see the guide.

## Three things that will catch you out

**It must keep working from `file://`.** That is why there is no build step and no
modules: every file is a plain script that sets a global. It is also why Stockfish
ships as a string (`js/vendor/stockfish-src.js`) and runs in a worker made from a
Blob: a double-clicked page can load neither a worker by URL nor a `.wasm` file.
Anything that needs `fetch()` of a local file will work on GitHub Pages and fail
for the person who downloaded it.

**Engine searches run on a copy of the game.** `rankAsync` yields to the event loop
between root moves, so a search on the live `Chess` object would interleave with
moves the user plays meanwhile — that corrupted the board once. Search
`new Chess(g.fen())`, and drop any engine answer whose position is no longer on
the board (`stillCurrent` in `ui.js`).

**Everything read back from storage or a backup is untrusted.** A backup is a file
anyone can edit, and its fields reach `innerHTML` and `href`. New fields go through
`cleanGame` / `cleanTrack` / `cleanCards` in `ui.js`, and every string rendered into
markup goes through `esc()`.

## Tests

Each bug fixed gets a check in `test/regress.js` (Node) or `test/ui_check.py`
(browser), written to fail on the code before the fix. Watch it fail first: a
check that passes on the broken code proves nothing.
