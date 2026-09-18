/* training.js — puzzle deck, spaced repetition, daily plan, calendar export. */
(function (root) {
  'use strict';
  var DAY = 86400000;

  /* ---------------- endgame curriculum ----------------
     Starter set of theoretical positions. Descriptions are written here, not
     lifted from any book; extend freely via the "Add position" control. */
  var ENDGAMES = [
    { id: 'lucena', name: 'Lucena — building the bridge', tier: 1, family: 'rook',
      fen: '2K5/2P1k3/8/8/8/8/r7/3R4 w - - 0 1',
      goal: 'White to play and win.',
      idea: 'The pawn cannot queen while the enemy rook checks from behind. Post your rook on the fourth rank first, walk the king out, then interpose the rook to block the final check.' },
    { id: 'philidor', name: 'Philidor — third-rank defence', tier: 1, family: 'rook',
      fen: 'R3k3/8/1r2K3/4P3/8/8/8/8 b - - 0 1',
      goal: 'Black to play and draw.',
      idea: 'Hold the rook on the sixth rank so the white king cannot advance. The instant the pawn steps to the sixth, drop the rook to the first rank and check from behind forever.' },
    { id: 'vancura', name: 'Vancura — drawing against the a-pawn', tier: 2, family: 'rook',
      fen: 'R7/7k/P4r2/8/4K3/8/8/8 b - - 0 1',
      goal: 'Black to play and draw.',
      idea: 'Attack the rook pawn from the side along the sixth rank rather than blockading in front. The white rook stays tied to the pawn and the black king shelters near the h-file.' },
    { id: 'behind-passer', name: 'Rooks belong behind passed pawns', tier: 1, family: 'rook',
      fen: '1r3k2/8/8/1P6/8/8/8/1R4K1 w - - 0 1',
      goal: 'White to play. Show why the attacking rook gains and the blockading rook suffers.',
      idea: 'The rook behind the pawn grows more active with every advance; the rook in front grows more passive. Trade this understanding for tempo, not material.' },
    { id: 'saavedra', name: 'Saavedra — underpromotion', tier: 2, family: 'rook vs pawn',
      fen: '8/8/1KP5/3r4/8/8/8/k7 w - - 0 1',
      goal: 'White to play and win.',
      idea: 'Queening allows a stalemate trick. Promote to a rook instead and the threat of mate on the a-file decides.' },
    { id: 'opposition', name: 'Opposition and key squares', tier: 1, family: 'pawn',
      fen: '8/8/8/4k3/8/4K3/4P3/8 w - - 0 1',
      goal: 'Evaluate with White to move, then with Black to move.',
      idea: 'The result flips on whose turn it is. Learn the three key squares in front of the pawn and count distant opposition before you touch a piece.' },
    { id: 'breakthrough', name: 'The three-pawn breakthrough', tier: 1, family: 'pawn',
      fen: '6k1/ppp5/8/PPP5/8/8/8/6K1 w - - 0 1',
      goal: 'White to play and win.',
      idea: 'A pawn sacrifice in the centre of the trio creates an unstoppable passer. Calculate the race to the end rather than assessing by feel.' },
    { id: 'reti', name: 'Réti — the king that walks two ways at once', tier: 2, family: 'pawn',
      fen: '7K/8/k1P5/7p/8/8/8/8 w - - 0 1',
      goal: 'White to play and draw.',
      idea: 'Diagonal king moves chase the enemy pawn and support your own simultaneously. Geometry on a chessboard is not Euclidean.' },
    { id: 'bn-mate', name: 'Bishop and knight mate', tier: 3, family: 'technique',
      fen: '8/8/8/4k3/8/8/8/3BKN2 w - - 0 1',
      goal: 'Mate within fifty moves.',
      idea: 'Drive the king to a corner matching your bishop. The knight traces a W to cut escape squares while the bishop holds the long diagonal.' },
    { id: 'two-bishops', name: 'Two bishops mate', tier: 2, family: 'technique',
      fen: '8/8/8/4k3/8/8/8/2B1KB2 w - - 0 1',
      goal: 'Mate efficiently.',
      idea: 'Bishops on adjacent diagonals build a wall; the king does the pushing. Any corner will do.' },
    { id: 'wrong-bishop', name: 'Rook pawn and the wrong bishop', tier: 2, family: 'minor piece', fen: null,
      goal: 'Recognise the drawn structure before you enter it.',
      idea: 'If the bishop does not control the promotion square, the defending king reaching the corner draws no matter the material count. This is an evaluation skill, not a calculation one.' },
    { id: 'opp-bishops', name: 'Opposite-coloured bishops: two pawns is often not enough', tier: 2, family: 'minor piece', fen: null,
      goal: 'Learn which pawn structures still win.',
      idea: 'Connected passers separated by enough files win; anything the defending bishop can blockade on its own colour does not. Decide before trading into it.' },
    { id: 'q-vs-pawn', name: 'Queen against a pawn on the seventh', tier: 2, family: 'queen', fen: null,
      goal: 'Know which files win and which draw.',
      idea: 'Centre and knight pawns lose. Rook and bishop pawns draw because of stalemate resources when the queen tries to gain the tempo to bring the king closer.' },
    { id: 'short-side', name: 'Short-side defence in rook endings', tier: 3, family: 'rook', fen: null,
      goal: 'Defend rook and pawn down when Philidor is unavailable.',
      idea: 'Put the king on the short side of the pawn and check from the long side. The checking distance of three files is what makes it hold.' }
  ];

  /* ---------------- spaced repetition (SM-2 variant) ---------------- */

  function newCard(id, meta) {
    return { id: id, ease: 2.4, interval: 0, reps: 0, lapses: 0,
      due: Date.now(), last: null, meta: meta || {}, history: [] };
  }

  // grade: 0 failed, 1 hard, 2 good, 3 instant
  function review(card, grade, now) {
    now = now || Date.now();
    card.history.push({ t: now, g: grade });
    if (card.history.length > 30) card.history.shift();
    if (grade === 0) {
      card.lapses++; card.reps = 0;
      card.ease = Math.max(1.3, card.ease - 0.25);
      card.interval = 0;
      card.due = now + 20 * 60 * 1000; // back today
    } else {
      card.reps++;
      card.ease = Math.max(1.3, Math.min(3.2, card.ease + (grade === 3 ? 0.12 : grade === 2 ? 0.02 : -0.14)));
      if (card.reps === 1) card.interval = grade === 1 ? 1 : 2;
      else if (card.reps === 2) card.interval = grade === 1 ? 3 : 6;
      else card.interval = Math.round(card.interval * card.ease * (grade === 1 ? 0.7 : 1));
      card.interval = Math.max(1, Math.min(240, card.interval));
      card.due = now + card.interval * DAY;
    }
    card.last = now;
    return card;
  }

  function retention(card) {
    if (!card.history.length) return null;
    var hits = card.history.filter(function (h) { return h.g > 0; }).length;
    return +(hits / card.history.length).toFixed(2);
  }

  /* ---------------- deck building ---------------- */

  /* Turn mined errors into puzzle cards. Only positions with a known refutation
     become puzzles; everything else becomes a "review" item instead. */
  function buildDeck(errors, existing) {
    existing = existing || {};
    var deck = [];
    errors.forEach(function (e) {
      if (!e.best) return;
      if (e.best === e.played) return;
      var card = existing[e.key] || newCard(e.key);
      card.meta = {
        fen: e.fen, solution: e.best, solutionUci: e.bestUci, played: e.played,
        line: e.line, cpLoss: e.cpLoss, severity: e.severity, phase: e.phase,
        motifs: e.motifs, gameUrl: e.gameUrl, moveNo: e.moveNo, myColor: e.myColor,
        opening: e.opening, date: e.date, timePressure: e.timePressure
      };
      deck.push(card);
    });
    return deck;
  }

  function dueCards(deck, now) {
    now = now || Date.now();
    return deck.filter(function (c) { return c.due <= now; })
      .sort(function (a, b) { return (b.meta.cpLoss || 0) - (a.meta.cpLoss || 0); });
  }

  /* ---------------- daily plan ---------------- */

  function seededRandom(seed) {
    var s = 0;
    for (var i = 0; i < seed.length; i++) s = (s * 31 + seed.charCodeAt(i)) >>> 0;
    return function () { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  }

  function dateKey(d) {
    var x = new Date(d);
    return x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0');
  }

  /* Weekly rhythm. Middlegame work is the backbone because that's where the
     errors are; endgame theory appears twice a week so it accumulates without
     eating the calendar. */
  var RHYTHM = {
    0: ['recall', 'sparring', 'review'],           // Sunday
    1: ['recall', 'motif', 'calculation'],          // Monday
    2: ['recall', 'endgame', 'motif'],              // Tuesday
    3: ['recall', 'sparring', 'review'],            // Wednesday
    4: ['recall', 'calculation', 'motif'],          // Thursday
    5: ['recall', 'sparring', 'calculation'],       // Friday
    6: ['recall', 'endgame', 'review']              // Saturday
  };

  var BLOCK_META = {
    recall: { label: 'Blunder recall', minutes: 10,
      note: 'Positions you have already got wrong, resurfaced on schedule.' },
    motif: { label: 'Motif drill', minutes: 15,
      note: 'Concentrated work on the pattern costing you the most rating.' },
    calculation: { label: 'Calculation set', minutes: 20,
      note: 'Sharp positions from your own games. Write the line before you move.' },
    endgame: { label: 'Endgame theory', minutes: 20,
      note: 'One theoretical position, learned to the point you could teach it.' },
    sparring: { label: 'Sparring games', minutes: 30,
      note: 'Games against the model of your own play, at your measured strength.' },
    review: { label: 'Game justification', minutes: 20,
      note: 'Replay a recent game and defend every move out loud before seeing the engine.' }
  };

  function planDay(date, profile, deck, opts) {
    opts = opts || {};
    var d = new Date(date);
    var key = dateKey(d);
    var rnd = seededRandom(key + (opts.salt || ''));
    var blocks = (opts.rhythm || RHYTHM)[d.getDay()].slice();
    if (opts.minutesBudget) {
      var used = 0, kept = [];
      blocks.forEach(function (b) {
        if (used + BLOCK_META[b].minutes <= opts.minutesBudget) { kept.push(b); used += BLOCK_META[b].minutes; }
      });
      blocks = kept.length ? kept : [blocks[0]];
    }

    var due = dueCards(deck, d.getTime());
    var topMotifs = (profile && profile.motifs || []).filter(function (m) {
      return m.motif !== 'positional' && m.motif !== 'unclassified';
    }).slice(0, 6);
    var weakestPhase = null;
    if (profile && profile.phases) {
      weakestPhase = Object.keys(profile.phases).sort(function (a, b) {
        return profile.phases[b].acplInPhase - profile.phases[a].acplInPhase;
      })[0];
    }

    var items = blocks.map(function (b) {
      var meta = BLOCK_META[b];
      var item = { type: b, label: meta.label, minutes: meta.minutes, note: meta.note, payload: {} };
      if (b === 'recall') {
        item.payload.cardIds = due.slice(0, 12).map(function (c) { return c.id; });
        item.count = item.payload.cardIds.length;
        if (!item.count) item.note = 'Nothing due. Import newer games or take the day.';
      } else if (b === 'motif') {
        var m = topMotifs.length ? topMotifs[Math.floor(rnd() * Math.min(3, topMotifs.length))] : null;
        item.payload.motif = m ? m.motif : null;
        item.label = m ? 'Motif drill — ' + m.motif : 'Motif drill';
        item.payload.cardIds = deck.filter(function (c) {
          return m && (c.meta.motifs || []).indexOf(m.motif) > -1;
        }).slice(0, 10).map(function (c) { return c.id; });
        item.count = item.payload.cardIds.length;
      } else if (b === 'calculation') {
        var pool = deck.filter(function (c) {
          return c.meta.phase === (weakestPhase === 'opening' ? 'middlegame' : weakestPhase) &&
            (c.meta.cpLoss || 0) >= 150;
        });
        if (pool.length < 4) pool = deck.filter(function (c) { return (c.meta.cpLoss || 0) >= 200; });
        item.payload.cardIds = shuffle(pool, rnd).slice(0, 6).map(function (c) { return c.id; });
        item.count = item.payload.cardIds.length;
        item.payload.requireLine = true;
      } else if (b === 'endgame') {
        var tierPool = ENDGAMES.filter(function (e) { return e.tier <= (opts.endgameTier || 2) && e.fen; });
        if (!tierPool.length) tierPool = ENDGAMES.filter(function (e) { return e.fen; });
        var pick = tierPool[Math.floor(rnd() * tierPool.length)];
        item.payload.endgameId = pick.id;
        item.label = 'Endgame — ' + pick.name;
        item.note = pick.goal;
      } else if (b === 'sparring') {
        item.payload.games = 2;
        item.payload.color = rnd() > 0.5 ? 'w' : 'b';
        item.note = 'Two games as ' + (item.payload.color === 'w' ? 'White' : 'Black') +
          ' against your mirror at ' + (profile && profile.calibration ? profile.calibration.trueStrength : '—') + '.';
      } else if (b === 'review') {
        item.note = 'Pick the most recent game you have not justified yet.';
      }
      return item;
    });

    return {
      date: key,
      weekday: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][d.getDay()],
      totalMinutes: items.reduce(function (s, i) { return s + i.minutes; }, 0),
      items: items
    };
  }

  function shuffle(arr, rnd) {
    var a = arr.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor((rnd ? rnd() : Math.random()) * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  function planRange(startDate, days, profile, deck, opts) {
    var out = [];
    for (var i = 0; i < days; i++) {
      out.push(planDay(new Date(startDate).getTime() + i * DAY, profile, deck, opts));
    }
    return out;
  }

  /* ---------------- calendar export ---------------- */

  function toICS(plans, opts) {
    opts = opts || {};
    var hour = opts.hour != null ? opts.hour : 19;
    function stamp(d, h, m) {
      var x = new Date(d);
      x.setHours(h, m || 0, 0, 0);
      return x.getFullYear() + String(x.getMonth() + 1).padStart(2, '0') + String(x.getDate()).padStart(2, '0') +
        'T' + String(x.getHours()).padStart(2, '0') + String(x.getMinutes()).padStart(2, '0') + '00';
    }
    var lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Dvoretsky Lab//EN', 'CALSCALE:GREGORIAN'];
    plans.forEach(function (p) {
      var offset = 0;
      p.items.forEach(function (item, idx) {
        var start = new Date(p.date + 'T00:00:00');
        var sh = hour + Math.floor(offset / 60), sm = offset % 60;
        offset += item.minutes;
        var eh = hour + Math.floor(offset / 60), em = offset % 60;
        lines.push('BEGIN:VEVENT');
        lines.push('UID:' + p.date + '-' + idx + '@dvoretsky.lab');
        lines.push('DTSTART:' + stamp(start, sh, sm));
        lines.push('DTEND:' + stamp(start, eh, em));
        lines.push('SUMMARY:' + escapeICS(item.label));
        lines.push('DESCRIPTION:' + escapeICS(item.note + (item.count ? ' (' + item.count + ' positions)' : '')));
        lines.push('END:VEVENT');
      });
    });
    lines.push('END:VCALENDAR');
    return lines.join('\r\n');
  }

  function escapeICS(s) {
    return String(s || '').replace(/([,;\\])/g, '\\$1').replace(/\n/g, '\\n');
  }

  root.Training = {
    ENDGAMES: ENDGAMES, BLOCK_META: BLOCK_META, RHYTHM: RHYTHM,
    newCard: newCard, review: review, retention: retention,
    buildDeck: buildDeck, dueCards: dueCards,
    planDay: planDay, planRange: planRange, dateKey: dateKey, toICS: toICS
  };
})(typeof window !== 'undefined' ? window : globalThis);
