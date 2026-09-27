#!/usr/bin/env node
// Head-to-head matches against reference engines over UCI, as cutechess-cli runs them.
//
//   node tools/match.js --opponent "name=SF-1500 elo=1500 cmd=stockfish.exe \"opt.Move Overhead=100\" opt.UCI_LimitStrength=true opt.UCI_Elo=1500" \
//        --opponent "name=Maia-1500 elo=1500 cmd=lc0.exe arg=--weights=maia-1500.pb.gz nodes=1" \
//        [--engine "name=House cmd=node arg=tools/uci.js"] [--games 24] [--tc 10+0.1] [--concurrency 3] [--pgn out.pgn] [--verbose]
//
// An engine is a list of key=value: cmd (the program), arg (repeatable), opt.<Name>
// (a UCI setoption; quote the whole pair when the name has a space, "opt.Move Overhead=100"),
// nodes or depth (search by that instead of the clock, as Maia is
// meant to be run: one node, the network's own move), elo (the opponent's rating,
// for the performance estimate). The house engine defaults to tools/uci.js.
//
// Each opening is played twice with colours swapped. Games end by the rules
// (checked by js/core.js, not by the engines), on time, or by adjudication:
// 200 plies is a draw, and both engines scoring beyond 10 pawns the same way
// for 6 plies running is a win. Each engine gets a fresh process per game.
// Prints each opponent's score and the Elo difference with a 95% margin, then a
// performance rating fitted across all the rated opponents.
globalThis.window = globalThis;
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const Chess = require(path.join(__dirname, '..', 'js', 'core.js'));
const { OPENINGS, gameEnd, winAdjudicator } = require('./games.js');

// ---------------------------------------------------------------- arguments
const argv = process.argv.slice(2);
const flag = (name, dflt) => { const i = argv.indexOf('--' + name); return i > -1 ? argv[i + 1] : dflt; };
const flags = name => argv.flatMap((a, i) => (a === '--' + name ? [argv[i + 1]] : []));

function parseEngine(spec) {
  const e = { args: [], options: {} };
  for (const tok of spec.match(/(?:[^\s"]+|"[^"]*")+/g) || []) {
    const t = tok.replace(/^"|"$/g, '');          // "opt.Move Overhead=100": a name with a space
    const eq = t.indexOf('='); if (eq < 0) continue;
    const k = t.slice(0, eq), v = t.slice(eq + 1).replace(/^"|"$/g, '');
    if (k === 'arg') e.args.push(v);
    else if (k.startsWith('opt.')) e.options[k.slice(4)] = v;
    else e[k] = v;
  }
  if (!e.cmd) throw new Error('an engine needs cmd=: ' + spec);
  e.name = e.name || path.basename(e.cmd);
  if (e.elo != null) e.elo = +e.elo;
  return e;
}

const house = parseEngine(flag('engine', `name=House cmd=${process.execPath} arg=${path.join(__dirname, 'uci.js')}`));
const opponents = flags('opponent').map(parseEngine);
// Concurrency: keep engines <= physical cores. With more, an engine is descheduled mid-move,
// runs past its own clock, and the match measures the machine instead of the engines.
const GAMES = +flag('games', 24), CONCURRENCY = +flag('concurrency', 3);
const [BASE, INC] = flag('tc', '10+0.1').split('+').map(x => Math.round(parseFloat(x) * 1000) || 0);
const PGN = flag('pgn', null);
const VERBOSE = argv.includes('--verbose');   // each move: who, how long, both clocks
const MARGIN = +flag('timemargin', 200);   // ms of grace for process and pipe latency before a loss on time
if (!opponents.length) {
  console.error('usage: node tools/match.js --opponent "name=... cmd=... [opt.X=v] [nodes=1] [elo=1500]" [--games 24] [--tc 10+0.1]');
  process.exit(2);
}

// ---------------------------------------------------------------- one UCI process
class UciEngine {
  constructor(spec) {
    this.spec = spec;
    this.proc = spawn(spec.cmd, spec.args, { cwd: path.isAbsolute(spec.cmd) ? path.dirname(spec.cmd) : process.cwd(),   // lc0 finds its DLLs and nets beside it
      env: { ...process.env, OPENBLAS_NUM_THREADS: '1' }, stdio: ['pipe', 'pipe', 'ignore'] });
    this.buf = ''; this.waiters = []; this.lastScore = null; this.dead = false;
    this.proc.on('exit', () => { this.dead = true; this.waiters.forEach(w => w.reject(new Error(spec.name + ' exited'))); this.waiters = []; });
    this.proc.on('error', err => { this.dead = true; this.waiters.forEach(w => w.reject(err)); this.waiters = []; });
    // An engine that dies before reading its input: writing to it is EPIPE, which unhandled
    // ended the whole match. The exit handler already aborts this game.
    this.proc.stdin.on('error', () => { this.dead = true; });
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', d => {
      this.buf += d;
      let nl;
      while ((nl = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, nl).trim(); this.buf = this.buf.slice(nl + 1);
        const s = line.match(/\bscore (cp|mate) (-?\d+)/);
        if (s) this.lastScore = s[1] === 'cp' ? +s[2] : (+s[2] > 0 ? 100000 : -100000);
        const tm = line.match(/\btime (\d+)/);
        if (tm && line.startsWith('info')) this.lastTime = +tm[1];
        this.waiters = this.waiters.filter(w => { if (w.test(line)) { w.resolve(line); return false; } return true; });
      }
    });
  }
  send(line) { if (!this.dead) this.proc.stdin.write(line + '\n'); }
  wait(re, ms) {
    return new Promise((resolve, reject) => {
      const w = { test: l => re.test(l), resolve, reject };
      this.waiters.push(w);
      const timer = ms && setTimeout(() => { if (this.waiters.includes(w)) { this.waiters = this.waiters.filter(x => x !== w); reject(new Error('timeout')); } }, ms);
      const done = f => v => { clearTimeout(timer); f(v); };
      w.resolve = done(resolve); w.reject = done(reject);
    });
  }
  async start() {
    this.send('uci'); await this.wait(/^uciok/, 30000);
    for (const [k, v] of Object.entries(this.spec.options)) this.send(`setoption name ${k} value ${v}`);
    this.send('ucinewgame'); this.send('isready'); await this.wait(/^readyok/, 60000);
  }
  quit() { this.send('quit'); setTimeout(() => { try { this.proc.kill(); } catch (e) { /* gone */ } }, 1000); }
}

