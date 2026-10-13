/* stockfish-reader.js — Stockfish as a second reader of every position.

   The house engine (engine.js) is club strength on purpose: it is the thing the
   sparring opponent is built from, and it has to stay tunable and legible.
   Stockfish is the check on it. It reads the same positions in a Web Worker and
   reports what it would play and how it scores the position, so every move --
   yours and the mirror's -- can be measured against something much stronger than
   the engine that chose it.

   The engine is Stockfish 19 (Stockfish.js 19.0.1, "lite, single-threaded", WebAssembly).
   js/vendor/stockfish-19-src.js holds its glue script as a string (STOCKFISH_SOURCE) and
   its .wasm as base64 (STOCKFISH_WASM), because a page opened from file:// can neither
   load a worker script by URL nor fetch a file. The worker is made from a Blob: a few
   lines that decode the .wasm and answer the glue's one fetch() of it from memory, then
   the glue, unmodified. Positions are read strictly in order, one at a time, so a fast
   exchange of moves still gets every position read.

   The time rule: a read given T ms is answered no earlier than T - 5 and no later than
   T ms after its search was sent (performance.now()). Measured here, a "stop" took 1 to
   47 ms to bring a bestmove back (the worker reads its messages only between slices of
   search), while Stockfish's own clock ended a "go movetime" 0 to 11 ms late. So the search
   is sent as "go movetime M", M short of T by the hold point and by the slowest of the
   recent overruns, and the page keeps the deadline itself: a bestmove before T - 5 is held
   to T - HOLD; if none has come by T - CUT, the read is answered from the deepest line
   Stockfish has reported, it is told to stop, and its bestmove, when it comes, is dropped.
   Page timers are coarse too (15.6 ms ticks on Windows), so each wait ends by messages to
   itself for its last few ms. A watchdog replaces a worker that sends no bestmove at all.
   Every search has an id, and only the search in hand can answer a read. */
