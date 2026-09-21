/* analysis.js — strength calibration, error mining, motif classification. */
(function (root) {
  'use strict';
  var Chess = root.Chess;
  var VAL = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 20000 };
  var DAY = 86400000;

  /* ---------------- rating calibration ---------------- */

  // FIDE dp table (rating difference for a given score percentage)
  var DP = [-800,-677,-589,-538,-501,-470,-444,-422,-401,-383,-366,-351,-336,-322,-309,-296,-284,-273,-262,-251,
            -240,-230,-220,-211,-202,-193,-184,-175,-166,-158,-149,-141,-133,-125,-117,-110,-102,-95,-87,-80,
            -72,-65,-57,-50,-43,-36,-29,-21,-14,-7,0,7,14,21,29,36,43,50,57,65,
            72,80,87,95,102,110,117,125,133,141,149,158,166,175,184,193,202,211,220,230,
            240,251,262,273,284,296,309,322,336,351,366,383,401,422,444,470,501,538,589,677,800];

  function performanceRating(games) {
    var rated = games.filter(function (g) { return g.oppRating && typeof g.score === 'number'; });
    if (rated.length < 3) return null;
    var sumOpp = 0, sumScore = 0;
    rated.forEach(function (g) { sumOpp += g.oppRating; sumScore += g.score; });
    var avgOpp = sumOpp / rated.length;
    var pct = Math.round((sumScore / rated.length) * 100);
    pct = Math.max(0, Math.min(100, pct));
    return { rating: Math.round(avgOpp + DP[pct]), n: rated.length, avgOpp: Math.round(avgOpp), scorePct: pct };
  }

  // Empirical ACPL → strength curve, fitted to public Lichess rapid distributions.
  // Elo ≈ 3912 − 505·ln(ACPL).  acpl 20→2400, 35→2117, 50→1937, 80→1700.
  function eloFromAcpl(acpl) {
    if (!acpl || acpl <= 0) return null;
    return Math.max(600, Math.min(2900, Math.round(3912 - 505 * Math.log(acpl))));
  }
  function acplFromElo(elo) {
    return Math.max(4, Math.exp((3912 - elo) / 505));
  }

  // Half-life weighted mean, newer games count more.
  function weightedMean(pairs, halfLifeDays, now) {
    var num = 0, den = 0;
    pairs.forEach(function (p) {
      if (p.value == null || isNaN(p.value)) return;
      var ageDays = (now - p.date) / DAY;
      var w = Math.pow(0.5, ageDays / halfLifeDays) * (p.weight || 1);
      num += p.value * w; den += w;
    });
    return den > 0 ? num / den : null;
  }

  /* Blend: 90-day performance rating (result-based) with move-quality strength (ACPL-based).
     Result-based rating is noisy over small samples; move quality is lower-variance but
     ignores practical strength (clock handling, resourcefulness). We weight by sample size. */
  function calibrateStrength(games, lichessRating, now) {
    now = now || Date.now();
    var window90 = games.filter(function (g) { return now - g.date <= 90 * DAY; });
    var perf = performanceRating(window90);
    var analysed = window90.filter(function (g) { return g.acpl != null; });
    var acplWeighted = weightedMean(analysed.map(function (g) {
      return { value: g.acpl, date: g.date, weight: Math.min(1.4, (g.moves.length / 2) / 30) };
    }), 35, now);
    var moveQualityElo = eloFromAcpl(acplWeighted);

    var n = perf ? perf.n : 0;
    // confidence in the result-based estimate grows with sample size
    var wPerf = n >= 3 ? Math.min(0.62, n / (n + 22)) : 0;
    var wMove = moveQualityElo != null ? 0.38 : 0;
    var wAnchor = 1 - wPerf - wMove;
    if (wAnchor < 0) { wAnchor = 0; }
    var total = wPerf + wMove + wAnchor || 1;

    var anchor = lichessRating || (perf ? perf.rating : 2000);
    var blended = ((perf ? perf.rating : anchor) * wPerf + (moveQualityElo || anchor) * wMove + anchor * wAnchor) / total;

    // standard error of performance rating ≈ 800/sqrt(n) for Elo-ish scales
    var se = n ? Math.round(700 / Math.sqrt(n)) : 200;

    return {
      trueStrength: Math.round(blended),
      lichessRating: lichessRating || null,
      performanceRating: perf ? perf.rating : null,
      moveQualityElo: moveQualityElo,
      acpl: acplWeighted ? Math.round(acplWeighted * 10) / 10 : null,
      sample: n,
      analysedSample: analysed.length,
      avgOpp: perf ? perf.avgOpp : null,
      scorePct: perf ? perf.scorePct : null,
      marginOfError: Math.min(180, se),
      weights: { results: +(wPerf / total).toFixed(2), moveQuality: +(wMove / total).toFixed(2), anchor: +(wAnchor / total).toFixed(2) },
      windowStart: now - 90 * DAY,
      windowGames: window90.length
    };
  }

  /* ---------------- phase + geometry helpers ---------------- */

  function phaseWeight(g) {
    var w = 0;
    for (var sq = 0; sq < 128; sq++) {
      if (sq & 0x88) { sq += 7; continue; }
      var p = g.board[sq]; if (!p) continue;
      var t = p & Chess.TYPE_MASK;
      w += t === Chess.KNIGHT || t === Chess.BISHOP ? 1 : t === Chess.ROOK ? 2 : t === Chess.QUEEN ? 4 : 0;
    }
    return w;
  }

  function phaseOf(fen, ply, openingPly) {
    var g = new Chess(fen);
    var pw = phaseWeight(g);
    if (openingPly && ply <= openingPly) return 'opening';
    if (pw <= 6) return 'endgame';
    if (ply <= 20) return 'opening';
    return 'middlegame';
  }

  function endgameType(fen) {
    var g = new Chess(fen), counts = { w: {}, b: {} }, sq, p, t, c;
    for (sq = 0; sq < 128; sq++) {
      if (sq & 0x88) { sq += 7; continue; }
      p = g.board[sq]; if (!p) continue;
      t = Chess.SYM[p & Chess.TYPE_MASK];
      c = (p & Chess.COLOR_MASK) === Chess.WHITE ? 'w' : 'b';
      counts[c][t] = (counts[c][t] || 0) + 1;
    }
    var heavy = ['q', 'r', 'b', 'n'].filter(function (k) { return counts.w[k] || counts.b[k]; });
    if (!heavy.length) return 'pawn endgame';
    if (heavy.length === 1 && heavy[0] === 'r') {
      return (counts.w.r === 1 && counts.b.r === 1) ? 'rook endgame' : 'double rook endgame';
    }
    if (heavy.length === 1 && heavy[0] === 'q') return 'queen endgame';
    if (heavy.length === 1 && heavy[0] === 'b') return 'bishop endgame';
    if (heavy.length === 1 && heavy[0] === 'n') return 'knight endgame';
    if (heavy.indexOf('q') === -1 && heavy.indexOf('r') === -1) return 'minor piece endgame';
    return 'complex endgame';
  }

  function pieceAt(g, sq) {
    var p = g.board[sq];
    if (!p) return null;
    return { type: Chess.SYM[p & Chess.TYPE_MASK], color: (p & Chess.COLOR_MASK) === Chess.WHITE ? 'w' : 'b', sq: sq };
  }

  function squaresAttackedFrom(g, sq) {
    // pseudo targets of the piece standing on sq
    var saved = g.turn;
    var p = g.board[sq];
    if (!p) return [];
    g.turn = p & Chess.COLOR_MASK;
    var ms = g.generate({ legal: false, square: Chess.algebraic(sq) });
    g.turn = saved;
    if ((p & Chess.TYPE_MASK) === Chess.PAWN) {
      ms = ms.filter(function (m) { return (m.to & 15) !== (m.from & 15); });
    }
    return ms.map(function (m) { return m.to; });
  }

  function colorBit(c) { return c === 'w' ? Chess.WHITE : Chess.BLACK; }

  /* ---------------- motif classification ---------------- */

  function classifyMotifs(fenBefore, playedUci, bestUci, ctx) {
    var tags = [];
    ctx = ctx || {};
    var g;
    try { g = new Chess(fenBefore); } catch (e) { return tags; }
    var mover = g.turnColor();
    var them = mover === 'w' ? 'b' : 'w';
    var best = bestUci ? g.moveFromSan(bestUci) : null;
    var played = playedUci ? g.moveFromSan(playedUci) : null;

    var pw = phaseWeight(g);
    if (pw <= 6) tags.push(endgameType(fenBefore));

    // --- what the played move left hanging ---
    if (played) {
      g.makeMove(played);
      var loose = looseValuablePieces(g, mover);
      if (loose.length) tags.push('left material loose');
      if (g.attacked(colorBit(them), g.kings[colorBit(mover)])) { /* moved into check impossible */ }
      var kingPressure = attackersNearKing(g, mover);
      if (pw > 6 && kingPressure >= 4) tags.push('king safety');
      g.undoMove();
    }

    if (!best) return dedupe(tags);

    // --- what the best move would have done ---
    g.makeMove(best);
    var mate = g.generate().length === 0 && g.inCheck();
    if (mate) {
      tags.push('mating net');
      if (isBackRank(g, them)) tags.push('back rank');
    }
    // fork: moved piece now attacks 2+ valuable/undefended enemy targets
    var targets = squaresAttackedFrom(g, best.to).map(function (s) { return pieceAt(g, s); })
      .filter(function (p) { return p && p.color === them; });
    var movedType = Chess.SYM[g.board[best.to] & Chess.TYPE_MASK];
    var juicy = targets.filter(function (t) {
      return VAL[t.type] > VAL[movedType] || !g.attacked(colorBit(them), t.sq) || t.type === 'k';
    });
    if (juicy.length >= 2) tags.push(movedType === 'n' ? 'knight fork' : 'double attack');

    // pin / skewer on new slider rays
    var lineTag = lineTactic(g, best.to, them);
    if (lineTag) tags.push(lineTag);

    // discovered attack: a different friendly slider gained a valuable target
    if (discovered(g, best, mover, them)) tags.push('discovered attack');

    // trapped enemy piece
    var trapped = findTrapped(g, them);
    if (trapped) tags.push('trapped piece');
    g.undoMove();

    // sacrifice / deflection: best move gives material immediately yet wins
    if (best.captured == null || VAL[Chess.SYM[best.piece]] > VAL[best.captured ? Chess.SYM[best.captured] : 'p'] + 50) {
      g.makeMove(best);
      var enPrise = g.attacked(colorBit(them), best.to) && !g.attacked(colorBit(mover), best.to);
      g.undoMove();
      if (enPrise && (ctx.cpLoss || 0) >= 150) tags.push('sacrifice / deflection');
    }
    if (best.promo) tags.push('promotion');
    if (best.captured && !best.promo) {
      g.makeMove(best);
      var defended = g.attacked(colorBit(them), best.to);
      g.undoMove();
      if (!defended) tags.push('hanging piece');
    }
    // quiet best move in a calm position = positional
    if (!best.captured && !tags.length && (ctx.cpLoss || 0) < 200) tags.push('positional');
    // defensive resource: we were worse and best move holds
    var concrete = tags.filter(function (t) {
      return ['knight fork','double attack','pin','skewer','discovered attack','hanging piece',
              'mating net','back rank','trapped piece','promotion','sacrifice / deflection'].indexOf(t) > -1;
    }).length;
    if (!concrete && ctx.evalBefore != null && ctx.evalBefore < -150 && (ctx.cpLoss || 0) >= 120) {
      tags.push('defensive resource');
    }
    if (ctx.timePressure) tags.push('time pressure');

    return dedupe(tags);
  }

  function dedupe(a) { return a.filter(function (v, i) { return a.indexOf(v) === i; }); }

  function looseValuablePieces(g, color) {
    var out = [], cb = colorBit(color), ob = color === 'w' ? Chess.BLACK : Chess.WHITE;
    for (var sq = 0; sq < 128; sq++) {
      if (sq & 0x88) { sq += 7; continue; }
      var p = g.board[sq];
      if (!p || (p & Chess.COLOR_MASK) !== cb) continue;
      var t = Chess.SYM[p & Chess.TYPE_MASK];
      if (t === 'k' || t === 'p') continue;
      if (g.attacked(ob, sq) && !g.attacked(cb, sq)) out.push({ sq: Chess.algebraic(sq), type: t });
    }
    return out;
  }

  function attackersNearKing(g, color) {
    var k = g.kings[colorBit(color)];
    if (k < 0) return 0;
    var ob = color === 'w' ? Chess.BLACK : Chess.WHITE, n = 0;
    var ring = [-17, -16, -15, -1, 1, 15, 16, 17, 0];
    ring.forEach(function (o) {
      var s = k + o;
      if (!(s & 0x88) && g.attacked(ob, s)) n++;
    });
    return n;
  }

  function isBackRank(g, color) {
    var k = g.kings[colorBit(color)];
    if (k < 0) return false;
    var r = k >> 4;
    return (color === 'w' && r === 7) || (color === 'b' && r === 0);
  }

  function lineTactic(g, from, them) {
    var p = g.board[from], t = p & Chess.TYPE_MASK;
    if (t !== Chess.BISHOP && t !== Chess.ROOK && t !== Chess.QUEEN) return null;
    var offs = t === Chess.BISHOP ? [-17, -15, 15, 17] : t === Chess.ROOK ? [-16, -1, 1, 16] : [-17, -16, -15, -1, 1, 15, 16, 17];
    for (var i = 0; i < offs.length; i++) {
      var cur = from + offs[i], first = null;
      while (!(cur & 0x88)) {
        var q = g.board[cur];
        if (q) {
          var pc = pieceAt(g, cur);
          if (pc.color !== them) break;
          if (!first) { first = pc; }
          else {
            // pin: something valuable stands behind a lesser piece
            if (pc.type === 'k' || pc.type === 'q' || VAL[pc.type] - VAL[first.type] >= 170) return 'pin';
            // skewer: the valuable piece is in front and must move
            if ((first.type === 'k' || VAL[first.type] >= 500) && VAL[pc.type] >= 300) return 'skewer';
            break;
          }
        }
        cur += offs[i];
      }
    }
    return null;
  }

  function discovered(g, move, mover, them) {
    // after `move`, does some other friendly slider attack the enemy king or queen?
    var cb = colorBit(mover), ob = colorBit(them);
    var targets = [];
    for (var sq = 0; sq < 128; sq++) {
      if (sq & 0x88) { sq += 7; continue; }
      var p = g.board[sq];
      if (p && (p & Chess.COLOR_MASK) === ob) {
        var t = p & Chess.TYPE_MASK;
        if (t === Chess.KING || t === Chess.QUEEN || t === Chess.ROOK) targets.push(sq);
      }
    }
    for (var i = 0; i < targets.length; i++) {
      if (!g.attacked(cb, targets[i])) continue;
      // is the attacker something other than the piece we just moved?
      var byOther = false;
      for (var s = 0; s < 128 && !byOther; s++) {
        if (s & 0x88) { s += 7; continue; }
        if (s === move.to) continue;
        var q = g.board[s];
        if (!q || (q & Chess.COLOR_MASK) !== cb) continue;
        var qt = q & Chess.TYPE_MASK;
        if (qt !== Chess.BISHOP && qt !== Chess.ROOK && qt !== Chess.QUEEN) continue;
        if (squaresAttackedFrom(g, s).indexOf(targets[i]) > -1 &&
            onSameRay(move.from, s, targets[i])) byOther = true;
      }
      if (byOther) return true;
    }
    return false;
  }

  function onSameRay(vacated, sliderSq, target) {
    var dr = (target >> 4) - (sliderSq >> 4), df = (target & 15) - (sliderSq & 15);
    if (dr !== 0 && df !== 0 && Math.abs(dr) !== Math.abs(df)) return false;
    var stepR = Math.sign(dr), stepF = Math.sign(df);
    var cur = sliderSq + stepR * 16 + stepF;
    while (cur !== target && !(cur & 0x88)) {
      if (cur === vacated) return true;
      cur += stepR * 16 + stepF;
    }
    return false;
  }

  function findTrapped(g, color) {
    var cb = colorBit(color), ob = color === 'w' ? Chess.BLACK : Chess.WHITE;
    for (var sq = 0; sq < 128; sq++) {
      if (sq & 0x88) { sq += 7; continue; }
      var p = g.board[sq];
      if (!p || (p & Chess.COLOR_MASK) !== cb) continue;
      var t = p & Chess.TYPE_MASK;
      if (t !== Chess.KNIGHT && t !== Chess.BISHOP && t !== Chess.ROOK && t !== Chess.QUEEN) continue;
      if (!g.attacked(ob, sq)) continue;
      var dests = squaresAttackedFrom(g, sq);
      var safe = dests.filter(function (d) {
        var occ = g.board[d];
        if (occ && (occ & Chess.COLOR_MASK) === cb) return false;
        return !g.attacked(ob, d);
      });
      if (safe.length === 0) return Chess.algebraic(sq);
    }
    return null;
  }

  /* ---------------- error mining ---------------- */

  function clampEval(e) { return Math.max(-1200, Math.min(1200, e)); }

  function mineErrors(games, opts) {
    opts = opts || {};
    var minLoss = opts.minLoss || 80;
    var out = [];
    games.forEach(function (game) {
      if (!game.moves || !game.moves.length) return;
      var prevEval = 20; // white's small first-move edge
      var total = game.moves.length;
      for (var i = 0; i < total; i++) {
        var mv = game.moves[i];
        var isMine = (mv.color === game.myColor);
        var after = (typeof mv.evalAfter === 'number') ? clampEval(mv.evalAfter) : null;
        if (after == null) { continue; }
        var before = prevEval;
        prevEval = after;
        if (!isMine) continue;
        var cpLoss = mv.color === 'w' ? (before - after) : (after - before);
        if (cpLoss < minLoss) continue;

        var ply = i + 1;
        var phase = phaseOf(mv.fenBefore, ply, game.openingPly);
        var clockFrac = null, timePressure = false;
        if (mv.clock != null && game.clockInitial) {
          clockFrac = mv.clock / game.clockInitial;
          timePressure = clockFrac < 0.15;
        }
        var bestUci = mv.serverBest || null;
        var bestSan = null;
        if (bestUci) {
          try {
            var tmp = new Chess(mv.fenBefore);
            var bm = tmp.moveFromSan(bestUci);
            if (bm) bestSan = tmp.san(bm);
          } catch (e) {}
        }
        if (!bestSan && mv.serverLine) bestSan = String(mv.serverLine).split(/\s+/)[0];

        var motifs = [];
        try {
          motifs = classifyMotifs(mv.fenBefore, mv.san, bestUci || bestSan, {
            cpLoss: cpLoss, evalBefore: mv.color === 'w' ? before : -before, timePressure: timePressure
          });
        } catch (e) { motifs = []; }

        out.push({
          key: game.id + ':' + ply,
          gameId: game.id,
          gameUrl: game.url,
          date: game.date,
          opening: game.openingName,
          eco: game.eco,
          myColor: game.myColor,
          oppRating: game.oppRating,
          ply: ply,
          moveNo: Math.ceil(ply / 2),
          fen: mv.fenBefore,
          played: mv.san,
          best: bestSan,
          bestUci: bestUci,
          line: mv.serverLine || null,
          cpLoss: Math.round(cpLoss),
          severity: cpLoss >= 300 ? 'blunder' : cpLoss >= 150 ? 'mistake' : 'inaccuracy',
          judgment: mv.judgment || null,
          phase: phase,
          motifs: motifs,
          clockLeft: mv.clock != null ? Math.round(mv.clock) : null,
          clockFrac: clockFrac != null ? +clockFrac.toFixed(2) : null,
          timePressure: timePressure,
          progress: +(ply / total).toFixed(2)
        });
      }
    });
    return out.sort(function (a, b) { return b.cpLoss - a.cpLoss; });
  }

  /* ---------------- opening tree ---------------- */
  // "A tree: your moves as nodes, each annotated with how many times you
  // reached it, your score from there, and the average evaluation drop over
  // the following ten moves." Nodes are keyed by literal move sequence (both
  // colours' plies, like a real opening tree), not by Lichess's coarse
  // openingName family used in the `openings` list above -- that's what lets
  // this show e.g. the Caro-Kann Advance and Exchange as separate branches
  // instead of one bucket.

  var OPENING_TREE_MAX_PLY = 20;       // ~10 full moves: how deep the tree grows
  var OPENING_TREE_EVAL_WINDOW = 10;   // the "following ten moves" the feature is named for
  var OPENING_TREE_MIN_GAMES = 2;      // same repetition threshold the openings list above uses

  // Eval, from MY perspective, after the move at `ply` (1-indexed). Reuses the
  // same clamp mineErrors()/buildProfile() use so one mate score can't blow
  // out a node's average.
  function myPovEval(g, ply) {
    var mv = g.moves && g.moves[ply - 1];
    if (!mv || typeof mv.evalAfter !== 'number') return null;
    var cp = clampEval(mv.evalAfter);
    return g.myColor === 'b' ? -cp : cp;
  }

  function newTreeNode(san, ply) {
    return { san: san, ply: ply, games: 0, score: 0, evalDropSum: 0, evalDropSamples: 0, children: {} };
  }

  function buildOpeningTree(games) {
    var root = newTreeNode(null, 0);
    games.forEach(function (g) {
      if (!g.moves || !g.moves.length) return;
      var node = root;
      var maxPly = Math.min(g.moves.length, OPENING_TREE_MAX_PLY);
      for (var ply = 1; ply <= maxPly; ply++) {
        var mv = g.moves[ply - 1];
        var san = mv && mv.san;
        if (!san) break;
        if (!node.children[san]) node.children[san] = newTreeNode(san, ply);
        node = node.children[san];
        node.games++;
        node.score += g.score;
        var before = myPovEval(g, ply);
        var after = myPovEval(g, ply + OPENING_TREE_EVAL_WINDOW);
        if (before != null && after != null) {
          node.evalDropSum += (before - after);
          node.evalDropSamples++;
        }
      }
    });
    finalizeTreeNode(root);
    return root;
  }

  // Fills in derived stats and sorts+prunes each node's children by
  // frequency, so the busiest lines (typically the player's actual
  // repertoire, e.g. Caro-Kann / QGD) surface first without hardcoding any
  // opening name.
  function finalizeTreeNode(node) {
    node.scorePct = node.games ? Math.round(node.score / node.games * 100) : 0;
    node.evalDrop = node.evalDropSamples ? Math.round(node.evalDropSum / node.evalDropSamples) : null;
    var kids = Object.keys(node.children).map(function (k) { return node.children[k]; })
      .filter(function (k) { return k.games >= OPENING_TREE_MIN_GAMES; });
    kids.forEach(finalizeTreeNode);
    kids.sort(function (a, b) { return b.games - a.games; });
    node.childList = kids;
    return node;
  }

  /* ---------------- aggregate profile ---------------- */

  function buildProfile(games, lichessRating, now) {
    now = now || Date.now();
    var cal = calibrateStrength(games, lichessRating, now);
    var errors = mineErrors(games);
    var analysed = games.filter(function (g) { return g.analysed; });

    var phases = { opening: blank(), middlegame: blank(), endgame: blank() };
    function blank() { return { errors: 0, cpLost: 0, totalLoss: 0, blunders: 0, mistakes: 0, plies: 0 }; }

    games.forEach(function (g) {
      if (!g.analysed) return;
      var prev = 20;
      g.moves.forEach(function (mv, i) {
        var after = (typeof mv.evalAfter === 'number') ? Math.max(-1200, Math.min(1200, mv.evalAfter)) : null;
        if (after == null) return;
        var before = prev; prev = after;
        if (mv.color !== g.myColor) return;
        var ph = phaseOf(mv.fenBefore, i + 1, g.openingPly);
        var loss = Math.max(0, mv.color === 'w' ? (before - after) : (after - before));
        phases[ph].plies++;
        phases[ph].totalLoss += loss;
      });
    });
    errors.forEach(function (e) {
      var p = phases[e.phase];
      p.errors++; p.cpLost += e.cpLoss;
      if (e.severity === 'blunder') p.blunders++;
      if (e.severity === 'mistake') p.mistakes++;
    });
    Object.keys(phases).forEach(function (k) {
      var p = phases[k];
      p.acplInPhase = p.plies ? Math.round(p.totalLoss / p.plies) : 0;
      p.errorAcpl = p.plies ? Math.round(p.cpLost / p.plies) : 0;
      p.errorRate = p.plies ? +(p.errors / p.plies * 100).toFixed(1) : 0;
    });

    // motif frequency + cost
    var motifMap = {};
    errors.forEach(function (e) {
      (e.motifs.length ? e.motifs : ['unclassified']).forEach(function (m) {
        if (!motifMap[m]) motifMap[m] = { motif: m, count: 0, cpLost: 0, blunders: 0, examples: [] };
        motifMap[m].count++; motifMap[m].cpLost += e.cpLoss;
        if (e.severity === 'blunder') motifMap[m].blunders++;
        if (motifMap[m].examples.length < 8) motifMap[m].examples.push(e.key);
      });
    });
    var motifs = Object.keys(motifMap).map(function (k) { return motifMap[k]; })
      .map(function (m) { m.avgCost = Math.round(m.cpLost / m.count); m.severityScore = m.cpLost; return m; })
      .sort(function (a, b) { return b.severityScore - a.severityScore; });

    // openings
    var openMap = {};
    games.forEach(function (g) {
      var name = g.openingName || 'Unlabelled';
      var fam = name.split(':')[0];
      var k = g.myColor + '|' + fam;
      if (!openMap[k]) openMap[k] = { name: fam, color: g.myColor, games: 0, score: 0, cpLost: 0, errors: 0, eco: g.eco };
      openMap[k].games++; openMap[k].score += g.score;
    });
    errors.forEach(function (e) {
      var fam = (e.opening || 'Unlabelled').split(':')[0];
      var k = e.myColor + '|' + fam;
      if (openMap[k]) { openMap[k].cpLost += e.cpLoss; openMap[k].errors++; }
    });
    var openings = Object.keys(openMap).map(function (k) { return openMap[k]; })
      .map(function (o) { o.scorePct = Math.round(o.score / o.games * 100); return o; })
      .filter(function (o) { return o.games >= 2; })
      .sort(function (a, b) { return b.games - a.games; });

    var openingTree = buildOpeningTree(games);

    // clock behaviour
    var timeErrors = errors.filter(function (e) { return e.timePressure; }).length;
    var withClock = errors.filter(function (e) { return e.clockFrac != null; }).length;

    // when in the game do errors cluster
    var buckets = [0, 0, 0, 0, 0];
    errors.forEach(function (e) { buckets[Math.min(4, Math.floor(e.progress * 5))]++; });

    // style vector — used to shape the sparring opponent
    var style = styleVector(games);

    return {
      generatedAt: now,
      calibration: cal,
      counts: {
        games: games.length,
        analysed: analysed.length,
        errors: errors.length,
        blunders: errors.filter(function (e) { return e.severity === 'blunder'; }).length,
        mistakes: errors.filter(function (e) { return e.severity === 'mistake'; }).length
      },
      phases: phases,
      motifs: motifs,
      openings: openings,
      openingTree: openingTree,
      clock: { pressureErrors: timeErrors, withClockData: withClock,
        pressureRate: withClock ? +(timeErrors / withClock * 100).toFixed(1) : null },
      errorTiming: buckets,
      style: style,
      errors: errors
    };
  }

  /* Habits that make the sparring bot feel like the user. */
  function styleVector(games) {
    var captures = 0, quiet = 0, checks = 0, queenMovesEarly = 0, castleEarly = 0, castled = 0;
    var pawnMoves = 0, totalMoves = 0, tradesWhenAhead = 0, aggression = 0;
    games.forEach(function (g) {
      var myCastlePly = null;
      g.moves.forEach(function (mv, i) {
        if (mv.color !== g.myColor) return;
        totalMoves++;
        if (/x/.test(mv.san)) captures++; else quiet++;
        if (/\+/.test(mv.san)) checks++;
        if (/^[a-h]/.test(mv.san)) pawnMoves++;
        if (/^Q/.test(mv.san) && i < 16) queenMovesEarly++;
        if (/^O-O/.test(mv.san)) { castled++; myCastlePly = i + 1; }
      });
      if (myCastlePly && myCastlePly <= 20) castleEarly++;
    });
    var n = totalMoves || 1;
    return {
      captureRate: +(captures / n).toFixed(3),
      checkRate: +(checks / n).toFixed(3),
      pawnMoveRate: +(pawnMoves / n).toFixed(3),
      earlyQueenRate: +(queenMovesEarly / (games.length || 1)).toFixed(2),
      castlesEarly: games.length ? +(castleEarly / games.length).toFixed(2) : 0,
      castleRate: games.length ? +(castled / games.length).toFixed(2) : 0,
      sampleMoves: totalMoves
    };
  }

  /* Opening book harvested from the user's own games — both colours. */
  function buildBook(games, maxPly) {
    maxPly = maxPly || 24;
    var book = {};
    games.forEach(function (g) {
      var pos = new Chess();
      for (var i = 0; i < g.moves.length && i < maxPly; i++) {
        var fenKey = pos.fen().split(' ').slice(0, 4).join(' ');
        var san = g.moves[i].san;
        if (!book[fenKey]) book[fenKey] = {};
        if (!book[fenKey][san]) book[fenKey][san] = { n: 0, score: 0, mine: 0 };
        book[fenKey][san].n++;
        book[fenKey][san].score += g.score;
        if (g.moves[i].color === g.myColor) book[fenKey][san].mine++;
        var applied = pos.move(san);
        if (!applied) break;
      }
    });
    return book;
  }

  root.Analysis = {
    performanceRating: performanceRating,
    eloFromAcpl: eloFromAcpl,
    acplFromElo: acplFromElo,
    calibrateStrength: calibrateStrength,
    phaseOf: phaseOf,
    endgameType: endgameType,
    classifyMotifs: classifyMotifs,
    mineErrors: mineErrors,
    buildProfile: buildProfile,
    buildBook: buildBook,
    buildOpeningTree: buildOpeningTree,
    VAL: VAL
  };
})(typeof window !== 'undefined' ? window : globalThis);
