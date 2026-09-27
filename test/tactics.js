// EPD test suites: positions with known best moves, scored on whether the engine
// finds the move and how quickly.
//   node test/tactics.js [ms per position] [suite ...]
// A suite is wac, bk, bt2630, sts, or a path to any .epd file. Default: wac at 500 ms.
//
//   wac     Win at Chess, 300 tactics
//   bk      Bratko-Kopec, 24 positions, tactical and positional
//   bt2630  30 hard positions, scored as a rating: 2630 - (total seconds to solve) / 30,
//           an unsolved position counting 900 s (the suite's 15-minute limit)
//   sts     Strategic Test Suite, 1,500 quiet positions in 15 themes; every sensible
//           move is worth points (the best 10), so it measures judgement, not just tactics
//
// Solved: the engine's final choice is a best move ("bm"), or avoids the move
// to avoid ("am"). Solve time: when the last completed depth that changed its
// mind to a right answer finished -- the moment it found the move and kept it.
// Each suite prints a signature of which positions were solved, so a change that
// trades one position for another shows even when the total doesn't move.
globalThis.window = globalThis;
const fs = require('fs');
const path = require('path');
const Chess = require('../js/core.js');
const Engine = require('../js/engine.js');

const args = process.argv.slice(2);
const MS = /^\d+$/.test(args[0] || '') ? +args.shift() : 500;
const SUITES = { wac: 'wac.epd', bk: 'bk.epd', bt2630: 'bt2630.epd', sts: 'sts.epd' };
const files = (args.length ? args : ['wac']).map(a => SUITES[a] ? path.join(__dirname, 'epd', SUITES[a]) : a);

const strip = s => s.replace(/[+#!?]/g, '');
const op = (line, name) => { const m = line.match(new RegExp('\\b' + name + '\\s+("([^"]*)"|[^;]*);')); return m ? (m[2] != null ? m[2] : m[1]).trim() : null; };

function parse(file) {
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(l => l.trim()).map(line => {
    const f = line.trim().split(/\s+/);
    const moves = s => (s ? s.split(/\s+/).map(strip) : []);
    const p = { fen: f.slice(0, 4).join(' ') + ' 0 1', id: op(line, 'id') || f.slice(0, 4).join(' '),
                bm: moves(op(line, 'bm')), am: moves(op(line, 'am')), points: null };
    const c7 = op(line, 'c7'), c8 = op(line, 'c8');   // STS: the moves, and what each is worth
    if (c7 && c8) {
      p.points = {};
      moves(c7).forEach((m, i) => { p.points[m] = +c8.split(/\s+/)[i] || 0; });
    }
    return p;
  });
}

function solve(p) {
  const depths = [];
  const t0 = Date.now();
  const r = new Engine().rank(new Chess(p.fen), 64, MS,
    (d, rs) => { if (rs.length) depths.push({ d, ms: Date.now() - t0, san: strip(rs[0].san) }); });
  const played = r.length ? strip(r[0].san) : '-';
  const right = san => (p.bm.length ? p.bm.includes(san) : true) && !p.am.includes(san);
  const ok = right(played);
  let at = null;
  if (ok) {
    // the earliest depth from which every later completed depth also chose a right move
    at = depths.length ? depths[depths.length - 1].ms : Date.now() - t0;
    for (let i = depths.length - 1; i >= 0 && right(depths[i].san); i--) at = depths[i].ms;
  }
  const depth = depths.length ? depths[depths.length - 1].d : 0;
  return { played, ok, at, depth, points: p.points ? (p.points[played] || 0) : null };
}

(async () => {
  for (const file of files) {
    const name = path.basename(file, '.epd');
    const positions = parse(file);
    const t0 = Date.now();
    const rows = [];
    for (const p of positions) rows.push({ p, ...solve(p) });

    const solved = rows.filter(r => r.ok);
    const bits = rows.map(r => (r.ok ? 1 : 0));
    const sig = bits.reduce((h, b, i) => (h * 31 + b * (i + 7)) >>> 0, 7).toString(16);
    const times = solved.map(r => r.at).sort((a, b) => a - b);
    const median = times.length ? times[Math.floor(times.length / 2)] : null;
    const depthAvg = rows.reduce((s, r) => s + r.depth, 0) / rows.length;

    if (!/^sts/i.test(name)) {
      rows.filter(r => !r.ok).forEach(r => console.log(`  miss ${r.p.id}: played ${r.played}, wanted ` +
        (r.p.bm.length ? r.p.bm.join(' or ') : 'not ' + r.p.am.join(' or '))));
    }
    console.log(`\n${name}: solved ${solved.length} of ${rows.length} at ${MS} ms each ` +
      `(${(100 * solved.length / rows.length).toFixed(1)}%), median solve time ${median == null ? '-' : median + ' ms'}, ` +
      `mean depth ${depthAvg.toFixed(1)}, ${((Date.now() - t0) / 1000).toFixed(0)} s. Signature ${sig}`);

    if (/bt2630/i.test(name)) {
      const total = rows.reduce((s, r) => s + (r.ok ? r.at / 1000 : 900), 0);
      console.log(`  BT2630 rating ${Math.round(2630 - total / 30)} ` +
        `(a floor: the suite allows 15 minutes a position, this run ${MS / 1000} s, and an unsolved one counts 900 s)`);
    }
    if (rows.some(r => r.points != null)) {
      const got = rows.reduce((s, r) => s + (r.points || 0), 0);
      console.log(`  STS points ${got} of ${rows.length * 10} (${(100 * got / rows.length / 10).toFixed(1)}%)`);
      const themes = new Map();
      rows.forEach(r => {
        const m = r.p.id.match(/^STS\(v([\d.]+)\)\s*(.*?)\.\d+$/);
        const key = m ? `${m[1].padStart(4)} ${m[2].split('/')[0]}` : 'other';
        const t = themes.get(key) || { n: 0, pts: 0, best: 0 };
        t.n++; t.pts += r.points || 0; t.best += r.ok ? 1 : 0;
        themes.set(key, t);
      });
      [...themes].sort((a, b) => parseFloat(a[0]) - parseFloat(b[0])).forEach(([k, t]) =>
        console.log(`    ${k.padEnd(40)} ${String(t.pts).padStart(4)} / ${t.n * 10}   best move ${t.best}/${t.n}`));
    }
  }
})();
