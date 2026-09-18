const Chess = require('../js/core.js'); const Engine = require('../js/engine.js');
const e = new Engine();
// mate in 1 test
let g = new Chess('6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1');
let t0=Date.now(); let r = e.rank(g, 3, 3000);
console.log('legal moves:', r.length, 'top:', r.slice(0,3).map(x=>x.san+' '+x.score).join(' | '), 'ms', Date.now()-t0, 'nodes', e.nodes);
// back rank mate should be found: Ra8#
console.log('mate found?', r[0].san === 'Ra8#' || r[0].score > 20000);
// hanging queen test
g = new Chess('rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq d6 0 2');
t0=Date.now(); r = e.rank(g, 3, 4000);
console.log('opening top3:', r.slice(0,3).map(x=>x.san+' '+x.score).join(' | '), 'ms', Date.now()-t0);
// speed at depth 4 midgame
g = new Chess('r1bq1rk1/pp2bppp/2n1pn2/2pp4/3P1B2/2PBPN2/PP1N1PPP/R2Q1RK1 w - - 0 9');
t0=Date.now(); r = e.rank(g, 3, 6000);
console.log('midgame d3:', r.slice(0,3).map(x=>x.san+' '+x.score).join(' | '), 'ms', Date.now()-t0, 'nodes', e.nodes);
console.log('complexity:', e.complexity(g, r));