(function (root) {
  'use strict';

  var MATE = 30000;   // same scale as engine.js, so Sparring.cpDisplay shows "#3" for both
  var WASM_NAME = 'stockfish-19-lite-single.wasm';   // what the glue fetches (it reads the name from the worker URL's #)

  var WINDOW = 5;        // a read of T ms answers in [T - WINDOW, T]
  var HOLD = 4;          // a bestmove that comes before T - WINDOW is held until T - HOLD
  var CUT = 4;           // no bestmove at T - CUT: answer from the last line reported (4 ms to spare for a busy page)
  var OVERRUN = 3;       // ms past its movetime a search is taken to run, until one has been timed
  var OVERRUN_MAX = 25;  // the most planned for, so one slow search cannot take much of the next one's time
  var OVERRUN_KEPT = 10; // recent overruns remembered; the slowest is planned for
  var WATCHDOG = 3000;   // ms past T with no bestmove: the worker is stuck, and is replaced
  var SPIN = 30;         // a page timer can fire 16 ms late (and more the first time): the last SPIN ms of a wait are counted by messages
  var RECORDS = 100;     // timings kept (reader.timings), the newest

  // Run in the worker before the glue: the .wasm, decoded from base64, answers the glue's fetch() of it.
  var PRELUDE = '(function () {\n' +
    '  var name = ' + JSON.stringify(WASM_NAME) + ', text = atob(self.STOCKFISH_WASM), bytes = new Uint8Array(text.length), fetch0 = self.fetch;\n' +
    '  for (var i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);\n' +
    '  delete self.STOCKFISH_WASM;\n' +
    '  self.fetch = function (url) {\n' +
    '    if (String(url) === name) return Promise.resolve(new Response(bytes, { headers: { "Content-Type": "application/wasm" } }));\n' +
    '    return fetch0.apply(self, arguments);\n' +
    '  };\n' +
    '})();\n';

  function now() { return performance.now(); }

  /* fn at performance.now() >= time, never before it. A timer brings the wait to SPIN ms
     short of time; messages to a channel of its own count out the rest, each a task, so
     the page goes on with its other work meanwhile. Without MessageChannel, timers alone. */
  function at(time, fn) {
    var h = { port: null };
    function check() {
      if (now() >= time) { cancel(h); fn(); return; }
      if (typeof MessageChannel === 'undefined') { h.timer = setTimeout(check, Math.max(0, time - now())); return; }
      if (!h.port) { var ch = new MessageChannel(); h.port = ch.port1; h.peer = ch.port2; h.port.onmessage = check; }
      h.peer.postMessage(0);
    }
    var wait = time - SPIN - now();
    if (wait > 0) h.timer = setTimeout(check, wait);   // a timer of 0 can take a 15.6 ms tick: count from now instead
    else check();
    return h;
  }
  // A closed port delivers nothing more, and the timer is cleared: a cancelled wait never runs its fn.
  function cancel(h) {
    clearTimeout(h.timer);
    if (h.port) { h.port.onmessage = null; h.port.close(); h.peer.close(); h.port = null; }
  }

  /* One UCI "info" line -> {depth, multipv, kind, value, pv[, wdl]}, or null for lines
     without a final score ("info string ...", "currmove" progress, and bounds from a
     failed aspiration window: they are limits, not scores). With no legal move Stockfish
     19 writes "info depth 0 score mate 0" (or "cp 0", stalemate) and no pv. */
  function parseInfo(line) {
    if (!/^info\b/.test(line) || /^info string\b/.test(line) || !/\bscore (cp|mate) /.test(line)) return null;
    if (/\b(lowerbound|upperbound)\b/.test(line)) return null;
    var depth = line.match(/\bdepth (\d+)/);
    if (!depth) return null;
    var score = line.match(/\bscore (cp|mate) (-?\d+)/);
    var multipv = line.match(/\bmultipv (\d+)/);
    var wdl = line.match(/\bwdl (\d+) (\d+) (\d+)/);
    // the moves after "pv", up to the first token that is not a move (Stockfish 10 appended "bmc 1")
    var tokens = line.split(/\s+/), at = tokens.indexOf('pv'), pv = [];
    for (var i = at + 1; at > -1 && i < tokens.length && /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(tokens[i]); i++) pv.push(tokens[i]);
    var info = { depth: +depth[1], multipv: multipv ? +multipv[1] : 1, kind: score[1], value: +score[2], pv: pv };
    if (wdl) info.wdl = [+wdl[1], +wdl[2], +wdl[3]];   // only with UCI_ShowWDL, which this reader leaves off
    return info;
  }

  /* UCI scores are from the side to move; the app reads everything from White's
     side. Mate in n moves becomes MATE - (2n - 1), which cpDisplay turns back into
     "#n"; being mated right now (mate 0) is -MATE for the side to move. */
  function whiteCp(info, whiteToMove) {
    var cp;
    if (info.kind === 'mate') cp = info.value === 0 ? -MATE : (info.value > 0 ? 1 : -1) * (MATE - (2 * Math.abs(info.value) - 1));
    else cp = info.value;
    return whiteToMove ? cp : -cp;
  }

  // source: the engine's script; wasm: its .wasm as base64, or nothing for a script that needs none
  function Reader(source, wasm) {
    this.source = source;
    this.wasm = wasm || null;
    this.worker = null;
    this.ready = null;
    this.isReady = false;
    this.queue = [];
    this.current = null;     // the read waiting for its answer
    this.searching = null;   // the read whose search the engine is running: its bestmove is still to come
    this.searches = 0;       // search ids
    this.multipv = 1;
    this.overruns = [];      // ms past its movetime each recent bestmove came, the newest last
    this.timings = [];       // one per read answered: { id, movetime, asked, ms, bestmoveMs, how }
  }

  Reader.available = function () {
    return typeof Worker !== 'undefined' && typeof Blob !== 'undefined' && !!root.STOCKFISH_SOURCE;
  };

  Reader.prototype.start = function () {
    if (this.ready) return this.ready;
    var self = this;
    at(now() + 1, function () {});   // the first wait by messages is slow (a channel set up, code compiled): not a read's
    this.ready = new Promise(function (resolve, reject) {
      try {
        var parts = self.wasm ? ['self.STOCKFISH_WASM = "', self.wasm, '";\n', PRELUDE, self.source] : [self.source];
        var url = URL.createObjectURL(new Blob(parts, { type: 'text/javascript' }));
        self.worker = new Worker(self.wasm ? url + '#' + WASM_NAME : url);
      } catch (e) { reject(e); return; }
      self.resolveReady = resolve;
      self.worker.onerror = function (e) {
        var err = new Error('Stockfish did not start: ' + (e && e.message ? e.message : 'worker error'));
        reject(err);
        self.failAll(err);
      };
      self.worker.onmessage = function (e) { self.onLine(String(e.data)); };
      self.send('uci');
      self.send('setoption name Hash value 16');
      self.send('isready');
    });
    return this.ready;
  };

  Reader.prototype.send = function (cmd) { if (this.worker) this.worker.postMessage(cmd); };

  /* Read one position. Resolves with
       { fen, best, depth, cp, mate, pv, lines: [{cp, mate, pv, depth}], ms, how }   (cp from White's side)
     or null if clear() dropped it first. opts.movetime: T, the ms to think (default 1000);
     the answer comes T - 5 to T ms after the search is sent. how: 'bestmove' (Stockfish's,
     on time), 'held' (Stockfish's, held to the window) or 'deadline' (none by T - CUT: the
     deepest line's first move). opts.searchmoves: UCI moves to restrict the search to --
     how a single move is scored from the position it was played in. */
  Reader.prototype.read = function (fen, opts) {
    opts = opts || {};
    var self = this;
    return new Promise(function (resolve, reject) {
      self.queue.push({ fen: fen, movetime: opts.movetime || 1000, multipv: opts.multipv || 1,
                        searchmoves: opts.searchmoves || null, resolve: resolve, reject: reject, infos: {} });
      self.kick();
    });
  };

  // The movetime Stockfish is given for a read of T ms: T less the hold point and the slowest recent overrun.
  Reader.prototype.movetimeFor = function (T) {
    var over = this.overruns.length ? Math.max.apply(null, this.overruns) : OVERRUN;
    return Math.max(1, Math.floor(T - HOLD - Math.min(OVERRUN_MAX, over)));
  };

  Reader.prototype.kick = function () {
    if (!this.isReady || this.current || this.searching || !this.queue.length) return;
    var job = this.current = this.searching = this.queue.shift(), self = this;
    job.id = ++this.searches;
    if (job.multipv !== this.multipv) {
      this.send('setoption name MultiPV value ' + job.multipv);
      this.multipv = job.multipv;
    }
    this.send('position fen ' + job.fen);
    job.asked = this.movetimeFor(job.movetime);
    job.go = now();
    this.send('go movetime ' + job.asked + (job.searchmoves ? ' searchmoves ' + job.searchmoves.join(' ') : ''));
    job.timer = at(job.go + job.movetime - CUT, function () { self.cut(job); });
    job.watchdog = setTimeout(function () { self.stuck(job); }, job.movetime + WATCHDOG);
  };

  Reader.prototype.onLine = function (line) {
    if (line === 'readyok' && !this.isReady) {
      this.isReady = true;
      if (this.resolveReady) this.resolveReady();
      this.kick();
      return;
    }
    var job = this.searching, self = this;
    if (!job) return;   // no search in hand: nothing this line could belong to
    if (/^info\b/.test(line)) {
      var info = parseInfo(line);
      if (info) job.infos[info.multipv] = info;   // later lines are deeper: keep the last one
      return;
    }
    if (/^bestmove\b/.test(line)) {
      clearTimeout(job.watchdog);
      this.searching = null;
      job.bestmoveMs = now() - job.go;
      this.overruns.push(Math.max(0, job.bestmoveMs - job.asked));
      if (this.overruns.length > OVERRUN_KEPT) this.overruns.shift();
      if (job.done) { this.kick(); return; }   // answered at its deadline: this bestmove is for nothing now
      if (job.cancelled) { this.finish(job); job.resolve(null); this.kick(); return; }   // dropped by clear()
      var best = line.split(/\s+/)[1];
      job.best = best && best !== '(none)' ? best : null;
      if (job.bestmoveMs >= job.movetime - WINDOW) { this.answer(job, 'bestmove'); return; }
      cancel(job.timer);
      job.timer = at(job.go + job.movetime - HOLD, function () { self.answer(job, 'held'); });
    }
  };

  // T - CUT and no bestmove: the deepest line reported answers, and Stockfish is told to stop. With no line
  // at all (an engine that has said nothing), its bestmove answers when it comes, or the watchdog does.
  Reader.prototype.cut = function (job) {
    this.send('stop');
    var top = job.infos[1];
    if (top && top.pv.length) { job.best = top.pv[0]; this.answer(job, 'deadline'); }
  };

  Reader.prototype.finish = function (job) {
    job.done = true;
    cancel(job.timer);
    this.current = null;   // only the read in hand is ever finished
  };

  Reader.prototype.answer = function (job, how) {
    this.finish(job);
    var ms = now() - job.go;
    this.timings.push({ id: job.id, movetime: job.movetime, asked: job.asked, ms: ms, bestmoveMs: job.bestmoveMs, how: how });
    if (this.timings.length > RECORDS) this.timings.shift();
    var whiteToMove = job.fen.split(' ')[1] !== 'b';
    var lines = Object.keys(job.infos).sort(function (a, b) { return a - b; }).map(function (k) {
      var i = job.infos[k];
      return { cp: whiteCp(i, whiteToMove), mate: i.kind === 'mate' ? (whiteToMove ? i.value : -i.value) : null,
               pv: i.pv, depth: i.depth };
    });
    var top = lines[0] || { cp: 0, mate: null, pv: [], depth: 0 };
    job.resolve({ fen: job.fen, best: job.best, depth: top.depth, cp: top.cp, mate: top.mate, pv: top.pv, lines: lines,
                  ms: ms, how: how });
    this.kick();
  };

  /* No bestmove WATCHDOG ms past the deadline: the worker is stuck. It is replaced; the read, if
     nothing has answered it, fails (or resolves null, if it was dropped); the reads queued behind
     it go to the new worker. */
  Reader.prototype.stuck = function (job) {
    this.searching = null;
    this.worker.terminate();
    this.worker = null; this.ready = null; this.isReady = false; this.multipv = 1;
    if (!job.done) {
      this.finish(job);
      if (job.cancelled) job.resolve(null);   // dropped already: there is nothing to fail
      else job.reject(new Error('Stockfish stopped answering: no move ' + (job.movetime + WATCHDOG) + ' ms after it was asked'));
    }
    var self = this;
    if (this.queue.length) this.start().catch(function (err) { self.failAll(err); });   // a new worker that cannot start fails them
  };

  /* Drop everything queued, and stop the read in hand: it resolves null when its bestmove
     comes (at once, if that is in already and only held). Used when a new game starts. */
  Reader.prototype.clear = function () {
    this.queue.splice(0).forEach(function (j) { j.resolve(null); });
    var job = this.current;
    if (job && this.searching !== job) { this.finish(job); job.resolve(null); }
    else if (job) { job.cancelled = true; cancel(job.timer); }
    if (this.searching) this.send('stop');
  };

  // The worker failed: every read in hand or queued fails with it, and no bestmove is waited for.
  Reader.prototype.failAll = function (err) {
    var job = this.current;
    if (job) { this.finish(job); job.reject(err); }
    this.forget();
    this.queue.splice(0).forEach(function (j) { j.reject(err); });
  };

  Reader.prototype.forget = function () {
    if (this.searching) { clearTimeout(this.searching.watchdog); this.searching = null; }
  };

  /* clear() leaves the read in hand to resolve when its bestmove arrives; a terminated worker
     sends none, so that read resolves null here instead of never, and its search is forgotten. */
  Reader.prototype.terminate = function () {
    this.clear();
    var job = this.current;
    if (job) { this.finish(job); job.resolve(null); }
    this.forget();
    if (this.worker) this.worker.terminate();
    this.worker = null; this.ready = null; this.isReady = false;
    this.multipv = 1;   // a fresh worker starts at MultiPV 1, so the next read must send setoption again
  };

  root.StockfishReader = { Reader: Reader, parseInfo: parseInfo, whiteCp: whiteCp, MATE: MATE, at: at, cancel: cancel,
                           WINDOW: WINDOW, HOLD: HOLD, CUT: CUT, WATCHDOG: WATCHDOG, WASM_NAME: WASM_NAME };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.StockfishReader;
})(typeof window !== 'undefined' ? window : globalThis);
