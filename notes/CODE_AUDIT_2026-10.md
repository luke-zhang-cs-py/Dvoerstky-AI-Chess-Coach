# Code audit, 5 October 2026

Scope: the files the two earlier passes read least, `js/coach.js` (65.9% of lines covered,
`respond` and `callLLM` never run by any suite), `js/data.js`'s PGN import, `js/sparring.js`,
`js/training.js`, `js/board.js` and `js/stockfish-reader.js`, plus a sweep of `ui.js` for
markup and links built from untrusted text. The earlier passes, below, were not redone.

Baseline before any change: every Node suite green (regress 68/68, rules 39/39, titled 37/37,
the rest print and exit 0), `ui_check.py` 56/56 in Chrome, the UCI gauntlet's legality run
1,002/1,002 legal. After: regress 75/75, the new `test/coach.js` 12/12, the rest unchanged,
`ui_check.py` 56/56.

## Bugs fixed

| # | Class | What was wrong | Fix | Check |
|---|---|---|---|---|
| 1 | Functional (out of bounds, numbering) | The prompt for the written verdict numbered moves `Math.ceil(ply / 2)` over a 0-based ply, so White's first move was "Move 0" and every White move sat one behind the board the review screen shows. | `Math.ceil((ply + 1) / 2)`, the review screen's own formula. | regress.js: "the prompt numbers moves as the board does" |
| 2 | Logic (regex) | `importPGN` found the end of a game with `/\b(1-0\|0-1\|1\/2-1\/2\|\*)\s*$/`. There is no word boundary between a space and `*`, so a game whose result is unknown (an unfinished or set-up game) never ended, and the next game in the file was glued onto it: two games in, one game out. | `(^\|\s)` instead of `\b`. | regress.js: "a game ending "*" does not swallow the game after it" |
| 3 | Integration (identity) | A PGN game's id was the last segment of `Site`. chess.com writes `Site "Chess.com"` (the game's page is in `Link`), and other tools write `"?"` or a city, so every game in such a file had the same id: the second file imported was all "already loaded", and transcripts, drill cards (`id:ply`) and the review list ran different games together. | `gameUrl()` takes the game's page from `Site` or `Link`; with neither, `pgnId()` hashes players, date, round, start position and moves, so the same game re-imported keeps its id and two games never share one. Lichess ids are unchanged. | regress.js: four "pgn:" checks |
| 4 | Functional | An answer from the API with no text in it (a refusal, a stop before any text) was shown as an empty verdict box. | `callLLM` rejects with the stop reason, which the existing `.catch` already shows. | regress.js: "an answer with no text is an error that says why" |

Each check was run against the code before its fix and failed there (bug 2 also made the id
checks fail, which is how it was found).

## Checklist

**Dispensables.** Fixed: `Sparring.assemble`'s `fmt(list, side, pos)` took two arguments it never
read, and `dualAdvice` kept a `threats` variable that was only ever `null`; both gone, the
`null` passed directly with a comment saying when. Nothing stale found in the comments read.
Left: `Board.flip` and `Board.onKey` (keyboard moves) are reached by no suite; they are live
UI, not dead code.

**Bloaters.** Left: `ui.js` is still one 1,800-line file around the `S` state object (the
reasons are in the October section below). `summarizeGame` is about 90 lines, but it reads as
one narrative in order and splitting it would only move the sentences apart.

**Abusers.** Nothing new. `respond`'s chain of `if`s is a rubric where each rule reads the
score differently, not a switch over one value.

**Couplers.** Nothing new. `coach.js` reads the error objects `analysis.js` produces, which is
its job.

**Change preventers.** The move-number formula existed in `ui.js` (twice) and `coach.js`, and the
copy in `coach.js` was the wrong one (bug 1). Left as three short expressions, now identical,
with a comment at the odd one out; a shared helper would mean a new dependency between the
modules for one line.

**Global data, magic numbers, naming.** Nothing new. The coach's rubric weights (0.3, 0.2, 0.75,
...) are the model, and its comment says so.

