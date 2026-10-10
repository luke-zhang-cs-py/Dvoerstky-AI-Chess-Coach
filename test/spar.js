// Sparring checks: the mirror plays its book first and then legal moves, its error model
// scales with the target strength, and dual-sided advice answers for both colours.
// Run: node test/spar.js
globalThis.window = globalThis;
require('../js/core.js'); require('../js/engine.js'); require('../js/data.js');
require('../js/analysis.js'); require('../js/training.js'); require('../js/coach.js'); require('../js/sparring.js');
const { Chess, Engine, Analysis, Sparring } = globalThis;

let failed = 0, passed = 0;
function check(name, ok, detail) {
  if (ok) passed++; else failed++;
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail !== undefined ? '  [' + detail + ']' : ''));
}

const profile = { calibration: { trueStrength: 2050 },
  phases: { opening: { plies: 400, blunders: 4 }, middlegame: { plies: 600, blunders: 22 }, endgame: { plies: 200, blunders: 9 } },
  style: { captureRate: 0.16, checkRate: 0.05, pawnMoveRate: 0.33, earlyQueenRate: 0.3, castlesEarly: 0.8, sampleMoves: 900 } };

// a small book: 1.e4 c6 2.d4 d5 3.Nc3 dxe4 4.Nxe4 Bf5, played five times
const LINE = ['e4', 'c6', 'd4', 'd5', 'Nc3', 'dxe4', 'Nxe4', 'Bf5'];
const fake = [];
for (let i = 0; i < 5; i++) {
  const g = new Chess(); const moves = [];
  LINE.forEach(san => {
    const before = g.fen(); const mv = g.move(san);
    moves.push({ san: mv.san, color: mv.color === Chess.WHITE ? 'w' : 'b', fenBefore: before, fenAfter: g.fen() });
  });
  fake.push({ id: 'b' + i, myColor: 'b', score: 0.5, moves });
}
const book = Analysis.buildBook(fake);
check('book: one entry per position on the line', Object.keys(book).length === LINE.length, Object.keys(book).length);

