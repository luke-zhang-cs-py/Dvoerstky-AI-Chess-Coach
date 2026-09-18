/* sparring.js — an opponent modelled on the user, at the user's measured strength.
   Three layers: their own opening book, a strength-calibrated error model, and
   style biases harvested from their games. */
(function (root) {
  'use strict';
  var Chess = root.Chess, Engine = root.Engine, Analysis = root.Analysis;

  function Mirror(profile, opts) {
    opts = opts || {};
    this.engine = new Engine();
    this.profile = profile || {};
    this.book = opts.book || {};
    this.targetElo = opts.targetElo ||
      (profile && profile.calibration ? profile.calibration.trueStrength : 2000);
    this.style = (profile && profile.style) || {};
    this.budgetMs = opts.budgetMs || 900;
    this.maxDepth = opts.maxDepth || 3;
    this.lastCandidates = [];
    this.bookHits = 0;
    this.log = [];
  }

  /* How much a player of this strength typically bleeds per move, and how often
     they lose the plot entirely. Both scale with how sharp the position is. */
  Mirror.prototype.errorModel = function (complexity, phase) {
    var baseAcpl = Analysis.acplFromElo(this.targetElo);
    var sharp = 0.55 + (complexity / 100) * 1.1;      // 0.55x in dead positions, ~1.65x in chaos
    var phaseMul = phase === 'endgame' ? 1.15 : phase === 'opening' ? 0.5 : 1;
    var expected = baseAcpl * sharp * phaseMul;

    // blunder frequency, taken from the user's own record when available
    var pb = 0.035;
    var ph = this.profile.phases && this.profile.phases[phase];
    if (ph && ph.plies > 40) pb = Math.min(0.22, ph.blunders / ph.plies);
    pb *= sharp;

    return { expectedLoss: expected, blunderProb: Math.min(0.30, pb) };
  };

  /* Style shaping: nudge the sampler toward the kinds of move this player makes. */
  Mirror.prototype.styleBonus = function (mv, g, ply) {
    var s = this.style, bonus = 0;
    if (!s || !s.sampleMoves) return 0;
    if (mv.captured) bonus += (s.captureRate - 0.13) * 400;
    if (/^[a-h]/.test(mv.san || '')) bonus += (s.pawnMoveRate - 0.36) * 180;
    if (/\+$/.test(mv.san || '')) bonus += (s.checkRate - 0.06) * 350;
    if (/^O-O/.test(mv.san || '') && ply < 24) bonus += (s.castlesEarly - 0.6) * 200;
    if (/^Q/.test(mv.san || '') && ply < 14) bonus += (s.earlyQueenRate - 0.5) * 60;
    return bonus;
  };

  Mirror.prototype.bookMove = function (g) {
    var key = g.fen().split(' ').slice(0, 4).join(' ');
    var entry = this.book[key];
    if (!entry) return null;
    var options = Object.keys(entry).map(function (san) {
      return { san: san, n: entry[san].n, score: entry[san].score / entry[san].n };
    }).filter(function (o) { return o.n >= 2; });
    if (!options.length) return null;
    var total = options.reduce(function (s, o) { return s + o.n; }, 0);
    var r = Math.random() * total, acc = 0;
    for (var i = 0; i < options.length; i++) {
      acc += options[i].n;
      if (r <= acc) {
        var mv = g.moveFromSan(options[i].san);
        if (mv) { mv.san = options[i].san; return { move: mv, fromBook: true, n: options[i].n, of: total }; }
      }
    }
    return null;
  };

  /* Find the softmax temperature at which this candidate set yields exactly the
     centipawn loss we are aiming for. Without this the sampler is far more
     accurate than the rating it claims to represent. */
  function solveLambda(losses, target) {
    function meanAt(lam) {
      var num = 0, den = 0;
      for (var i = 0; i < losses.length; i++) {
        var w = Math.exp(-losses[i] * lam);
        num += losses[i] * w; den += w;
      }
      return den > 0 ? num / den : 0;
    }
    var lo = 1e-5, hi = 1;
    if (meanAt(lo) <= target) return lo;      // even a coin flip is too accurate
    for (var k = 0; k < 40; k++) {
      var mid = Math.sqrt(lo * hi);            // geometric bisection: lambda spans decades
      if (meanAt(mid) > target) lo = mid; else hi = mid;
    }
    return Math.sqrt(lo * hi);
  }

  /* Pick a move. Returns {move, san, fromBook, intendedLoss, candidates}. */
  Mirror.prototype.chooseMove = function (g, ply) {
    var self = this;
    var bm = this.bookMove(g);
    if (bm) {
      this.bookHits++;
      this.lastCandidates = [];
      return Promise.resolve({ move: bm.move, san: bm.san || g.san(bm.move),
        fromBook: true, note: 'Your own repertoire: played ' + bm.n + ' of ' + bm.of + ' times in this position.' });
    }

    return this.engine.rankAsync(g, this.maxDepth, this.budgetMs).then(function (ranked) {
      if (!ranked.length) return null;
      self.lastCandidates = ranked.slice(0, 6);
      var phase = Analysis.phaseOf(g.fen(), ply, null);
      var complexity = self.engine.complexity(g, ranked);
      var model = self.errorModel(complexity, phase);
      var best = ranked[0].score;

      // score each candidate: how plausible is it that this player picks it?
      var blunder = Math.random() < model.blunderProb;
      var losses = ranked.map(function (r) { return Math.max(0, Math.min(2000, best - r.score)); });
      var lambda = solveLambda(losses, model.expectedLoss);
      var pool = ranked.map(function (r, i) {
        var loss = losses[i];
        var styl = self.styleBonus(r.move, g, ply);
        var w = Math.exp(-loss * lambda) * Math.exp(styl / 300);
        if (blunder) {
          // on a blunder turn, deliberately favour the plausible-but-bad band
          w = (loss >= 200 && loss <= 900) ? w * 14 + 0.05 : w * 0.25;
        }
        if (Math.abs(r.score) > 9000) w = loss === 0 ? w * 4 : w * 0.01; // never miss forced mate for self
        return { r: r, loss: loss, w: Math.max(w, 1e-6) };
      });

      var total = pool.reduce(function (s, p) { return s + p.w; }, 0);
      var pick = pool[0], roll = Math.random() * total, acc = 0;
      for (var i = 0; i < pool.length; i++) {
        acc += pool[i].w;
        if (roll <= acc) { pick = pool[i]; break; }
      }

      self.log.push({ ply: ply, complexity: complexity, phase: phase,
        expectedLoss: Math.round(model.expectedLoss), lambda: lambda, blunderTurn: blunder,
        chosen: pick.r.san, loss: Math.round(pick.loss) });

      return {
        move: pick.r.move, san: pick.r.san, fromBook: false,
        intendedLoss: Math.round(pick.loss), complexity: complexity,
        blunderTurn: blunder, candidates: ranked.slice(0, 5)
      };
    });
  };

  /* ---------------- dual-sided advice ----------------
     What both players should be doing in this position, computed together.
     The side not to move is evaluated through a null move, which is the same
     question as "what is he threatening". */
  function dualAdvice(engine, g, opts) {
    opts = opts || {};
    var depth = opts.depth || 3, budget = opts.budget || 700;
    var mover = g.turnColor();
    return engine.rankAsync(g, depth, budget).then(function (mine) {
      var threats = null;
      if (!g.inCheck()) {
        var fen = g.fen().split(' ');
        fen[1] = mover === 'w' ? 'b' : 'w';
        fen[3] = '-';
        var flipped;
        try { flipped = new Chess(fen.join(' ')); } catch (e) { flipped = null; }
        if (flipped) {
          return engine.rankAsync(flipped, Math.max(2, depth - 1), Math.round(budget * 0.7))
            .then(function (theirs) {
              return assemble(g, mover, mine, theirs, engine);
            });
        }
      }
      return assemble(g, mover, mine, threats, engine);
    });
  }

  function assemble(g, mover, mine, theirs, engine) {
    function fmt(list, side, pos) {
      if (!list) return [];
      return list.slice(0, 3).map(function (r, i) {
        return {
          rank: i + 1, san: r.san, uci: r.uci,
          cp: r.score, display: cpDisplay(r.score, side === 'w'),
          delta: i === 0 ? 0 : Math.round(list[0].score - r.score)
        };
      });
    }
    var other = mover === 'w' ? 'b' : 'w';
    var out = {
      sideToMove: mover,
      evalCp: mine.length ? (mover === 'w' ? mine[0].score : -mine[0].score) : 0,
      complexity: engine.complexity(g, mine),
      white: mover === 'w' ? fmt(mine, 'w') : fmt(theirs, 'w'),
      black: mover === 'b' ? fmt(mine, 'b') : fmt(theirs, 'b'),
      threatNote: null
    };
    if (theirs && theirs.length) {
      out.threatNote = 'If it were ' + (other === 'w' ? 'White' : 'Black') + ' to move: ' +
        theirs.slice(0, 2).map(function (t) { return t.san; }).join(' or ') + '.';
    }
    // a move is "only" if the second best drops a lot
    if (mine.length >= 2 && mine[0].score - mine[1].score >= 150) {
      out.onlyMove = mine[0].san;
    }
    return out;
  }

  function cpDisplay(cp, whitePov) {
    if (Math.abs(cp) > 9000) {
      var mateIn = Math.ceil((30000 - Math.abs(cp)) / 2);
      return (cp > 0 ? '#' : '-#') + Math.max(1, mateIn);
    }
    var v = (whitePov ? cp : cp) / 100;
    return (v > 0 ? '+' : '') + v.toFixed(2);
  }

  root.Sparring = { Mirror: Mirror, dualAdvice: dualAdvice, cpDisplay: cpDisplay };
})(typeof window !== 'undefined' ? window : globalThis);
