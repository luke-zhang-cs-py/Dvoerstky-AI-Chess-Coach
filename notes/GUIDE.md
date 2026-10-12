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

**Compared with titled players**, on the Strength tab under the calibration cards:
- **Who:** well-known CMs, FMs, IMs and GMs on Lichess (Tryfon Gavriel, Nate Solon, Eric
  Rosen, John Bartholomew, Christof Sielecki, Magnus Carlsen, Alireza Firouzja, Anish Giri,
  Nihal Sarin, Andrew Tang, Sergei Zhigalko, Oleksandr Bortnyk, Simon Williams). Pick who to
  show; one of each title is on by default.
- **Same scale:** they sit on one chart with your own Lichess ratings and your measured
  strength.
- **All speeds:** each bar runs from a player's lowest to highest *established* rating across
  bullet, blitz, rapid and classical. Established means not provisional and at least 20
  games, so a GM who never plays rapid on Lichess is not drawn at a placeholder 1500.
- **One speed:** each player's current rating there, with the low and high over their most
  recent 12 months where their rating history is public.
- **Title floors:** the dashed lines are FIDE's rating floors for each title (CM 2200,
  FM 2300, IM 2400, GM 2500). Lichess ratings run higher than FIDE, so they are context, not a
  conversion.
- **Data:** ratings ship as a dated snapshot (`js/titled.js`) so this works offline;
  **Refresh from Lichess** reads the live numbers, one request at a time.

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
repetition, plus a starter endgame curriculum of 15 studies (Lucena, Philidor, Vancura, Saavedra,
opposition and key squares with either side to move, the three-pawn breakthrough, Réti, B+N mate, and
others) that you play out against an engine: Stockfish while it is switched on, the house engine
otherwise. Each ends judged against its goal, and Restart plays it again. A card takes any move as
good as the stored one: another mate, or one the house engine scores within 30 cp of it.

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
- **Modelled:** the sparring opponent's error rate. Validated over self-play
  (`node tools/acpl.js`: three 44-ply games per strength, the loss judged by the house
  engine). Re-measured on 9 October 2026, after the engine changes: asked for 1600 it
  realised 82 to 86 cp/move over three runs, mapping back to about 1660–1690; asked for 2050,
  34 to 47 cp over four (about 1970–2160); asked for 2350, 18 to 29 cp over four (about
  2210–2500). So it runs *strong* at 1600, by 60–90 Elo, and above about 1800 it lands on
  either side of the target by up to about 150 Elo: one run gave about 2150 and 2500 for
  2050 and 2350, two others about 1970 for 2050. Three games is a small sample, and the
  mirror searches against the clock (220 ms a move), so the numbers depend on the machine's speed and load: a slower or
  busier machine searches less deeply and gives away more.
