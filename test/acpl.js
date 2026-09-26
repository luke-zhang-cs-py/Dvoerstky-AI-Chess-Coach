globalThis.window = globalThis;
require('../js/core.js'); require('../js/engine.js'); require('../js/data.js');
require('../js/analysis.js'); require('../js/sparring.js');
const { Chess, Engine, Analysis, Sparring } = globalThis;

const profile = { calibration: { trueStrength: 2050 },
  phases: { opening:{plies:400,blunders:4}, middlegame:{plies:600,blunders:22}, endgame:{plies:200,blunders:9} },
  style: { captureRate:0.16, checkRate:0.05, pawnMoveRate:0.33, earlyQueenRate:0.3, castlesEarly:0.8, sampleMoves:900 } };

async function play(targetElo, plies) {
  const m = new Sparring.Mirror(profile, { book: {}, targetElo, budgetMs: 220, maxDepth: 3 });
  const g = new Chess();
  for (let ply = 1; ply <= plies; ply++) {
    if (g.gameOver()) break;
    const res = await m.chooseMove(g, ply);
    if (!res) break;
    g.makeMove(res.move);
  }
  return m.log;
}

(async () => {
  for (const elo of [1600, 2050, 2350]) {
    let logs = [];
    for (let game = 0; game < 3; game++) logs = logs.concat(await play(elo, 44));
    const realised = logs.reduce((a,l)=>a+l.loss,0) / logs.length;
    const intended = logs.reduce((a,l)=>a+l.expectedLoss,0) / logs.length;
    const nominal = Analysis.acplFromElo(elo);
    const big = logs.filter(l=>l.loss>=200).length;
    console.log(`elo ${elo}: nominal ${nominal.toFixed(0)} | model-target ${intended.toFixed(0)} | realised ${realised.toFixed(0)} cp`
      + ` | ratio ${(realised/intended).toFixed(2)} | >=200cp moves ${big}/${logs.length}`
      + ` | back-implied elo ${Analysis.eloFromAcpl(Math.max(4,realised)).toFixed(0)}`);
  }
})();
