# Dvoretsky Lab — the full guide

The short version is the [README](../README.md). This is every tab, every number and where it
comes from.

A training room built around one player's actual games. Everything runs in the page — no
server, no build step, no account, no paywall. Your games and notes stay in the browser's
local storage on your own machine.

---

## Running it

**Easiest:** unzip the folder and double-click `index.html`.

**Better:** serve it, so the browser gives the page a real origin (localStorage survives
more reliably and the Lichess request is less likely to be blocked):

```bash
python3 -m http.server 8000     # from the repository root
# then open http://localhost:8000
```

Then put your Lichess username or profile link in the box at the top, pick **All games** or one
Lichess format (UltraBullet, Bullet, Blitz, Rapid, Classical, Correspondence) beside it, and
press **Sync games**. Variants such as Chess960 are left out: they do not start from the normal
position, so neither engine can read them.

### If Lichess won't load

The Lichess public API allows cross-origin requests, so this normally works straight from
`file://`. If your browser blocks it anyway, use **Settings → Import PGN** instead: export
your games from Lichess (`lichess.org/@/YOURNAME/download`, tick *Include computer
analysis* and *Include clock times*) and drop the `.pgn` in. Every feature except the live
profile lookup works identically from an imported PGN.

### The one requirement that matters

**Error mining reads Lichess's own server-side analysis.** Games without computer analysis
still count towards your results and performance rating, but they produce no mistakes, so
no puzzles and no drill deck. On Lichess, open a game and press *Request a computer
analysis* — it is free and takes seconds. If most of your games are unanalysed, the app
tells you so after syncing.

---

## What is in each tab

**Strength** — the calibration. A slider at the top picks how far back it looks, from the
last 7 days to all time (the default); Sync downloads that window, and moving it re-measures
the games already loaded without syncing again. Measured playing strength blended from three sources:
your FIDE-style performance rating over the window you pick, an Elo implied by your average centipawn loss,
and your listed Lichess rating as an anchor. Underneath: accuracy broken down by phase,
clock-pressure rate, which tactical motifs your mistakes share and what each costs you,
openings sorted by score *and* by evaluation leaked, an opening tree of your actual move
sequences (both colours) showing how often you reach each position, your score from there,
and the average evaluation swing over your next ten moves — the number that finds a
structure you keep entering and then misplaying, as opposed to a single bad opening move
— when in the game things go wrong, your ten most expensive moves (each with a button that
opens it as a drill), and the trajectory chart described below.

**Sparring** — an opponent modelled on you. It plays your own opening book first (built
from your games, both colours), then a move-selection model tuned so its realised
centipawn loss matches a target strength, with blunder frequency taken from your actual
per-phase blunder rate and small style biases from your capture / check / pawn-move
habits. Live advice shows the top three candidates for **both** colours at once — the side
not to move is evaluated through a null move, which is the same question as *what is he
threatening*.

**Stockfish reader** — beside the board, Stockfish 10 reads every position in a background
worker and grades each move, yours and the mirror's, by scoring the move played against its
own best from the same position. It also shows the house engine's evaluation next to its own,
and sets what the mirror *meant* to give away against what Stockfish *measured* — a running
check on the engine this app is built on. Stockfish is GPL-3.0 and vendored unmodified; see
`js/vendor/README.md`.

**Drills** — puzzles generated only from your own mistakes, scheduled by SM-2 spaced
repetition, plus a starter endgame curriculum (Lucena, Philidor, Vancura, Saavedra,
opposition and key squares, the three-pawn breakthrough, Réti, B+N mate, and others) that
you play out against the engine at full strength.

**Calendar** — a 28-day plan on a weekly rhythm: recall every day, endgame theory Tuesday
and Saturday, sparring Sunday/Wednesday/Friday, with the calculation and motif blocks
weighted towards your weakest phase and costliest motif. Fits a minutes-per-day budget you
set. Exports to `.ics` for any calendar app.

