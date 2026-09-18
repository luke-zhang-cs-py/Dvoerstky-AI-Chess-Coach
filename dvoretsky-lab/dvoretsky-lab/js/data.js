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

  /* Fetch NDJSON stream of games. Requires network access from the page origin. */
  function fetchGames(opts, onProgress) {
    var user = opts.user;
    var since = opts.since || (Date.now() - 1000 * 60 * 60 * 24 * (opts.days || 90));
    var params = new URLSearchParams({
      since: String(Math.floor(since)),
      max: String(opts.max || 300),
      rated: 'true',
      pgnInJson: 'true',
      opening: 'true',
      evals: 'true',
      clocks: 'true',
      accuracy: 'true',
      sort: 'dateDesc'
    });
    if (opts.perfType) params.set('perfType', opts.perfType);
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

  /* Import a PGN file (possibly many games) as a fallback when the API is unreachable. */
  function importPGN(text, user) {
    var chunks = text.replace(/\r/g, '').split(/\n\n(?=\[)/);
    var joined = [], buf = '';
    chunks.forEach(function (c) {
      buf += (buf ? '\n\n' : '') + c;
      if (/\b(1-0|0-1|1\/2-1\/2|\*)\s*$/.test(c.trim())) { joined.push(buf); buf = ''; }
    });
    if (buf.trim()) joined.push(buf);

    var lower = (user || '').toLowerCase();
    var out = [];
    joined.forEach(function (p, i) {
      var parsed;
      try { parsed = Chess.parsePGN(p); } catch (e) { return; }
      if (!parsed.moves.length) return;
      var t = parsed.tags;
      var myColor = (t.White || '').toLowerCase() === lower ? 'w' :
        (t.Black || '').toLowerCase() === lower ? 'b' : (i % 2 === 0 ? 'w' : 'w');
      if (!lower) myColor = 'w';
      var score = parsed.result === '1/2-1/2' ? 0.5 :
        parsed.result === '1-0' ? (myColor === 'w' ? 1 : 0) :
        parsed.result === '0-1' ? (myColor === 'b' ? 1 : 0) : 0.5;
      var d = Date.parse((t.UTCDate || t.Date || '').replace(/\./g, '-') + 'T' + (t.UTCTime || '12:00:00') + 'Z');
      out.push({
        id: t.Site ? (t.Site.split('/').pop() || 'pgn' + i) : 'pgn' + i,
        source: 'pgn', url: t.Site && /^http/.test(t.Site) ? t.Site : null,
        speed: guessSpeed(t.TimeControl), perf: guessSpeed(t.TimeControl), rated: true,
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
        moves: attachPgnEvals(parsed.moves)
      });
    });
    return out;
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

  function guessSpeed(tc) {
    if (!tc) return 'rapid';
    var base = parseInt(String(tc).split('+')[0], 10);
    if (isNaN(base)) return 'rapid';
    if (base < 180) return 'bullet';
    if (base < 480) return 'blitz';
    if (base < 1500) return 'rapid';
    return 'classical';
  }

  root.Data = {
    Store: Store,
    parseHandle: parseHandle,
    fetchGames: fetchGames,
    fetchProfile: fetchProfile,
    fetchRatingHistory: fetchRatingHistory,
    importPGN: importPGN,
    normalizeLichess: normalizeLichess
  };
})(typeof window !== 'undefined' ? window : globalThis);
