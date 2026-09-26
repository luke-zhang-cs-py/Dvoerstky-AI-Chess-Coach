# Contributing

## Setup

There is nothing to install to run it: open `index.html`. To run the tests:

```bash
node test/perft.js && node test/regress.js     # plus the other test/*.js suites
pip install playwright && playwright install chromium
python test/ui_check.py                         # drives index.html in Chromium
python test/coverage_report.py --out coverage.html
```

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
