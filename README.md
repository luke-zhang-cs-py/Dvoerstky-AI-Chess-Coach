# Dvoretsky Lab

[![tests](https://github.com/luke-zhang-cs-py/Dvoerstky-AI-Chess-Coach/actions/workflows/tests.yml/badge.svg)](https://github.com/luke-zhang-cs-py/Dvoerstky-AI-Chess-Coach/actions/workflows/tests.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![No build step](https://img.shields.io/badge/runs%20from-file%3A%2F%2F-blue.svg)](#run-it)

Why do *you* keep losing? A chess training room built from one player's own games:
an opponent that plays like you, drills cut from your own mistakes, and Stockfish
grading every move.

### ▶ [Try it now — runs in your browser, nothing to install](https://luke-zhang-cs-py.github.io/Dvoerstky-AI-Chess-Coach/)

![The Strength tab re-measuring as the window narrows to 30 days, then a sparring game: the mirror answers 1.e4 with its own Caro-Kann, and Stockfish grades 3.Bc4 a blunder](docs/demo.gif)

*Above: the analysis window narrowing from all time to 30 days, then a sparring game
against the mirror. It answers from the player's own repertoire, and Stockfish grades
every move as it lands. Recorded from the live page by
[`tools/record_demo.py`](tools/record_demo.py).*

**[Read the full guide →](notes/GUIDE.md)** — every tab, every number and where it
comes from.

## Run it

Double-click `index.html`. That's it: no server, no build, no account. Then put a
Lichess username in the box, pick **All games** or one format, and press **Sync
games** (or import a PGN in Settings).

```bash
python tools/build_single_file.py     # one self-contained HTML file, Stockfish included
```

## Two engines, on purpose

| | the house engine (`js/engine.js`) | Stockfish 10 (`js/vendor/`) |
|---|---|---|
| job | the sparring opponent, the drills, live advice | the check on all of that |
| strength | club level, on purpose, so it can be tuned to *your* error rate | far stronger |
| search | alpha-beta, quiescence, transposition table, null-move pruning | Stockfish's |
| runs | on the page | in a Web Worker, from a Blob, because `file://` blocks the usual way |

The mirror's moves are chosen to lose centipawns at the rate *you* lose them.
Stockfish then measures what each move really cost, so the panel shows whether the
house engine judged its own mistakes correctly.

## Layout

```
index.html   the whole app: open it
js/          ten modules, plain scripts, no bundler; js/vendor/ is Stockfish (GPL-3.0)
css/         one stylesheet
test/        Node suites, a Playwright drive of the page, and a coverage report
tools/       the single-file build and the demo recorder
experiments/ a PyTorch move predictor and an Elo study against Stockfish, apart from the app
notes/       the full guide
```

## Tests

**60 regression checks, 39 rules checks, 38 browser checks, and perft on 21
positions**, 15 of them edge cases (en passant out of a pin, castling into check,
underpromotion) with counts taken from Stockfish 19. Every bug fixed has a check that
failed on the code before its fix. The browser checks run the real Stockfish.

| strength | |
|---|---|
| SPRT against the previous engine (`tools/sprt.js`) | +41 ± 28 Elo, H1 accepted |
| Win at Chess, 300 tactics (`test/tactics.js`) | 104 at 0.5 s, 127 at 2 s |
| speed (`test/bench.js`) | 60–110k nodes/s, by machine load; perft 3.4M leaves/s |

`test/stockfish_check.py` re-checks the app's claims against Stockfish 19: every
endgame study's verdict, the imported evaluations, the mined mistakes and the house
engine's own choices (93% within 50 cp of best). `tools/uci.js` runs the engine in
any UCI GUI. Setup: [`.github/CONTRIBUTING.md`](.github/CONTRIBUTING.md).

MIT, except `js/vendor/` (Stockfish.js, GPL-3.0).