(async () => {
  const mirror = new Sparring.Mirror(profile, { book, targetElo: 2050, budgetMs: 600 });
  const g = new Chess();
  const played = [];
  let illegal = 0;
  for (let ply = 1; ply <= 14; ply++) {
    const res = await mirror.chooseMove(g, ply);
    if (!res) break;
    if (!g.generate().some(m => g.san(m) === res.san)) illegal++;
    g.makeMove(res.move);
    played.push(res.san + (res.fromBook ? '*' : ''));
  }
  check('mirror: plays 14 plies', played.length === 14, played.join(' '));
  check('mirror: every move is legal where it was played', illegal === 0, illegal + ' illegal');
  check('mirror: the first eight plies are the book line', played.slice(0, 8).join(' ') === LINE.map(s => s + '*').join(' '), played.slice(0, 8).join(' '));
  check('mirror: eight book hits, then the model for the rest', mirror.bookHits === 8 && mirror.log.length === 6,
        mirror.bookHits + ' hits, ' + mirror.log.length + ' logged');
  check('mirror: every logged loss is a finite number of centipawns', mirror.log.every(l => Number.isFinite(l.loss) && l.loss >= 0),
        mirror.log.map(l => l.loss).join());

  // error model across strengths
  const models = [1400, 1800, 2100, 2400].map(elo => {
    const m = new Sparring.Mirror(profile, { targetElo: elo });
    return { elo, lo: m.errorModel(20, 'middlegame'), hi: m.errorModel(80, 'middlegame') };
  });
  const desc = models.map(x => x.elo + ': ' + Math.round(x.lo.expectedLoss) + '/' + Math.round(x.hi.expectedLoss)).join(', ');
  check('error model: a stronger target loses fewer centipawns', models.every((x, i) => i === 0 || x.lo.expectedLoss < models[i - 1].lo.expectedLoss), desc);
  check('error model: a sharper position costs more at every strength', models.every(x => x.hi.expectedLoss > x.lo.expectedLoss), desc);
  check('error model: blunder chances are probabilities, higher when sharp',
        models.every(x => x.lo.blunderProb > 0 && x.hi.blunderProb < 1 && x.hi.blunderProb > x.lo.blunderProb),
        models.map(x => (x.lo.blunderProb * 100).toFixed(1) + '/' + (x.hi.blunderProb * 100).toFixed(1) + '%').join(', '));

  const plain = new Sparring.Mirror({ calibration: { trueStrength: 1500 } }, {});
  const mid = plain.errorModel(50, 'middlegame').expectedLoss;
  check('error model: half the loss in the opening, 15% more in the endgame',
        Math.abs(plain.errorModel(50, 'opening').expectedLoss - mid * 0.5) < 1e-9 && Math.abs(plain.errorModel(50, 'endgame').expectedLoss - mid * 1.15) < 1e-9,
        Math.round(plain.errorModel(50, 'opening').expectedLoss) + ' / ' + Math.round(mid) + ' / ' + Math.round(plain.errorModel(50, 'endgame').expectedLoss));
  const queenie = new Sparring.Mirror({ style: { captureRate: 0.13, checkRate: 0.06, pawnMoveRate: 0.36, earlyQueenRate: 1.5, castlesEarly: 0.6, sampleMoves: 100 } }, {});
  check('style: a player who brings the queen out early is nudged to early queen moves, and only early',
        queenie.styleBonus({ san: 'Qh5' }, 5) === 60 && queenie.styleBonus({ san: 'Qh5' }, 20) === 0 && plain.styleBonus({ san: 'Qh5' }, 5) === 0,
        queenie.styleBonus({ san: 'Qh5' }, 5) + ', ' + queenie.styleBonus({ san: 'Qh5' }, 20) + ', ' + plain.styleBonus({ san: 'Qh5' }, 5));

  // A blunder turn moves the choice toward the 2-9 pawn band. The two random draws (blunder
  // or not, then where the roll lands) are fixed, so the same roll is compared on both kinds of turn.
  async function pickWith(blunderDraw, roll) {
    const m = new Sparring.Mirror({ calibration: { trueStrength: 1500 } }, { budgetMs: 5000, maxDepth: 2 });
    const real = Math.random, seq = [blunderDraw, roll]; let k = 0;
    Math.random = () => (k < seq.length ? seq[k++] : real());
    try { return await m.chooseMove(new Chess('r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3'), 5); }
    finally { Math.random = real; }
  }
  const turns = [];
  for (const roll of [0.05, 0.5, 0.97]) turns.push([await pickWith(0.999, roll), await pickWith(0, roll)]);
  const shown = turns.map(([n, b]) => n.san + ' ' + n.intendedLoss + ' / ' + b.san + ' ' + b.intendedLoss).join('; ');
  check('mirror: a blunder turn is flagged, and never picks a cheaper move than the same roll on a normal turn',
        turns.every(([n, b]) => !n.blunderTurn && b.blunderTurn && b.intendedLoss >= n.intendedLoss), shown);
  check('mirror: ...and at the top of the roll it lands in the 2-9 pawn band, where a normal turn does not',
        turns[2][1].intendedLoss >= 200 && turns[2][1].intendedLoss <= 900 && turns[2][0].intendedLoss < 200, shown);

  // dual-sided advice
  const pos =new Chess('r1bq1rk1/pp2bppp/2n1pn2/2pp4/3P1B2/2PBPN2/PP1N1PPP/R2Q1RK1 w - - 0 9');
  const adv = await Sparring.dualAdvice(new Engine(), pos, { depth: 3, budget: 700 });
  check('advice: three candidates for each colour', adv.white.length === 3 && adv.black.length === 3,
        adv.white.map(c => c.san).join() + ' / ' + adv.black.map(c => c.san).join());
  check('advice: the evaluation is the side to move\'s best', adv.sideToMove === 'w' && adv.evalCp === adv.white[0].cp, adv.evalCp + ' vs ' + adv.white[0].cp);
  check('advice: each candidate\'s delta is its distance from the best', adv.white.concat(adv.black).every(c => c.delta >= 0) &&
        adv.white[0].delta === 0 && adv.black[0].delta === 0, adv.white.map(c => c.delta).join() + ' / ' + adv.black.map(c => c.delta).join());
  const flipped = new Chess(pos.fen().replace(' w ', ' b '));
  const blackLegal = flipped.generate().map(m => flipped.san(m));
  check('advice: Black\'s candidates are Black moves in this position', adv.black.every(c => blackLegal.indexOf(c.san) >= 0), adv.black.map(c => c.san).join());
  check('advice: the threat note names Black\'s two best', adv.threatNote === 'If it were Black to move: ' + adv.black[0].san + ' or ' + adv.black[1].san + '.', adv.threatNote);
  check('advice: complexity is a number from 0 to 100', adv.complexity >= 0 && adv.complexity <= 100, adv.complexity);

  // in check there is no null move, so no threats
  const inCheck = new Chess('4k3/8/8/8/8/8/4q3/4K3 w - - 0 1');
  const adv2 = await Sparring.dualAdvice(new Engine(), inCheck, { depth: 2, budget: 300 });
  check('advice: in check, no threat list and no threat note', adv2.black.length === 0 && adv2.threatNote === null, adv2.black.length + ', ' + adv2.threatNote);
  check('advice: in check, the one legal move is the only candidate', adv2.white.length === 1 && adv2.white[0].san === 'Kxe2', adv2.white.map(c => c.san).join());

  // ---------------------------------------------------------------- October 2026 coverage round
  {
    const m = new Sparring.Mirror(profile);
    check('style: castling early earns the castling bonus only before move 12; a candidate with no SAN earns none',
      Math.round(m.styleBonus({ san: 'O-O', move: {} }, 10)) === 40 && m.styleBonus({ san: 'O-O', move: {} }, 30) === 0
      && m.styleBonus({ move: {} }, 10) === 0, [m.styleBonus({ san: 'O-O', move: {} }, 10), m.styleBonus({ move: {} }, 10)].join());
    // The engine finding no moves at all (the position is over) is no move, not a crash.
    const none = new Sparring.Mirror(profile);
    none.engine = { rankAsync: () => Promise.resolve([]), complexity: () => 0 };
    const nothing = await none.chooseMove(new Chess('7k/8/8/8/8/8/8/K7 w - - 0 1'), 40);
    check('mirror: with no candidates from the engine it plays nothing', nothing === null, String(nothing));
    // Every candidate close to equal and a weak target: even the flattest choice is more
    // accurate than asked, so the temperature stops at its floor rather than searching.
    const flat = new Sparring.Mirror(profile, { targetElo: 800 });
    const pos = new Chess();
    const moves = pos.generate();
    flat.engine = { rankAsync: () => Promise.resolve(moves.slice(0, 3).map((mv, i) => ({ move: mv, san: pos.san(mv), score: 20 - i * 5 }))),
                    complexity: () => 0 };
    const realRandom = Math.random;
    Math.random = () => 0.99;   // no blunder turn
    await flat.chooseMove(pos, 30);
    // Two forced mates: the shorter is taken, the longer all but excluded (x0.01), however the roll falls.
    const mates = new Sparring.Mirror(profile);
    mates.engine = { rankAsync: () => Promise.resolve([{ move: moves[0], san: 'M1', score: 29999 }, { move: moves[1], san: 'M2', score: 29997 }]),
                     complexity: () => 0 };
    Math.random = () => 0.9;
    const mate = await mates.chooseMove(pos, 30);
    Math.random = realRandom;
    check('mirror: a weak target among near-equal moves sets the temperature at its floor', flat.log[0].lambda === 1e-5, flat.log[0].lambda);
    check('mirror: between two forced mates it plays the shorter even on a high roll', mate.san === 'M1' && mate.intendedLoss === 0, mate.san);
  }

  {
    // The roll lands past the first book move, on one that cannot be played here: no book move.
    const start = new Chess(), key = start.fen().split(' ').slice(0, 4).join(' ');
    const m = new Sparring.Mirror(profile, { book: { [key]: { e4: { n: 2, score: 1, scored: 2 }, Ke3: { n: 2, score: 1, scored: 2 } } } });
    const realRandom = Math.random;
    Math.random = () => 0.99; const high = m.bookMove(start);
    Math.random = () => 0; const low = m.bookMove(start);
    Math.random = realRandom;
    check('mirror: a roll past the first book move that lands on an unplayable one gives no book move; a low roll gives the first',
      high === null && low && low.move.toSq === 'e4' && low.n === 2 && low.of === 4, String(high) + ' / ' + (low && low.san));
  }
  {
    // A mirror with no profile at all plays at 2000 with no style; a book from before results
    // were kept apart (no "scored") counts every game, and a move with no scored game is 50%.
    const plain = new Sparring.Mirror(null);
    const start = new Chess(), key = start.fen().split(' ').slice(0, 4).join(' ');
    const old = new Sparring.Mirror(null, { book: { [key]: { e4: { n: 4, score: 3 }, d4: { n: 2, score: 0, scored: 0 } } } });
    const realRandom = Math.random;
    Math.random = () => 0; const pick = old.bookMove(start);
    Math.random = realRandom;
    check('mirror: no profile is 2000 and no style; an old book entry counts every game',
      plain.targetElo === 2000 && plain.styleBonus({ san: 'O-O', move: {} }, 5) === 0 && pick && pick.move.toSq === 'e4' && pick.n === 4 && pick.of === 6,
      plain.targetElo + ' ' + (pick && pick.san));
    // Advice with no options, Black to move, a position with one clear move; and one already mated.
    const recapture = new Chess('4k3/8/8/3q4/8/8/3R4/7K b - - 0 1');
    const adv = await Sparring.dualAdvice(new Engine(), recapture);
    check('advice: with Black to move, Black\'s moves are Black\'s, the threat is White\'s, and Qxd2 is the only move',
      adv.sideToMove === 'b' && adv.black[0].san === 'Qxd2' && adv.onlyMove === 'Qxd2' && /If it were White to move: Rxd5/.test(adv.threatNote)
      && adv.evalCp < 0, JSON.stringify([adv.black.map((c) => c.san), adv.onlyMove, adv.threatNote, adv.evalCp]));
    const mated = new Chess('6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1'); mated.move('Ra8#');
    const done = await Sparring.dualAdvice(new Engine(), mated, { depth: 2, budget: 200 });
    check('advice: in a mated position there is nothing to suggest and the evaluation is 0',
      done.evalCp === 0 && done.white.length === 0 && done.black.length === 0 && done.threatNote === null, JSON.stringify(done));
    check('display: Black having mated is 0-1, Black mating in one is -#1', Sparring.cpDisplay(-30000) === '0-1' && Sparring.cpDisplay(-29999) === '-#1',
      Sparring.cpDisplay(-30000) + ' ' + Sparring.cpDisplay(-29999));
  }
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exitCode = failed ? 1 : 0;
})();
