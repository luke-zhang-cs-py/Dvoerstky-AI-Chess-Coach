// Stockfish 19 in the page's reader: the vendored engine itself, run in Node, and the time rule.
// Run: node test/stockfish19.js
//
// 1. js/vendor/stockfish-19-src.js holds the two files of stockfish@19.0.1 byte for byte (the
//    SHA-256 pinned in make_stockfish_src.py).
// 2. The glue runs in Node too: it is written out beside its .wasm, loaded as the module it is
//    in Node in a worker thread, and put behind a stand-in for a Worker, so js/stockfish-reader.js drives the real
//    Stockfish 19 here as it does in the page. Stockfish answers as Stockfish 19, finds a mate
//    in one, and says when there is no move.
// 3. The time rule on the real engine, at 50, 100, 250, 500 and 1000 ms, 20 reads each (min/median/max
//    printed): no answer before T - 5 ms, held strictly. No answer after T is the rule too, and the
//    browser check (test/ui_check.py) holds it for every read; here one late read in 20 is let
//    through, and printed. Measured on Windows (VS Code's Code.exe as Node, 13 October 2026), Node's
//    main thread stalls for 6 to 49 ms at a time while the engine thread searches (a loop of
//    messages to itself saw the gaps; garbage collection was at most 4 ms of them), and a stall
//    across a deadline makes that read late by as much: 2 late in 100 at worst, by 1 to 10 ms,
//    none in most runs. A page's main thread did not stall that way in the same runs.
// 4. The reader's deadline control with scripted workers: a bestmove too early is held, none
//    by the deadline is answered from the last line, a late bestmove is dropped and never
//    answers the next position, a worker that never answers is replaced.
globalThis.window = globalThis;
const fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto');
require('../js/core.js');
const SR = require('../js/stockfish-reader.js');
require('../js/vendor/stockfish-19-src.js');
const { Chess } = globalThis;

