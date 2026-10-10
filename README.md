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
python test/dist_check.py             # open that file on its own and check it works
```

The single file lands in `dist/Dvoretsky-Lab.html`. `dist/` is not in git, so build it
from the sources when you need it: a copy left from older sources goes stale with nothing
to say so. CI builds it on every push and opens it in Chromium with nothing beside it;
`test/dist_check.py` fails on any page error, any file left un-inlined, or any inlined
file that differs from the one in `js/` or `css/`.

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
js/          11 modules, plain scripts, no bundler; js/vendor/ is Stockfish (GPL-3.0)
css/         one stylesheet
test/        Node suites, the UCI gauntlet, Playwright drives of the page and the single file, a coverage report
tools/       uci.js (the engine for any UCI GUI), match.js and sprt.js (engine matches; games.js is
             what they share), bench.js and acpl.js (speed and sparring calibration), the
             single-file build and the demo recorder
experiments/ a PyTorch move predictor and an Elo study against Stockfish, apart from the app
notes/       the full guide
```

## Tests

**478 checks.** In Node: 96 regression, 52 rules, 45 app (PGN import, Lichess sync, mining,
calendar, storage, the Stockfish reader), 37 titled-player, 22 integration, 21 sparring,
21 coach, 18 analysis and 10 engine checks,
and perft on 21 positions (35 counts, plus 5 SAN and PGN checks), 15 of them edge cases (en
passant out of a pin, castling into check, underpromotion) with counts taken from Stockfish 19,
one from python-chess. In Chromium: 110 browser checks and 6 on the single-file build. Every
suite exits non-zero on a failure, which is what CI reads. Every bug fixed has a check that
failed on the code before its fix. The browser checks run the real Stockfish. Together
they run 99.96% of the 4,756 code lines in `js/` and 678 of its 681 functions
(`test/coverage_report.py`, 10 October 2026).

**From the outside** (`test/engine_gauntlet.py`): the engine driven over UCI the way a
GUI drives it, with python-chess as a referee that shares no code with `js/core.js`.

| check | result | measured |
|---|---|---|
| legality: 1,000 positions (random games, EPD suites, random valid placements, 18 edge cases) plus 2 game-over positions | 1,002 of 1,002 legal and well-formed, every reply within 100 ms a move + 150 ms of slack (a later one fails); median 83 ms, slowest 127 ms. On time means within the slack, not within 100 ms: replies of 176 ms have been seen on a loaded machine | 9 Oct 2026, this engine |
| mate in 1: 100 positions, screened by Stockfish and proved by brute force | 100 of 100 at 1 s (fewer fails CI) | 9 Oct 2026, this engine |
| mate in 2: 100 positions, any forced line accepted | 100 of 100 at 1 s (CI fails below 95); 82 at 0.3 s | 9 Oct 2026, this engine |
| 100 games against a random mover, 50 against a greedy capturer (CI plays 20 and 10: `random --games 20`) | 150 wins, no draws, no freezes, no games run to the ply cap; median win in 32 plies against the random mover (31 on the previous engine), 36 against the greedy one | 9 Oct 2026, this engine |
| 20 games against Stockfish 19 at 0.1 s a move (house engine also 0.1 s) | 0.5 of 20 (one perpetual), as expected. Median first blunder (200+ cp by a depth-12 referee) at move 8 after the opening; really down material from move 14 | 28 Sep 2026, previous engine |

On Windows the harness switches off power throttling for the engines it starts: a
windowless child otherwise runs at about half speed (66k against 127k nodes/s here),
and mate in 2 fell to 95–97 of 100 because depth 3 no longer fit in the second.

| strength | | measured |
|---|---|---|
| SPRT against the engine before it (`tools/sprt.js`, 60 ms a move, elo0 0, elo1 20) | +83.5 ± 45.7 Elo over 212 games (+120 =22 −70), LLR 3.00, H1 accepted | 9 Oct 2026, this engine |
| Win at Chess, 300 tactics (`test/tactics.js`) | 93 at 0.5 s (87 on the previous engine) | 9 Oct 2026, this engine |
| Bratko-Kopec, 24 positions | 6 at 10 s (6 before) | 9 Oct 2026, this engine |
| BT2630, 30 hard positions | 3 at 10 s: a rating floor of 1820 (the same before) | 9 Oct 2026, this engine |
| matches against Stockfish 19 (set to 1500, 1800, 2100) and Maia 1500, 1900 (`tools/match.js`, 30+0.3) | performance about 1730 over 66 games | 27 Sep 2026, previous engine |
| STS, 1,500 strategic positions | 41.9% of the points at 0.5 s | 27 Sep 2026, previous engine |
| speed (`tools/bench.js`, depth 4) | 61–73k nodes/s with other work running (the previous engine 62k beside it; 60–110k by machine load before); signature 3,015,335 nodes. Perft 2.3M leaves/s (3.4M before, on a quieter machine) | 9 Oct 2026, this engine |

*This engine* is `js/engine.js` after the 9 October 2026 changes (the quiescence search
searches check evasions, the deadline reaches quiescence, the mate threshold); *the previous
engine* is `js/engine.js` as of `e278488` (27 September 2026). The rows on the previous engine
need Stockfish or Lc0 to rerun, so they were not. Every timed figure depends on the machine
and its load: these were taken with other work running.

Stockfish 19 through the same suites and scorer: WAC 276 at 1 s, Bratko-Kopec 20, BT2630
24, STS 86.2%, so the answer keys and the scoring hold up.

`test/stockfish_check.py` re-checks the app's claims against Stockfish 19: every
endgame study's verdict, the imported evaluations, the mined mistakes and the house
engine's own choices (93% within 50 cp of best, on the previous engine), and exits 1 if
an endgame claim is wrong. `tools/uci.js` runs the engine in
any UCI GUI. Setup: [`.github/CONTRIBUTING.md`](.github/CONTRIBUTING.md).

MIT, except `js/vendor/` (Stockfish.js, GPL-3.0).
