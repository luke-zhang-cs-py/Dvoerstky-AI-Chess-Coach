// Engine checks: a mate in one is found, the searches rank every legal move with a
// finite score, best first, and complexity is a bounded number. Run: node test/eng.js
const Chess = require('../js/core.js'); const Engine = require('../js/engine.js');

let failed = 0, passed = 0;
function check(name, ok, detail) {
  if (ok) passed++; else failed++;
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail !== undefined ? '  [' + detail + ']' : ''));
}
const top = r => r.slice(0, 3).map(x => x.san + ' ' + x.score).join(' | ');

const e = new Engine();
// back-rank mate: Ra8#
let g = new Chess('6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1');
let r = e.rank(g, 3, 3000);
check('engine: every legal move is ranked (back-rank position)', r.length === 20, r.length);
check('engine: the back-rank mate Ra8# is ranked first', r[0].san === 'Ra8#', top(r));
check('engine: ...with a mate score', r[0].score > 20000, r[0].score);

// after 1.e4 d5: every move ranked, the pawn on d5 attacked
g = new Chess('rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq d6 0 2');
r = e.rank(g, 3, 4000);
check('engine: every legal move is ranked after 1.e4 d5', r.length === g.generate().length, r.length + ' of ' + g.generate().length);
check('engine: every score is finite', r.every(x => Number.isFinite(x.score)), top(r));
check('engine: the ranking is sorted best first', r.every((x, i) => i === 0 || r[i - 1].score >= x.score), top(r));
check('engine: no move after 1.e4 d5 is judged a forced loss', r[0].score > -300 && r[0].score < 300, top(r));

// a quiet middlegame
g = new Chess('r1bq1rk1/pp2bppp/2n1pn2/2pp4/3P1B2/2PBPN2/PP1N1PPP/R2Q1RK1 w - - 0 9');
r = e.rank(g, 3, 6000);
check('engine: every legal move is ranked in the middlegame', r.length === g.generate().length, r.length);
check('engine: the middlegame evaluation is within a pawn and a half of level', Math.abs(r[0].score) < 150, top(r));
const c = e.complexity(g, r);
check('engine: complexity is a number from 0 to 100', Number.isFinite(c) && c >= 0 && c <= 100, c);

// ---------------------------------------------------------------- October 2026 coverage round
{
  const mated = new Chess('6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1');
  mated.move('Ra8#');
  check('engine: a position with no legal moves ranks nothing', e.rank(mated, 3, 1000).length === 0);
  // An error from the onDepth callback is not a timeout: it reaches the caller, and the
  // position the engine searched is back as it was (the throw skipped its undos).
  const pos = new Chess(), before = pos.fen();
  let thrown = null;
  try { e.rank(pos, 3, 0, function (d) { if (d === 2) throw new Error('caller-failed'); }); } catch (err) { thrown = err.message; }
  const again = e.rank(pos, 1, 0);
  check('engine: an error thrown by onDepth propagates, and the engine still ranks afterwards',
    thrown === 'caller-failed' && pos.fen() === before && again.length === 20, thrown + '; ' + again.length);
}

(async () => {
  // A promotion is ranked with its piece in the UCI, and Black to move searches as White does.
  const promo = e.rank(new Chess('8/P6k/8/8/8/8/8/K7 w - - 0 1'), 2, 0);
  check('engine: a promotion\'s UCI names the piece', promo.some((r) => r.uci === 'a7a8q') && promo.some((r) => r.uci === 'a7a8n') && promo.some((r) => r.uci === 'a1b2'), top(promo));
  const black = e.rank(new Chess('r5k1/5ppp/8/8/8/8/5PPP/6K1 b - - 0 1'), 3, 3000);
  check('engine: with Black to move it finds Black\'s mate', black[0].san === 'Ra1#' && black[0].score > 20000, top(black));
  // The null-move test with Black to move (it has a rook to pass with), in a window that is not a mate score.
  const nullBlack = e.search(new Chess('4k3/8/8/8/8/8/r7/3QK3 b - - 0 1'), 3, -100, 100, 0);
  check('engine: a search with Black to move, null move included, stays inside its window', nullBlack >= -100 && nullBlack <= 100, nullBlack);
  // At the fifty-move limit every quiet move is a draw, however much material is ahead.
  const fifty = e.rank(new Chess('k7/8/8/8/8/8/8/KQ6 w - - 100 90'), 2, 0);
  check('engine: past the fifty-move limit a queen up scores 0', fifty.every((r) => r.score === 0), top(fifty));
  // Quiescence follows checks only so far, then scores the position as it stands.
  const checked = new Chess('4k3/8/8/8/8/8/4r3/4K3 w - - 0 1');
  check('engine: quiescence in check at its depth limit is the static score', e.quiesce(checked, -50000, 50000, -4) === e.evaluate(checked));
  // Full, the transposition table starts again rather than growing.
  const big = new Engine();
  for (let i = 0; i < 200000; i++) big.tt.set('k' + i, { depth: 0, score: 0, flag: 0 });
  big.rank(new Chess(), 2, 0);
  check('engine: a full transposition table is cleared, not grown', big.tt.size < 200000 && big.tt.size > 0, big.tt.size);
  check('engine: complexity without a ranking is still a bounded number', (() => { const c = e.complexity(new Chess()); return Number.isFinite(c) && c >= 0 && c <= 100; })());
  check('engine: being mated in one reads as -1', Engine.mateIn(-29999) === -1 && Engine.mateIn(29999) === 1);

  // rankAsync: nothing to rank; the default budget; an onDepth error reaches the caller.
  const over = new Chess('6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1'); over.move('Ra8#');
  const none = await new Engine().rankAsync(over, 2);
  const quick = await new Engine().rankAsync(new Chess(), 1);
  let asyncThrown = null;
  await new Engine().rankAsync(new Chess(), 2, 5000, () => { throw new Error('onDepth-failed'); }).catch((err) => { asyncThrown = err.message; });
  check('engine: rankAsync ranks nothing when the game is over, uses a default budget, and passes on an onDepth error',
    none.length === 0 && quick.length === 20 && asyncThrown === 'onDepth-failed', [none.length, quick.length, asyncThrown].join());
  // An error inside the search that is not the clock's: rankAsync rejects with it, nothing swallowed.
  const broken = new Engine();
  broken.search = () => { throw new Error('search-failed'); };
  let searchErr = null;
  await broken.rankAsync(new Chess(), 2, 1000).catch((err) => { searchErr = err.message; });
  check('engine: an error from the search itself is passed on by rankAsync', searchErr === 'search-failed', searchErr);
  // The deadline passing between two slices of root moves: that depth is dropped, not half-used.
  const slow = new Engine();
  let searched = 0, depths = 0;
  slow.search = () => { searched++; return 0; };
  const realNow = Date.now, t0 = realNow();
  Date.now = () => t0 + (searched >= 3 ? 60000 : 0);
  const cut = await slow.rankAsync(new Chess(), 3, 1000, () => { depths++; });
  Date.now = realNow;
  check('engine: a deadline between slices drops the depth and keeps every move ranked', depths === 0 && searched === 3 && cut.length === 20,
    depths + ' depths, ' + searched + ' searched, ' + cut.length + ' ranked');

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exitCode = failed ? 1 : 0;
})();
