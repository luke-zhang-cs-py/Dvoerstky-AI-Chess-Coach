// Analysis checks: the motif tagger on hand-built positions, the strength calibration
// on synthetic games, the ACPL-to-Elo curve, and the opening tree's arithmetic.
// Run: node test/an.js
globalThis.Chess = require('../js/core.js');
require('../js/analysis.js');
const A = globalThis.Analysis;

let failed = 0, passed = 0;
function check(name, ok, detail) {
  if (ok) passed++; else failed++;
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail !== undefined ? '  [' + detail + ']' : ''));
}

function tags(fen, played, best, ctx) { return A.classifyMotifs(fen, played, best, ctx || {}); }
function motif(name, fen, played, best, want) {
  const t = tags(fen, played, best);
  check('motif: ' + name + ' is tagged "' + want + '"', t.indexOf(want) >= 0, t.join(', '));
}
motif('Nc7+ forking king and rook', 'r3k3/8/4N3/8/8/8/8/4K3 w - - 0 1', 'Ke2', 'Nc7+', 'knight fork');
motif('Qa4+ hitting king and rook', '4k3/8/8/8/8/8/2r5/Q3K3 w - - 0 1', 'Kf2', 'Qa4+', 'double attack');
motif('Ra8#', '6k1/5ppp/8/8/8/8/8/R3K3 w - - 0 1', 'Kd2', 'Ra8#', 'back rank');
motif('Ra8# (the net)', '6k1/5ppp/8/8/8/8/8/R3K3 w - - 0 1', 'Kd2', 'Ra8#', 'mating net');
motif('Rxd5 of a loose knight', '4k3/8/8/3n4/8/8/8/3RK3 w - - 0 1', 'Ke2', 'Rxd5', 'hanging piece');
motif('a rook ending', '8/5pk1/8/8/8/8/5PK1/R6r w - - 0 1', 'Kg3', 'Ra7+', 'rook endgame');
motif('a king and pawn ending', '8/5pk1/8/8/8/8/5PK1/8 w - - 0 1', 'Kg3', 'f4', 'pawn endgame');
{
  const t = tags('r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 0 3', 'd3', 'Bb5');
  check('motif: a quiet opening move is "positional", nothing tactical', t.length === 1 && t[0] === 'positional', t.join(', '));
}

// calibration: 40 games against about 2100, a third won, a third drawn, ACPL 38-46
const now = Date.now();
function mkGame(i, opp, score, acpl) { return { id: 'g' + i, date: now - i * 86400000, oppRating: opp, score, acpl, moves: new Array(70), analysed: true, myColor: 'w', openingName: 'Caro-Kann Defense', eco: 'B12' }; }
const games = [];
for (let i = 0; i < 40; i++) games.push(mkGame(i, 2100 + (i % 7 - 3) * 30, i % 3 === 0 ? 1 : (i % 3 === 1 ? 0.5 : 0), 38 + (i % 9)));
const cal = A.calibrateStrength(games, 2100, now);
check('calibration: every game counts', cal.sample === 40 && cal.analysedSample === 40, cal.sample + ', ' + cal.analysedSample);
check('calibration: about 50% against about 2100 is a performance near 2100', Math.abs(cal.performanceRating - 2100) <= 50, cal.performanceRating);
check('calibration: the blend lies between its two sources', cal.trueStrength >= Math.min(cal.performanceRating, cal.moveQualityElo) &&
      cal.trueStrength <= Math.max(cal.performanceRating, cal.moveQualityElo), cal.moveQualityElo + ' <= ' + cal.trueStrength + ' <= ' + cal.performanceRating);
check('calibration: the margin of error is positive and under 300', cal.marginOfError > 0 && cal.marginOfError < 300, cal.marginOfError);
const e20 = A.eloFromAcpl(20), e35 = A.eloFromAcpl(35), e80 = A.eloFromAcpl(80);
check('calibration: Elo falls as ACPL rises', e20 > e35 && e35 > e80, e20 + ' > ' + e35 + ' > ' + e80);
check('calibration: the curve is 3912 - 505 ln(ACPL)', Math.abs(e35 - (3912 - 505 * Math.log(35))) < 1, e35);
check('calibration: acplFromElo inverts eloFromAcpl', Math.abs(A.acplFromElo(e35) - 35) < 0.5, A.acplFromElo(e35));

