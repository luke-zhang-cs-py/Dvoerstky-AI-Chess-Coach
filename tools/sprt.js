#!/usr/bin/env node
// Engine against engine, with a Sequential Probability Ratio Test deciding when
// the result is no longer noise -- the method cutechess-cli and Fishtest use.
//
//   node tools/sprt.js --base path/to/old/engine.js [--new js/engine.js]
//        [--movetime 60] [--elo0 0] [--elo1 20] [--games 400] [--threads 6]
//
// H0: the new engine is elo0 stronger (usually 0: no better). H1: it is elo1
// stronger. After every game the log-likelihood ratio is updated; above the
// upper bound, H1 is accepted (it is better); below the lower one, H0 is (it
// isn't); in between, keep playing. alpha = beta = 0.05.
//
// Each opening is played twice with colours swapped, so neither engine gets
// the better side of an unbalanced line. Games end by the rules (mate,
// stalemate, fifty moves, threefold repetition, dead position) or by
// adjudication: 200 plies is a draw, and a score beyond +/-10 pawns from both
// engines for 6 plies running is a win.
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const path = require('path');
const { OPENINGS, gameEnd, winAdjudicator } = require('./games.js');

function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  return i > -1 ? process.argv[i + 1] : dflt;
}

// ---------------------------------------------------------------- a game, in a worker
function playGame({ corePath, whitePath, blackPath, opening, movetime }) {
  globalThis.window = globalThis;
  const Chess = require(corePath);
  const load = p => { delete require.cache[require.resolve(p)]; return require(p); };
  const White = load(whitePath), Black = load(blackPath);
  const engines = { w: new White(), b: new Black() };
  const g = new Chess();
  opening.split(' ').forEach(s => g.move(s));
  const won = winAdjudicator();
  for (;;) {
    const end = gameEnd(g);
    if (end) return end.result;
    const side = g.turnColor();
    const r = engines[side].rank(g, 64, movetime);
    if (!r.length) return '1/2-1/2';
    const whitePov = side === 'w' ? r[0].score : -r[0].score;
    const leader = won(whitePov);
    if (leader) return leader === 'w' ? '1-0' : '0-1';
    g.makeMove(r[0].move);
  }
}

if (!isMainThread) {
  parentPort.on('message', job => parentPort.postMessage({ id: job.id, result: playGame(job), newIsWhite: job.newIsWhite }));
  return;
}

// ---------------------------------------------------------------- SPRT
// The trinomial approximation used by cutechess-cli: LLR from the mean score
// and its variance, with the two hypotheses as expected scores.
function llr(w, d, l, elo0, elo1) {
  const n = w + d + l;
  if (!w || !l) return 0;
  const s = (w + d / 2) / n;
  const variance = (w * (1 - s) ** 2 + d * (0.5 - s) ** 2 + l * (0 - s) ** 2) / n;
  const score = elo => 1 / (1 + 10 ** (-elo / 400));
  const s0 = score(elo0), s1 = score(elo1);
  return n * (s1 - s0) * (2 * s - s0 - s1) / (2 * variance);
}
function eloOf(w, d, l) {
  const n = w + d + l, s = (w + d / 2) / n;
  if (s <= 0 || s >= 1) return { elo: s <= 0 ? -Infinity : Infinity, margin: NaN };
  const elo = -400 * Math.log10(1 / s - 1);
  const sd = Math.sqrt((w * (1 - s) ** 2 + d * (0.5 - s) ** 2 + l * s ** 2) / n / n);
  const hi = -400 * Math.log10(1 / Math.min(0.999, s + 1.96 * sd) - 1), lo = -400 * Math.log10(1 / Math.max(0.001, s - 1.96 * sd) - 1);
  return { elo, margin: (hi - lo) / 2 };
}

const base = path.resolve(arg('base', ''));
const cand = path.resolve(arg('new', path.join(__dirname, '..', 'js', 'engine.js')));
const corePath = path.resolve(arg('core', path.join(__dirname, '..', 'js', 'core.js')));
const movetime = +arg('movetime', 60), elo0 = +arg('elo0', 0), elo1 = +arg('elo1', 20);
const maxGames = +arg('games', 400), threads = +arg('threads', 6);
if (!arg('base')) { console.error('usage: node tools/sprt.js --base old/engine.js [--new js/engine.js]'); process.exit(2); }

const lower = Math.log(0.05 / 0.95), upper = Math.log(0.95 / 0.05);
console.log(`SPRT elo0=${elo0} elo1=${elo1} alpha=beta=0.05  bounds [${lower.toFixed(2)}, ${upper.toFixed(2)}]`);
console.log(`new  ${cand}\nbase ${base}\n${movetime} ms a move, up to ${maxGames} games, ${threads} at a time\n`);

let next = 0, done = 0, w = 0, d = 0, l = 0, stopped = null;
const jobs = [];
for (let i = 0; i < maxGames; i++) {
  const opening = OPENINGS[Math.floor(i / 2) % OPENINGS.length], newIsWhite = i % 2 === 0;
  jobs.push({ id: i, corePath, opening, movetime, newIsWhite,
              whitePath: newIsWhite ? cand : base, blackPath: newIsWhite ? base : cand });
}
const workers = [];
function report(final) {
  const e = eloOf(w, d, l), ratio = llr(w, d, l, elo0, elo1);
  console.log(`${final ? 'FINAL ' : ''}games ${done}  +${w} =${d} -${l}  elo ${isFinite(e.elo) ? e.elo.toFixed(1) : e.elo} ` +
              `+/- ${isFinite(e.margin) ? e.margin.toFixed(1) : '?'}  LLR ${ratio.toFixed(2)} ` +
              `${final ? '-> ' + (stopped || 'inconclusive: no hypothesis accepted within the game limit') : ''}`);
}
function feed(worker) {
  if (stopped || next >= jobs.length) { worker.terminate(); return; }
  worker.postMessage(jobs[next++]);
}
for (let t = 0; t < threads; t++) {
  const worker = new Worker(__filename);
  worker.on('message', ({ result, newIsWhite }) => {
    done++;
    const newWon = (result === '1-0' && newIsWhite) || (result === '0-1' && !newIsWhite);
    if (result === '1/2-1/2') d++; else if (newWon) w++; else l++;
    const ratio = llr(w, d, l, elo0, elo1);
    if (!stopped && ratio >= upper) stopped = 'H1 accepted: the new engine is stronger';
    if (!stopped && ratio <= lower) stopped = 'H0 accepted: the new engine is not ' + elo1 + ' Elo stronger';
    if (done % 20 === 0) report(false);
    if (stopped || done >= jobs.length) { if (!workers.finished) { workers.finished = true; setTimeout(() => { report(true); process.exit(0); }, 50); } }
    feed(worker);
  });
  workers.push(worker);
  feed(worker);
}