**Review** — the calculation transcript. You justify each move in writing *before* the
engine is revealed; your note is scored against four Dvoretsky habits (enumerate
candidates, ask what the opponent wants, calculate concretely rather than by principle,
commit to an evaluation), and the session ends with a summary, turning points and
homework. Optionally, with an Anthropic API key in Settings, a written verdict from a
language model; without one it hands you the prompt to paste elsewhere.

**Scout** — read any public Lichess profile from a link and get the same tailored report.
Useful for preparing against a specific opponent, and for pointing the app at a friend.

**Settings** — minutes per day, endgame difficulty tier, session hour, API
key, PGN import, full backup export/import, and a delete-everything button. The board
theme list includes the Lichess (brown, blue) and Chess.com (green, brown, blue) boards,
with their square and highlight colours and solid pieces.

---

## Be clear about what is measured and what is estimated

- **Measured:** your results, your opponents' ratings, your centipawn loss per move
  (Lichess's numbers, not mine), your clock usage, your opening frequencies, which moves
  cost what.
- **Fitted:** the ACPL→Elo mapping (`Elo ≈ 3912 − 505·ln(ACPL)`). It is a curve through
  published data, not a law. It is least reliable at the extremes.
- **Heuristic:** the motif tagger. It classifies each mistake geometrically — knight fork,
  back rank, skewer, hanging piece, and so on — by looking at the resulting position. It is
  right often enough to be useful for grouping your errors, and wrong often enough that you
  should not treat a tag as gospel. Anything it cannot place is labelled honestly as
  unclassified rather than guessed at.
- **Modelled:** the sparring opponent's error rate. Validated over self-play: asked for
  2050 it realises 40 cp/move, which maps back to 2048; asked for 2350 it realises 23 cp,
  mapping back to 2326. It runs slightly *strong* below about 1800.
- **The engine is mine, not Stockfish.** Tapered piece-square tables, material, bishop
  pair, pawn structure and mobility, with alpha-beta search, MVV-LVA ordering and
  quiescence. The move generator is verified by perft on 21 positions, 15 of them edge
  cases counted by Stockfish 19, and the rules (castling, en passant, promotion, the
  fifty-move rule, threefold repetition, dead positions) by `test/rules.js`. But the evaluation is club-strength, not superhuman: for ground truth on
  *your own games* the app uses Lichess's analysis, and the local engine is used for
  sparring, drills and live advice where speed matters more than the last 20 centipawns.

---

## Four more features worth building

These are ordered by what they would be worth against a 2100 plateau, not by effort.

**1. A clock-discipline trainer.** The app already measures what fraction of your blunders
arrive in the last third of your clock. If that fraction is high, no amount of tactics
training fixes it — the issue is time allocation, not vision. A drill that gives you a
position and a *budget* (thirty seconds for this one, four minutes for that one), grades
you on both the move and whether you respected the budget, and reports where you overspend,
targets something puzzle sites cannot.

**2. Blindfold and visualisation ladders.** Difficulty in "spotting advanced sequences" is
very often a visualisation ceiling rather than a pattern gap: you can find a four-move idea
but cannot hold the position at the end of it clearly enough to evaluate it. A ladder —
name the square colour, then track a knight's path with the board hidden, then play out
three moves from a shown position and evaluate the result from memory — attacks that
directly, and is measurable week over week.

**3. Predict-the-move on classic games.** Dvoretsky's own method. Step through a master
game one move at a time, commit to your move before seeing the played one, and score your
agreement across a whole game. Curated by theme (Karpov's prophylaxis, Rubinstein's rook
endings, Petrosian's exchange sacrifices) and matched to your weakest phase, this trains
plan selection in a way tactics puzzles never touch — puzzles always tell you something is
there, which is the opposite of a real middlegame.

**4. A coach-facing export.** One PDF or page: calibration with error bars, phase
breakdown, motif table, the ten most expensive moves with diagrams, the trajectory, and the
last month's drill compliance. If you ever work with a human coach — and for the climb from
CM to NM you probably should — this is the document that saves the first three sessions of
them working out what you already know about yourself. It also makes the Scout tab useful
for genuine preparation against a named opponent.

A fifth, if you want one: **rated drill sessions**, where the puzzles carry a rating and so
do you, so the drill queue difficulty tracks your actual solving strength rather than
whichever of your blunders happened to be worst.

Already built: **opening leak tracing** — the Strength tab's opening tree, keyed by literal
move sequence rather than Lichess's coarser opening-name family, each node showing games
reached, score from there, and average evaluation swing over the following ten moves
(`Analysis.buildOpeningTree` in `js/analysis.js`, rendered by `openingTree()` in `js/ui.js`).

---

## Trajectory

Every sync writes one dated mark: measured strength, margin of error, rating, sample size.
Once there are three marks spanning two weeks, the Strength tab fits a line through them and
tells you the rate in points per month, and — if the rate is positive — roughly when it
crosses 2200. Treat the date as a direction rather than a promise; improvement is not
linear, and the honest use of the chart is the flat case, where it tells you that hours
played are not the constraint.

---

## File map

```
index.html          shell and tab structure
css/app.css         the whole stylesheet
js/core.js          0x88 chess rules: move generation, SAN, FEN, PGN parsing
js/engine.js        evaluation, alpha-beta search, quiescence, complexity scoring
js/data.js          Lichess API, PGN import, localStorage wrapper
js/analysis.js      calibration, motif classification, error mining, profile building
js/training.js      endgame curriculum, SM-2 scheduling, day planner, .ics export
js/coach.js         justification rubric, scoring, game summaries, optional LLM call
js/sparring.js      the mirror opponent and dual-sided advice
js/board.js         board rendering and interaction
js/stockfish-reader.js  Stockfish in a Web Worker: UCI parsing, an ordered read queue
js/vendor/          Stockfish.js 10.0.2 (GPL-3.0), wrapped as a string so file:// can run it
js/ui.js            all seven workspaces
test/               perft, rules, engine, analysis, integration, sparring and regression tests (node),
                    a browser check of the UI (ui_check.py) and a coverage report
test/bench.js       fixed-depth benchmark: nodes/s and a signature that changes when the search does
test/tactics.js     an EPD suite (Win at Chess in test/epd/) at a set time per position
test/stockfish_check.py  the app's claims re-checked against a local Stockfish
tools/uci.js        the house engine as a UCI engine, for any chess GUI
tools/sprt.js       engine against engine, stopped by a sequential probability ratio test
```

Run the tests with `node test/perft.js`, `node test/rules.js`, `node test/integration.js`,
`node test/acpl.js`, and `node test/regress.js` — one check per bug from the September
2026 audit, each written to fail on the code before its fix.

Strength and speed are measured apart from the pass/fail suites, because they depend on
the machine:

```bash
node test/bench.js [depth]                   # nodes/s; the signature must not change for a speed-only edit
node test/tactics.js [ms]                    # Win at Chess: 104/300 at 500 ms, 127/300 at 2000 ms
node tools/sprt.js --base <old engine.js> --movetime 60   # until H0 or H1 is accepted
python test/stockfish_check.py <path to stockfish>
```

`sprt.js` plays each opening twice with colours swapped and stops on the trinomial
log-likelihood ratio, as cutechess does (alpha = beta = 0.05). The last run, the
repetition and mate-score fixes against the engine before them: +161 =123 −114,
+41 ± 28 Elo, H1 accepted.

The UI is checked in a real browser, and coverage is measured across both:

```bash
pip install playwright && playwright install chromium
python test/ui_check.py                      # the browser checks: they drive index.html
python test/coverage_report.py --out coverage.html
```

`coverage_report.py` runs every Node suite and the browser check under V8's own block
coverage and merges them, so a line counts as covered if any test ran it. Chromium drops
a page's coverage when it reloads, so the browser check snapshots it before each reload.
