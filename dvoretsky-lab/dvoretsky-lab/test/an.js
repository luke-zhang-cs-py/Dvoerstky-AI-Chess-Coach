globalThis.Chess = require('../js/core.js');
require('../js/analysis.js');
const A = globalThis.Analysis;

function t(name, fen, played, best, ctx){
  console.log(name, '->', JSON.stringify(A.classifyMotifs(fen, played, best, ctx||{})));
}
// knight fork: Nc7+ forking king and rook
t('knight fork', 'r3k3/8/4N3/8/8/8/8/4K3 w - - 0 1', 'Ke2', 'Nc7+');
t('queen fork', '4k3/8/8/8/8/8/2r5/Q3K3 w - - 0 1', 'Kf2', 'Qa4+');
// back rank mate
t('back rank', '6k1/5ppp/8/8/8/8/8/R3K3 w - - 0 1', 'Kd2', 'Ra8#');
// hanging piece capture
t('hanging', '4k3/8/8/3n4/8/8/8/3RK3 w - - 0 1', 'Ke2', 'Rxd5');
// pin: Bb5 pinning knight to king
t('pin', 'r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 0 3', 'd3', 'Bb5');
// rook endgame tag
t('rook eg', '8/5pk1/8/8/8/8/5PK1/R6r w - - 0 1', 'Kg3', 'Ra7+');
// pawn endgame
t('pawn eg', '8/5pk1/8/8/8/8/5PK1/8 w - - 0 1', 'Kg3', 'f4');

// calibration sanity
const now = Date.now();
function mkGame(i, opp, score, acpl){ return {id:'g'+i, date: now - i*86400000, oppRating:opp, score, acpl, moves:new Array(70), analysed:true, myColor:'w', openingName:'Caro-Kann Defense', eco:'B12'}; }
const games = [];
for (let i=0;i<40;i++) games.push(mkGame(i, 2100 + (i%7-3)*30, i%3===0?1:(i%3===1?0.5:0), 38 + (i%9)));
const cal = A.calibrateStrength(games, 2100, now);
console.log('\ncalibration:', JSON.stringify(cal, null, 1));
console.log('acpl 20 ->', A.eloFromAcpl(20), '| 35 ->', A.eloFromAcpl(35), '| 80 ->', A.eloFromAcpl(80));
