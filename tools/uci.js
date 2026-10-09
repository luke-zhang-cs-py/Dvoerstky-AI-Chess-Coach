#!/usr/bin/env node
// The house engine behind the UCI protocol, so cutechess-cli, Arena, or any UCI
// GUI can play it -- against itself, an older version, or Stockfish.
//   node tools/uci.js
//   cutechess-cli -engine cmd=node arg=tools/uci.js -engine cmd=stockfish ...
//
// The search runs in a worker thread, so the protocol thread keeps reading:
// "isready" is answered at once mid-search, "stop" ends the search (the
// worker polls a shared flag with the clock and plays its best so far), and
// "quit" exits. "go infinite" searches until "stop"; "go nodes N" stops at
// N nodes.
globalThis.window = globalThis;
const path = require('path');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const Chess = require(path.join(__dirname, '..', 'js', 'core.js'));
const Engine = require(path.join(__dirname, '..', 'js', 'engine.js'));

// ---------------------------------------------------------------- the search, in the worker
if (!isMainThread) {
  const stopFlag = new Int32Array(workerData.stop);
  const fresh = () => { const e = new Engine(); e.shouldStop = () => Atomics.load(stopFlag, 0) !== 0; return e; };
  let engine = fresh();
  parentPort.on('message', job => {
    if (job.type === 'new') { engine = fresh(); return; }
    const g = new Chess(job.fen);
    job.moves.forEach(m => g.move(m));
    engine.nodeLimit = job.nodes || 0;
    const t0 = Date.now();
    const r = engine.rank(g, job.depth, job.ms);
    const took = Math.max(1, Date.now() - t0);
    parentPort.postMessage(r.length ? { uci: r[0].uci, score: r[0].score, nodes: engine.nodes, took } : { uci: null });
  });
  return;
}

let moveOverhead = 50;            // ms kept back for the GUI and the pipes (UCI "Move Overhead")
let game = new Chess(), startFen = Chess.START, played = [];
const say = line => process.stdout.write(line + '\n');

const stopBuffer = new SharedArrayBuffer(4), stopFlag = new Int32Array(stopBuffer);
const worker = new Worker(__filename, { workerData: { stop: stopBuffer } });
worker.unref();                   // idle, it does not keep the process alive
let searching = null;             // {infinite, stopped, result} while a search is out
let inputEnded = false;

// "position [startpos | fen <FEN>] [moves m1 m2 ...]". The FEN is everything up
// to "moves" or the end of the line, so one with fewer than six fields works.
function setPosition(tokens) {
  let i = 1, fen;
  if (tokens[i] === 'startpos') { fen = Chess.START; i++; }
  else if (tokens[i] === 'fen') {
    const end = tokens.indexOf('moves', i + 1);
    fen = tokens.slice(i + 1, end < 0 ? tokens.length : end).join(' ');
    i = end < 0 ? tokens.length : end;
  } else return;
  let g;
  try { g = new Chess(fen); } catch (e) { say('info string invalid fen: ' + e.message); return; }
  const moves = [];
  if (tokens[i] === 'moves') {
    for (const uci of tokens.slice(i + 1)) {
      const m = g.move(uci);
      if (!m) { say('info string illegal move ' + uci); break; }
      moves.push(m.fromSq + m.toSq + (m.promo ? Chess.SYM[m.promo] : ''));
    }
  }
  game = g; startFen = fen; played = moves;
}

// Time for this move: a fixed movetime, or a slice of the clock, less the overhead,
// and never more than the clock can pay for. 0 is no time limit.
function budget(opts, white) {
  if (opts.infinite) return 0;
  if (opts.movetime) return Math.max(10, opts.movetime - moveOverhead);
  const left = white ? opts.wtime : opts.btime, inc = (white ? opts.winc : opts.binc) || 0;
  if (left == null) return (opts.depth || opts.nodes) ? 0 : 1000;
  const moves = opts.movestogo || 30;
  return Math.max(10, Math.min(left / 2, left / moves + inc * 0.8, left - 2 * moveOverhead) - moveOverhead);
}

function sendBest(r) {
  if (!r.uci) { say('bestmove 0000'); return; }
  const mate = Engine.mateIn(r.score);
  const score = mate !== null ? 'mate ' + mate : 'cp ' + Math.round(r.score);
  say(`info score ${score} nodes ${r.nodes} nps ${Math.round(r.nodes / r.took * 1000)} time ${r.took} pv ${r.uci}`);
  say('bestmove ' + r.uci);
}

// The worker has answered. Under "go infinite" the move waits for "stop".
function finished(r) {
  const s = searching;
  if (s.infinite && !s.stopped) { s.result = r; return; }
  searching = null;
  worker.unref();
  sendBest(r);
  if (inputEnded) process.exit(0);
}

worker.on('message', finished);
worker.on('error', err => { say('info string search failed: ' + err.message); process.exit(1); });

function go(tokens) {
  if (searching) { say('info string already searching'); return; }
  const opts = {};
  for (let i = 1; i < tokens.length; i++) {
    const k = tokens[i];
    if (['depth', 'movetime', 'wtime', 'btime', 'winc', 'binc', 'movestogo', 'nodes'].includes(k)) opts[k] = +tokens[++i];
    else if (k === 'infinite') opts.infinite = true;
  }
  Atomics.store(stopFlag, 0, 0);
  searching = { infinite: !!opts.infinite, stopped: false, result: null };
  worker.ref();
  worker.postMessage({ fen: startFen, moves: played, depth: opts.depth || 64,
    ms: budget(opts, game.turnColor() === 'w'), nodes: opts.nodes || 0 });
}

function stop() {
  if (!searching) return;
  searching.stopped = true;
  Atomics.store(stopFlag, 0, 1);
  if (searching.result) finished(searching.result);   // an infinite search already done, waiting
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, nl).trim(); buffer = buffer.slice(nl + 1);
    const t = line.split(/\s+/);
    switch (t[0]) {
      case 'uci':
        say('id name Dvoretsky Lab'); say('id author Luke Zhang');
        say('option name Move Overhead type spin default 50 min 0 max 5000'); say('uciok'); break;
      case 'setoption': {
        const m = line.match(/^setoption name (.+?) value (.+)$/i);
        if (m && /^move overhead$/i.test(m[1])) moveOverhead = Math.max(0, Math.min(5000, +m[2] || 0));
        break;
      }
      case 'isready': say('readyok'); break;
      case 'ucinewgame':
        if (!searching) { worker.postMessage({ type: 'new' }); game = new Chess(); startFen = Chess.START; played = []; }
        break;
      case 'position': if (!searching) setPosition(t); break;
      case 'go': go(t); break;
      case 'stop': stop(); break;
      case 'quit': process.exit(0);
      default: break;          // ponderhit and the rest
    }
  }
});
// Input closed (a script piped in): let a timed search finish, end an infinite one, then exit.
process.stdin.on('end', () => {
  inputEnded = true;
  if (!searching) process.exit(0);
  if (searching.infinite) stop();
});