// ---------------------------------------------------------------- one game
async function playGame(white, black, opening) {
  const g = new Chess();
  const uci = [], san = [];
  for (const s of opening.split(' ')) { const m = g.move(s); uci.push(m.fromSq + m.toSq + (m.promo ? Chess.SYM[m.promo] : '')); san.push(m.san); }
  const engines = { w: new UciEngine(white), b: new UciEngine(black) };
  const clock = { w: BASE, b: BASE };
  let result = '*', reason = '';
  const won = winAdjudicator();
  try {
    await Promise.all([engines.w.start(), engines.b.start()]);
    for (;;) {
      const end = gameEnd(g);
      if (end) { ({ result, reason } = end); break; }
      const side = g.turnColor(), e = engines[side];
      e.send('position startpos' + (uci.length ? ' moves ' + uci.join(' ') : ''));
      const limit = e.spec.nodes ? `nodes ${e.spec.nodes}` : e.spec.depth ? `depth ${e.spec.depth}`
        : `wtime ${Math.max(1, clock.w)} btime ${Math.max(1, clock.b)} winc ${INC} binc ${INC}`;
      e.lastScore = null; e.lastTime = null;
      const t0 = Date.now();
      e.send('go ' + limit);
      const line = await e.wait(/^bestmove/, (e.spec.nodes || e.spec.depth) ? 120000 : clock[side] + MARGIN + 5000);
      const used = Date.now() - t0;
      if (VERBOSE) console.error(`    ${e.spec.name} ${line.split(/\s+/)[1]} took ${used} ms (says ${e.lastTime}), clocks w ${clock.w} b ${clock.b} (${limit})`);
      if (!e.spec.nodes && !e.spec.depth) {
        clock[side] -= used;
        if (clock[side] < -MARGIN) { result = side === 'w' ? '0-1' : '1-0'; reason = `${e.spec.name} lost on time`; break; }
        clock[side] += INC;
      }
      const mv = line.split(/\s+/)[1];
      const m = mv && mv !== '0000' ? g.move(mv) : null;
      if (!m) { result = side === 'w' ? '0-1' : '1-0'; reason = `${e.spec.name} played an illegal move (${mv})`; break; }
      uci.push(mv); san.push(m.san);
      const sc = e.lastScore == null ? 0 : (side === 'w' ? e.lastScore : -e.lastScore);   // White's view
      const leader = won(sc);
      if (leader) { result = leader === 'w' ? '1-0' : '0-1'; reason = 'adjudicated: both engines agree it is won'; break; }
    }
  } catch (err) {
    reason = 'aborted: ' + err.message;
    result = '*';
  } finally {
    engines.w.quit(); engines.b.quit();
  }
  return { result, reason, san };
}

function pgnOf(white, black, opening, game, round) {
  const moves = game.san.map((s, i) => (i % 2 === 0 ? `${i / 2 + 1}. ` : '') + s).join(' ');
  return `[Event "tools/match.js ${BASE / 1000}+${INC / 1000}"]\n[Round "${round}"]\n[White "${white.name}"]\n[Black "${black.name}"]\n` +
         `[Result "${game.result}"]\n[Opening "${opening}"]\n[Termination "${game.reason}"]\n\n${moves} ${game.result}\n\n`;
}

