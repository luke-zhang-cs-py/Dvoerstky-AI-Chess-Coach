/* Titled players to measure against: well-known CMs, FMs, IMs and GMs on Lichess, compared on the
   same scale as the player's own Lichess ratings.

   A player's "range" is honest about what Lichess exposes:
   - all speeds: lowest to highest of their ESTABLISHED ratings (not provisional, at least MIN_GAMES
     games). Provisional ratings are left out: a GM who never plays rapid on Lichess shows a
     placeholder near 1500, which says nothing about their strength.
   - one speed: their current established rating there, plus the low and high over their most recent
     12 months at that speed when their rating history is public (many are not).
   FIDE title floors are drawn for context only: Lichess ratings run higher than FIDE.

   Ratings ship as a dated snapshot so the tab works offline and from file://; refresh() reads the
   live numbers from the Lichess API, one request at a time. */
(function (root) {
  'use strict';

  var MIN_GAMES = 20;
  var SPEEDS = ['bullet', 'blitz', 'rapid', 'classical'];
  var HISTORY_NAMES = { Bullet: 'bullet', Blitz: 'blitz', Rapid: 'rapid', Classical: 'classical' };
  var TITLE_ORDER = ['CM', 'FM', 'IM', 'GM'];
  // FIDE's rating requirements for each title (the GM and IM norms come on top of these).
  var TITLE_FLOORS = [{ title: 'CM', rating: 2200 }, { title: 'FM', rating: 2300 }, { title: 'IM', rating: 2400 }, { title: 'GM', rating: 2500 }];

  // Lichess accounts whose owners are publicly known; titles are Lichess's own verified ones.
  var PLAYERS = [
    { user: 'Kingscrusher-YouTube', name: 'Tryfon Gavriel' },
    { user: 'CheckRaiseMate', name: 'Nate Solon' },
    { user: 'EricRosen', name: 'Eric Rosen' },
    { user: 'Fins', name: 'John Bartholomew' },
    { user: 'ChessExplained', name: 'Christof Sielecki' },
    { user: 'DrNykterstein', name: 'Magnus Carlsen' },
    { user: 'alireza2003', name: 'Alireza Firouzja' },
    { user: 'AnishGiri', name: 'Anish Giri' },
    { user: 'nihalsarin2004', name: 'Nihal Sarin' },
    { user: 'penguingim1', name: 'Andrew Tang' },
    { user: 'Zhigalko_Sergei', name: 'Sergei Zhigalko' },
    { user: 'Night-King96', name: 'Oleksandr Bortnyk' },
    { user: 'GingerGM', name: 'Simon Williams' }
  ];
  var DEFAULT_PICKS = ['Kingscrusher-YouTube', 'CheckRaiseMate', 'EricRosen', 'DrNykterstein'];

  // From the Lichess API on the date below. Per speed: [rating, games, provisional, 12-month low,
  // 12-month high, last game at that speed]; low/high/last are null where the history is not public.
  var SNAPSHOT = {"date":"2026-10-01","players":{"Kingscrusher-YouTube":{"t":"CM","s":{"bullet":[2612,221328,0,2409,2740,"2026-09-30"],"blitz":[2334,43903,0,2286,2393,"2026-09-19"],"rapid":[2202,2265,1,2202,2219,"2020-12-29"],"classical":[1544,7,1,1544,1544,"2019-05-10"]}},"CheckRaiseMate":{"t":"FM","s":{"bullet":[2530,13453,0,null,null,null],"blitz":[2477,7045,0,null,null,null],"rapid":[2366,70,1,null,null,null],"classical":[2416,5,1,null,null,null]}},"EricRosen":{"t":"IM","s":{"bullet":[2760,19592,0,null,null,null],"blitz":[2544,9309,0,null,null,null],"rapid":[2574,1931,0,null,null,null],"classical":[2468,309,1,null,null,null]}},"Fins":{"t":"IM","s":{"bullet":[2681,7313,1,null,null,null],"blitz":[2700,3470,0,null,null,null],"rapid":[2664,591,0,null,null,null],"classical":[2496,31,1,null,null,null]}},"ChessExplained":{"t":"IM","s":{"bullet":[2815,6282,1,null,null,null],"blitz":[2460,19001,0,null,null,null],"rapid":[2385,65,1,null,null,null],"classical":[2187,37,1,null,null,null]}},"DrNykterstein":{"t":"GM","s":{"bullet":[3243,9583,0,null,null,null],"blitz":[3153,606,1,null,null,null],"rapid":[2500,0,1,null,null,null],"classical":[2500,0,1,null,null,null]}},"alireza2003":{"t":"GM","s":{"bullet":[3190,9171,0,null,null,null],"blitz":[2906,530,1,null,null,null],"rapid":[1427,3,1,null,null,null],"classical":[1500,0,1,null,null,null]}},"AnishGiri":{"t":"GM","s":{"bullet":[3271,2476,0,null,null,null],"blitz":[2854,107,1,null,null,null],"rapid":[2700,0,1,null,null,null],"classical":[2700,0,1,null,null,null]}},"nihalsarin2004":{"t":"GM","s":{"bullet":[3328,18772,0,3175,3378,"2026-09-30"],"blitz":[2905,1333,1,2883,2905,"2026-02-14"],"rapid":[1500,0,1,null,null,null],"classical":[1500,0,1,null,null,null]}},"penguingim1":{"t":"GM","s":{"bullet":[3184,47990,0,null,null,null],"blitz":[2719,5226,0,null,null,null],"rapid":[2672,237,1,null,null,null],"classical":[2578,6,1,null,null,null]}},"Zhigalko_Sergei":{"t":"GM","s":{"bullet":[3067,81980,0,null,null,null],"blitz":[2815,17868,0,null,null,null],"rapid":[2948,446,1,null,null,null],"classical":[1500,0,1,null,null,null]}},"Night-King96":{"t":"GM","s":{"bullet":[3375,16506,0,3168,3375,"2026-09-29"],"blitz":[2830,3848,0,2813,2877,"2026-08-28"],"rapid":[2777,81,1,2588,2777,"2023-12-08"],"classical":[1500,0,1,null,null,null]}},"GingerGM":{"t":"GM","s":{"bullet":[2497,69,1,null,null,null],"blitz":[2560,10199,0,null,null,null],"rapid":[1810,3,1,null,null,null],"classical":[1939,9,1,null,null,null]}}}};

  /* ---------- one speed ---------- */

  // [rating, games, prov, lo, hi, last] -> { rating, games, established, lo, hi, last }
  function speedOf(row) {
    if (!row) return null;
    var games = row[1] || 0;
    return { rating: row[0], games: games, established: !row[2] && games >= MIN_GAMES,
      lo: row[3] == null ? null : row[3], hi: row[4] == null ? null : row[4], last: row[5] || null };
  }

  // A Lichess /api/user perfs object -> the same compact rows (no history yet).
  function rowsFromPerfs(perfs) {
    var out = {};
    SPEEDS.forEach(function (k) {
      var p = perfs && perfs[k];
      if (p && typeof p.rating === 'number') out[k] = [p.rating, p.games || 0, p.prov ? 1 : 0, null, null, null];
    });
    return out;
  }

  // A Lichess rating-history answer -> per speed { lo, hi, last }: the 12 months up to the last game
  // at that speed (today, for anyone still playing it). Months in the API are 0-based.
  function historyRanges(history, today) {
    var out = {};
    var now = today || new Date();
    (Array.isArray(history) ? history : []).forEach(function (h) {
      var key = HISTORY_NAMES[h && h.name];
      if (!key || !Array.isArray(h.points) || !h.points.length) return;
      var dated = h.points.map(function (p) { return { d: new Date(p[0], p[1], p[2]), r: p[3] }; })
        .filter(function (x) { return !isNaN(x.d) && typeof x.r === 'number'; });
      if (!dated.length) return;
      var last = new Date(Math.max.apply(null, dated.map(function (x) { return +x.d; })));
      var end = last < now ? last : now;
      var start = new Date(end.getFullYear() - 1, end.getMonth(), end.getDate());
      var year = dated.filter(function (x) { return x.d >= start && x.d <= end; }).map(function (x) { return x.r; });
      if (!year.length) return;
      out[key] = { lo: Math.min.apply(null, year), hi: Math.max.apply(null, year), last: iso(last) };
    });
    return out;
  }

  function iso(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  function withHistory(rows, ranges) {
    var out = {};
    Object.keys(rows || {}).forEach(function (k) {
      var r = rows[k].slice();
      var h = ranges && ranges[k];
      if (h) { r[3] = h.lo; r[4] = h.hi; r[5] = h.last; }
      out[k] = r;
    });
    return out;
  }

  /* ---------- saved data is untrusted: numbers stay numbers ---------- */

  var TITLES = /^(GM|IM|FM|CM|WGM|WIM|WFM|WCM|NM|LM)$/;
  var num = function (v) { return typeof v === 'number' && isFinite(v) ? Math.round(v) : null; };

  // Rows read back from localStorage (a live refresh, or your own ratings) or a tampered backup:
  // only known speeds, finite numbers and real dates survive, so nothing else reaches the page.
  function cleanRows(rows) {
    var out = {};
    if (!rows || typeof rows !== 'object') return out;
    SPEEDS.forEach(function (k) {
      var r = rows[k];
      if (!Array.isArray(r) || num(r[0]) == null) return;
      out[k] = [num(r[0]), num(r[1]) || 0, r[2] ? 1 : 0, num(r[3]), num(r[4]),
        typeof r[5] === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r[5]) ? r[5] : null];
    });
    return out;
  }
  function cleanTitle(t) { return typeof t === 'string' && TITLES.test(t) ? t : null; }

  /* ---------- a whole player ---------- */

  // rows -> { lo, hi, points: [{ speed, rating }] } over established speeds, or null when none.
  function rangeAcross(rows) {
    var points = [];
    SPEEDS.forEach(function (k) {
      var s = speedOf(rows && rows[k]);
      if (s && s.established) points.push({ speed: k, rating: s.rating });
    });
    if (!points.length) return null;
    var vals = points.map(function (p) { return p.rating; });
    return { lo: Math.min.apply(null, vals), hi: Math.max.apply(null, vals), points: points };
  }

  // One speed: the current rating with the 12-month low/high around it (the low/high always
  // include the current rating, so the whisker never sits beside its own dot).
  function rangeAt(rows, speed) {
    var s = speedOf(rows && rows[speed]);
    if (!s || !s.established) return null;
    var lo = s.lo == null ? s.rating : Math.min(s.lo, s.rating);
    var hi = s.hi == null ? s.rating : Math.max(s.hi, s.rating);
    return { rating: s.rating, lo: lo, hi: hi, games: s.games, last: s.last, history: s.lo != null };
  }

  function range(rows, speed) {
    return !speed || speed === 'all' ? rangeAcross(rows) : rangeAt(rows, speed);
  }

  // The players, each with their rows: the live ones when refreshed, else the snapshot.
  function players(live) {
    var snap = SNAPSHOT.players;
    return PLAYERS.map(function (p) {
      var l = live && live.players && live.players[p.user];
      var s = l && typeof l === 'object' ? { t: cleanTitle(l.t), s: cleanRows(l.s) } : snap[p.user] || { t: null, s: {} };
      return { user: p.user, name: p.name, title: s.t, rows: s.s };
    }).sort(function (a, b) {
      return TITLE_ORDER.indexOf(a.title) - TITLE_ORDER.indexOf(b.title) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    });
  }

  // How far your top established rating sits below the bottom of theirs (negative: you overlap or lead).
  function gap(you, them) {
    if (!you || !them) return null;
    return them.lo - you.hi;
  }

  // The scale every bar is drawn on: just wider than everything shown, in round hundreds.
  function scale(ranges) {
    var vals = [];
    ranges.forEach(function (r) { if (r) { vals.push(r.lo, r.hi); } });
    TITLE_FLOORS.forEach(function (f) { vals.push(f.rating); });
    var lo = Math.floor((Math.min.apply(null, vals) - 50) / 100) * 100;
    var hi = Math.ceil((Math.max.apply(null, vals) + 50) / 100) * 100;
    return { lo: lo, hi: hi, pos: function (v) { return Math.max(0, Math.min(100, (v - lo) / (hi - lo) * 100)); } };
  }

  /* ---------- live numbers ---------- */

  // fetchImpl defaults to fetch; tests pass their own. One request at a time with a pause, the way
  // Lichess asks API users to behave. Returns { date, players: { user: { t, s } } }.
  function refresh(users, opts) {
    opts = opts || {};
    var get = opts.fetch || (typeof fetch !== 'undefined' ? fetch.bind(root) : null);
    var pause = opts.pause == null ? 1100 : opts.pause;
    var today = opts.today || new Date();
    var wait = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
    if (!get) return Promise.reject(new Error('No network here.'));
    return get('https://lichess.org/api/users', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: users.join(',') })
      .then(function (r) { if (!r.ok) throw new Error('Lichess answered ' + r.status + '.'); return r.json(); })
      .then(function (list) {
        var out = { date: iso(today), players: {} };
        var byName = {};
        (list || []).forEach(function (u) { if (u && u.username && !u.closed && !u.disabled) byName[u.username.toLowerCase()] = u; });
        var chain = Promise.resolve();
        users.forEach(function (name) {
          var u = byName[name.toLowerCase()];
          if (!u) return;
          chain = chain.then(function () { return wait(pause); })
            .then(function () { return get('https://lichess.org/api/user/' + encodeURIComponent(name) + '/rating-history'); })
            .then(function (r) { return r.ok ? r.json() : []; }, function () { return []; })
            .then(function (hist) {
              out.players[name] = { t: u.title || null, s: withHistory(rowsFromPerfs(u.perfs), historyRanges(hist, today)) };
            });
        });
        return chain.then(function () { return out; });
      });
  }

  root.Titled = {
    MIN_GAMES: MIN_GAMES, SPEEDS: SPEEDS, TITLE_FLOORS: TITLE_FLOORS, TITLE_ORDER: TITLE_ORDER,
    PLAYERS: PLAYERS, DEFAULT_PICKS: DEFAULT_PICKS, SNAPSHOT: SNAPSHOT,
    speedOf: speedOf, rowsFromPerfs: rowsFromPerfs, historyRanges: historyRanges, withHistory: withHistory,
    cleanRows: cleanRows, cleanTitle: cleanTitle, rangeAcross: rangeAcross, rangeAt: rangeAt, range: range, players: players, gap: gap, scale: scale, refresh: refresh
  };
})(typeof window !== 'undefined' ? window : globalThis);