// opening tree: 5 identical Caro-Kann games as Black, so the eval-drop arithmetic is
// hand-checkable. White-POV evals per ply below; at the "e4" node (ply 1) my-POV eval is
// -25, ten plies later (ply 11) it's -35, so the expected evalDrop there is
// (-25) - (-35) = 10 for every one of the 5 games.
const caroSans = ['e4', 'c6', 'd4', 'd5', 'Nc3', 'dxe4', 'Nxe4', 'Bf5', 'Ng3', 'Bg6', 'h4', 'h6', 'Nf3', 'Nf6'];
const caroEvals = [25, 20, 35, 15, 28, 10, 22, 18, 30, 20, 35, 25, 30, 15];
function mkOpeningGame(id, myColor, score) {
  const moves = caroSans.map(function (san, i) { return { san: san, color: i % 2 === 0 ? 'w' : 'b', evalAfter: caroEvals[i] }; });
  return { id: id, moves: moves, myColor: myColor, score: score, analysed: true };
}
const caroGames = [];
for (let i = 0; i < 5; i++) caroGames.push(mkOpeningGame('caro' + i, 'b', i % 2 === 0 ? 1 : 0));
const tree = A.buildOpeningTree(caroGames);
const e4 = tree.childList[0];
const desc = tree.childList.map(n => n.san + ' (' + n.games + 'g, ' + n.scorePct + '%, drop=' + n.evalDrop + ')').join(', ');
check('opening tree: one root move, e4, reached in all 5 games', tree.childList.length === 1 && e4.san === 'e4' && e4.games === 5, desc);
check('opening tree: 3 wins of 5 is 60%', e4.scorePct === 60, desc);
check('opening tree: the eval drop over ten plies is 10', e4.evalDrop === 10, desc);

// ---------------------------------------------------------------- October 2026 coverage round
motif('Nf5, opening the d-file onto the queen', '3q2k1/8/8/8/3N4/8/8/3R2K1 w - - 0 1', 'Kh1', 'Nf5', 'discovered attack');
{
  const t = tags('8/8/8/8/5K1k/8/8/6Q1 w - - 0 1', 'Kf3', 'Qh2#');
  check('motif: a mate in the middle of the board is a mating net, not a back-rank mate',
    t.indexOf('mating net') >= 0 && t.indexOf('back rank') < 0, t.join(', '));
}
{
  // A stored ACPL that is not a number (an old backup, a hand-edited file) is left out of the
  // move-quality mean, and a game with no moves array weighs nothing rather than throwing.
  const ok = { date: now, oppRating: 2000, score: 1, acpl: 40, moves: new Array(60) };
  const odd = { date: now, oppRating: 2000, score: 0, acpl: 'n/a' };
  const cal2 = A.calibrateStrength([ok, odd], 2000, now);
  const alone = A.calibrateStrength([ok], 2000, now);
  check('calibration: an ACPL that is not a number is left out of move quality, not NaN',
    cal2.moveQualityElo === alone.moveQualityElo && Number.isFinite(cal2.trueStrength), cal2.moveQualityElo + ' vs ' + alone.moveQualityElo);
}
{
  // Lichess's best move unreadable here: the first move of its line is used instead.
  const sans = ['e4', 'e5', 'Ba6', 'bxa6', 'Nf3'], evals = [30, 30, -300, -300, -300];
  const pos = new Chess(), moves = sans.map((san, i) => {
    const mv = { san, color: i % 2 ? 'b' : 'w', fenBefore: pos.fen(), evalAfter: evals[i] };
    pos.move(san); return mv;
  });
  moves[2].serverBest = 'z9z9'; moves[2].serverLine = 'Nf3 Nc6 Bc4';
  const errs = A.mineErrors([{ id: 'sb', myColor: 'w', moves }]);
  check('mining: a best move that cannot be read falls back to the first move of the line',
    errs.length === 1 && errs[0].best === 'Nf3' && errs[0].bestUci === 'z9z9' && errs[0].line === 'Nf3 Nc6 Bc4',
    JSON.stringify(errs.map((e) => [e.played, e.best, e.bestUci])));
}
{
  // An unfinished game (no score) adds its moves to the book, not to the results.
  const mk = (id, score) => ({ id, myColor: 'w', score, moves: [{ san: 'e4', color: 'w' }, { san: 'e5', color: 'b' }] });
  const book = A.buildBook([mk('b1', 1), mk('b2', undefined)]);
  const e4 = book['rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -']['e4'];
  check('book: an unfinished game counts in n but not in the score', e4.n === 2 && e4.scored === 1 && e4.score === 1 && e4.mine === 2, JSON.stringify(e4));
}

