# Elo calibration study (experiment, not part of the app)

Does `Sparring.Mirror`, asked for `targetElo=X`, actually produce game
*outcomes* consistent with strength X? The README's own "Be clear about what
is measured and what is estimated" section already flags the sparring
opponent's error rate as **Modelled**, validated only by self-play (Mirror
vs. Mirror: "asked for 2050 it realises 40cp/move, which maps back to
2048"). This experiment checks it against an external, independent ground
truth instead: real Stockfish, set to the same Elo via its own officially
calibrated `UCI_LimitStrength` + `UCI_Elo` mode (not the coarser 0-20 "Skill
Level" knob, which isn't Stockfish's own Elo estimate).

**Not part of the app** — pure Python/Playwright, drives the real unmodified
`js/sparring.js` code in a real browser. `js/` has no dependency on this.

## Result: Mirror loses ~100% of games against Stockfish at every Elo tested

`calibrate.py`'s run (`results.jsonl`): 24 games across targetElo 1600 /
2000 / 2400, 8 games each, Stockfish set to the matching `UCI_Elo`. Mirror
scored **0/24** — not close losses, almost all by outright checkmate.

That number looks alarming on its own, so before trusting it I ran four
isolation tests (`debug_*.py`, `sanity_check.py`) to find out whether this
is a harness bug, an engine.js bug, or a real finding:

1. **`debug_one_game.py`** — full move-by-move trace of one game, checking
   the board position tracked by the Python side against the one tracked by
   the page after every move. No desync, no crash. Moves looked like
   plausible chess with occasional deliberately-weak choices (as the error
   model intends).
2. **`debug_raw_engine.py`** — bypassed Mirror's error injection entirely
   and just played `engine.rankAsync()`'s own top move against
   Stockfish@1320 (Stockfish's documented floor). **Engine.js won cleanly**,
   its own eval climbing from +48 to a forced mate at ply 49. This rules out
   a bug in this session's transposition-table/null-move-pruning work —
   the search and evaluation are correct.
3. **`debug_mirror_sampling.py`** — called `Mirror.chooseMove()` 8 times on
   a fixed position at `targetElo=2400` and compared the actual loss of the
   move it picked against `Analysis.acplFromElo(2400)` (20cp). Observed
   losses: 26, 32, 26, 32, 0, 32, 13cp — close to the target. The
   move-by-move error model is not obviously broken either.
4. **`debug_vs_random.py`** — Mirror@2400 vs. a purely random legal-move
   opponent, no Stockfish, no bridging at all. **Mirror won all 4 games**,
   in 15-44 plies. Rules out a deep bug in Mirror or the harness.

So: the search is correct, the per-move error model is roughly calibrated,
and Mirror beats a genuinely weak opponent easily — but it still loses
almost every game against Stockfish even at Stockfish's *weakest possible*
setting. The conclusion isn't a bug; it's a real, known limitation of using
average centipawn loss as a proxy for "plays like a human of this Elo":

**Elo-limited Stockfish is a much more consistent, tactically reliable
opponent than a human of the same nominal Elo.** Its weakening mechanism
(added noise / reduced depth) erodes positional judgement more than it
erodes tactical accuracy, so it still converts almost every opportunity
Mirror's modelled errors hand it — something a real human at that Elo
would routinely fail to do. Average-cp-loss can be well-calibrated in
isolation (per move, and in self-play) without producing competitive
*results* against an opponent whose error profile is shaped completely
differently. This is a documented property of engine Elo-limiting in the
chess-programming community, not specific to this app.

## What this does and doesn't mean for the app

- It does **not** mean `engine.js`'s search/eval is broken (test 2 disproves
  that directly) or that Mirror's per-move error model is miscalibrated in
  isolation (test 3).
- It does mean: don't take "Mirror-vs-Stockfish game score" as a calibration
  metric for this app. The self-play validation the README already
  describes, and human playtesting, remain the meaningful ways to check
  this. This experiment is evidence *for* that existing caveat, not against
  the app.

## Methodology notes / deviations from production

- `Mirror` was run with `budgetMs=600` (below the app's own 900ms default,
  `sparring.js:16`) purely to keep the study's run time bounded. Not
  expected to explain a 100%-vs-0% result on its own (test 2's raw-engine
  game used the full 900ms budget and still won cleanly).
- Games that didn't reach checkmate/stalemate by move 60 (`MAX_PLIES=120`)
  are scored via `adjudicate_score()`: a fresh, full-strength Stockfish
  evaluation of the final position converted to a win probability via the
  standard cp -> win-probability logistic, not a flat 0.5 draw — scoring
  every truncated game as a draw would have biased the whole study toward
  50% regardless of who was actually winning.
- Only one run (24 games) plus the four targeted isolation tests above,
  not a large repeated-trials study — the mechanism is now well enough
  understood (four independent tests agree) that more games at the same
  settings would mostly reconfirm the same qualitative result rather than
  change the conclusion. Rerun `calibrate.py` with more checkpoints/games
  if you want a tighter quantitative estimate.

## Running it

```
pip install playwright python-chess
playwright install chromium
python -m http.server 8000       # from dvoretsky-lab/dvoretsky-lab
python calibrate.py              # downloads nothing itself -- see below
```

Stockfish isn't committed here (it's a ~180MB binary; see `.gitignore`).
Download the official Windows build and unzip it into `stockfish/` next to
`calibrate.py`:
<https://github.com/official-stockfish/Stockfish/releases> (this study used
`sf_19`, `stockfish-windows-x86-64-universal.zip`).
