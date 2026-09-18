/* engine.js — evaluation + search. Depends on core.js (Chess). */
(function (root) {
  'use strict';
  var Chess = root.Chess || require('./core.js');
  var W = Chess.WHITE, B = Chess.BLACK, TM = Chess.TYPE_MASK, CM = Chess.COLOR_MASK;
  var P = 1, N = 2, BI = 3, R = 4, Q = 5, K = 6;   // BI (not B): B is already taken by Chess.BLACK above

  var MG_VAL = [0, 82, 337, 365, 477, 1025, 0];
  var EG_VAL = [0, 94, 281, 297, 512, 936, 0];
  var PHASE_W = [0, 0, 1, 1, 2, 4, 0];
  var TOTAL_PHASE = 24;

  // Evaluation tuning weights
  var BISHOP_PAIR_MG = 30, BISHOP_PAIR_EG = 45;
  var DOUBLED_PAWN_MG = 12, DOUBLED_PAWN_EG = 22;
  var ISOLATED_PAWN_MG = 16, ISOLATED_PAWN_EG = 20;
  var MOBILITY_MG_WEIGHT = 3, MOBILITY_EG_WEIGHT = 2;

  // Piece-square tables, white POV, index rank*8+file with rank 0 = 8th rank
  var PST_MG = {
    1: [0,0,0,0,0,0,0,0, 98,134,61,95,68,126,34,-11, -6,7,26,31,65,56,25,-20, -14,13,6,21,23,12,17,-23, -27,-2,-5,12,17,6,10,-25, -26,-4,-4,-10,3,3,33,-12, -35,-1,-20,-23,-15,24,38,-22, 0,0,0,0,0,0,0,0],
    2: [-167,-89,-34,-49,61,-97,-15,-107, -73,-41,72,36,23,62,7,-17, -47,60,37,65,84,129,73,44, -9,17,19,53,37,69,18,22, -13,4,16,13,28,19,21,-8, -23,-9,12,10,19,17,25,-16, -29,-53,-12,-3,-1,18,-14,-19, -105,-21,-58,-33,-17,-28,-19,-23],
    3: [-29,4,-82,-37,-25,-42,7,-8, -26,16,-18,-13,30,59,18,-47, -16,37,43,40,35,50,37,-2, -4,5,19,50,37,37,7,-2, -6,13,13,26,34,12,10,4, 0,15,15,15,14,27,18,10, 4,15,16,0,7,21,33,1, -33,-3,-14,-21,-13,-12,-39,-21],
    4: [32,42,32,51,63,9,31,43, 27,32,58,62,80,67,26,44, -5,19,26,36,17,45,61,16, -24,-11,7,26,24,35,-8,-20, -36,-26,-12,-1,9,-7,6,-23, -45,-25,-16,-17,3,0,-5,-33, -44,-16,-20,-9,-1,11,-6,-71, -19,-13,1,17,16,7,-37,-26],
    5: [-28,0,29,12,59,44,43,45, -24,-39,-5,1,-16,57,28,54, -13,-17,7,8,29,56,47,57, -27,-27,-16,-16,-1,17,-2,1, -9,-26,-9,-10,-2,-4,3,-3, -14,2,-11,-2,-5,2,14,5, -35,-8,11,2,8,15,-3,1, -1,-18,-9,10,-15,-25,-31,-50],
    6: [-65,23,16,-15,-56,-34,2,13, 29,-1,-20,-7,-8,-4,-38,-29, -9,24,2,-16,-20,6,22,-22, -17,-20,-12,-27,-30,-25,-14,-36, -49,-1,-27,-39,-46,-44,-33,-51, -14,-14,-22,-46,-44,-30,-15,-27, 1,7,-8,-64,-43,-16,9,8, -15,36,12,-54,8,-28,24,14]
  };
  var PST_EG = {
    1: [0,0,0,0,0,0,0,0, 178,173,158,134,147,132,165,187, 94,100,85,67,56,53,82,84, 32,24,13,5,-2,4,17,17, 13,9,-3,-7,-7,-8,3,-1, 4,7,-6,1,0,-5,-1,-8, 13,8,8,10,13,0,2,-7, 0,0,0,0,0,0,0,0],
    2: [-58,-38,-13,-28,-31,-27,-63,-99, -25,-8,-25,-2,-9,-25,-24,-52, -24,-20,10,9,-1,-9,-19,-41, -17,3,22,22,22,11,8,-18, -18,-6,16,25,16,17,4,-18, -23,-3,-1,15,10,-3,-20,-22, -42,-20,-10,-5,-2,-20,-23,-44, -29,-51,-23,-15,-22,-18,-50,-64],
    3: [-14,-21,-11,-8,-7,-9,-17,-24, -8,-4,7,-12,-3,-13,-4,-14, 2,-8,0,-1,-2,6,0,4, -3,9,12,9,14,10,3,2, -6,3,13,19,7,10,-3,-9, -12,-3,8,10,13,3,-7,-15, -14,-18,-7,-1,4,-9,-15,-27, -23,-9,-23,-5,-9,-16,-5,-17],
    4: [13,10,18,15,12,12,8,5, 11,13,13,11,-3,3,8,3, 7,7,7,5,4,-3,-5,-3, 4,3,13,1,2,1,-1,2, 3,5,8,4,-5,-6,-8,-11, -4,0,-5,-1,-7,-12,-8,-16, -6,-6,0,2,-9,-9,-11,-3, -9,2,3,-1,-5,-13,4,-20],
    5: [-9,22,22,27,27,19,10,20, -17,20,32,41,58,25,30,0, -20,6,9,49,47,35,19,9, 3,22,24,45,57,40,57,36, -18,28,19,47,31,34,39,23, -16,-27,15,6,9,17,10,5, -22,-23,-30,-16,-16,-23,-36,-32, -33,-28,-22,-43,-5,-32,-20,-41],
    6: [-74,-35,-18,-18,-11,15,4,-17, -12,17,14,17,17,38,23,11, 10,17,23,15,20,45,44,13, -8,22,24,27,26,33,26,3, -18,-4,21,24,27,23,9,-11, -19,-3,11,21,23,16,7,-9, -27,-11,4,13,14,4,-5,-17, -53,-34,-21,-11,-28,-14,-24,-43]
  };

  function pstIndex(sq, color) {
    var r = sq >> 4, f = sq & 7;
    return color === W ? r * 8 + f : (7 - r) * 8 + f;
  }

  function Engine() {
    this.nodes = 0;   // public: node count from the most recent rank()/rankAsync() call
    this.tt = new Map();   // Zobrist key -> {depth, score, flag}, persists across calls
  }

  // Single pass over the board: material + PST (tapered), plus the raw counts
  // (pawns per file, bishops per side) the structure/bishop-pair scorers need.
  // Kept as one loop deliberately -- evaluate() runs on every leaf node, and
  // splitting the 128-square walk into multiple passes would multiply that cost.
  function scanMaterialAndPST(g) {
    var b = g.board, mg = 0, eg = 0, phase = 0;
    var pawnsFile = {}, bishops = {};
    pawnsFile[W] = new Int8Array(8); pawnsFile[B] = new Int8Array(8);
    bishops[W] = 0; bishops[B] = 0;
    var sq, p, t, c, sign, idx;

    for (sq = 0; sq < 128; sq++) {
      if (sq & 0x88) { sq += 7; continue; }
      p = b[sq]; if (!p) continue;
      t = p & TM; c = p & CM; sign = c === W ? 1 : -1;
      phase += PHASE_W[t];
      idx = pstIndex(sq, c);
      mg += sign * (MG_VAL[t] + PST_MG[t][idx]);
      eg += sign * (EG_VAL[t] + PST_EG[t][idx]);
      if (t === P) pawnsFile[c][sq & 7]++;
      if (t === BI) bishops[c]++;
    }
    return { mg: mg, eg: eg, phase: phase, pawnsFile: pawnsFile, bishops: bishops };
  }

  function bishopPairScore(bishops) {
    var mg = 0, eg = 0;
    if (bishops[W] >= 2) { mg += BISHOP_PAIR_MG; eg += BISHOP_PAIR_EG; }
    if (bishops[B] >= 2) { mg -= BISHOP_PAIR_MG; eg -= BISHOP_PAIR_EG; }
    return { mg: mg, eg: eg };
  }

  function pawnStructureScore(pawnsFile) {
    var mg = 0, eg = 0;
    [W, B].forEach(function (c) {
      var s = c === W ? 1 : -1;
      for (var f = 0; f < 8; f++) {
        var n = pawnsFile[c][f];
        if (n > 1) { mg -= s * DOUBLED_PAWN_MG * (n - 1); eg -= s * DOUBLED_PAWN_EG * (n - 1); }
        if (n > 0) {
          var left = f > 0 ? pawnsFile[c][f - 1] : 0;
          var right = f < 7 ? pawnsFile[c][f + 1] : 0;
          if (!left && !right) { mg -= s * ISOLATED_PAWN_MG; eg -= s * ISOLATED_PAWN_EG; }
        }
      }
    });
    return { mg: mg, eg: eg };
  }

  // cheap: pseudo-legal move count for side to move and opponent
  function mobilityScore(g) {
    var wm = g.mobility(W), bm = g.mobility(B);
    return { mg: (wm - bm) * MOBILITY_MG_WEIGHT, eg: (wm - bm) * MOBILITY_EG_WEIGHT };
  }

  Engine.prototype.evaluate = function (g) {
    var scan = scanMaterialAndPST(g);
    var mg = scan.mg, eg = scan.eg;

    var bp = bishopPairScore(scan.bishops);
    mg += bp.mg; eg += bp.eg;

    var ps = pawnStructureScore(scan.pawnsFile);
    mg += ps.mg; eg += ps.eg;

    var mob = mobilityScore(g);
    mg += mob.mg; eg += mob.eg;

    var ph = Math.min(scan.phase, TOTAL_PHASE);
    var score = (mg * ph + eg * (TOTAL_PHASE - ph)) / TOTAL_PHASE;
    if (g.turn === B) score = -score;
    return Math.round(score);
  };

  // cheap eval for quiescence / ordering
  Engine.prototype.materialOnly = function (g) {
    var b = g.board, s = 0;
    for (var sq = 0; sq < 128; sq++) {
      if (sq & 0x88) { sq += 7; continue; }
      var p = b[sq]; if (!p) continue;
      s += ((p & CM) === W ? 1 : -1) * MG_VAL[p & TM];
    }
    return g.turn === W ? s : -s;
  };

  // Search tuning constants
  var CAPTURE_ORDER_SCALE = 10;   // MVV-LVA: rank captures by victim value, break ties by attacker value
  var PROMOTION_ORDER_BONUS = 900;
  var MATE_SCORE = 30000;
  var NODE_TIMEOUT_CHECK_MASK = 511;   // check the clock every 512 nodes
  var QUIESCE_MAX_DEPTH = 4;
  var MATE_DEPTH_OFFSET = 100;   // prefer shorter mates; must exceed any reachable search depth
  var FIFTY_MOVE_RULE_HALFMOVES = 100;

  // complexity() tuning weights
  var COMPLEXITY_CHECK_SAMPLE = 40;   // cap on how many legal moves to test for checks
  var COMPLEXITY_SPREAD_CAP = 300;
  var COMPLEXITY_LEGAL_WEIGHT = 0.9;
  var COMPLEXITY_CAPTURE_WEIGHT = 3.5;
  var COMPLEXITY_CHECK_WEIGHT = 4;
  var COMPLEXITY_SPREAD_DIVISOR = 8;
  var COMPLEXITY_MAX = 100;

  // Shape a search result as {move, san, score, uci}; ms is the full legal-move
  // list at the position r.move was played from (san() needs it to disambiguate).
  function formatResult(g, ms, r) {
    return { move: r.move, san: g.san(r.move, ms), score: r.score,
      uci: r.move.fromSq + r.move.toSq + (r.move.promo ? Chess.SYM[r.move.promo] : '') };
  }

  function orderMoves(ms) {
    ms.sort(function (a, c) {
      var sa = (a.captured ? MG_VAL[a.captured] * CAPTURE_ORDER_SCALE - MG_VAL[a.piece] : 0) + (a.promo ? PROMOTION_ORDER_BONUS : 0);
      var sc = (c.captured ? MG_VAL[c.captured] * CAPTURE_ORDER_SCALE - MG_VAL[c.piece] : 0) + (c.promo ? PROMOTION_ORDER_BONUS : 0);
      return sc - sa;
    });
    return ms;
  }

  function randomUint32() { return (Math.random() * 0x100000000) >>> 0; }

  // --- Transposition table keys (Zobrist hashing) --------------------------
  // Computed fresh from the board on every search() node, rather than
  // maintained incrementally across makeMove()/undoMove(). Incremental
  // hashing would be cheaper per node, but it means XOR-ing in/out on every
  // move type (normal, capture, castle, en passant, promotion) inside
  // core.js's move/undo path -- a much larger, riskier change to verify
  // without a test runner than recomputing the hash from the current board
  // each time. Two independent 32-bit hashes are combined into one string
  // key, giving an effective ~64-bit key space so collisions stay
  // astronomically unlikely for a normal browser session.
  //
  // Covers piece placement, side to move, castling rights, and the en
  // passant file -- NOT the halfmove clock, so (like most simple engines)
  // this ignores fifty-move-rule proximity when reusing a cached score.
  // core.js has no threefold-repetition detection either, so that's not a
  // new limitation this introduces.
  var ZOBRIST_SQ = {};
  [W, B].forEach(function (color) {
    ZOBRIST_SQ[color] = {};
    for (var pt = P; pt <= K; pt++) {
      var table = [];
      for (var s = 0; s < 64; s++) table[s] = [randomUint32(), randomUint32()];
      ZOBRIST_SQ[color][pt] = table;
    }
  });
  var ZOBRIST_TURN = [randomUint32(), randomUint32()];
  var ZOBRIST_CASTLE = [   // WK, WQ, BK, BQ
    [randomUint32(), randomUint32()], [randomUint32(), randomUint32()],
    [randomUint32(), randomUint32()], [randomUint32(), randomUint32()]
  ];
  var ZOBRIST_EP_FILE = [];
  for (var epf = 0; epf < 8; epf++) ZOBRIST_EP_FILE[epf] = [randomUint32(), randomUint32()];

  function zobristKey(g) {
    var b = g.board, h1 = 0, h2 = 0, sq, p, t, c, s64, pair;
    for (sq = 0; sq < 128; sq++) {
      if (sq & 0x88) { sq += 7; continue; }
      p = b[sq]; if (!p) continue;
      t = p & TM; c = p & CM;
      s64 = (sq >> 4) * 8 + (sq & 7);
      pair = ZOBRIST_SQ[c][t][s64];
      h1 ^= pair[0]; h2 ^= pair[1];
    }
    if (g.turn === B) { h1 ^= ZOBRIST_TURN[0]; h2 ^= ZOBRIST_TURN[1]; }
    if (g.castling[W] & Chess.FLAG.KSIDE) { h1 ^= ZOBRIST_CASTLE[0][0]; h2 ^= ZOBRIST_CASTLE[0][1]; }
    if (g.castling[W] & Chess.FLAG.QSIDE) { h1 ^= ZOBRIST_CASTLE[1][0]; h2 ^= ZOBRIST_CASTLE[1][1]; }
    if (g.castling[B] & Chess.FLAG.KSIDE) { h1 ^= ZOBRIST_CASTLE[2][0]; h2 ^= ZOBRIST_CASTLE[2][1]; }
    if (g.castling[B] & Chess.FLAG.QSIDE) { h1 ^= ZOBRIST_CASTLE[3][0]; h2 ^= ZOBRIST_CASTLE[3][1]; }
    if (g.ep !== -1) { pair = ZOBRIST_EP_FILE[g.ep & 7]; h1 ^= pair[0]; h2 ^= pair[1]; }
    return (h1 >>> 0) + '_' + (h2 >>> 0);
  }

  var TT_EXACT = 0, TT_LOWER = 1, TT_UPPER = 2;
  var MAX_TT_ENTRIES = 200000;   // cap so a long browser session can't grow this unboundedly

  var NULL_MOVE_MIN_DEPTH = 3;
  var NULL_MOVE_REDUCTION = 2;

  // True if `color` has any piece besides king/pawns. Null-move pruning is
  // unsound in king-and-pawn endgames (zugzwang: having "an extra move" can
  // actually be bad), so it's skipped there.
  function hasNonPawnMaterial(g, color) {
    var b = g.board;
    for (var sq = 0; sq < 128; sq++) {
      if (sq & 0x88) { sq += 7; continue; }
      var p = b[sq];
      if (p && (p & CM) === color) {
        var t = p & TM;
        if (t !== P && t !== K) return true;
      }
    }
    return false;
  }

  Engine.prototype.quiesce = function (g, alpha, beta, depth) {
    this.nodes++;
    var stand = this.evaluate(g);
    if (stand >= beta) return beta;
    if (stand > alpha) alpha = stand;
    if (depth <= 0) return alpha;
    var ms = g.generate().filter(function (m) { return m.captured || m.promo; });
    orderMoves(ms);
    for (var i = 0; i < ms.length; i++) {
      g.makeMove(ms[i]);
      var sc = -this.quiesce(g, -beta, -alpha, depth - 1);
      g.undoMove();
      if (sc >= beta) return beta;
      if (sc > alpha) alpha = sc;
    }
    return alpha;
  };

  // stopAt: epoch-ms deadline, or falsy for "search to completion" (used by rank()'s
  // synchronous fixed-budget search and rankAsync()'s per-slice deadline alike).
  Engine.prototype.search = function (g, depth, alpha, beta, stopAt) {
    this.nodes++;
    if (stopAt && (this.nodes & NODE_TIMEOUT_CHECK_MASK) === 0 && Date.now() > stopAt) throw { timeout: true };
    var ms = g.generate();
    if (ms.length === 0) return g.inCheck() ? -MATE_SCORE + (MATE_DEPTH_OFFSET - depth) : 0;
    if (g.halfmoves >= FIFTY_MOVE_RULE_HALFMOVES) return 0;
    if (depth <= 0) return this.quiesce(g, alpha, beta, QUIESCE_MAX_DEPTH);

    var key = zobristKey(g);
    var cached = this.tt.get(key);
    if (cached && cached.depth >= depth) {
      if (cached.flag === TT_EXACT) return cached.score;
      if (cached.flag === TT_LOWER && cached.score >= beta) return cached.score;
      if (cached.flag === TT_UPPER && cached.score <= alpha) return cached.score;
    }

    if (depth >= NULL_MOVE_MIN_DEPTH && !g.inCheck() && hasNonPawnMaterial(g, g.turn)) {
      var savedTurn = g.turn, savedEp = g.ep;
      g.turn = savedTurn === W ? B : W;
      g.ep = -1;
      var nullScore;
      try {
        nullScore = -this.search(g, depth - 1 - NULL_MOVE_REDUCTION, -beta, -beta + 1, stopAt);
      } finally {
        // Always restore, even if the nested call threw a timeout: this is a
        // pass, not a real move, so it never goes through g.history -- the
        // usual "unwind g.history back to base" cleanup in rank()/rankAsync()
        // wouldn't know how to undo it.
        g.turn = savedTurn;
        g.ep = savedEp;
      }
      if (nullScore >= beta) return beta;
    }

    orderMoves(ms);
    var alpha0 = alpha;
    var best = -Infinity;
    for (var i = 0; i < ms.length; i++) {
      g.makeMove(ms[i]);
      var sc = -this.search(g, depth - 1, -beta, -alpha, stopAt);
      g.undoMove();
      if (sc > best) best = sc;
      if (sc > alpha) alpha = sc;
      if (alpha >= beta) break;
    }

    var flag = best <= alpha0 ? TT_UPPER : best >= beta ? TT_LOWER : TT_EXACT;
    if (this.tt.size >= MAX_TT_ENTRIES) this.tt.clear();
    this.tt.set(key, { depth: depth, score: best, flag: flag });
    return best;
  };

  /* Returns ranked candidate list [{move, san, score, uci}] from side-to-move POV (cp) */
  Engine.prototype.rank = function (g, depth, msBudget) {
    var ms = g.generate();
    if (!ms.length) return [];
    orderMoves(ms);
    this.nodes = 0;
    var stopAt = msBudget ? Date.now() + msBudget : 0;
    var results = ms.map(function (m) { return { move: m, score: -Infinity }; });
    var self = this;
    var base = g.history.length;
    try {
      for (var d = 1; d <= depth; d++) {
        var partial = [];
        for (var i = 0; i < results.length; i++) {
          var m = results[i].move;
          g.makeMove(m);
          var sc = -self.search(g, d - 1, -Infinity, Infinity, stopAt);
          g.undoMove();
          partial.push({ move: m, score: sc });
        }
        partial.sort(function (a, b) { return b.score - a.score; });
        results = partial;
      }
    } catch (e) {
      while (g.history.length > base) g.undoMove();   // the throw skipped the undos
      if (!e.timeout) throw e;
    }
    return results.map(function (r) { return formatResult(g, ms, r); });
  };

  var ROOT_SLICE = 3;   // root moves searched per slice before yielding to the event loop

  /* Same as rank(), but yields to the event loop between root moves so the
     page stays responsive. Web Workers are avoided deliberately: they do not
     load from a file:// origin, and this app is meant to run by double-click.

     Three concerns, one per helper below: yieldNow() gives the event loop a
     turn; runDepth() searches every root move once, in slices, at a fixed
     depth; the outer loop drives iterative deepening across depths until the
     deadline or requested depth is reached. */
  Engine.prototype.rankAsync = async function (g, depth, msBudget, onDepth) {
    var self = this;
    var ms = g.generate();
    if (!ms.length) return [];
    orderMoves(ms);
    this.nodes = 0;
    var deadline = Date.now() + (msBudget || 1200);
    var results = ms.map(function (m) { return { move: m, score: -Infinity }; });

    function yieldNow() { return new Promise(function (r) { setTimeout(r, 0); }); }

    function format(rs) {
      return rs.map(function (r) { return formatResult(g, ms, r); });
    }

    // Searches every root move at depth d, ROOT_SLICE at a time, yielding
    // between slices. Returns true once all moves are done (results updated
    // and sorted), or false if the deadline hit mid-depth (results untouched,
    // still holding the previous depth's ordering).
    async function runDepth(d) {
      var partial = [], i = 0;
      while (i < results.length) {
        var sliceEnd = Math.min(results.length, i + ROOT_SLICE);
        for (; i < sliceEnd; i++) {
          var m = results[i].move;
          var base = g.history.length;
          g.makeMove(m);
          var sc;
          try {
            sc = -self.search(g, d - 1, -Infinity, Infinity, deadline);
          } catch (e) {
            if (!e.timeout) { while (g.history.length > base) g.undoMove(); throw e; }
            sc = results[i].score;
          }
          while (g.history.length > base) g.undoMove();   // unwind whatever the throw skipped
          partial.push({ move: m, score: sc });
        }
        if (i < results.length) {
          if (Date.now() >= deadline) return false;   // ran out of time mid-depth: keep previous ordering
          await yieldNow();
        }
      }
      partial.sort(function (a, b) { return b.score - a.score; });
      results = partial;
      if (onDepth) onDepth(d, format(results));
      return true;
    }

    for (var d = 1; d <= depth && Date.now() < deadline; d++) {
      var completed = await runDepth(d);
      if (!completed) break;
      await yieldNow();
    }
    return format(results);
  };

  Engine.prototype.bestLine = function (g, depth, len) {
    var line = [], i;
    len = len || 4;
    for (i = 0; i < len; i++) {
      var r = this.rank(g, Math.max(1, depth - Math.floor(i / 2)), 400);
      if (!r.length) break;
      line.push(r[0].san);
      g.makeMove(r[0].move);
    }
    for (i = 0; i < line.length; i++) g.undoMove();
    return line;
  };

  /* Position complexity: how sharp/tactical is this? Used to model human error rate. */
  Engine.prototype.complexity = function (g, ranked) {
    var ms = ranked || [];
    var legal = g.generate();
    var captures = legal.filter(function (m) { return m.captured; }).length;
    var checks = 0;
    for (var i = 0; i < legal.length && i < COMPLEXITY_CHECK_SAMPLE; i++) {
      g.makeMove(legal[i]);
      if (g.inCheck()) checks++;
      g.undoMove();
    }
    var spread = 0;
    if (ms && ms.length > 2) spread = Math.min(COMPLEXITY_SPREAD_CAP, Math.abs(ms[0].score - ms[Math.min(3, ms.length - 1)].score));
    return Math.min(COMPLEXITY_MAX, Math.round(legal.length * COMPLEXITY_LEGAL_WEIGHT + captures * COMPLEXITY_CAPTURE_WEIGHT + checks * COMPLEXITY_CHECK_WEIGHT + spread / COMPLEXITY_SPREAD_DIVISOR));
  };

  Engine.MG_VAL = MG_VAL;
  root.Engine = Engine;
  if (typeof module !== 'undefined' && module.exports) module.exports = Engine;
})(typeof window !== 'undefined' ? window : globalThis);
