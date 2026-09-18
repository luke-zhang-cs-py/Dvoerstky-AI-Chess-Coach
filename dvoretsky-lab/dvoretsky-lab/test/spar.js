globalThis.window = globalThis;
require('../js/core.js'); require('../js/engine.js'); require('../js/data.js');
require('../js/analysis.js'); require('../js/training.js'); require('../js/coach.js'); require('../js/sparring.js');
const { Chess, Engine, Analysis, Sparring } = globalThis;

const profile = { calibration: { trueStrength: 2050 },
  phases: { opening:{plies:400,blunders:4}, middlegame:{plies:600,blunders:22}, endgame:{plies:200,blunders:9} },
  style: { captureRate:0.16, checkRate:0.05, pawnMoveRate:0.33, earlyQueenRate:0.3, castlesEarly:0.8, sampleMoves:900 } };

// a small book: 1.e4 c6 2.d4 d5 played repeatedly
const fake = [];
for (let i=0;i<5;i++){
  const g = new Chess(); const moves=[];
  ['e4','c6','d4','d5','Nc3','dxe4','Nxe4','Bf5'].forEach(san=>{
    const before=g.fen(); const mv=g.move(san);
    moves.push({san:mv.san, color: mv.color===Chess.WHITE?'w':'b', fenBefore:before, fenAfter:g.fen()});
  });
  fake.push({id:'b'+i, myColor:'b', score:0.5, moves});
}
const book = Analysis.buildBook(fake);
console.log('book positions:', Object.keys(book).length);

(async () => {
  const mirror = new Sparring.Mirror(profile, { book, targetElo: 2050, budgetMs: 600 });
  const g = new Chess();
  const played = [];
  const t0 = Date.now();
  for (let ply=1; ply<=14; ply++){
    const res = await mirror.chooseMove(g, ply);
    if (!res) break;
    g.makeMove(res.move);
    played.push(res.san + (res.fromBook ? '*' : res.intendedLoss>80 ? `(-${res.intendedLoss})` : ''));
  }
  console.log('mirror self-play 14 plies in', Date.now()-t0, 'ms');
  console.log(played.join(' '));
  console.log('book hits:', mirror.bookHits, '| blunder turns:', mirror.log.filter(l=>l.blunderTurn).length, '/', mirror.log.length);
  const avgLoss = mirror.log.reduce((a,l)=>a+l.loss,0)/Math.max(1,mirror.log.length);
  console.log('avg intended cp loss:', Math.round(avgLoss), '| target acpl:', Math.round(Analysis.acplFromElo(2050)));

  // error model across strengths
  [1400,1800,2100,2400].forEach(elo=>{
    const m = new Sparring.Mirror(profile,{targetElo:elo});
    const lo = m.errorModel(20,'middlegame'), hi = m.errorModel(80,'middlegame');
    console.log(`  elo ${elo}: quiet ${Math.round(lo.expectedLoss)}cp/${(lo.blunderProb*100).toFixed(1)}% | sharp ${Math.round(hi.expectedLoss)}cp/${(hi.blunderProb*100).toFixed(1)}%`);
  });

  // dual sided advice
  const pos = new Chess('r1bq1rk1/pp2bppp/2n1pn2/2pp4/3P1B2/2PBPN2/PP1N1PPP/R2Q1RK1 w - - 0 9');
  const e = new Engine();
  const t1 = Date.now();
  const adv = await Sparring.dualAdvice(e, pos, { depth:3, budget:700 });
  console.log('\ndualAdvice in', Date.now()-t1, 'ms | sharpness', adv.complexity, '| eval', adv.evalCp);
  console.log(' white:', adv.white.map(c=>`${c.san} ${c.display}`).join(', '));
  console.log(' black:', adv.black.map(c=>`${c.san} ${c.display}`).join(', '));
  console.log(' threat:', adv.threatNote, '| only move:', adv.onlyMove || 'none');
})();
