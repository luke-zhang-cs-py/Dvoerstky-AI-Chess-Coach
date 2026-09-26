// Tactical test suite: EPD positions with known best moves, a fixed time each.
//   node test/tactics.js [ms per position] [path/to/suite.epd]
// Default: test/epd/wac.epd (Win at Chess, 300 positions), 500 ms each. A
// position counts as solved when the engine's first choice is one of the
// listed best moves ("bm"). Prints the solved count, the misses, and a
// signature of which were solved, so a change that trades one tactic for
// another shows up even when the total stays the same.
globalThis.window = globalThis;
const fs = require('fs');
const path = require('path');
const Chess = require('../js/core.js');
const Engine = require('../js/engine.js');

const MS = +(process.argv[2] || 500);
const FILE = process.argv[3] || path.join(__dirname, 'epd', 'wac.epd');

const positions = fs.readFileSync(FILE, 'utf8').split(/\r?\n/).filter(Boolean).map(line => {
  const f = line.split(/\s+/);
  const fen = f.slice(0, 4).join(' ') + ' 0 1';
  const bm = (line.match(/\bbm ([^;]+);/) || [])[1];
  const id = (line.match(/\bid "([^"]+)"/) || [])[1] || fen;
  return { id, fen, bm: bm ? bm.trim().split(/\s+/) : [] };
});

const strip = s => s.replace(/[+#!?]/g, '');
let solved = 0;
const misses = [], bits = [];
const t0 = Date.now();
for (const p of positions) {
  const g = new Chess(p.fen);
  const r = new Engine().rank(g, 64, MS);
  const ok = r.length && p.bm.map(strip).includes(strip(r[0].san));
  if (ok) solved++; else misses.push(`${p.id}: played ${r.length ? r[0].san : '-'}, wanted ${p.bm.join(' or ')}`);
  bits.push(ok ? 1 : 0);
}
const sig = bits.reduce((h, b, i) => (h * 31 + b * (i + 7)) >>> 0, 7);
console.log(misses.map(m => '  miss ' + m).join('\n'));
console.log(`\n${path.basename(FILE)}: solved ${solved} of ${positions.length} at ${MS} ms each ` +
            `(${(100 * solved / positions.length).toFixed(1)}%) in ${((Date.now() - t0) / 1000).toFixed(0)} s. Signature ${sig.toString(16)}`);