**Security.** Swept every `innerHTML` and `href` in `ui.js`: names, results, openings and URLs
go through `esc`, links through `cleanGame`'s `https?://` filter (which the new `url` from
`Link` also passes through). The API key goes only to `api.anthropic.com` in a header, never
in a backup (checked by `ui_check.py`). `experiments/move_predictor/ermactually_games.pgn` is
one public Lichess account's games, committed as training data; it holds no more than the
public Lichess profile does. No secrets found in tracked files.

## Coverage

`python test/coverage_report.py` (Node 24.21.0, `ui_check.py` driven in Chrome via
`PW_CHANNEL=chrome`). Line coverage; the report has no branch figure, and "partial" counts
lines that ran with some code on them skipped.

| file | lines before | lines after | functions before | functions after |
|---|---|---|---|---|
| coach.js | 65.9% of 214 | 93.5% of 216 | 27/32 | 35/37 |
| data.js | 81.9% of 226 | 82.7% of 237 | 26/29 | 30/33 |
| sparring.js | 98.9% of 178 | 100.0% of 177 | 23/23 | 23/23 |
| analysis.js, engine.js, titled.js | 100.0% | 100.0% | all | all |
| core.js | 99.8% of 483 | 99.8% of 483 | 33/34 | 33/34 |
| training.js | 98.2% of 279 | 98.2% of 279 | 34/35 | 34/35 |
| board.js | 92.5% of 173 | 92.5% of 173 | 15/18 | 15/18 |
| stockfish-reader.js | 90.8% of 119 | 90.8% of 119 | 16/20 | 16/20 |
| ui.js | 88.1% of 1,662 | 88.1% of 1,662 | 239/267 | 239/267 |
| **total** | **92.3% of 4,460** | **93.7% of 4,472** | **581/626** | **593/635** |

`coach.js`'s remaining gap is the two `fetch` callbacks' error shapes that only a real network
produces. `data.js`'s is `fetchGames` and `fetchProfile` against the live API, which the browser
check stubs at the route level. `sparring.js` reached 100% this run because the time-limited
search happened to take the one branch it missed last time; it is not a new test.

## Maintenance

- **Corrective:** bugs 1 to 4.
- **Adaptive:** `callLLM` defaults to `claude-sonnet-4-6` with `anthropic-version: 2023-06-01`.
  Both are still served; a newer default model would be a product choice (cost, and newer models
  think by default, which a 1,000-token cap may cut short), so it is left for the owner.
  `actions/checkout@v4`, `setup-node@v4`, `setup-python@v5` in CI are current majors.
- **Perfective:** chess.com and other non-Lichess PGN exports now import as separate games, and
  an empty model answer says why.
- **Preventive:** `test/coach.js` runs `respond` and `callLLM` (no key, success, HTTP error) for
  the first time; CI picks it up with the other `test/*.js` files.

## Left for later

- Games already stored from a non-Lichess PGN keep the shared id they were given; importing that
  file again adds them once more under their new ids. Clearing local data and importing again
  gives clean ids.
- `importPGN` still splits a file on a blank line before `[`; a PGN whose comments contain a
  blank line followed by `[` would split mid-game. Not seen in Lichess or chess.com exports.
- The review screen and the prompt number moves from 1 even for a game set up from a FEN whose
  move number is not 1.
- `ui_check.py` never drives the justification review (`submitJustification`, `finishReview`,
  `askLLM`) or the scout sheet (`scout`, `scoutReport`); their pure halves are now covered in
  Node, the DOM wiring is not. `Store.del`, `Store.keys` (the "delete all data" button) and the
  Stockfish worker's failure paths (`failAll`, `terminate`, `onerror`) are not run either.

---

# Code audit, October 2026

Scope: the newest code first (`js/titled.js` and the "Compared with titled players" sheet in
`js/ui.js`), then `js/analysis.js`, `js/data.js` and the rest of `js/ui.js`. The September
2026 audit (`test/regress.js`, the backup and settings coercion in `ui.js`, the engine fixes)
was not redone. Every bug below was reproduced on the code before its fix, and each has a
check that fails on that code and passes after it.

## Bugs, by class

