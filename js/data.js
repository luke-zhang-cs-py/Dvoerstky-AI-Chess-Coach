/* data.js — game ingestion (Lichess API + PGN), local persistence. */
(function (root) {
  'use strict';
  var Chess = root.Chess;

  var Store = {
    key: function (k) { return 'dvor:' + k; },
    get: function (k, dflt) {
      try { var v = localStorage.getItem(Store.key(k)); return v ? JSON.parse(v) : dflt; }
      catch (e) { return dflt; }
    },
    set: function (k, v) {
      try { localStorage.setItem(Store.key(k), JSON.stringify(v)); return true; }
      catch (e) { console.warn('storage full', e); return false; }
    },
    del: function (k) { try { localStorage.removeItem(Store.key(k)); } catch (e) {} },
    keys: function () {
      var out = [];
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (k.indexOf('dvor:') === 0) out.push(k.slice(5));
      }
      return out;
    }
  };

  /* Parse a Lichess profile URL or bare username. */
  function parseHandle(input) {
    if (!input) return null;
    var s = String(input).trim();
    var m = s.match(/lichess\.org\/@\/([A-Za-z0-9_-]+)/i);
    if (m) return m[1];
    m = s.match(/lichess\.org\/([A-Za-z0-9_-]{2,30})\/?$/i);
    if (m && ['games', 'tv', 'training', 'analysis'].indexOf(m[1].toLowerCase()) === -1) return m[1];
    m = s.match(/^@?([A-Za-z0-9_-]{2,30})$/);
    if (m) return m[1];
    return null;
  }

  // Every standard-chess speed. Lichess's export also carries variants (Chess960,
  // crazyhouse...) when perfType is left out, and those do not start from the
  // normal position, so "all" is spelled out rather than omitted.
  var STANDARD_PERFS = 'ultraBullet,bullet,blitz,rapid,classical,correspondence';

  // The name the Sparring tab's game text gives the mirror, so importing that text
  // knows which side was the user's.
  var MIRROR_NAME = 'Dvoretsky Lab mirror';

  /* Fetch NDJSON stream of games. Requires network access from the page origin.
     opts.days: how far back (0 or none = the whole history). opts.perfType: one speed,
     or 'all' for every standard one. */
  function fetchGames(opts, onProgress) {
    var user = opts.user;
    var since = opts.since || (opts.days ? Date.now() - 1000 * 60 * 60 * 24 * opts.days : 0);
    var params = new URLSearchParams({
      max: String(opts.max || 300),
      rated: 'true',
      pgnInJson: 'true',
      opening: 'true',
      evals: 'true',
      clocks: 'true',
      accuracy: 'true',
      sort: 'dateDesc'
    });
    if (since) params.set('since', String(Math.floor(since)));
    if (opts.perfType) params.set('perfType', opts.perfType === 'all' ? STANDARD_PERFS : opts.perfType);
    var url = 'https://lichess.org/api/games/user/' + encodeURIComponent(user) + '?' + params.toString();
    var headers = { Accept: 'application/x-ndjson' };
    if (opts.token) headers.Authorization = 'Bearer ' + opts.token;

    return fetch(url, { headers: headers }).then(function (res) {
      if (res.status === 404) throw new Error('No Lichess account found for "' + user + '".');
      if (res.status === 429) throw new Error('Lichess is rate-limiting this connection. Wait a minute and retry.');
      if (!res.ok) throw new Error('Lichess returned ' + res.status + '.');
      return res.text();
    }).then(function (text) {
      var out = [];
      text.split('\n').forEach(function (line) {
        line = line.trim();
        if (!line) return;
        try { out.push(normalizeLichess(JSON.parse(line), user)); } catch (e) {}
      });
      if (onProgress) onProgress(out.length);
      return out;
    });
  }

  function fetchProfile(user) {
    return fetch('https://lichess.org/api/user/' + encodeURIComponent(user))
      .then(function (r) { if (!r.ok) throw new Error('Profile lookup failed (' + r.status + ').'); return r.json(); });
  }

  function fetchRatingHistory(user) {
    return fetch('https://lichess.org/api/user/' + encodeURIComponent(user) + '/rating-history')
      .then(function (r) { return r.ok ? r.json() : []; }).catch(function () { return []; });
  }

  /* Convert a Lichess game object into our internal shape. */
  function normalizeLichess(g, user) {
    var lower = (user || '').toLowerCase();
    var wName = (((g.players || {}).white || {}).user || {}).name || (g.players.white.aiLevel ? 'Stockfish L' + g.players.white.aiLevel : 'Anonymous');
    var bName = (((g.players || {}).black || {}).user || {}).name || (g.players.black.aiLevel ? 'Stockfish L' + g.players.black.aiLevel : 'Anonymous');
    var myColor = wName.toLowerCase() === lower ? 'w' : (bName.toLowerCase() === lower ? 'b' : null);
    var me = myColor === 'w' ? g.players.white : g.players.black;
    var opp = myColor === 'w' ? g.players.black : g.players.white;
    var result = g.winner ? (g.winner === 'white' ? '1-0' : '0-1') : '1/2-1/2';
    var score = !g.winner ? 0.5 : ((g.winner === 'white') === (myColor === 'w') ? 1 : 0);

    var moves = [];
    if (g.pgn) {
      try { moves = Chess.parsePGN(g.pgn).moves; } catch (e) { moves = []; }
    } else if (g.moves) {
      try { moves = Chess.parsePGN('1. ' + g.moves).moves; } catch (e) { moves = []; }
    }

    // attach server evals when present
    if (g.analysis && g.analysis.length) {
      for (var i = 0; i < moves.length && i < g.analysis.length; i++) {
        var a = g.analysis[i];
        moves[i].evalAfter = (typeof a.eval === 'number') ? a.eval : (a.mate ? (a.mate > 0 ? 10000 : -10000) : null);
        moves[i].mateAfter = (typeof a.mate === 'number') ? a.mate : null;
        if (a.judgment) { moves[i].judgment = a.judgment.name; moves[i].judgmentText = a.judgment.comment; }
        if (a.best) moves[i].serverBest = a.best;
        if (a.variation) moves[i].serverLine = a.variation;
      }
    }
    if (g.clocks && g.clocks.length) {
      for (var j = 0; j < moves.length && j < g.clocks.length; j++) moves[j].clock = g.clocks[j] / 100;
    }

    return {
      id: g.id,
      source: 'lichess',
      url: 'https://lichess.org/' + g.id,
      speed: g.speed,
      perf: g.perf,
      rated: !!g.rated,
      date: g.createdAt,
      endedAt: g.lastMoveAt || g.createdAt,
      status: g.status,
      myColor: myColor,
      myName: myColor === 'w' ? wName : bName,
      oppName: myColor === 'w' ? bName : wName,
      myRating: me ? me.rating : null,
      oppRating: opp ? opp.rating : null,
      ratingDiff: me ? me.ratingDiff : null,
      score: score,
      result: result,
      eco: (g.opening || {}).eco || null,
      openingName: (g.opening || {}).name || null,
      openingPly: (g.opening || {}).ply || null,
      analysed: !!(g.analysis && g.analysis.length),
      acpl: me && me.analysis ? me.analysis.acpl : null,
      oppAcpl: opp && opp.analysis ? opp.analysis.acpl : null,
      accuracy: me && me.analysis ? me.analysis.accuracy : null,
      counts: me && me.analysis ? {
        inaccuracy: me.analysis.inaccuracy || 0,
        mistake: me.analysis.mistake || 0,
        blunder: me.analysis.blunder || 0
      } : null,
      clockInitial: g.clock ? g.clock.initial : null,
      clockIncrement: g.clock ? g.clock.increment : null,
      moves: moves
    };
  }

  /* Cut a PGN file into games. A game ends where the next one's tags begin -- a tag
     line after movetext, with or without a blank line between (some tools write
     none) -- or after its result token. Lines inside a {comment} are neither: a
     comment's second paragraph may well start with "[". */
  var TAG_LINE = /^\s*\[[A-Za-z0-9_]+\s+"/;
  var RESULT_END = /(^|\s)(1-0|0-1|1\/2-1\/2|\*)\s*$/;   // not \b: there is no word boundary between a space and "*"
  function splitGames(text) {
    var games = [], cur = [], hasMoves = false, inComment = false;
    function close() { if (cur.join('').trim()) games.push(cur.join('\n')); cur = []; hasMoves = false; }
    text.replace(/\r/g, '').split('\n').forEach(function (line) {
      var isTag = !inComment && TAG_LINE.test(line);
      if (isTag && hasMoves) close();
      cur.push(line);
      if (isTag || !line.trim()) return;
      var code = '';   // the part of the line outside comments, where a result can be
      for (var i = 0; i < line.length; i++) {
        var ch = line[i];
        if (inComment) { if (ch === '}') inComment = false; continue; }
        if (ch === '{') { inComment = true; continue; }
        if (ch === ';') break;   // a comment to the end of the line
        code += ch;
      }
      if (code.trim()) hasMoves = true;
      if (!inComment && hasMoves && RESULT_END.test(code)) close();
    });
    close();
    return games;
  }

  // Only standard chess: a variant's moves (a crazyhouse drop, Chess960 castling) do not
  // follow the rules js/core.js plays by, and its positions are not ones to drill.
  var STANDARD_VARIANT = /^(standard|from position|)$/i;

  /* Import a PGN file (possibly many games) as a fallback when the API is unreachable.
     Returns the games; out.skipped lists what was left out and why:
     { reason: 'variant', variant } or { reason: 'unreadable', detail }. */
  function importPGN(text, user) {
    var skipped = [];
    var parsedAll = splitGames(text).map(function (p) {
      var variant = (p.match(/^\s*\[Variant\s+"([^"]*)"\]/m) || [])[1];
      if (variant != null && !STANDARD_VARIANT.test(variant.trim())) {
        skipped.push({ reason: 'variant', variant: variant });
        return null;
      }
      try { return Chess.parsePGN(p); } catch (e) { skipped.push({ reason: 'unreadable', detail: e.message }); return null; }
    }).filter(function (p) { return p && p.moves.length; });

    // Whose games are these? The handle if it names a player; otherwise the
    // name that turns up in the most games -- a player's own export has them in
    // every one, on both colours. The Sparring tab's game text names its other
    // side MIRROR_NAME, which is never the user.
    var lower = (user || '').toLowerCase(), mirror = MIRROR_NAME.toLowerCase();
    var seen = {};
    parsedAll.forEach(function (p) {
      [p.tags.White, p.tags.Black].forEach(function (n) {
        if (n && n.toLowerCase() !== mirror) { n = n.toLowerCase(); seen[n] = (seen[n] || 0) + 1; }
      });
    });
    if (!seen[lower]) {
      lower = Object.keys(seen).sort(function (a, b) { return seen[b] - seen[a]; })[0] || '';
    }

    var out = [];
    parsedAll.forEach(function (parsed, i) {
      var t = parsed.tags;
      // Which side is the user's: the side with their name, else the side the mirror is
      // not on. A game that names neither (bare movetext, no tags) is read as played
      // with White -- nothing tells, and White is where the move list starts -- and is
      // marked colourGuessed, so the import notice can say how many were read that way.
      var w = (t.White || '').toLowerCase(), b = (t.Black || '').toLowerCase();
      var named = !!lower && (w === lower || b === lower);
      var myColor = named ? (w === lower ? 'w' : 'b') : w === mirror ? 'b' : 'w';
      var guessed = !named && w !== mirror && b !== mirror;
      // "*" is a game with no result (unfinished, abandoned): no score, so the
      // performance rating and every score percentage leave it out.
      var score = parsed.result === '1/2-1/2' ? 0.5 :
        parsed.result === '1-0' ? (myColor === 'w' ? 1 : 0) :
        parsed.result === '0-1' ? (myColor === 'b' ? 1 : 0) : null;
      // Lichess names its events "Rated Blitz game" or "Casual Rapid game"; with no word
      // either way (chess.com's "Live Chess", an over-the-board event) it is not known.
      var ev = t.Event || '';
      var rated = /\b(casual|unrated)\b/i.test(ev) ? false : /\brated\b/i.test(ev) ? true : null;
      var d = Date.parse((t.UTCDate || t.Date || '').replace(/\./g, '-') + 'T' + (t.UTCTime || '12:00:00') + 'Z');
      var url = gameUrl(t);
      out.push({
        id: url ? url.replace(/[\/?#]+$/, '').split('/').pop() : pgnId(t, parsed.moves),
        source: 'pgn', url: url,
        speed: guessSpeed(t.TimeControl), perf: guessSpeed(t.TimeControl), rated: rated,
        date: isNaN(d) ? Date.now() - i * 86400000 : d,
        endedAt: isNaN(d) ? Date.now() - i * 86400000 : d,
        status: t.Termination || 'unknown',
        myColor: myColor,
        myName: myColor === 'w' ? t.White : t.Black,
        oppName: myColor === 'w' ? t.Black : t.White,
        myRating: parseInt(myColor === 'w' ? t.WhiteElo : t.BlackElo, 10) || null,
        oppRating: parseInt(myColor === 'w' ? t.BlackElo : t.WhiteElo, 10) || null,
        score: score, result: parsed.result,
        eco: t.ECO || null, openingName: t.Opening || null, openingPly: null,
        analysed: parsed.moves.some(function (m) { return m.comment && /\[%eval/.test(m.comment); }),
        acpl: null, accuracy: null, counts: null,
        clockInitial: null, clockIncrement: null,
        moves: attachPgnEvals(parsed.moves),
        colourGuessed: guessed
      });
    });
    out.skipped = skipped;
    return out;
  }

  // The game's own page: Lichess puts it in Site, chess.com in Link. A Site that is
  // not a link ("Chess.com", "?", a city) names a place every game in the file shares.
  function gameUrl(t) {
    return [t.Site, t.Link].filter(function (u) { return /^https?:\/\/[^\/]+\/./.test(u || ''); })[0] || null;
  }

  // With no link, the id is a hash of who, when and the moves: the same game imported
  // twice has the same id, and two games from one file never share one.
  function pgnId(t, moves) {
    var s = [t.Event, t.White, t.Black, t.Date, t.UTCDate, t.UTCTime, t.Round, t.FEN].join('|') + '|' +
      moves.map(function (m) { return m.san; }).join(' ');
    var h = 5381;
    for (var i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
    return 'pgn-' + h.toString(36) + '-' + moves.length;
  }

  function attachPgnEvals(moves) {
    moves.forEach(function (m) {
      if (!m.comment) return;
      var e = m.comment.match(/\[%eval\s+(#?-?[\d.]+)\]/);
      if (e) {
        if (e[1][0] === '#') { m.mateAfter = parseInt(e[1].slice(1), 10); m.evalAfter = m.mateAfter > 0 ? 10000 : -10000; }
        else m.evalAfter = Math.round(parseFloat(e[1]) * 100);
      }
      var c = m.comment.match(/\[%clk\s+(\d+):(\d+):([\d.]+)\]/);
      if (c) m.clock = (+c[1]) * 3600 + (+c[2]) * 60 + parseFloat(c[3]);
    });
    return moves;
  }

  // Lichess's own rule: a game is sorted by its estimated length, base + 40 x increment
  // seconds. "-" (no clock) is correspondence.
  function guessSpeed(tc) {
    if (!tc) return 'rapid';
    if (String(tc).trim() === '-') return 'correspondence';
    var parts = String(tc).split('+'), base = parseInt(parts[0], 10), inc = parseInt(parts[1], 10) || 0;
    if (isNaN(base)) return 'rapid';
    var est = base + 40 * inc;
    if (est < 30) return 'ultraBullet';
    if (est < 180) return 'bullet';
    if (est < 480) return 'blitz';
    if (est < 1500) return 'rapid';
    return 'classical';
  }

  root.Data = {
    Store: Store,
    parseHandle: parseHandle,
    fetchGames: fetchGames,
    fetchProfile: fetchProfile,
    fetchRatingHistory: fetchRatingHistory,
    importPGN: importPGN,
    splitGames: splitGames,
    MIRROR_NAME: MIRROR_NAME,
    normalizeLichess: normalizeLichess
  };
})(typeof window !== 'undefined' ? window : globalThis);
