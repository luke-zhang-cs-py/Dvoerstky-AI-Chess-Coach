/* stockfish-reader.js — Stockfish as a second reader of every position.

   The house engine (engine.js) is club strength on purpose: it is the thing the
   sparring opponent is built from, and it has to stay tunable and legible.
   Stockfish is the check on it. It reads the same positions in a Web Worker and
   reports what it would play and how it scores the position, so every move --
   yours and the mirror's -- can be measured against something much stronger than
   the engine that chose it.

   The worker is made from a Blob holding STOCKFISH_SOURCE (js/vendor/stockfish-src.js),
   because a page opened from file:// can neither load a worker script by URL nor
   fetch one. Positions are read strictly in order, one at a time, so a fast
   exchange of moves still gets every position read. */
(function (root) {
  'use strict';

  var MATE = 30000;   // same scale as engine.js, so Sparring.cpDisplay shows "#3" for both

  /* One UCI "info" line -> {depth, multipv, kind, value, pv}, or null for lines
     without a final score (bounds from a failed aspiration window are skipped:
     they are limits, not scores). */
  function parseInfo(line) {
    if (!/^info\b/.test(line) || !/\bscore (cp|mate) /.test(line)) return null;
    if (/\b(lowerbound|upperbound)\b/.test(line)) return null;
    var depth = line.match(/\bdepth (\d+)/);
    var score = line.match(/\bscore (cp|mate) (-?\d+)/);
    var multipv = line.match(/\bmultipv (\d+)/);
    if (!depth || !score) return null;
    // the moves after "pv", up to the first token that is not a move (Stockfish 10 appends "bmc 1")
    var tokens = line.split(/\s+/), at = tokens.indexOf('pv'), pv = [];
    for (var i = at + 1; at > -1 && i < tokens.length && /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(tokens[i]); i++) pv.push(tokens[i]);
    return { depth: +depth[1], multipv: multipv ? +multipv[1] : 1, kind: score[1], value: +score[2], pv: pv };
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

  function Reader(source) {
    this.source = source;
    this.worker = null;
    this.ready = null;
    this.isReady = false;
    this.queue = [];
    this.current = null;
    this.multipv = 1;
  }

  Reader.available = function () {
    return typeof Worker !== 'undefined' && typeof Blob !== 'undefined' && !!root.STOCKFISH_SOURCE;
  };

  Reader.prototype.start = function () {
    if (this.ready) return this.ready;
    var self = this;
    this.ready = new Promise(function (resolve, reject) {
      try {
        var url = URL.createObjectURL(new Blob([self.source], { type: 'text/javascript' }));
        self.worker = new Worker(url);
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
       { fen, best, depth, cp, mate, lines: [{cp, mate, pv}] }   (cp from White's side)
     or null if clear() dropped it before it finished. opts.searchmoves: UCI moves to
     restrict the search to -- how a single move is scored from the position it was
     played in. */
  Reader.prototype.read = function (fen, opts) {
    opts = opts || {};
    var self = this;
    return new Promise(function (resolve, reject) {
      self.queue.push({ fen: fen, movetime: opts.movetime || 1000, multipv: opts.multipv || 1,
                        searchmoves: opts.searchmoves || null, resolve: resolve, reject: reject, infos: {} });
      self.kick();
    });
  };

  Reader.prototype.kick = function () {
    if (!this.isReady || this.current || !this.queue.length) return;
    var job = this.current = this.queue.shift();
    if (job.multipv !== this.multipv) {
      this.send('setoption name MultiPV value ' + job.multipv);
      this.multipv = job.multipv;
    }
    this.send('position fen ' + job.fen);
    this.send('go movetime ' + job.movetime + (job.searchmoves ? ' searchmoves ' + job.searchmoves.join(' ') : ''));
  };

  Reader.prototype.onLine = function (line) {
    if (line === 'readyok' && !this.isReady) {
      this.isReady = true;
      if (this.resolveReady) this.resolveReady();
      this.kick();
      return;
    }
    var job = this.current;
    if (!job) return;
    if (/^info\b/.test(line)) {
      var info = parseInfo(line);
      if (info) job.infos[info.multipv] = info;   // later lines are deeper: keep the last one
      return;
    }
    if (/^bestmove\b/.test(line)) {
      this.current = null;
      var best = line.split(/\s+/)[1];
      var whiteToMove = job.fen.split(' ')[1] !== 'b';
      var lines = Object.keys(job.infos).sort(function (a, b) { return a - b; }).map(function (k) {
        var i = job.infos[k];
        return { cp: whiteCp(i, whiteToMove), mate: i.kind === 'mate' ? (whiteToMove ? i.value : -i.value) : null,
                 pv: i.pv, depth: i.depth };
      });
      var top = lines[0] || { cp: 0, mate: null, pv: [], depth: 0 };
      if (job.cancelled) job.resolve(null);
      else job.resolve({ fen: job.fen, best: best && best !== '(none)' ? best : null, depth: top.depth,
                         cp: top.cp, mate: top.mate, pv: top.pv, lines: lines });
      this.kick();
    }
  };

  /* Drop everything queued, and stop the position being read (its promise
     resolves null). Used when a new game starts. */
  Reader.prototype.clear = function () {
    this.queue.splice(0).forEach(function (j) { j.resolve(null); });
    if (this.current) { this.current.cancelled = true; this.send('stop'); }
  };

  Reader.prototype.failAll = function (err) {
    if (this.current) { this.current.reject(err); this.current = null; }
    this.queue.splice(0).forEach(function (j) { j.reject(err); });
  };

  /* clear() leaves the position in hand to resolve when its "bestmove" arrives; a
     terminated worker sends none, so that read resolves null here instead of never. */
  Reader.prototype.terminate = function () {
    this.clear();
    if (this.current) { this.current.resolve(null); this.current = null; }
    if (this.worker) this.worker.terminate();
    this.worker = null; this.ready = null; this.isReady = false;
  };

  root.StockfishReader = { Reader: Reader, parseInfo: parseInfo, whiteCp: whiteCp, MATE: MATE };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.StockfishReader;
})(typeof window !== 'undefined' ? window : globalThis);
