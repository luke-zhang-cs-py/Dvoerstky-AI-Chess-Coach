// What tools/match.js and tools/sprt.js share: the openings, and how a game ends.

// Each is played twice, colours swapped, so neither side gets the better of an unbalanced line.
const OPENINGS = [
  'e4 e5 Nf3 Nc6 Bb5 a6', 'e4 e5 Nf3 Nc6 Bc4 Bc5', 'e4 e5 Nf3 Nf6 Nxe5 d6', 'e4 c5 Nf3 d6 d4 cxd4',
  'e4 c5 Nf3 Nc6 d4 cxd4', 'e4 c5 Nc3 Nc6 g3 g6', 'e4 e6 d4 d5 Nc3 Bb4', 'e4 e6 d4 d5 e5 c5',
  'e4 c6 d4 d5 e5 Bf5', 'e4 c6 d4 d5 Nc3 dxe4', 'e4 d5 exd5 Qxd5 Nc3 Qa5', 'e4 Nf6 e5 Nd5 d4 d6',
  'd4 d5 c4 e6 Nc3 Nf6', 'd4 d5 c4 c6 Nf3 Nf6', 'd4 d5 c4 dxc4 Nf3 Nf6', 'd4 Nf6 c4 e6 Nc3 Bb4',
  'd4 Nf6 c4 g6 Nc3 Bg7', 'd4 Nf6 c4 c5 d5 b5', 'd4 f5 g3 Nf6 Bg2 g6', 'c4 e5 Nc3 Nf6 Nf3 Nc6',
  'c4 c5 Nf3 Nf6 Nc3 Nc6', 'Nf3 d5 g3 Nf6 Bg2 c6', 'Nf3 Nf6 c4 g6 Nc3 d5', 'e4 g6 d4 Bg7 Nc3 d6',
];

const MAX_PLIES = 200;          // a game this long is adjudicated a draw
const WON_SCORE = 1000;         // both engines past 10 pawns the same way...
const WON_PLIES = 6;            // ...this many plies running: a win

// {result, reason} once the game is over, else null. The rules are asked
// first: a mate delivered on the last allowed ply is a mate, not a draw.
function gameEnd(g) {
  const over = g.gameOver();
  if (over === 'checkmate') return { result: g.turnColor() === 'w' ? '0-1' : '1-0', reason: 'checkmate' };
  if (over) return { result: '1/2-1/2', reason: over === 'material' ? 'insufficient material' : over === 'fifty' ? 'fifty moves' : over };
  if (g.history.length >= MAX_PLIES) return { result: '1/2-1/2', reason: 'adjudicated: ' + MAX_PLIES + ' plies' };
  return null;
}

// Feed it each move's score from White's side; it answers 'w' or 'b' once one
// side has been winning for WON_PLIES plies running, else null.
function winAdjudicator() {
  let side = null, run = 0;
  return whiteScore => {
    const leader = whiteScore > WON_SCORE ? 'w' : whiteScore < -WON_SCORE ? 'b' : null;
    run = leader && leader === side ? run + 1 : (leader ? 1 : 0);
    side = leader;
    return run >= WON_PLIES ? leader : null;
  };
}

module.exports = { OPENINGS, MAX_PLIES, gameEnd, winAdjudicator };
