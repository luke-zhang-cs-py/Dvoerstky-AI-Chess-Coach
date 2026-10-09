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

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exitCode = failed ? 1 : 0;