- **The engine is mine, not Stockfish.** Tapered piece-square tables, material, bishop
  pair, pawn structure and mobility, with alpha-beta search, MVV-LVA ordering and
  quiescence. The move generator is verified by perft on 21 positions, 15 of them edge
  cases (14 counted by Stockfish 19, one by python-chess), and the rules (castling, en passant, promotion, the
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

## The puzzles, 12 October 2026

Every puzzle in the Drills tab was played through, and some did not work.

**What did not work.**
- Four endgame studies had no position (wrong bishop, opposite-coloured bishops, queen against a
  pawn on the seventh, short-side defence). The list showed them disabled, "(reading only)".
- *Opposition and key squares* asked you to evaluate the position with White to move and then with
  Black to move, but only White to move could be played, and then you played the side that cannot lose.
- A study that ended only printed how it ended (mate, stalemate, repetition and so on). It never
  said whether the goal was met, there was no way to play it again, and after a draw by
  repetition the board still took moves.
- The prompt said the engine "will answer at full strength". It was the house engine at four plies
  and 1.4 s, even with Stockfish switched on. An engine that failed left the board waiting for good.
- A drill card took only the one stored move, compared as text. A second mate in one was "Not", and
  so was a different move just as good.
- A card whose stored best move was not a legal move in its position (a damaged line) could never be
  solved: only "Show the move" ended it.

**What changed.**
- All 15 studies have a position (the opposition is now two, one for each side to move). Each
  says which side you play (`play`) and what that side is to get (`result`, a win or a draw); when
  you are not the side to move, the engine moves first, and the board turns round when you have Black.
- A finished study is judged against its goal (`Training.judgeStudy`): a win study is solved only
  by a mate you give, and fails on any draw or loss; a draw study is solved by any draw (stalemate,
  no mating material, threefold repetition, the fifty-move rule) and fails only on a loss. The board
  then takes no more moves. **Restart** plays the study again from its position; a reply to the old
  game that lands later goes nowhere, and the day still counts as practised.
- Stockfish answers the study while it is switched on (the Sparring tab's "Read every move", on
  unless unticked), at the time per position set there. When it cannot (no legal move, a worker
  that will not start, switched off mid-search, not in the page), the house engine answers and the
  reply says why. Only a legal move is ever played; if no engine can answer, the study says so and
  lets you make the engine's move, so the board is never stuck. The prompt names the engine that
  answers, and says what the house engine is.
- `Chess.gameOver()` already saw threefold repetition and the fifty-move rule in a study (the game
  played on the board keeps its history from the study's position): `test/rules.js` now checks both
  there, a repetition in Philidor and in Vancura, and the browser check ends a Vancura on one.
- A drill card takes any move that mates when the stored move mates, and any move the house
  engine scores within 30 cp of the stored move in that position (as short a mate, when the stored
  move leads to mate), at depth 3 in at most 0.8 s. It says "Also correct", shows the stored move
  and its line, and grades as before. The board takes no move while that look runs; a reveal or
  quitting meanwhile drops it; an engine that fails says so and gives the board back. Moves are
  compared as moves, so the stored move written another way still counts.
- A mistake whose stored best move is not legal in its position makes no card
  (`Training.buildDeck`).
- Checked and found already working: promotion in a study (the picker, a rook in the Saavedra), the
  calendar's Set up for a study, and a backup restored in the middle of one (the study stays on the board
  and plays on). Each check written for a fix failed on the code before it; these last pass on both.

**Every study, verified on 12 October 2026.** Positions of seven pieces or fewer were read from the
[Lichess tablebase](https://tablebase.lichess.ovh) (exact; DTM is its distance to mate, in plies, with best play); the three-pawn breakthrough has eight,
so it was read by the Stockfish 10 in `js/vendor/` (60 s in Chromium, depth 40). Stockfish 10 also
read every other position for 15 s and agreed with the tablebase each time (the draws within 0.32
pawns of level, the wins as wins). `python-chess` found every position valid. The network was used
for this and nothing else; `test/rules.js` pins each study's position, side to move, side played,
result and goal, so an edit cannot quietly change one.

| study | position | to move | you play | goal | verdict | source |
|---|---|---|---|---|---|---|
| lucena | `2K5/2P1k3/8/8/8/8/r7/3R4 w - - 0 1` | White | White | win | win, DTM 35 (12 of 16 moves win, Re1+ and Rd7+ among them; Rd6 and Rd8 only draw, Ra1 and Rd2 lose) | tablebase |
| philidor | `4k3/R7/1r6/4PK2/8/8/8/8 b - - 0 1` | Black | Black | draw | draw (8 of 16 moves hold; Rb5, Rb8, Re6, Rf6+ lose) | tablebase |
| vancura | `R7/7k/P4r2/8/4K3/8/8/8 b - - 0 1` | Black | Black | draw | draw (Rb6–Rh6 along the sixth, Re6+, Kg7 hold; Rxa6, Rf1, Kg6 lose) | tablebase |
| behind-passer | `1r3k2/8/8/1P6/8/8/8/1R4K1 w - - 0 1` | White | White | draw | draw (every move holds) | tablebase |
| saavedra | `8/8/1KP5/3r4/8/8/8/k7 w - - 0 1` | White | White | win | win, by c7 only (DTM 51) | tablebase |
| opposition | `8/8/8/4k3/8/4K3/4P3/8 w - - 0 1` | White | Black | draw | draw | tablebase |
| opposition-b | `8/8/8/4k3/8/4K3/4P3/8 b - - 0 1` | Black | White | win | White wins (DTM 40) | tablebase |
| breakthrough | `6k1/ppp5/8/PPP5/8/8/8/6K1 w - - 0 1` | White | White | win | +153 pawns at depth 40, best b6 | Stockfish 10 |
| reti | `7K/8/k1P5/7p/8/8/8/8 w - - 0 1` | White | White | draw | draw, by Kg7 only | tablebase |
| bn-mate | `8/8/8/4k3/8/8/8/3BKN2 w - - 0 1` | White | White | win | win (DTM 59, inside the fifty moves) | tablebase |
| two-bishops | `8/8/8/4k3/8/8/8/2B1KB2 w - - 0 1` | White | White | win | win (DTM 33) | tablebase |
| wrong-bishop | `8/4k3/8/7P/2B3K1/8/8/8 b - - 0 1` | Black | Black | draw | draw, by Kf6 only (Kf8, Ke8, Kd6 and the rest lose); with a dark-squared bishop the same kind of position is lost | tablebase |
| opp-bishops | `2k5/6b1/6B1/4P3/5P2/8/8/6K1 b - - 0 1` | Black | Black | draw | draw, by Kd7 or Bh6 only (8 other moves lose) | tablebase |
| q-vs-pawn | `K7/8/8/8/8/8/1pk5/7Q w - - 0 1` | White | White | win | win (DTM 35; only the five checks Qe4+, Qg2+, Qc6+, Qh7+, Qh2+ win) | tablebase |
| short-side | `4k3/R7/4K3/4P3/8/8/8/1r6 b - - 0 1` | Black | Black | draw | draw, by Kf8 (the short side) or Rb6+ only; Kd8 and 13 others lose | tablebase |

The idea texts were checked against the same source. Queen against a pawn on the seventh: from
White Ka8, Qh1, the knight pawn (b2, king c2) and the centre pawn (d2, king e2) lose, while the
bishop pawn (c2, king d2) and the rook pawn (a2, king b2) draw. The rook pawn with the king on c2
instead loses (Qa1): the defending king has to stand beside its pawn, as the text says. The short side
is mirrored with the rook on h1: then only Kd8 or Rh6+ hold.

`test/stockfish_check.py` now reads each study's claim from its `play` and `result`, so it judges all
15 against a native Stockfish without a table of its own.

---

## File map

```
index.html          shell and tab structure
css/app.css         the whole stylesheet
js/core.js          0x88 chess rules: move generation, SAN, FEN, PGN parsing
js/engine.js        evaluation, alpha-beta search, quiescence, complexity scoring
js/data.js          Lichess API, PGN import, localStorage wrapper
js/analysis.js      calibration, motif classification, error mining, profile building
js/titled.js        titled players (CM to GM): snapshot, established ranges, live refresh
js/training.js      endgame curriculum, SM-2 scheduling, day planner, .ics export
js/coach.js         justification rubric, scoring, game summaries, optional LLM call
js/sparring.js      the mirror opponent and dual-sided advice
js/board.js         board rendering and interaction
js/stockfish-reader.js  Stockfish in a Web Worker: UCI parsing, an ordered read queue
js/vendor/          Stockfish.js 10.0.2 (GPL-3.0), wrapped as a string so file:// can run it
js/ui.js            all seven workspaces
test/               Node suites: perft.js, rules.js, eng.js (engine), an.js (analysis), integration.js,
                    spar.js (sparring), regress.js, titled.js, coach.js, app.js (PGN import, sync, mining,
                    calendar); ui_check.py (the UI in a real browser); dist_check.py (the single-file
                    build on its own); engine_gauntlet.py (the engine over UCI, refereed by
                    python-chess); and coverage_report.py
test/tactics.js     EPD suites in test/epd/ (Win at Chess, Bratko-Kopec, BT2630, STS), timed to the move found
test/stockfish_check.py  the app's claims re-checked against a local Stockfish
tools/bench.js      fixed-depth benchmark: nodes/s and a signature that changes when the search does
tools/acpl.js       the sparring calibration by self-play: asked strength against realised centipawn loss
tools/uci.js        the house engine as a UCI engine, for any chess GUI
tools/sprt.js       engine against engine, stopped by a sequential probability ratio test
tools/match.js      head-to-head matches over UCI against reference engines (Stockfish, Lc0 with Maia)
tools/games.js      what match.js and sprt.js share: the openings and how a game ends
```

Every `test/*.js` file except `tactics.js` is a pass/fail suite: it prints a line per
check, ends with "N passed, M failed" (perft: "ALL PERFT PASS"), and exits non-zero on a
failure, which is what CI reads. Run them all with

```bash
export TZ=America/Toronto                    # see the time zone note below
for t in test/*.js; do [ "$t" = test/tactics.js ] || node "$t" || break; done
```

`test/regress.js` holds at least one check for each bug from the September and October 2026
audits, written to fail on the code before its fix; `notes/CODE_AUDIT_2026-10.md` writes the
audits up, including the one check that did not fail there until it was tightened.
`titled.js` covers the titled-player comparison, `coach.js` the written-verdict rubric and
the API call, and `app.js` PGN import, the Lichess sync format, mistake mining, the calendar,
local storage and the Stockfish reader's lifecycle.

**The time zone matters for two checks.** "14 days across the clock change" (regress.js)
and "02:00 on the day the clocks go forward" (app.js) need a zone with daylight saving, so
run the suites with `TZ=America/Toronto`, as CI does. In a zone without it they print SKIP
(and fail in CI, where nothing may be skipped). On Windows, a `TZ` set in Git Bash does not reach
a Node that is not an MSYS program (VS Code's `Code.exe` run as Node, say): it reads the
system zone instead, so check what it sees with
`node -e "console.log(Intl.DateTimeFormat().resolvedOptions().timeZone)"`.

From the outside, over UCI (`pip install chess`):

```bash
python test/engine_gauntlet.py legality      # 1,000 positions: legal, well-formed, within movetime + 150 ms
python test/engine_gauntlet.py mates --min-mate1 100 --min-mate2 100   # fewer solved is a failure
python test/engine_gauntlet.py random        # 100 games against a random mover, 50 against a greedy one
```

CI runs the same three, with `mates --min-mate1 100 --min-mate2 95` (at the default 1 s a
move; with the engine at half speed, under Windows power throttling, it solved 95 to 97 of
the mates in 2) and
`random --games 20`, to keep the job short.

Strength and speed are measured apart from the pass/fail suites, because they depend on
the machine:

```bash
node tools/bench.js [depth]                  # nodes/s; the signature must not change for a speed-only edit
node tools/acpl.js                           # the sparring calibration, by self-play
node test/tactics.js 500 wac sts             # Win at Chess and STS at 500 ms a position
node test/tactics.js 10000 bk bt2630         # Bratko-Kopec and BT2630 at 10 s
node tools/sprt.js --base <old engine.js> --movetime 60   # until H0 or H1 is accepted
node tools/match.js --tc 30+0.3 --opponent "name=SF-1800 elo=1800 cmd=stockfish.exe \
    opt.Threads=1 \"opt.Move Overhead=100\" opt.UCI_LimitStrength=true opt.UCI_Elo=1800" \
    --opponent "name=Maia-1500 elo=1500 cmd=lc0.exe arg=--weights=maia-1500.pb.gz nodes=1"
python test/stockfish_check.py <path to stockfish>
```

The suites score different things. Win at Chess is 300 tactics. Bratko-Kopec is 24
positions, half of them positional. BT2630 is 30 hard positions and gives a rating,
2630 minus the total seconds taken over 30, an unsolved one counting its full 15 minutes:
run at 10 s a position the number is a floor, not a rating. STS is 1,500 quiet positions
in 15 themes, and every reasonable move is worth points (the best 10), so it measures
judgement rather than tactics. Each suite prints a solve time for every position (when
the engine found the move and kept it) and a signature of which positions it solved.

`match.js` plays reference engines over UCI, each opening twice with colours swapped, with
the rules checked by `js/core.js` rather than trusted to the engines. Stockfish plays at
a set rating (`UCI_LimitStrength`, `UCI_Elo`); Maia is Lc0 with networks trained on Lichess
games at a given rating, played at one node as its authors intend, so it plays like a
human of that rating. It prints the Elo difference against each with a 95% margin and a
performance rating fitted across them. Two things to know: keep games at once no more than
half the physical cores (each game runs two engines, and a descheduled engine runs past its
own clock), and give Stockfish a Move Overhead of 100 ms, since a limited Stockfish at fast
time controls spends its clock to the last few milliseconds and pipe latency then flags it.

`sprt.js` plays each opening twice with colours swapped and stops on the trinomial
log-likelihood ratio, as cutechess does (alpha = beta = 0.05). The last run, 9 October
2026, the engine with the quiescence search searching check evasions (and this round's
other engine fixes) against the one before it, at 60 ms a move with elo0 = 0 and
elo1 = 20: 212 games, +120 =22 −70, +83.5 ± 45.7 Elo, LLR 3.00, H1 accepted. The run
before it (26 September), the repetition and mate-score fixes against the engine before
them: +161 =123 −114, +41 ± 28 Elo, H1 accepted.

The UI is checked in a real browser, and coverage is measured across both:

```bash
pip install playwright && playwright install chromium
python test/ui_check.py                      # the browser checks: they drive index.html
python test/coverage_report.py --out coverage.html
```

`coverage_report.py` runs what CI runs, under V8's own block coverage: every Node suite
but `tactics.js` (with `CI=true`, child processes and workers included), the browser
check, and the single-file check on a file built from the tree as it is (its inlined
scripts are mapped back onto `js/`, CRLF and all). It measures every `.js` file under
`js/` except `js/vendor/` (Stockfish, third-party), and fails if any run fails or records
nothing. Chromium drops a page's coverage when it reloads, so the browser check takes it
before each reload, from each fresh page before it closes, and, for "Delete everything",
paused on the call to `location.reload` itself. Each record is read on its own (the
innermost V8 range decides) and the records are merged as "ran in any of them", which
cannot count twice. It reports five figures: lines (a line is partial when part of it
never ran, and partial lines are listed), statements, branches (both arms of every `if`,
the implicit else included, every `?:` arm, every `&&`/`||`/`??` operand, every case),
V8's blocks, and functions. Statements, branches and the function list come from the
TypeScript parser (VS Code carries one; `--ts` names another), because V8 does not list
a function nested in one that never ran. With no parser the report prints a `PROBLEM` line
and exits 1 (so does a `--ts` that is not a file); `--no-ts` asks for the report without
statements and branches. `--node` may be VS Code's `Code.exe`: it is then run with
`ELECTRON_RUN_AS_NODE=1`. Offsets are V8's UTF-16 units into the file as
it is on disk, so a CRLF checkout measures the same as CI. Two things V8 does not tell:
a statement after a call that threw counts as run, and a function V8 counts per function
only (code reused from its compilation cache) has none of its lines credited; the browser
runs turn that cache off for this reason. With it on, every reloaded page counted whole
functions as run, and the figure before this round, 99.96% of lines, was really 99.03%
(95.6% of statements, 86.7% of branches). Checked by hand on `stockfish-reader.js` (120
code lines, 21 functions), and on a scratch copy given a function no test calls, which it
reported as never called, with its nested function, its lines, statements and branches.

On 12 October 2026, after the puzzles round: all 4,834 lines, all 712 functions, all 4,272 statements, all 3,505
branches and every V8 block (2,990 in the last run: V8 lists only the blocks it compiled, so the total can differ between runs).
One run that day left a sparring guard unreached (a mirror's reply landing after a restart): the check
waited a fixed 400 ms for the mirror to start thinking, and on a loaded machine restarted before it had.
It now waits until the mirror has been asked. What was still left a day earlier was reached this way. The titled
players' sort keeps two accounts of one player (the same name and title) in the order they
are listed. Guards for a page other than this one (edited, or older than the code) are
tested on such a page, changed before the app boots: a tab added before its panel, no
Stockfish readout, no window note, and a header that is not the masthead, which stopped
boot altogether until `initChrome` took the care `measureMasthead` already did. Grading
now needs the card's grades to be showing: a second Enter on a grade button, landing before
the page redraws, still reaches the button the first one hid, and graded the next card
unseen. The same review found Enter in the handle box starting a second sync while one ran
(the button is disabled then, the box is not), which left the button reading "Syncing" for
good; Enter does nothing now while a sync runs. The Stockfish cache passes 400 readings in a 210-move game, read by a stand-in
worker that answers at once and played by the scripted mirror. Guards nothing could reach
were removed: the titled sheet's body, status line and redrawn checkbox (drawn whenever
there is a profile, and one never goes once there), Refresh pressed while a refresh runs (the button pressed is replaced at once
by a disabled one), the day's Mark button (always drawn), a disabled grade button (it gets
no click) and an endgame move with no study on (its board is only on screen during one).
Fallbacks that could never be taken (`||` defaults for settings that `cleanSettings` has
already filled, for lists the code that builds them always fills, and checks that a value
its only callers always pass is there) were removed in the same way.
