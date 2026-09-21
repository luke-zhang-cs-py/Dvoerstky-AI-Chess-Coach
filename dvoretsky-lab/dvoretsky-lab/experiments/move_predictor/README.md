# Move predictor (experiment, not part of the app)

Trains a small CNN to predict ermactually's move choices from board position,
instead of hand-coding evaluation rules the way `js/engine.js` does. This is
a standalone Python/PyTorch script — it does not touch the JS app, and
nothing in `js/` depends on it.

## Data

`ermactually_games.pgn` — 33 of ermactually's own Lichess games, with
per-move engine evals attached.

Only 33 games, and only this account, because of environment constraints hit
while fetching the data (not a design choice):

- Lichess's bulk games-export endpoint (`/api/games/user/{username}`) — the
  correct, documented endpoint — returned 404 from this environment for every
  account tried, including definitely-real, heavily-active ones. Other
  Lichess endpoints worked fine.
- chess.com's public API is behind a Cloudflare bot challenge that a
  non-browser client can't pass, so `twilightequinox`'s chess.com games
  aren't in here at all.
- Workaround used: `/api/user/{username}/perf/{perfType}` (works) embeds a
  handful of notable game IDs per game type (best wins, worst losses,
  highest/lowest rating point, streaks). Collected the unique IDs across all
  perf types with games, then fetched each individually via
  `/game/export/{id}.pgn` (also works). That's a curated "notable games"
  sample, not this account's full history — take the results here as a
  proof-of-concept of the training pipeline, not a real measure of how
  predictable this player is.

If you can get a full PGN export yourself (Lichess: Export games on your own
profile; the account's own download link), drop it in here to replace
`ermactually_games.pgn` and rerun — the loader doesn't care how the file was
obtained, only that it's a standard multi-game PGN with `[White]`/`[Black]`
headers.

## Running it

```
pip install torch python-chess
python train.py
```

## What it does and doesn't show

- Board -> move-probability model: 12-plane (piece type x colour) board
  encoding, always from the mover's point of view, small 3-layer CNN, softmax
  over a 4096-way (from-square, to-square) action space. Promotion piece
  choice is dropped from the label space — not worth the complexity on this
  little data, and queen promotion dominates in practice anyway.
- Reports accuracy two ways: raw top-1 (argmax over all 4096 classes) and
  legal-move-restricted top-1/top-3 (only among moves actually legal in that
  position) — the second is the fairer number, since with this little data
  the raw one is easily inflated by the model just learning "central squares
  are popular."
- With on the order of a few hundred training positions, expect this to
  mostly demonstrate the pipeline (board encoding, POV normalization,
  train/val split by game to avoid leakage, legal-move-aware evaluation)
  rather than produce a genuinely strong predictor of this player's style —
  that would need hundreds to thousands of real games, not a few dozen
  curated ones.