let failed = 0, passed = 0;
function check(name, ok, detail) {
  if (ok) passed++; else failed++;
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail !== undefined ? '  [' + detail + ']' : ''));
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const median = a => { const s = a.slice().sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

(async () => {
  // ---------------------------------------------------------------- 1. the vendored files
  const glue = Buffer.from(globalThis.STOCKFISH_SOURCE, 'utf8'), wasm = Buffer.from(globalThis.STOCKFISH_WASM, 'base64');
  const pins = fs.readFileSync(path.join(__dirname, '..', 'js', 'vendor', 'make_stockfish_src.py'), 'utf8');
  const pin = name => (pins.match(new RegExp('"package/bin/' + name.replace(/\./g, '\\.') + '": "([0-9a-f]{64})"')) || [])[1];
  const sha = b => crypto.createHash('sha256').update(b).digest('hex');
  check('vendor: the glue is bin/stockfish-19-lite-single.js of stockfish@19.0.1, byte for byte',
        glue.length === 28230 && sha(glue) === pin('stockfish-19-lite-single.js'), glue.length + ' bytes, ' + sha(glue));
  check('vendor: the engine is bin/stockfish-19-lite-single.wasm, byte for byte',
        wasm.length === 1845971 && sha(wasm) === pin('stockfish-19-lite-single.wasm'), wasm.length + ' bytes, ' + sha(wasm));

  // ---------------------------------------------------------------- 2. the real engine, behind the reader
  // In Node the glue loads the .wasm named after itself from its own folder, and is one engine per process.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dvor-sf19-'));
  fs.writeFileSync(path.join(dir, 'stockfish-19-lite-single.js'), glue);
  fs.writeFileSync(path.join(dir, SR.WASM_NAME), wasm);
  // The engine runs in a thread of its own, as in the page: the glue, loaded as a module there, its lines posted back.
  const BOOT = "const { parentPort, workerData } = require('worker_threads');" +
               "const sf = require(workerData)(); sf.listener = line => parentPort.postMessage(line);" +
               "parentPort.on('message', cmd => sf.processCommand(cmd));";
  const { Worker: Thread } = require('worker_threads');
  const urls = [];
  class GlueWorker {   // what the reader needs of a Worker: postMessage, onmessage, onerror, terminate
    constructor(url) {
      urls.push(url);
      this.thread = new Thread(BOOT, { eval: true, workerData: path.join(dir, 'stockfish-19-lite-single.js') });
      this.thread.on('message', line => this.onmessage && this.onmessage({ data: line }));
      this.thread.on('error', e => this.onerror && this.onerror(e));
    }
    postMessage(cmd) { this.thread.postMessage(cmd); }
    terminate() { this.thread.terminate(); }
  }
  const realWorker = globalThis.Worker;
  globalThis.Worker = GlueWorker;
  const heard = [];
  const r = new SR.Reader(globalThis.STOCKFISH_SOURCE, globalThis.STOCKFISH_WASM);
  const onLine = r.onLine;
  r.onLine = function (line) { heard.push(line); return onLine.call(this, line); };
  const t0 = performance.now();
  await r.start();
  const startMs = performance.now() - t0;
  check('engine: the vendored glue runs in Node and answers the UCI handshake as Stockfish 19',
        heard.includes('id name Stockfish 19 Lite WASM') && heard.includes('uciok') && heard.includes('readyok'),
        heard.filter(l => /^id name/.test(l)).join() + ', ready in ' + Math.round(startMs) + ' ms');
  check('engine: the worker is made with the .wasm\'s name after its #, where the glue looks for it',
        urls.length === 1 && urls[0].endsWith('#' + SR.WASM_NAME), urls[0]);
  check('engine: single-threaded, so Threads is fixed at 1', heard.includes('option name Threads type spin default 1 min 1 max 1'));
  const mate = await r.read('6k1/5ppp/8/8/8/8/5PPP/3R2K1 w - - 0 1', { movetime: 200 });
  check('engine: a mate in one is found and scored #1', mate.best === 'd1d8' && mate.mate === 1 && mate.cp === SR.MATE - 1,
        JSON.stringify({ best: mate.best, mate: mate.mate, cp: mate.cp, how: mate.how, ms: Math.round(mate.ms) }));
  const stale = await r.read('7k/5Q2/6K1/8/8/8/8/8 b - - 0 1', { movetime: 100 });
  check('engine: stalemate, "bestmove (none)": no move, a score of 0, and still answered in the window',
        stale.best === null && stale.cp === 0 && stale.how === 'held' && stale.ms >= 95 && stale.ms <= 100,
        JSON.stringify({ best: stale.best, cp: stale.cp, how: stale.how, ms: stale.ms.toFixed(1) }));
  const mated = await r.read('7k/6Q1/6K1/8/8/8/8/8 b - - 0 1', { movetime: 100 });
  check('engine: checkmated, "score mate 0": no move and the bottom of the scale for the side mated',
        mated.best === null && mated.cp === SR.MATE, JSON.stringify({ best: mated.best, cp: mated.cp }));
  const g = new Chess();
  const open = await r.read(g.fen(), { movetime: 300, multipv: 2 });
  check('engine: two lines asked for, two lines given, each with a legal first move',
        open.lines.length === 2 && open.lines.every(l => l.pv.length && g.moveFromSan(l.pv[0])) && !!g.moveFromSan(open.best),
        open.lines.map(l => l.pv[0] + ' ' + l.cp).join(', '));

  // ---------------------------------------------------------------- 3. the time rule, measured
  const FENS = ['rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
                'r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3',
                'r1bq1rk1/pp2bppp/2n1pn2/3p4/2PP4/2N1PN2/PP3PPP/R2QKB1R w KQ - 0 8',
                '8/5pk1/6p1/8/3R4/6P1/5PKP/2r5 w - - 0 40'];
  const PER = 20;
  console.log('\n  the time rule in Node (real Stockfish 19): ms from the search sent to the answer');
  for (const T of [50, 100, 250, 500, 1000]) {
    const ms = [], hows = {}, bm = [], hw = [];
    for (let k = 0; k < PER; k++) {
      const res = await r.read(FENS[k % FENS.length], { movetime: T });
      ms.push(res.ms); hw.push(res.how); hows[res.how] = (hows[res.how] || 0) + 1;
      const t = r.timings[r.timings.length - 1];
      if (t.bestmoveMs !== undefined) bm.push(t.bestmoveMs);
    }
    const early = ms.filter(x => x < T - 5), late = ms.filter(x => x > T);
    const f = x => x.toFixed(1);
    console.log('  T ' + String(T).padStart(4) + ' ms: answer min ' + f(Math.min(...ms)) + ', median ' + f(median(ms)) + ', max ' + f(Math.max(...ms)) +
                '; bestmove min ' + f(Math.min(...bm)) + ', median ' + f(median(bm)) + ', max ' + f(Math.max(...bm)) + '; ' + JSON.stringify(hows));
    // Never early, held strictly. Late: at most one of the 20, said so -- see the note at the top.
    check('time: ' + PER + ' reads of ' + T + ' ms, none before ' + (T - 5) + ' ms, and at most one after ' + T + ' ms (a stall of Node itself)',
          early.length === 0 && late.length <= 1,
          (early.length + late.length ? 'outside: ' + early.concat(late).map(x => x.toFixed(1) + ' (' + hw[ms.indexOf(x)] + ')').join(', ') + '; ' : '') +
          'min ' + Math.min(...ms).toFixed(1) + ', max ' + Math.max(...ms).toFixed(1));
  }
  r.terminate();
  globalThis.Worker = realWorker;
  fs.rmSync(dir, { recursive: true, force: true });

  // ---------------------------------------------------------------- 4. the deadline control, scripted
  // A stand-in worker run by a script: script(cmd, say) answers each command; say(line, afterMs).
  function scripted(script) {
    const sent = [];
    class W {
      constructor(url) { this.url = url; W.made.push(this); }
      postMessage(cmd) {
        sent.push(cmd);
        const say = (l, t) => setTimeout(() => this.onmessage && this.onmessage({ data: l }), t || 0);
        if (cmd === 'isready') say('readyok');
        else script(cmd, say, this);
      }
      terminate() { this.onmessage = null; W.ended++; }
    }
    W.made = []; W.ended = 0; W.sent = sent;
    return W;
  }
  const F = Chess.START;
  {
    // At once: held to the window. Before, an early bestmove answered as soon as it came.
    const W = scripted((c, say) => { if (c.startsWith('go')) { say('info depth 5 multipv 1 score cp 21 wdl 50 900 50 pv e2e4 e7e5'); say('bestmove e2e4', 1); } });
    globalThis.Worker = W;
    const q = new SR.Reader('/* engine */');
    await q.start();
    const a = await q.read(F, { movetime: 60 });
    check('deadline: a bestmove that comes at once is held until the window opens, and answers then',
          a.best === 'e2e4' && a.how === 'held' && a.ms >= 55 && a.ms <= 60, a.how + ' at ' + a.ms.toFixed(1) + ' ms');
    check('deadline: the search asked for is "go movetime", short of the budget by the hold point and the overrun allowed',
          W.sent.includes('go movetime ' + Math.floor(60 - SR.HOLD - 3)), W.sent.filter(c => c.startsWith('go')).join());
    check('deadline: no "wdl" unless asked for, but an info line with it still reads', SR.parseInfo('info depth 5 multipv 1 score cp 21 wdl 50 900 50 pv e2e4').wdl.join() === '50,900,50');
    q.terminate();
  }
  {
    // Never by itself: at T - CUT the deepest line answers, Stockfish is told to stop, and its bestmove, when it
    // comes, is dropped. The next read is not sent before it, and is answered by its own search.
    let n = 0;
    const W = scripted((c, say) => {
      if (c.startsWith('go') && ++n === 1) { say('info depth 7 multipv 1 score cp 33 pv d2d4 d7d5', 2); }
      if (c.startsWith('go') && n === 2) { say('info depth 7 multipv 1 score cp -15 pv g8f6', 2); say('bestmove g8f6', 4); }
      if (c === 'stop' && n === 1) say('bestmove a2a3', 40);   // late, and not the line's move
    });
    globalThis.Worker = W;
    const q = new SR.Reader('/* engine */');
    await q.start();
    const g2 = new Chess(); g2.move('e4');
    const p1 = q.read(F, { movetime: 50 }), p2 = q.read(g2.fen(), { movetime: 50 });
    const a = await p1;
    const goesAt = W.sent.filter(c => c.startsWith('go')).length;
    const b = await p2;
    const order = W.sent.filter(c => c === 'stop' || c.startsWith('go') || c.startsWith('position')).map(c => c.split(' ')[0]);
    check('deadline: no bestmove by T - ' + SR.CUT + ' ms: the deepest line answers on time, and Stockfish is told to stop',
          a.best === 'd2d4' && a.how === 'deadline' && a.ms >= 45 && a.ms <= 50 && W.sent.includes('stop'), a.best + ' ' + a.how + ' at ' + a.ms.toFixed(1));
    check('deadline: the late bestmove is dropped: the next position is sent only after it, and answered by its own search',
          goesAt === 1 && order.join() === 'position,go,stop,position,go' && b.best === 'g8f6' && b.cp === 15, order.join() + '; ' + b.best);
    q.terminate();
  }
  {
    // A line with a score but no moves at the deadline: nothing to answer from, so the reader waits for the bestmove
    // that its "stop" brings, which answers.
    const W = scripted((c, say) => { if (c.startsWith('go')) say('info depth 3 multipv 1 score cp 5'); if (c === 'stop') say('bestmove e2e4'); });
    globalThis.Worker = W;
    const q = new SR.Reader('/* engine */');
    await q.start();
    const a = await q.read(F, { movetime: 40 });
    // (It comes when the worker sends it, so it can be late: Stockfish itself always reports a line with moves first.)
    check('deadline: a deepest line with no move is not an answer; the bestmove the stop brings is',
          a.best === 'e2e4' && a.how === 'bestmove' && a.cp === 5 && a.ms >= 40 - SR.CUT && W.sent.includes('stop'), a.best + ' ' + a.how + ' at ' + a.ms.toFixed(1));
    q.terminate();
  }
  {
    // A worker that says nothing to a search: no line to answer from at the deadline, so the watchdog replaces the
    // worker, the read fails saying so, and the read queued behind it is answered by the new worker.
    const W = scripted((c, say, w) => { if (c.startsWith('go') && W.made.indexOf(w) > 0 && !w.quiet) say('bestmove e2e4'); });
    globalThis.Worker = W;
    const q = new SR.Reader('/* engine */');
    await q.start();
    const t1 = performance.now();
    const p1 = q.read(F, { movetime: 30 }).then(() => 'answered', e => e.message), p2 = q.read(F, { movetime: 30 });
    const why = await p1, waited = performance.now() - t1, b = await p2;
    check('watchdog: a worker that never answers is replaced, the read fails saying why, the next read is answered',
          /^Stockfish stopped answering/.test(why) && waited >= 30 + SR.WATCHDOG && W.made.length === 2 && W.ended === 1 && b && b.best === 'e2e4',
          why + ' after ' + Math.round(waited) + ' ms; workers ' + W.made.length);
    // The same, after the read was dropped (clear): nothing to fail, and with nothing queued no new worker is made.
    W.made[1].quiet = true;   // the second worker goes quiet too
    const p3 = q.read(F, { movetime: 30 });
    await sleep(5);
    q.clear();
    const dropped = await p3;
    await sleep(30 + SR.WATCHDOG + 50);
    check('watchdog: a dropped read whose worker went quiet: the worker is let go, and none is started for an empty queue',
          dropped === null && W.ended === 2 && W.made.length === 2 && q.worker === null && q.searching === null, W.ended + ' ' + W.made.length);
    q.terminate();
  }
  {
    // Answered at its deadline, but the bestmove never comes, stop or no stop: the watchdog still lets that worker go,
    // and the next read gets a new one.
    const W = scripted((c, say, w) => { if (c.startsWith('go')) say('info depth 4 multipv 1 score cp 12 pv g1f3'); if (c.startsWith('go') && w !== W.made[0]) say('bestmove g1f3', 1); });
    globalThis.Worker = W;
    const q = new SR.Reader('/* engine */');
    await q.start();
    const a = await q.read(F, { movetime: 20 });
    await sleep(20 + SR.WATCHDOG + 50);
    const gone = W.ended === 1 && q.worker === null;
    await q.start();
    const b = await q.read(F, { movetime: 20 });
    check('watchdog: a read answered at its deadline whose bestmove never comes: the worker is let go, the next read has a new one',
          a.how === 'deadline' && a.best === 'g1f3' && gone && W.made.length === 2 && b.best === 'g1f3' && b.how !== 'deadline', [a.how, gone, W.made.length, b.how].join(' '));
    q.terminate();
  }
  {
    // The watchdog's new worker cannot be made at all: the read queued for it fails, saying why.
    let made = 0;
    globalThis.Worker = class { constructor() { if (++made > 1) throw new Error('no second worker'); }
      postMessage(c) { if (c === 'isready') setTimeout(() => this.onmessage({ data: 'readyok' })); } terminate() {} };
    const q = new SR.Reader('/* engine */');
    await q.start();
    const p1 = q.read(F, { movetime: 20 }).then(() => 'answered', e => e.message), p2 = q.read(F, { movetime: 20 }).then(() => 'answered', e => e.message);
    const both = await Promise.all([p1, p2]);
    check('watchdog: when the replacement worker cannot be made, the read queued for it fails with that reason',
          /^Stockfish stopped answering/.test(both[0]) && both[1] === 'no second worker', both.join(' | '));
    q.terminate();
  }
  {
    // clear() while a bestmove that came early is held: the read resolves null at once, and nothing more is sent.
    const W = scripted((c, say) => { if (c.startsWith('go')) say('bestmove e2e4'); });
    globalThis.Worker = W;
    const q = new SR.Reader('/* engine */');
    await q.start();
    const p = q.read(F, { movetime: 200 });
    await sleep(40);   // the bestmove is in and held
    const sentBefore = W.sent.length, t = performance.now();
    q.clear();
    const res = await p;
    check('clear: a read held for its window resolves null at once when dropped, with no stop sent to an idle engine',
          res === null && performance.now() - t < 20 && W.sent.length === sentBefore, W.sent.slice(sentBefore).join());
    q.terminate();
  }
  {
    // A worker error while a search runs fails the read in hand, and the next read does not wait for that search.
    const W = scripted((c, say, w) => { if (c.startsWith('go') && W.sent.filter(x => x.startsWith('go')).length > 1) say('bestmove e2e4'); });
    globalThis.Worker = W;
    const q = new SR.Reader('/* engine */');
    await q.start();
    const p1 = q.read(F, { movetime: 200 }).then(() => 'answered', e => e.message);
    await sleep(5);
    W.made[0].onerror({});
    const why = await p1, b = await q.read(F, { movetime: 30 });
    check('failure: a worker error fails the read in hand, and the next one is searched and answered',
          why === 'Stockfish did not start: worker error' && b.best === 'e2e4' && b.how === 'held', why + '; ' + (b && b.best));
    q.terminate();
  }
  {
    // A worker with the .wasm: the Blob holds the decoder before the engine, and the URL names the .wasm after its #.
    const parts = [];
    const RealBlob = globalThis.Blob;
    globalThis.Blob = class extends RealBlob { constructor(p, o) { super(p, o); parts.push(p); } };
    const W = scripted(() => {});
    globalThis.Worker = W;
    const q = new SR.Reader('/* engine */', 'AAEC');
    await q.start();
    globalThis.Blob = RealBlob;
    check('wasm: the worker\'s script is the .wasm (base64), the lines that answer its fetch, then the engine, unchanged',
          parts[0][1] === 'AAEC' && /self\.fetch = function/.test(parts[0][3]) && parts[0][4] === '/* engine */' && W.made[0].url.endsWith('#' + SR.WASM_NAME),
          W.made[0].url);
    q.terminate();
  }
  {
    // at(): never before its time, with or without MessageChannel; cancelled, never.
    const t = performance.now(), hit = await new Promise(res => SR.at(t + 25, () => res(performance.now() - t)));
    const MC = globalThis.MessageChannel;
    delete globalThis.MessageChannel;
    const t2 = performance.now(), hit2 = await new Promise(res => SR.at(t2 + 25, () => res(performance.now() - t2)));
    globalThis.MessageChannel = MC;
    let ran = false;
    const h = SR.at(performance.now() + 25, () => { ran = true; });
    await sleep(2); SR.cancel(h); await sleep(40);
    check('at: a wait ends at its time and not before, by messages or by timers alone; a cancelled one never runs',
          hit >= 25 && hit < 30 && hit2 >= 25 && !ran, hit.toFixed(1) + ' ' + hit2.toFixed(1) + ' ' + ran);
  }
  check('parse: "info string" lines and lines with a score but no depth are not readings',
        SR.parseInfo('info string Network replica 1: Local memory. score cp 10 depth 3') === null && SR.parseInfo('info score cp 10 pv e2e4') === null);
  const none = SR.parseInfo('info depth 0 score mate 0');
  check('parse: Stockfish 19 with no move to make: depth 0, mate 0, no line', none && none.depth === 0 && none.kind === 'mate' && none.value === 0 && none.pv.length === 0);
  globalThis.Worker = realWorker;

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exitCode = failed ? 1 : 0;
})();