{
  const types = ['6k1/5b2/8/8/8/8/1B6/6K1 w - - 0 1', '6k1/5n2/8/8/8/8/1N6/6K1 w - - 0 1', '6k1/5n2/8/8/8/8/1B6/6K1 w - - 0 1'].map((f) => A.endgameType(f));
  check('endgame type: bishops only, knights only, and a bishop against a knight', types.join() === 'bishop endgame,knight endgame,minor piece endgame', types.join());
  const rooks = ['6k1/5ppp/8/8/8/8/8/R5K1 w - - 0 1', '6k1/5ppp/8/8/8/8/8/r5K1 w - - 0 1', '6k1/r7/8/8/8/8/8/R5K1 w - - 0 1',
    'r5k1/r7/8/8/8/8/R7/R5K1 w - - 0 1', 'r5k1/8/8/8/8/8/R7/R5K1 w - - 0 1'].map((f) => A.endgameType(f));
  check('endgame type: a lone rook against pawns is a rook endgame, and only two rooks on a side make it double',
    rooks.join() === 'rook endgame,rook endgame,rook endgame,double rook endgame,double rook endgame', rooks.join());
  check('motif: a FEN that cannot be read gives no tags, and no played move is fine',
    tags('not a fen', 'e4', 'e5').length === 0 && tags('6k1/5ppp/8/8/8/8/8/R3K3 w - - 0 1', null, 'Ra8#').indexOf('back rank') >= 0);
  const promo = tags('8/P7/8/8/8/8/8/k6K w - - 0 1', 'Kh2', 'a8=Q', { timePressure: true });
  check('motif: a promotion is tagged, and so is time pressure', promo.indexOf('promotion') >= 0 && promo.indexOf('time pressure') >= 0, promo.join(', '));
  motif('Bb2, a rook in front of a knight on the diagonal', '6k1/8/5n2/8/3r4/8/8/2B4K w - - 0 1', 'Kg1', 'Bb2', 'skewer');
  motif('Ra1# against White', 'r5k1/8/8/8/8/8/5PPP/6K1 b - - 0 1', 'Kf8', 'Ra1#', 'back rank');
  const quiet = 'r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 0 3';
  const offer = '4k3/8/8/4p3/8/8/8/3QK3 w - - 0 1';
  check('motif: with no loss recorded, a worse position is no "defensive resource" and a piece offered is no sacrifice',
    tags(quiet, 'd3', 'Bb5', { evalBefore: -300 }).join() === 'positional' && tags(offer, 'Ke2', 'Qd4').indexOf('sacrifice / deflection') < 0
    && tags(offer, 'Ke2', 'Qd4', { cpLoss: 300 }).indexOf('sacrifice / deflection') >= 0, tags(offer, 'Ke2', 'Qd4', { cpLoss: 300 }).join(', '));
  const today = A.calibrateStrength(games, 2100);
  check('calibration: with no date given it measures as of now', today.sample === 40, today.sample);
  // Games kept in storage can be damaged: a move with no SAN ends the tree there, a move that
  // cannot be played ends the book there, and an "analysed" game with no moves adds nothing.
  const torn = (id) => ({ id, myColor: 'w', score: 1, moves: [{ san: 'e4', color: 'w' }, { color: 'b' }, { san: 'Nf3', color: 'w' }] });
  const tree2 = A.buildOpeningTree([torn('t1'), torn('t2'), torn('t3'), torn('t4'), torn('t5')]);
  const book2 = A.buildBook([{ id: 'k', myColor: 'w', moves: [{ san: 'e4', color: 'w' }, { san: 'Ke7', color: 'b' }, { san: 'Nf3', color: 'w' }] },
                             { id: 'f', myColor: 'w', moves: [{ san: 'e4', color: 'w', fenBefore: 'not a position' }] }]);
  const prof = A.buildProfile([{ id: 'p', analysed: true, myColor: 'w', score: 1, date: now, oppRating: 2000 }], 2000, now);
  check('stored games: a move with no SAN ends the tree, an unplayable move ends the book, an unreadable start adds nothing, an analysed game with no moves adds no plies',
    tree2.childList.length === 1 && tree2.childList[0].games === 5 && Object.keys(tree2.childList[0].children).length === 0 && Object.keys(book2).length === 2
    && prof.phases.opening.plies === 0, JSON.stringify([tree2.childList.map((n) => n.san), Object.keys(book2).length, prof.phases.opening.plies]));
}
console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exitCode = failed ? 1 : 0;
