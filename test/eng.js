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

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exitCode = failed ? 1 : 0;