| # | Class | What was wrong | How it was found and reproduced | Fix | Check |
|---|---|---|---|---|---|
| 1 | Logic | `mineErrors` and `buildProfile` took the eval before every game's first move to be +0.2, the opening's edge. A game set up from a position (a PGN with `[FEN]`) where White is already a rook down then had its quiet first move charged as a 520 cp blunder, and it became a drill. | Reading the eval walk (`prevEval = 20`). Reproduced in Node: `importPGN` of a lost set-up position, `1. Kd2 {-5.0}`: one blunder, 520 cp of endgame loss. | `eachScoredMove()` in `analysis.js`: the opening edge only when the first move starts from the initial position, otherwise the first move has no honest "before" and is skipped, like any other gap. | regress.js |
| 2 | Integration (storage round trip) | `compact()` did not store a game's start position and `hydrate()` always replayed from the initial one, skipping any move that did not fit and carrying on. After a reload a set-up game became a different game: `1... e5 2. Nf3 Nc6` from after 1.e4 came back as `1. Nf3 Nc6`, with the evals on the wrong moves. | Found while checking bug 1: where does `fenBefore` come from after a reload? Reproduced in the browser: import, reload, export. | `compact()` keeps `fen` when the game did not start from the initial position; `hydrate()` loads it (an untrusted FEN that does not load means the initial position) and stops at the first move that does not follow. | ui_check.py |
| 3 | Integration (promise chain) | In `Titled.refresh`, the error handler for a player's rating history sat beside the request, not after the body: a history that arrived but did not parse rejected the chain, so that player was dropped, and the next player's history request was never made (the rejection skipped it and was caught by its handler instead). | Reading the chain. Reproduced in Node with a fetch whose history body throws: EricRosen missing, one request fewer. | Each player's wait, request, parse and store is its own sub-chain with a `.catch` before the store. | titled.js |
| 4 | Runtime | `refresh` did `(list || []).forEach`: an answer that is not a list (an error object with status 200) threw a TypeError, and the page showed "(list \|\| []).forEach is not a function". | Reading; reproduced in Node. | A plain error when the answer is not a list. | titled.js |
| 5 | Workflow | While a refresh was reading Lichess, any redraw of the sheet (changing the speed, a checkbox) drew a fresh, enabled Refresh button, so a second refresh could run alongside the first, against Lichess's one-request-at-a-time rule that `refresh()` exists to keep. | Reading `renderTitled`: `btn.disabled` was set on an element the next render replaced. Reproduced in the browser: refresh, change speed, the button is enabled. | `titledFetch` holds the refresh in flight; the button is drawn disabled and the status reads "Reading N players" until it ends. | ui_check.py |
| 6 | Functional | After a refresh that only some players answered (closed accounts, a newly ticked player), the status said "Live ratings, fetched ..." for every bar, though the rest were the snapshot. | Reading; reproduced in the browser (the check's own Lichess stub answers for 1 of 4). | `Titled.players()` says which players are live; the status reads "Live ratings for 1 of 4 players, fetched ...; the rest as of ...". | ui_check.py (+ a titled.js check of the flag) |
| 7 | Functional | With nobody ticked, Refresh read the four default players but said "Reading 0 players". | Reading; reproduced in the browser. | The status counts the players actually read. | ui_check.py |
| 8 | Functional (out of the expected set) | The picker grouped players by CM, FM, IM and GM only. A live title outside those (an NM, none) left the player on the chart with no checkbox, so they could not be unticked. | Reading `cleanTitle` (it accepts NM, WGM, ...) against the picker's groups. Reproduced in the browser with a stored refresh. | An "Other" group for anyone else. | ui_check.py |
| 9 | Integration (race) | `rememberMyRatings` stored the profile, then the rating history when it arrived. Sync one account and then another quickly, and the first account's late history overwrote the second account's ratings. | Reading. Reproduced in the browser by holding the first account's history request until after the second sync. | The late write only happens if the stored ratings are still that account's. | ui_check.py |
| 10 | Logic | The "You" row showed whatever ratings were stored last, whoever they belonged to: after a sync whose profile lookup failed (the games still load), or a restored backup with another handle, another account's ratings were shown as yours, and the gap measured from them. | Reading `sync()`: `rememberMyRatings` returns early on a missing profile and leaves the old ones. Reproduced in the browser with a 404 profile. | `myRatings()` only returns ratings for the account in the handle box. | ui_check.py |
| 11 | Security | The rating saved at the last sync was read back from localStorage as it came and reached `innerHTML` in the ruler ("Lichess ...") and the calibration card. A tampered value ran as markup; a non-number also made the trajectory's date `NaN` and threw "Invalid time value". Import already coerced it; the load path did not. | A sweep of every `Store.get` in `ui.js` for raw reads. Reproduced in the browser: `onerror` fired. | `storedRating()`: a number or nothing, on load and in the backup. | ui_check.py |
| 12 | Runtime | `recordSnapshot` re-read the trajectory from storage raw, past `cleanTrack`: a stored value that was not a list threw on `push` and broke every sync and import from then on, and a cleaned trajectory in memory was replaced by the raw one. | The same sweep. Reproduced in the browser: "track.push is not a function". | It works on `S.track`, which is cleaned on load and on import. | ui_check.py |
| 13 | Runtime | `S.completed` (days logged as done) was loaded raw; a stored `null` threw on every calendar render, and the calendar never drew. | The same sweep. Reproduced in the browser. | `cleanCompleted()`: anything but an object is none. | ui_check.py |
| 14 | Logic (time zone) | The trajectory dated each mark with `toISOString()`, the UTC day. In Toronto a sync after 20:00 was marked tomorrow, and the next morning's sync then replaced it as "the same day", so a mark was lost. The 2200 projection's month had the same mix. | Reading: everything else in the app uses `Training.dateKey` (local). Reproduced in the browser with the clock fixed at 21:30 Toronto time and the time zone pinned through CDP. | `Training.dateKey(new Date())` for the mark and the projection. | ui_check.py |

Bugs 1 to 4 and 11 to 14 sit outside the titled sheet; 3 to 10 are in the newest code.

## Smells

| Smell | Where | Change |
|---|---|---|
| Temporary field | `S._titledScale`, stashed on the global state only to pass the scale from `renderTitled` to `titledRow` | passed as an argument |
| Long parameter list, flag argument (oddball) | `titledRow(label, sub, r, speed, cls)`; the measured band passed the made-up speed `'one'` to get a single dot | `titledRow(sc, row)`; the dot style follows the range's shape (a range across speeds has `points`) |
| Long method | `renderTitled`, about 90 lines: reading state, controls, picker, chart, table, notes, event wiring | `titledView` (state, read once), `titledStatus`, `titledControls`, `titledPicker`, `titledChart`, `titledTable`, `bindTitled` |
| Duplicate code, shotgun surgery | the eval walk (start value, clamp, gap rule) copied in `mineErrors` and `buildProfile`; bug 1 lived in both copies | one `eachScoredMove()` |
| Magic numbers | the +20 opening edge; the axis's 1200/200/100; the bar's 0.6% minimum | `OPENING_EDGE`, `AXIS_WIDE`, `MIN_BAR`; the axis loop steps by its interval instead of skipping |
| Dead code | `myRatings.date` (written, never read); the status line written after a refresh that the re-render had already written; `if ($('#titledBody'))` before a function that checks it itself; `S.track \|\| Store.get('track')` (S.track is always set); a temporary in `titledPicks` | removed |
| Global data | `Titled` used as an implicit global in `ui.js`, while every other module is declared at the top | declared with the others |
| Inconsistent naming / primitives | the same date regex spelt out where `titledLive` checks; `typeof v === 'object'` beside the file's own `isObj` | `ISO_DAY`, `isObj` |
| Inconsistent date handling | UTC (`toISOString`) in two places, local (`Training.dateKey`) everywhere else | local throughout (bug 14) |

## Reviewed and fine

- `titled.js`: `speedOf`, `rangeAt` (the whisker includes the current rating), `rangeAcross`, `scale` (title floors always in, so `hi > lo`), `cleanRows` and `cleanTitle` (only numbers, known speeds and real dates survive), `historyRanges` (0-based months, garbage in, nothing out), the sort.
- The titled sheet's output: every name, title and handle goes through `esc`; the profile link uses `encodeURIComponent`; picks are filtered to known players; the stored speed to known speeds.
- `data.js`: `Store` (every access in try/catch), `parseHandle`, `fetchRatingHistory` (never rejects), `guessSpeed`, `importPGN`'s player detection.
- `analysis.js`: winning-chance thresholds, `performanceRating`'s clamp to the dp table, the window filter, `eloFromAcpl` at 0.
- `ui.js`: the backup import (September), `S.completed` on import (already `isObj`), `renderWindowNote` (textContent only), the stored handle (only reaches `value` and `textContent`).

## Deliberately left

- A merged refresh keeps one date for every live player, so a player refreshed last week shows under this week's date. Per-player dates would change the stored shape; the status now at least says how many shown players are live.
- `Chess.parsePGN` skips tokens it cannot play and carries on. That tolerance is for imported files with odd annotations and is deliberate; `hydrate` replays the app's own SAN, where a move that does not fit means the rest is wrong, so only `hydrate` now stops.
- Scouting another player and adopting their profile puts their measured strength beside your Lichess ratings in the titled sheet. The flash already says the workspace is theirs until the next sync.
- The opening tree and the book key moves by SAN from the initial position, so a set-up game adds a few odd nodes (the book stops at its first illegal move). Rare, and it does not reach the drills.
- In an endgame, the endgame-type tag means a quiet best move is never tagged "positional". Whether that is intended is a design question, not a bug.
- `calibrateStrength`'s weights (0.62, 0.38, 22, 700/sqrt(n), the 2000 anchor) are the model, explained in its comment.
- `ui.js` is still one 1,800-line file, and `S` is still the app's state object. Splitting it into modules means a loader or a build step, which the page avoids by design (it runs from file:// and as one file).

## Coverage

Measured with `test/coverage_report.py`, which runs every Node suite (`tactics.js` at its default, WAC at
500 ms) and `ui_check.py` in Edge under V8 block coverage and merges them. Node 24.21.0,
Playwright 1.62 with the installed Edge.

| file | before (lines) | after (lines) | before (functions) | after (functions) |
|---|---|---|---|---|
| analysis.js | 99.2% of 589 | 100.0% of 590 | 81/81 | 84/84 |
| data.js | 67.3% of 226 | 81.9% of 226 | 23/27 | 26/29 |
| titled.js | 100.0% of 159 | 100.0% of 164 | 44/44 | 44/44 |
| ui.js | 86.8% of 1,619 | 88.1% of 1,662 | 220/253 | 238/267 |
| sparring.js | 100.0% of 178 | 98.9% of 178 | 23/23 | 23/23 |
| others | unchanged | unchanged | | |
| **total** | **91.0% of 4,411** | **92.3% of 4,460** | **556/607** | **580/626** |

`sparring.js` did not change; its one line depends on what the time-limited search picks in the browser run.
data.js rose because the new browser checks sync real (stubbed) games, so `normalizeLichess` now runs.

## Checks

| suite | before | after |
|---|---|---|
| test/regress.js | 67 | 68 |
| test/rules.js | 39 | 39 |
| test/titled.js | 34 | 37 |
| test/ui_check.py (browser) | 45 | 56 |
| test/perft.js | 21 positions | 21 positions |

On the code before the fixes the new checks fail: 1 of 68 in regress.js, 3 of 37 in
titled.js, and 11 of 56 in ui_check.py (plus "no uncaught errors", which also fails there).

## Maintenance classification

| Change | Type |
|---|---|
| Bugs 1, 2, 3, 5, 6, 7, 9, 10, 12, 13, 14 | corrective |
| Bug 4 (an answer that is not a list) and bug 8 (titles outside CM to GM) | corrective and adaptive: they make the sheet hold up when Lichess's data changes shape or a player's title changes |
| Bug 11 (stored rating) | corrective (security) |
| `renderTitled` split, `titledRow(sc, row)`, the dot style from the range's shape, `eachScoredMove`, named constants, `Titled` declared, dead code removed | perfective |
| `storedRating`, `cleanCompleted`, `Array.isArray` guards in `hydrate`, `ISO_DAY`/`isObj` reuse, the per-player sub-chains, and the 15 new checks (the time zone pinned in the browser check so it does not depend on the machine) | preventive |
| README and GUIDE counts | perfective (documentation) |
