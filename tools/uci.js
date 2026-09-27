#!/usr/bin/env node
// The house engine behind the UCI protocol, so cutechess-cli, Arena, or any UCI
// GUI can play it -- against itself, an older version, or Stockfish.
//   node tools/uci.js
//   cutechess-cli -engine cmd=node arg=tools/uci.js -engine cmd=stockfish ...
globalThis.window = globalThis;
const path = require('path');
const Chess = require(path.join(__dirname, '..', 'js', 'core.js'));
const Engine = require(path.join(__dirname, '..', 'js', 'engine.js'));

let engine = new Engine();
let moveOverhead = 50;            // ms kept back for the GUI and the pipes (UCI "Move Overhead")
let game = new Chess();
const say = line => process.stdout.write(line + '\n');

function setPosition(tokens) {
  let i = 1;
  if (tokens[i] === 'startpos') { game = new Chess(); i++; }
  else if (tokens[i] === 'fen') { game = new Chess(tokens.slice(i + 1, i + 7).join(' ')); i += 7; }
  if (tokens[i] === 'moves') {
    for (const uci of tokens.slice(i + 1)) {
      if (!game.move(uci)) { say('info string illegal move ' + uci); return; }
    }
  }
}

// Time for this move: a fixed movetime, or a slice of the clock, less the overhead,
// and never more than the clock can pay for.
function budget(opts, white) {
  if (opts.movetime) return Math.max(10, opts.movetime - moveOverhead);
  const left = white ? opts.wtime : opts.btime, inc = (white ? opts.winc : opts.binc) || 0;
  if (left == null) return opts.depth ? 0 : 1000;
  const moves = opts.movestogo || 30;
  return Math.max(10, Math.min(left / 2, left / moves + inc * 0.8, left - 2 * moveOverhead) - moveOverhead);
}

function go(tokens) {
  const opts = {};
  for (let i = 1; i < tokens.length; i++) {
    const k = tokens[i];
    if (['depth', 'movetime', 'wtime', 'btime', 'winc', 'binc', 'movestogo', 'nodes'].includes(k)) opts[k] = +tokens[++i];
  }
  const t0 = Date.now();
  const ms = budget(opts, game.turnColor() === 'w');
  const r = engine.rank(game, opts.depth || 64, ms);
  if (!r.length) { say('bestmove 0000'); return; }
  const best = r[0], took = Math.max(1, Date.now() - t0);
  const mate = Engine.mateIn(best.score);
  const score = mate !== null ? 'mate ' + mate : 'cp ' + Math.round(best.score);
  say(`info score ${score} nodes ${engine.nodes} nps ${Math.round(engine.nodes / took * 1000)} time ${took} pv ${best.uci}`);
  say('bestmove ' + best.uci);
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
      case 'ucinewgame': engine = new Engine(); game = new Chess(); break;
      case 'position': setPosition(t); break;
      case 'go': go(t); break;
      case 'quit': process.exit(0);
      default: break;          // stop, ponderhit: the search is synchronous
    }
  }
});