// ---------------------------------------------------------------- Elo
function eloOf(w, d, l) {
  const n = w + d + l, s = (w + d / 2) / n;
  if (!n) return { elo: NaN, margin: NaN, s: NaN };
  const clampS = x => Math.min(0.999, Math.max(0.001, x));
  const toElo = x => -400 * Math.log10(1 / clampS(x) - 1);
  const sd = Math.sqrt((w * (1 - s) ** 2 + d * (0.5 - s) ** 2 + l * s ** 2) / n / n);
  return { elo: toElo(s), margin: (toElo(s + 1.96 * sd) - toElo(s - 1.96 * sd)) / 2, s, capped: s <= 0 || s >= 1 };
}
// The rating R that makes the expected total score against the rated opponents equal the actual one.
function performance(rows) {
  const rated = rows.filter(r => r.opp.elo != null && r.n);
  if (!rated.length) return null;
  const actual = rated.reduce((t, r) => t + r.w + r.d / 2, 0), n = rated.reduce((t, r) => t + r.n, 0);
  if (actual <= 0 || actual >= n) return { capped: true, rating: actual <= 0 ? -Infinity : Infinity };
  let lo = -1000, hi = 4000;
  for (let i = 0; i < 60; i++) {
    const R = (lo + hi) / 2;
    const expected = rated.reduce((t, r) => t + r.n / (1 + 10 ** ((r.opp.elo - R) / 400)), 0);
    if (expected < actual) lo = R; else hi = R;
  }
  return { rating: (lo + hi) / 2 };
}

// ---------------------------------------------------------------- run
(async () => {
  const jobs = [];
  opponents.forEach(opp => {
    for (let i = 0; i < GAMES; i++) {
      const opening = OPENINGS[Math.floor(i / 2) % OPENINGS.length], houseWhite = i % 2 === 0;
      jobs.push({ opp, opening, houseWhite, round: i + 1 });
    }
  });
  const rows = opponents.map(opp => ({ opp, w: 0, d: 0, l: 0, n: 0, aborted: 0, reasons: {} }));
  if (PGN) fs.writeFileSync(PGN, '');
  console.log(`${house.name} against ${opponents.map(o => o.name).join(', ')}: ${GAMES} games each at ${BASE / 1000}+${INC / 1000}, ${CONCURRENCY} at a time\n`);
  let next = 0;
  async function worker() {
    while (next < jobs.length) {
      const job = jobs[next++];
      const [white, black] = job.houseWhite ? [house, job.opp] : [job.opp, house];
      const game = await playGame(white, black, job.opening);
      const row = rows.find(r => r.opp === job.opp);
      row.reasons[game.reason] = (row.reasons[game.reason] || 0) + 1;
      if (game.result === '*') row.aborted++;
      else {
        row.n++;
        const houseWon = (game.result === '1-0') === job.houseWhite;
        if (game.result === '1/2-1/2') row.d++; else if (houseWon) row.w++; else row.l++;
      }
      if (PGN) fs.appendFileSync(PGN, pgnOf(white, black, job.opening, game, job.round));
      process.stdout.write(`  ${white.name} - ${black.name}  ${game.result}  (${game.reason}, ${game.san.length} plies)\n`);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  console.log(`\n${'opponent'.padEnd(16)} ${'games'.padStart(5)}   +  =  -   score   Elo difference`);
  rows.forEach(r => {
    const e = eloOf(r.w, r.d, r.l);
    const diff = !r.n ? '-' : e.capped ? (e.s <= 0 ? 'below -1200 (no points)' : 'above +1200 (every point)')
      : `${e.elo >= 0 ? '+' : ''}${e.elo.toFixed(0)} +/- ${e.margin.toFixed(0)}` + (r.opp.elo != null ? `  -> about ${Math.round(r.opp.elo + e.elo)}` : '');
    console.log(`${r.opp.name.padEnd(16)} ${String(r.n).padStart(5)}  ${String(r.w).padStart(2)} ${String(r.d).padStart(2)} ${String(r.l).padStart(2)}  ` +
                `${r.n ? (100 * e.s).toFixed(0).padStart(4) + '%' : '    -'}   ${diff}${r.aborted ? `  (${r.aborted} aborted)` : ''}`);
  });
  const perf = performance(rows);
  if (perf) console.log(`\nPerformance rating against the rated opponents: ` +
    (perf.capped ? (perf.rating < 0 ? 'below the weakest (no points scored)' : 'above the strongest (every point scored)') : Math.round(perf.rating)));
  const ends = {};
  rows.forEach(r => Object.entries(r.reasons).forEach(([k, v]) => { ends[k] = (ends[k] || 0) + v; }));
  console.log('How games ended: ' + Object.entries(ends).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', '));
  if (PGN) console.log('PGN: ' + PGN);
})();
