/* ui.js — application shell and the five workspaces. */
(function () {
  'use strict';
  var Chess = window.Chess, Engine = window.Engine, Data = window.Data,
      Analysis = window.Analysis, Training = window.Training, Coach = window.Coach,
      Sparring = window.Sparring, Board = window.Board, Store = Data.Store;

  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };

  var S = {
    handle: Store.get('handle', ''),
    games: [],
    profile: null,
    deck: {},
    cardState: Store.get('cards', {}),
    track: Store.get('track', []),
    transcripts: Store.get('transcripts', {}),
    completed: Store.get('completed', {}),
    settings: Store.get('settings', { minutes: 60, endgameTier: 2, hour: 19, apiKey: '', perf: 'rapid',
      boardTheme: 'cyan', pieceSet: 'glyph', showCoords: true }),
    engine: new Engine(),
    spar: null,
    review: null,
    drill: null,
    scout: null
  };

  /* ---------- compact persistence (localStorage is small; FENs are recomputable) ---------- */
  function compact(games) {
    return games.map(function (g) {
      var c = {};
      ['id','source','url','speed','perf','rated','date','endedAt','status','myColor','myName','oppName',
       'myRating','oppRating','score','result','eco','openingName','openingPly','analysed','acpl','oppAcpl',
       'accuracy','clockInitial','clockIncrement'].forEach(function (k) { c[k] = g[k]; });
      c.m = g.moves.map(function (mv) {
        return [mv.san, mv.evalAfter == null ? '' : mv.evalAfter, mv.judgment || '',
                mv.serverBest || '', mv.clock == null ? '' : Math.round(mv.clock), mv.serverLine || ''];
      });
      return c;
    });
  }
  function hydrate(compacted) {
    return compacted.map(function (c) {
      var g = new Chess(), moves = [];
      (c.m || []).forEach(function (row, i) {
        var before = g.fen();
        var mv = g.move(row[0]);
        if (!mv) return;
        moves.push({
          san: mv.san, ply: i + 1, color: mv.color === Chess.WHITE ? 'w' : 'b',
          fenBefore: before, fenAfter: g.fen(),
          evalAfter: row[1] === '' ? null : +row[1],
          judgment: row[2] || null, serverBest: row[3] || null,
          clock: row[4] === '' ? null : +row[4], serverLine: row[5] || null
        });
      });
      var out = Object.assign({}, c); delete out.m; out.moves = moves;
      return out;
    });
  }

  function saveGames() {
    var ok = Store.set('games', compact(S.games));
    if (!ok) flash('Local storage is full. Reduce the sync window in Settings.', 'bad');
  }
  function loadGames() {
    var raw = Store.get('games', null);
    if (raw) { try { S.games = hydrate(raw); } catch (e) { S.games = []; } }
  }

  /* ---------- masthead + tabs ---------- */
  function initTabs() {
    $$('.tab').forEach(function (t) {
      t.addEventListener('click', function () { selectTab(t.dataset.tab); });
    });
    selectTab(location.hash.slice(1) || 'strength');
  }
  function selectTab(name) {
    $$('.tab').forEach(function (t) { t.setAttribute('aria-selected', String(t.dataset.tab === name)); });
    $$('.panel').forEach(function (p) { p.classList.toggle('active', p.id === 'panel-' + name); });
    history.replaceState(null, '', '#' + name);
    if (name === 'calendar') renderCalendar();
    if (name === 'drills') renderDrillHome();
    if (name === 'review') renderReviewHome();
  }

  function flash(msg, kind) {
    var el = $('#flash');
    el.className = 'notice ' + (kind || '');
    el.innerHTML = msg;
    el.classList.remove('hidden');
    if (kind !== 'bad') setTimeout(function () { el.classList.add('hidden'); }, 6000);
  }

  /* ---------- sync ---------- */
  function sync() {
    var raw = $('#handle').value;
    var user = Data.parseHandle(raw);
    if (!user) { flash('That does not look like a Lichess username or profile link.', 'bad'); return; }
    S.handle = user; Store.set('handle', user);
    var btn = $('#sync'); btn.disabled = true;
    var orig = btn.textContent; btn.innerHTML = '<span class="spin"></span> Syncing';

    var days = 90;
    Promise.all([
      Data.fetchProfile(user).catch(function () { return null; }),
      Data.fetchGames({ user: user, days: days, max: 300, perfType: S.settings.perf || 'rapid' })
    ]).then(function (res) {
      var prof = res[0], games = res[1];
      if (!games.length) {
        flash('No rated ' + (S.settings.perf || 'rapid') + ' games found for <b>' + esc(user) +
              '</b> in the last ' + days + ' days. Try another time control in Settings, or import a PGN.', 'warn');
      }
      S.games = games;
      saveGames();
      var rating = prof && prof.perfs && prof.perfs[S.settings.perf || 'rapid']
        ? prof.perfs[S.settings.perf || 'rapid'].rating : null;
      Store.set('lichessRating', rating);
      rebuild(rating);
      var an = games.filter(function (g) { return g.analysed; }).length;
      flash('Loaded ' + games.length + ' games, ' + an + ' with server analysis.' +
        (an < games.length * 0.5 ? ' Games without analysis contribute to results but not to the error mining — request computer analysis on Lichess for the rest.' : ''),
        an ? '' : 'warn');
    }).catch(function (err) {
      flash('Could not reach Lichess: ' + esc(err.message) +
        ' If the browser is blocking the request, use <b>Import PGN</b> instead.', 'bad');
    }).finally(function () {
      btn.disabled = false; btn.textContent = orig;
    });
  }

  function rebuild(rating) {
    rating = rating !== undefined ? rating : Store.get('lichessRating', null);
    S.profile = Analysis.buildProfile(S.games, rating);
    S.book = Analysis.buildBook(S.games);
    var cards = Training.buildDeck(S.profile.errors, S.cardState);
    S.deck = {};
    cards.forEach(function (c) { S.deck[c.id] = c; });
    persistCards();
    recordSnapshot();
    renderRuler();
    renderStrength();
    renderCalendar();
    renderDrillHome();
    renderReviewHome();
  }

  function persistCards() {
    var slim = {};
    Object.keys(S.deck).forEach(function (k) {
      var c = S.deck[k];
      slim[k] = { id: c.id, ease: c.ease, interval: c.interval, reps: c.reps,
        lapses: c.lapses, due: c.due, last: c.last, history: c.history.slice(-10) };
    });
    S.cardState = slim;
    Store.set('cards', slim);
  }

  /* ---------- trajectory ----------
     Every sync leaves a dated mark. Over weeks these marks answer the only
     question that matters: is the measured strength moving, and how fast. */
  function recordSnapshot() {
    if (!S.profile || !S.profile.calibration) return;
    var cal = S.profile.calibration;
    if (!cal.sample) return;
    var track = Store.get('track', []);
    var day = new Date().toISOString().slice(0, 10);
    var entry = { day: day, measured: cal.trueStrength, moe: cal.marginOfError,
      rating: cal.lichessRating || null, acpl: cal.acpl || null, n: cal.sample };
    var last = track[track.length - 1];
    if (last && last.day === day) track[track.length - 1] = entry;
    else track.push(entry);
    if (track.length > 400) track = track.slice(-400);
    S.track = track;
    Store.set('track', track);
  }

  function daysBetween(a, b) {
    return (Date.parse(b) - Date.parse(a)) / 86400000;
  }

  /* Ordinary least squares on measured strength against elapsed days. */
  function trend(track) {
    if (track.length < 3) return null;
    var span = daysBetween(track[0].day, track[track.length - 1].day);
    if (span < 14) return null;
    var n = track.length, sx = 0, sy = 0, sxx = 0, sxy = 0;
    track.forEach(function (p) {
      var x = daysBetween(track[0].day, p.day), y = p.measured;
      sx += x; sy += y; sxx += x * x; sxy += x * y;
    });
    var denom = n * sxx - sx * sx;
    if (!denom) return null;
    var slope = (n * sxy - sx * sy) / denom;        // elo per day
    var intercept = (sy - slope * sx) / n;
    var fitted = intercept + slope * span;
    return { slope: slope, per30: slope * 30, span: span, fitted: fitted, n: n };
  }

  function trajectoryCard() {
    var track = S.track || Store.get('track', []);
    if (track.length < 2) {
      return '<p class="soft">One mark so far. Sync again after a week or two of play and this becomes a line: ' +
        'measured strength over time, next to the rating, with an estimate of when the two reach 2200. ' +
        'A single reading cannot tell you whether you are improving.</p>';
    }
    var lo = 1700, hi = 2300;
    track.forEach(function (p) {
      lo = Math.min(lo, p.measured - 60, p.rating ? p.rating - 60 : 9999);
      hi = Math.max(hi, p.measured + 60, p.rating ? p.rating + 60 : 0);
    });
    var W = 640, H = 190, padL = 46, padR = 12, padT = 12, padB = 24;
    var total = Math.max(1, daysBetween(track[0].day, track[track.length - 1].day));
    var X = function (d) { return padL + (daysBetween(track[0].day, d) / total) * (W - padL - padR); };
    var Y = function (v) { return padT + (1 - (v - lo) / (hi - lo)) * (H - padT - padB); };

    var s = ['<svg viewBox="0 0 ' + W + ' ' + H + '" class="traj" role="img" aria-label="Measured strength over time against the 2200 line">'];
    [1800, 1900, 2000, 2100, 2200, 2300].forEach(function (v) {
      if (v < lo || v > hi) return;
      var goal = v === 2200;
      s.push('<line x1="' + padL + '" y1="' + Y(v) + '" x2="' + (W - padR) + '" y2="' + Y(v) +
        '" stroke="' + (goal ? 'var(--blue)' : 'var(--rule)') + '" stroke-width="1"' +
        (goal ? ' stroke-dasharray="5 3"' : '') + '/>');
      s.push('<text x="' + (padL - 6) + '" y="' + (Y(v) + 3.5) + '" text-anchor="end" class="traj-lab">' + v + '</text>');
    });

    var ratePts = track.filter(function (p) { return p.rating; });
    if (ratePts.length > 1) {
      s.push('<polyline fill="none" stroke="var(--ink-faint)" stroke-width="1.5" stroke-dasharray="3 3" points="' +
        ratePts.map(function (p) { return X(p.day) + ',' + Y(p.rating); }).join(' ') + '"/>');
    }
    s.push('<polyline fill="none" stroke="var(--olive)" stroke-width="2" points="' +
      track.map(function (p) { return X(p.day) + ',' + Y(p.measured); }).join(' ') + '"/>');
    track.forEach(function (p) {
      s.push('<circle cx="' + X(p.day) + '" cy="' + Y(p.measured) + '" r="3" fill="var(--olive)"><title>' +
        p.day + ': ' + p.measured + ' ± ' + p.moe + ' from ' + p.n + ' games</title></circle>');
    });
    s.push('<text x="' + padL + '" y="' + (H - 6) + '" class="traj-lab">' + track[0].day + '</text>');
    s.push('<text x="' + (W - padR) + '" y="' + (H - 6) + '" text-anchor="end" class="traj-lab">' +
      track[track.length - 1].day + '</text>');
    s.push('</svg>');

    var t = trend(track), note;
    var cur = track[track.length - 1].measured;
    if (!t) {
      note = '<p class="soft tiny">Trend needs at least three marks spanning two weeks. ' +
        (track.length) + ' so far.</p>';
    } else if (t.per30 <= 1.5) {
      note = '<p>Over ' + Math.round(t.span) + ' days the measured strength is flat ' +
        '(' + (t.per30 >= 0 ? '+' : '') + t.per30.toFixed(0) + ' per month). ' +
        'Hours played are not the constraint. The drills below are aimed at the specific leak; ' +
        'volume without them will keep the line horizontal.</p>';
    } else {
      var need = 2200 - cur;
      var months = need / t.per30;
      note = '<p>Measured strength is rising about <b>' + t.per30.toFixed(0) + ' points a month</b> ' +
        'over the last ' + Math.round(t.span) + ' days. ' +
        (need <= 0
          ? 'You are already measuring at or above 2200; the rating should follow if you keep playing rated games.'
          : 'At that rate 2200 arrives in roughly <b>' + (months < 1 ? 'under a month' :
             months.toFixed(months < 3 ? 1 : 0) + ' months') + '</b> — around ' +
             new Date(Date.now() + months * 30 * 86400000).toISOString().slice(0, 7) + '. ') +
        '<span class="soft tiny">Extrapolation from ' + t.n + ' readings. Improvement is rarely linear; treat this as a direction, not a date.</span></p>';
    }
    var legend = '<p class="tiny soft"><span class="key olive"></span> measured strength' +
      (ratePts.length > 1 ? ' &nbsp; <span class="key faint"></span> Lichess rating' : '') +
      ' &nbsp; <span class="key blue"></span> Candidate Master line</p>';
    return s.join('') + legend + note;
  }

  /* ---------- strength ruler ---------- */
  function renderRuler() {
    var track = $('#ruler'); track.innerHTML = '';
    var lo = 1600, hi = 2400;
    var pos = function (r) { return Math.max(0, Math.min(100, (r - lo) / (hi - lo) * 100)); };

    for (var v = lo; v <= hi; v += 50) {
      var tick = document.createElement('div');
      tick.className = 'ruler-tick' + (v % 200 === 0 ? ' major' : '');
      tick.style.left = pos(v) + '%';
      track.appendChild(tick);
      if (v % 200 === 0) {
        var lab = document.createElement('div');
        lab.className = 'ruler-tick-label'; lab.style.left = pos(v) + '%'; lab.textContent = v;
        track.appendChild(lab);
      }
    }

    var cal = S.profile && S.profile.calibration;
    var goal = document.createElement('div');
    goal.className = 'ruler-pin goal'; goal.style.left = pos(2200) + '%';
    goal.innerHTML = '<div class="head">CM 2200</div><div class="stem"></div>';
    track.appendChild(goal);

    if (!cal) { $('#rulerCaption').innerHTML = '<span class="soft">Sync a Lichess account to measure your strength.</span>'; return; }

    if (cal.lichessRating) {
      var lp = document.createElement('div');
      lp.className = 'ruler-pin hollow'; lp.style.left = pos(cal.lichessRating) + '%';
      lp.innerHTML = '<div class="head">Lichess ' + cal.lichessRating + '</div><div class="stem"></div>';
      track.appendChild(lp);
    }
    var band = document.createElement('div');
    band.className = 'ruler-band';
    band.style.left = pos(cal.trueStrength - cal.marginOfError) + '%';
    band.style.width = (pos(cal.trueStrength + cal.marginOfError) - pos(cal.trueStrength - cal.marginOfError)) + '%';
    track.appendChild(band);

    var pin = document.createElement('div');
    pin.className = 'ruler-pin'; pin.style.left = '0%';
    pin.innerHTML = '<div class="head">Measured ' + cal.trueStrength + '</div><div class="stem"></div>';
    track.appendChild(pin);
    requestAnimationFrame(function () { pin.style.left = pos(cal.trueStrength) + '%'; });

    var gap = 2200 - cal.trueStrength;
    $('#rulerCaption').innerHTML =
      '<span>90-day window: <b>' + cal.windowGames + '</b> games</span>' +
      '<span>Performance rating: <b>' + (cal.performanceRating || '—') + '</b></span>' +
      '<span>Move quality: <b>' + (cal.moveQualityElo || '—') + '</b> at <b>' + (cal.acpl || '—') + '</b> acpl</span>' +
      '<span>' + (gap > 0 ? 'Gap to Candidate Master: <b>' + gap + '</b>' : 'Above the CM line on this measure') + '</span>';
  }

  /* ---------- strength panel ---------- */
  function renderStrength() {
    var host = $('#strengthBody');
    if (!S.profile) {
      host.innerHTML = '<div class="empty">Nothing measured yet. Enter a Lichess username or profile link above and choose <b>Sync games</b>. Everything is computed in this page; no data leaves your machine except the request to Lichess.</div>';
      return;
    }
    var p = S.profile, cal = p.calibration;
    var h = [];

    h.push('<div class="grid3">');
    h.push(calCard(cal));
    h.push(phaseCard(p));
    h.push(clockCard(p));
    h.push('</div>');

    h.push('<div class="grid2" style="margin-top:1.1rem">');
    h.push('<div class="sheet"><h3>What the mistakes have in common</h3><div class="tablewrap">' + motifTable(p) + '</div></div>');
    h.push('<div class="sheet"><h3>Openings by result and leakage</h3><div class="tablewrap">' + openingTable(p) + '</div></div>');
    h.push('</div>');

    h.push('<div class="sheet" style="margin-top:1.1rem"><h3>Opening tree — how the positions you reach tend to evolve</h3>' +
      '<p class="tiny soft">Move-by-move, both colours. Score is your result from that point on; the cp figure is the average evaluation swing over your next ten moves from there — the number that finds a structure you keep entering and then misplaying, as opposed to a bad opening move itself.</p>' +
      openingTree(p) + '</div>');
    h.push('<div class="sheet" style="margin-top:1.1rem"><h3>Trajectory towards 2200</h3>' + trajectoryCard() + '</div>');
    h.push('<div class="sheet" style="margin-top:1.1rem"><h3>Where in the game it goes wrong</h3>' + timingChart(p) + '</div>');
    h.push('<div class="sheet" style="margin-top:1.1rem"><h3>Your ten most expensive moves</h3><div class="tablewrap">' + worstTable(p) + '</div></div>');
    host.innerHTML = h.join('');
    $$('[data-jump]', host).forEach(function (b) {
      b.addEventListener('click', function () { openErrorInDrill(b.dataset.jump); });
    });
  }

  function calCard(cal) {
    var w = cal.weights;
    return '<div class="sheet"><h3>Calibrated strength</h3>' +
      '<p class="tiny soft">Blended from three estimates. Results carry the most weight once there are enough of them; move quality is steadier but blind to practical skill.</p>' +
      '<table><tbody>' +
      row('Measured strength', '<b>' + cal.trueStrength + ' ± ' + cal.marginOfError + '</b>') +
      row('Lichess rating', cal.lichessRating || '—') +
      row('90-day performance', (cal.performanceRating || '—') + (cal.avgOpp ? ' <span class="soft tiny">vs ' + cal.avgOpp + ' avg, ' + cal.scorePct + '%</span>' : '')) +
      row('Move-quality estimate', (cal.moveQualityElo || '—') + (cal.acpl ? ' <span class="soft tiny">' + cal.acpl + ' acpl</span>' : '')) +
      row('Weighting', '<span class="tiny mono">results ' + w.results + ' / quality ' + w.moveQuality + ' / anchor ' + w.anchor + '</span>') +
      row('Sample', cal.sample + ' rated, ' + cal.analysedSample + ' analysed') +
      '</tbody></table></div>';
  }
  function row(k, v) { return '<tr><td>' + k + '</td><td class="ta-right">' + v + '</td></tr>'; }

  function phaseCard(p) {
    var max = Math.max(1, Math.max(p.phases.opening.acplInPhase, p.phases.middlegame.acplInPhase, p.phases.endgame.acplInPhase));
    var h = '<div class="sheet"><h3>Cost by phase</h3><table><thead><tr><th>Phase</th><th class="num">acpl</th><th class="num">errors</th><th style="width:34%"></th></tr></thead><tbody>';
    ['opening', 'middlegame', 'endgame'].forEach(function (k) {
      var x = p.phases[k];
      h += '<tr><td>' + k + '</td><td class="num">' + x.acplInPhase + '</td><td class="num">' + x.errors + '</td>' +
        '<td><span class="bar ' + (x.acplInPhase === max ? 'red' : '') + '" style="width:' + Math.round(x.acplInPhase / max * 100) + '%"></span></td></tr>';
    });
    h += '</tbody></table><p class="tiny soft" style="margin-top:.5rem">Centipawns lost per move you made in that phase, so the phases are comparable even though they differ in length.</p></div>';
    return h;
  }

  function clockCard(p) {
    var c = p.clock;
    return '<div class="sheet"><h3>Clock</h3><table><tbody>' +
      row('Errors under time pressure', c.pressureRate == null ? '—' : c.pressureRate + '%') +
      row('Errors with clock data', c.withClockData) +
      row('Blunders', p.counts.blunders) +
      row('Mistakes', p.counts.mistakes) +
      row('Games analysed', p.counts.analysed + ' of ' + p.counts.games) +
      '</tbody></table>' +
      (c.pressureRate > 25 ? '<p class="tiny" style="color:var(--red);margin-top:.5rem">More than a quarter of your errors arrive with under fifteen percent of the clock. That is a time-management problem wearing a tactics costume.</p>' : '') +
      '</div>';
  }

  function motifTable(p) {
    var list = p.motifs.slice(0, 12);
    if (!list.length) return '<div class="empty">No classified errors yet. Error mining needs games with Lichess computer analysis.</div>';
    var max = list[0].cpLost || 1;
    var h = '<table><thead><tr><th>Pattern</th><th class="num">times</th><th class="num">avg cost</th><th style="width:28%"></th></tr></thead><tbody>';
    list.forEach(function (m) {
      h += '<tr><td>' + esc(m.motif) + (m.blunders ? ' <span class="tag red">' + m.blunders + ' blunders</span>' : '') + '</td>' +
        '<td class="num">' + m.count + '</td><td class="num">' + m.avgCost + '</td>' +
        '<td><span class="bar red" style="width:' + Math.round(m.cpLost / max * 100) + '%"></span></td></tr>';
    });
    return h + '</tbody></table>';
  }

  function openingTable(p) {
    if (!p.openings.length) return '<div class="empty">Not enough repeated openings yet.</div>';
    var h = '<table><thead><tr><th>Opening</th><th>as</th><th class="num">n</th><th class="num">score</th><th class="num">cp lost</th></tr></thead><tbody>';
    p.openings.slice(0, 12).forEach(function (o) {
      var bad = o.scorePct < 42;
      h += '<tr><td>' + esc(o.name) + '</td><td class="soft">' + (o.color === 'w' ? 'White' : 'Black') + '</td>' +
        '<td class="num">' + o.games + '</td>' +
        '<td class="num"' + (bad ? ' style="color:var(--red)"' : '') + '>' + o.scorePct + '%</td>' +
        '<td class="num">' + o.cpLost + '</td></tr>';
    });
    return h + '</tbody></table>';
  }

  // Renders p.openingTree (built in analysis.js's buildOpeningTree): a tree of
  // literal move sequences, each node showing how often you reached it, your
  // score from there, and the average eval swing over the following ten
  // moves. Not filtered to any specific opening — the busiest lines (usually
  // a player's actual repertoire, e.g. Caro-Kann / QGD) simply sort first,
  // since children are already frequency-sorted by buildOpeningTree.
  var OPENING_TREE_LEAK_CP = 50;      // highlight threshold for the eval-swing stat
  var OPENING_TREE_MAX_CHILDREN = 8;  // per level, so a wide root doesn't swamp the panel

  function openingTree(p) {
    var kids = (p.openingTree && p.openingTree.childList) || [];
    if (!kids.length) return '<div class="empty">Not enough repeated lines yet — needs a handful of analysed games sharing the same opening moves.</div>';
    return '<ul class="opening-tree">' + kids.slice(0, OPENING_TREE_MAX_CHILDREN).map(openingTreeNode).join('') + '</ul>';
  }

  function openingTreeNode(node) {
    var label = Math.ceil(node.ply / 2) + (node.ply % 2 === 1 ? '.' : '…');
    var scoreBad = node.scorePct < 42;
    var dropLabel, dropBad = false;
    if (node.evalDrop == null) {
      dropLabel = 'no eval data';
    } else if (node.evalDrop > 0) {
      dropLabel = '−' + node.evalDrop + ' cp/10mv';
      dropBad = node.evalDrop >= OPENING_TREE_LEAK_CP;
    } else {
      dropLabel = '+' + (-node.evalDrop) + ' cp/10mv';
    }
    var h = '<li><div class="node">' +
      '<span class="san">' + label + ' ' + esc(node.san) + '</span>' +
      '<span class="stat">' + node.games + ' games</span>' +
      '<span class="stat' + (scoreBad ? ' bad' : '') + '">' + node.scorePct + '% score</span>' +
      '<span class="stat' + (dropBad ? ' bad' : '') + '">' + dropLabel + '</span>' +
      '</div>';
    var kids = node.childList || [];
    if (kids.length) h += '<ul>' + kids.slice(0, OPENING_TREE_MAX_CHILDREN).map(openingTreeNode).join('') + '</ul>';
    return h + '</li>';
  }

  function timingChart(p) {
    var b = p.errorTiming, max = Math.max(1, Math.max.apply(null, b));
    var labels = ['first fifth', 'second', 'middle', 'fourth', 'final fifth'];
    var h = '<table><tbody>';
    b.forEach(function (v, i) {
      h += '<tr><td style="width:9rem">' + labels[i] + '</td><td class="num" style="width:3rem">' + v + '</td>' +
        '<td><span class="bar ' + (v === max ? 'red' : '') + '" style="width:' + Math.round(v / max * 100) + '%"></span></td></tr>';
    });
    return h + '</tbody></table>';
  }

  function worstTable(p) {
    var list = p.errors.slice(0, 10);
    if (!list.length) return '<div class="empty">No errors mined. Request computer analysis on a few Lichess games and sync again.</div>';
    var h = '<table><thead><tr><th>Game</th><th>Move</th><th>Played</th><th>Best</th><th class="num">cost</th><th>Pattern</th><th></th></tr></thead><tbody>';
    list.forEach(function (e) {
      h += '<tr><td class="tiny">' + new Date(e.date).toLocaleDateString() +
        (e.gameUrl ? ' <a href="' + esc(e.gameUrl) + '" target="_blank" rel="noopener">↗</a>' : '') + '</td>' +
        '<td class="mono tiny">' + e.moveNo + (e.myColor === 'w' ? '.' : '…') + '</td>' +
        '<td class="mono" style="color:var(--red)">' + esc(e.played) + '</td>' +
        '<td class="mono" style="color:var(--olive)">' + esc(e.best || '—') + '</td>' +
        '<td class="num">' + (e.cpLoss / 100).toFixed(1) + '</td>' +
        '<td class="tiny">' + e.motifs.slice(0, 2).map(function (m) { return '<span class="tag">' + esc(m) + '</span>'; }).join('') + '</td>' +
        '<td><button class="quiet" data-jump="' + esc(e.key) + '">Drill</button></td></tr>';
    });
    return h + '</tbody></table>';
  }

  /* ---------- sparring ---------- */
  var sparBoard = null;
  function initSparring() {
    sparBoard = new Board($('#sparBoard'), boardOpts({
      onMove: onSparMove,
      allowedColor: 'w'
    }));
    $('#sparStart').addEventListener('click', function () { startSpar($('#sparColor').value); });
    $('#sparFlip').addEventListener('click', function () { sparBoard.flip(); });
    $('#sparHint').addEventListener('click', function () { refreshAdvice(true); });
    $('#sparTakeback').addEventListener('click', takeback);
    $('#sparResign').addEventListener('click', function () { if (S.spar) endSpar('You resigned.'); });
  }

  function startSpar(color) {
    if (!S.profile) { flash('Sync your games first — the opponent is built from them.', 'warn'); return; }
    var myColor = color === 'random' ? (Math.random() < 0.5 ? 'w' : 'b') : color;
    S.spar = {
      game: new Chess(),
      myColor: myColor,
      mirror: new Sparring.Mirror(S.profile, {
        book: S.book,
        targetElo: +$('#sparElo').value || S.profile.calibration.trueStrength,
        budgetMs: +$('#sparThink').value || 900
      }),
      history: [], advice: null, thinking: false, over: false
    };
    sparBoard.allowedColor = myColor;
    sparBoard.flipped = myColor === 'b';
    sparBoard.setGame(S.spar.game);
    $('#sparStatus').textContent = 'Playing as ' + (myColor === 'w' ? 'White' : 'Black') +
      ' against your mirror at ' + S.spar.mirror.targetElo + '.';
    renderSparMoves();
    if (myColor === 'b') setTimeout(mirrorMove, 250);
    else refreshAdvice();
  }

  function onSparMove(move, game) {
    if (!S.spar || S.spar.thinking || S.spar.over) return;
    var san = game.san(move);
    game.makeMove(move);
    S.spar.history.push({ san: san, color: move.color === Chess.WHITE ? 'w' : 'b' });
    sparBoard.setGame(game, { from: move.fromSq, to: move.toSq });
    renderSparMoves();
    if (checkSparEnd()) return;
    setTimeout(mirrorMove, 120);
  }

  function mirrorMove() {
    var sp = S.spar;
    if (!sp || sp.over) return;
    sp.thinking = true;
    $('#sparStatus').innerHTML = '<span class="spin"></span> Your mirror is thinking.';
    sp.mirror.chooseMove(sp.game, sp.history.length + 1).then(function (res) {
      sp.thinking = false;
      if (!res) { checkSparEnd(); return; }
      var san = res.san || sp.game.san(res.move);
      sp.game.makeMove(res.move);
      sp.history.push({ san: san, color: res.move.color === Chess.WHITE ? 'w' : 'b',
        fromBook: res.fromBook, loss: res.intendedLoss, blunderTurn: res.blunderTurn });
      sparBoard.setGame(sp.game, { from: res.move.fromSq, to: res.move.toSq });
      renderSparMoves();
      $('#sparStatus').textContent = res.fromBook ? res.note :
        'Played ' + san + (res.blunderTurn ? ' — and that one was a deliberate lapse, at the rate you lapse.' :
          res.intendedLoss > 60 ? ' (giving up ' + res.intendedLoss + ' centipawns, within your own error band)' : '');
      if (checkSparEnd()) return;
      refreshAdvice();
    });
  }

  function takeback() {
    var sp = S.spar; if (!sp || sp.thinking) return;
    for (var i = 0; i < 2 && sp.history.length; i++) { sp.game.undoMove(); sp.history.pop(); }
    sp.over = false;
    sparBoard.setGame(sp.game);
    renderSparMoves(); refreshAdvice();
  }

  function checkSparEnd() {
    var sp = S.spar, over = sp.game.gameOver();
    if (!over) return false;
    var msg = over === 'checkmate'
      ? (sp.game.turnColor() === sp.myColor ? 'Checkmate. You lost.' : 'Checkmate. You won.')
      : over === 'stalemate' ? 'Stalemate.' : over === 'fifty' ? 'Drawn by the fifty-move rule.' : 'Drawn, insufficient material.';
    endSpar(msg);
    return true;
  }

  function endSpar(msg) {
    S.spar.over = true;
    $('#sparStatus').textContent = msg + ' Export the game to review it in the Review tab.';
    sparBoard.interactive = false;
  }

  function renderSparMoves() {
    var sp = S.spar; if (!sp) return;
    var h = '';
    sp.history.forEach(function (m, i) {
      if (i % 2 === 0) h += '<span class="num">' + (i / 2 + 1) + '.</span> ';
      h += '<button' + (m.blunderTurn ? ' class="blunder"' : m.fromBook ? ' class="inacc"' : '') + '>' + esc(m.san) + '</button> ';
    });
    $('#sparMoves').innerHTML = h || '<span class="soft">No moves yet.</span>';
    $('#sparPgn').value = sp.history.map(function (m, i) {
      return (i % 2 === 0 ? (i / 2 + 1) + '. ' : '') + m.san;
    }).join(' ');
  }

  function refreshAdvice(force) {
    var sp = S.spar;
    if (!sp || sp.over) return;
    if (!force && !$('#sparCoach').checked) { $('#sparAdvice').innerHTML = '<p class="soft tiny">Live advice is off. Turn it on above, or ask for a single hint.</p>'; return; }
    $('#sparAdvice').innerHTML = '<p class="soft tiny"><span class="spin"></span> Reading the position for both sides.</p>';
    Sparring.dualAdvice(S.engine, sp.game, { depth: 3, budget: 800 }).then(function (adv) {
      sp.advice = adv;
      renderAdvice(adv);
    });
  }

  function renderAdvice(adv) {
    function col(side, label) {
      var list = adv[side], isMover = adv.sideToMove === (side === 'white' ? 'w' : 'b');
      var h = '<div class="side"><div class="side-head"><h4>' + label + '</h4>' +
        (isMover ? '<span class="tomove">to move</span>' : '') + '</div>';
      if (!list || !list.length) { h += '<p class="tiny soft">No candidates.</p></div>'; return h; }
      list.forEach(function (c, i) {
        h += '<div class="cand' + (i === 0 ? ' top' : '') + '"><span class="mv">' + esc(c.san) + '</span>' +
          '<span class="cp">' + Sparring.cpDisplay(side === 'white' ? (adv.sideToMove === 'w' ? c.cp : -c.cp) : (adv.sideToMove === 'b' ? c.cp : -c.cp), true) + '</span>' +
          (c.delta ? '<span class="dl">−' + c.delta + '</span>' : '') + '</div>';
      });
      return h + '</div>';
    }
    var pct = Math.max(2, Math.min(98, 50 + adv.evalCp / 16));
    $('#sparAdvice').innerHTML =
      '<div class="sides">' + col('white', 'White') + col('black', 'Black') + '</div>' +
      '<div class="evalbar" title="white advantage"><i style="width:' + pct + '%"></i></div>' +
      '<p class="tiny soft" style="margin-top:.5rem">Sharpness ' + adv.complexity + '/100. ' +
      (adv.onlyMove ? '<b>' + esc(adv.onlyMove) + '</b> looks like the only move. ' : '') +
      (adv.threatNote ? esc(adv.threatNote) : '') + '</p>';
  }

  /* ---------- drills ---------- */
  function renderDrillHome() {
    var host = $('#drillHome');
    if (!S.profile) { host.innerHTML = '<div class="empty">Drills are built from your own mistakes. Sync first.</div>'; return; }
    var all = Object.keys(S.deck).map(function (k) { return S.deck[k]; });
    var due = Training.dueCards(all);
    var motifs = {};
    all.forEach(function (c) { (c.meta.motifs || []).forEach(function (m) { motifs[m] = (motifs[m] || 0) + 1; }); });
    var h = '<div class="row" style="margin-bottom:.8rem">' +
      '<button class="primary" data-start="due">Start today\'s recall (' + due.length + ')</button>' +
      '<button data-start="all">Everything (' + all.length + ')</button>' +
      '<select id="drillMotif"><option value="">Filter by pattern</option>' +
      Object.keys(motifs).sort(function (a, b) { return motifs[b] - motifs[a]; }).map(function (m) {
        return '<option value="' + esc(m) + '">' + esc(m) + ' (' + motifs[m] + ')</option>';
      }).join('') + '</select>' +
      '<button data-start="motif">Drill that pattern</button>' +
      '<span style="flex:1"></span>' +
      '<select id="egPick">' + Training.ENDGAMES.map(function (e) {
        return '<option value="' + e.id + '"' + (e.fen ? '' : ' disabled') + '>' + esc(e.name) + (e.fen ? '' : ' (reading only)') + '</option>';
      }).join('') + '</select><button data-start="endgame">Set up endgame</button>' +
      '</div>';
    if (!all.length) h += '<div class="empty">No puzzles yet. They are generated from positions where you lost 80 centipawns or more, so you need games with Lichess computer analysis.</div>';
    host.innerHTML = h;
    $$('[data-start]', host).forEach(function (b) {
      b.addEventListener('click', function () { startDrill(b.dataset.start); });
    });
  }

  var drillBoard = null;
  function startDrill(mode) {
    var all = Object.keys(S.deck).map(function (k) { return S.deck[k]; });
    var queue;
    if (mode === 'endgame') { startEndgame($('#egPick').value); return; }
    if (mode === 'due') queue = Training.dueCards(all).slice(0, 25);
    else if (mode === 'motif') {
      var m = $('#drillMotif').value;
      queue = all.filter(function (c) { return (c.meta.motifs || []).indexOf(m) > -1; });
    } else queue = all.slice(0, 40);
    if (!queue.length) { flash('Nothing in that queue right now.', 'warn'); return; }
    S.drill = { queue: queue, index: 0, revealed: false, attempts: 0 };
    $('#drillHome').classList.add('hidden');
    $('#drillStage').classList.remove('hidden');
    if (!drillBoard) drillBoard = new Board($('#drillBoard'), boardOpts({ onMove: onDrillMove }));
    showCard();
  }

  function showCard() {
    var d = S.drill, c = d.queue[d.index];
    if (!c) { finishDrill(); return; }
    d.revealed = false; d.attempts = 0;
    var g = new Chess(c.meta.fen);
    drillBoard.allowedColor = g.turnColor();
    drillBoard.flipped = g.turnColor() === 'b';
    drillBoard.interactive = true;
    drillBoard.setGame(g);
    $('#drillProgress').textContent = (d.index + 1) + ' of ' + d.queue.length;
    $('#drillPrompt').innerHTML =
      '<h3>' + (g.turnColor() === 'w' ? 'White' : 'Black') + ' to move. Find what you missed.</h3>' +
      '<p class="tiny soft">Your game, move ' + c.meta.moveNo + ', ' + new Date(c.meta.date).toLocaleDateString() +
      (c.meta.opening ? ' · ' + esc(c.meta.opening) : '') + '. You played <span class="mono" style="color:var(--red)">' + esc(c.meta.played) + '</span> here and it cost ' +
      (c.meta.cpLoss / 100).toFixed(1) + ' pawns.' + (c.meta.timePressure ? ' You were short of time.' : '') + '</p>' +
      '<p>' + (c.meta.motifs || []).map(function (m) { return '<span class="tag">' + esc(m) + '</span>'; }).join('') + '</p>';
    $('#drillFeedback').innerHTML = '';
    $('#drillGrades').classList.add('hidden');
    $('#drillReveal').classList.remove('hidden');
  }

  function onDrillMove(move, game) {
    var d = S.drill, c = d.queue[d.index];
    var san = game.san(move).replace(/[+#]/g, '');
    var want = String(c.meta.solution || '').replace(/[+#!?]/g, '');
    d.attempts++;
    if (san === want) {
      game.makeMove(move);
      drillBoard.interactive = false;
      drillBoard.setGame(game, { from: move.fromSq, to: move.toSq });
      $('#drillFeedback').innerHTML = '<div class="coach-note ok">Correct: <b class="mono">' + esc(c.meta.solution) + '</b>. ' +
        (c.meta.line ? 'The line continues <span class="mono">' + esc(c.meta.line) + '</span>.' : '') + '</div>';
      revealGrades(d.attempts === 1 ? 3 : 2);
    } else {
      drillBoard.setGame(game);
      $('#drillFeedback').innerHTML = '<div class="coach-note">Not ' + esc(san) + '. ' +
        (d.attempts >= 2 ? 'Look at what your opponent is allowed to do after it.' : 'Try again — or reveal, and lose the card\'s interval.') + '</div>';
    }
  }

  function revealGrades(suggested) {
    S.drill.revealed = true;
    $('#drillReveal').classList.add('hidden');
    var g = $('#drillGrades');
    g.classList.remove('hidden');
    g.dataset.suggested = suggested;
  }

  function initDrillControls() {
    $('#drillReveal').addEventListener('click', function () {
      var c = S.drill.queue[S.drill.index];
      var g = new Chess(c.meta.fen);
      var mv = g.moveFromSan(c.meta.solution);
      if (mv) { g.makeMove(mv); drillBoard.setGame(g, { from: mv.fromSq, to: mv.toSq }); }
      drillBoard.interactive = false;
      $('#drillFeedback').innerHTML = '<div class="coach-note">The move was <b class="mono">' + esc(c.meta.solution) + '</b>. ' +
        (c.meta.line ? '<span class="mono">' + esc(c.meta.line) + '</span>' : '') + '</div>';
      revealGrades(0);
    });
    $$('[data-grade]').forEach(function (b) {
      b.addEventListener('click', function () {
        var d = S.drill, c = d.queue[d.index];
        Training.review(S.deck[c.id] || c, +b.dataset.grade);
        persistCards();
        d.index++;
        showCard();
      });
    });
    $('#drillQuit').addEventListener('click', finishDrill);
  }

  function finishDrill() {
    $('#drillStage').classList.add('hidden');
    $('#drillHome').classList.remove('hidden');
    renderDrillHome();
    markDone('drill');
  }

  function startEndgame(id) {
    var eg = Training.ENDGAMES.filter(function (e) { return e.id === id; })[0];
    if (!eg || !eg.fen) { flash('That entry is a concept to read, not a position to play.', 'warn'); return; }
    S.drill = { queue: [], index: 0, endgame: eg };
    $('#drillHome').classList.add('hidden');
    $('#drillStage').classList.remove('hidden');
    if (!drillBoard) drillBoard = new Board($('#drillBoard'), boardOpts({ onMove: onEndgameMove }));
    var g = new Chess(eg.fen);
    drillBoard.opts.onMove = onEndgameMove;
    drillBoard.allowedColor = g.turnColor();
    drillBoard.flipped = g.turnColor() === 'b';
    drillBoard.interactive = true;
    drillBoard.setGame(g);
    $('#drillProgress').textContent = 'Endgame study';
    $('#drillPrompt').innerHTML = '<h3>' + esc(eg.name) + '</h3><p>' + esc(eg.goal) + '</p>' +
      '<p class="tiny soft">' + esc(eg.idea) + '</p>' +
      '<p class="tiny soft">Play it out against the engine. It will answer at full strength here — theory is where approximations are useless.</p>';
    $('#drillFeedback').innerHTML = '';
    $('#drillGrades').classList.add('hidden');
    $('#drillReveal').classList.add('hidden');
  }

  function onEndgameMove(move, game) {
    game.makeMove(move);
    drillBoard.setGame(game, { from: move.fromSq, to: move.toSq });
    var over = game.gameOver();
    if (over) { $('#drillFeedback').innerHTML = '<div class="coach-note ok">' + over + '.</div>'; return; }
    $('#drillFeedback').innerHTML = '<span class="spin"></span> Engine replying.';
    S.engine.rankAsync(game, 4, 1400).then(function (r) {
      if (!r.length) return;
      game.makeMove(r[0].move);
      drillBoard.setGame(game, { from: r[0].move.fromSq, to: r[0].move.toSq });
      var o = game.gameOver();
      $('#drillFeedback').innerHTML = o ? '<div class="coach-note ok">' + o + '.</div>' :
        '<div class="coach-note">Engine plays <b class="mono">' + esc(r[0].san) + '</b>. Evaluation ' + Sparring.cpDisplay(game.turnColor() === 'w' ? r[0].score : -r[0].score, true) + '.</div>';
    });
  }

  function openErrorInDrill(key) {
    var c = S.deck[key];
    if (!c) { flash('That position has no known refutation stored, so it cannot be a puzzle.', 'warn'); return; }
    selectTab('drills');
    S.drill = { queue: [c], index: 0 };
    $('#drillHome').classList.add('hidden');
    $('#drillStage').classList.remove('hidden');
    if (!drillBoard) drillBoard = new Board($('#drillBoard'), boardOpts({ onMove: onDrillMove }));
    drillBoard.opts.onMove = onDrillMove;
    showCard();
  }

  /* ---------- calendar ---------- */
  function renderCalendar() {
    var host = $('#calBody');
    if (!S.profile) { host.innerHTML = '<div class="empty">The schedule is generated from your blind spots. Sync first.</div>'; return; }
    var deck = Object.keys(S.deck).map(function (k) { return S.deck[k]; });
    var start = new Date(); start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - start.getDay());
    var plans = Training.planRange(start, 28, S.profile, deck,
      { minutesBudget: +S.settings.minutes, endgameTier: +S.settings.endgameTier });
    S.plans = plans;

    var todayKey = Training.dateKey(new Date());
    var h = '<div class="grid2" style="grid-template-columns:2fr 1fr;align-items:start">';
    h += '<div><div class="row" style="margin-bottom:.5rem"><h3 style="margin:0">Next four weeks</h3>' +
      '<span style="flex:1"></span><button id="icsBtn">Download .ics</button></div><div class="calgrid">';
    ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].forEach(function (d) {
      h += '<div class="tiny soft" style="text-align:center">' + d + '</div>';
    });
    plans.forEach(function (p) {
      var done = S.completed[p.date];
      h += '<button class="day' + (p.date === todayKey ? ' today' : '') + (done ? ' done' : '') + '" data-day="' + p.date + '">' +
        '<span class="dnum">' + p.date.slice(5) + '</span><ul>' +
        p.items.map(function (i) { return '<li class="' + i.type + '">' + esc(i.label.split(' — ')[0]) + '</li>'; }).join('') +
        '</ul></button>';
    });
    h += '</div></div>';

    var today = plans.filter(function (p) { return p.date === todayKey; })[0] || plans[0];
    h += '<div id="dayDetail">' + dayDetail(today) + '</div>';
    h += '</div>';
    host.innerHTML = h;

    $('#icsBtn').addEventListener('click', function () {
      var ics = Training.toICS(plans, { hour: +S.settings.hour });
      download('dvoretsky-lab-' + todayKey + '.ics', ics, 'text/calendar');
    });
    $$('[data-day]', host).forEach(function (b) {
      b.addEventListener('click', function () {
        var p = plans.filter(function (x) { return x.date === b.dataset.day; })[0];
        $('#dayDetail').innerHTML = dayDetail(p);
        bindDayDetail(p);
      });
    });
    bindDayDetail(today);
  }

  function dayDetail(p) {
    if (!p) return '';
    var h = '<div class="sheet"><h3>' + p.weekday + ' ' + p.date + '</h3>' +
      '<p class="tiny soft">' + p.totalMinutes + ' minutes planned' +
      (S.completed[p.date] ? ' · logged as done' : '') + '</p>';
    p.items.forEach(function (i) {
      h += '<div class="block ' + i.type + '"><h4>' + esc(i.label) + '</h4>' +
        '<p>' + esc(i.note) + (i.count ? ' <span class="mono">' + i.count + ' positions</span>' : '') + '</p>' +
        (i.type === 'recall' && i.count ? '<button class="quiet" data-run="due">Run it</button>' : '') +
        (i.type === 'motif' && i.payload.motif ? '<button class="quiet" data-run="motif" data-motif="' + esc(i.payload.motif) + '">Run it</button>' : '') +
        (i.type === 'calculation' && i.count ? '<button class="quiet" data-run="calc">Run it</button>' : '') +
        (i.type === 'endgame' ? '<button class="quiet" data-run="eg" data-eg="' + esc(i.payload.endgameId) + '">Set up</button>' : '') +
        (i.type === 'sparring' ? '<button class="quiet" data-run="spar" data-color="' + i.payload.color + '">Play</button>' : '') +
        (i.type === 'review' ? '<button class="quiet" data-run="review">Open review</button>' : '') +
        '</div>';
    });
    h += '<button id="markDone">' + (S.completed[p.date] ? 'Unmark' : 'Mark the day done') + '</button></div>';
    return h;
  }

  function bindDayDetail(p) {
    var host = $('#dayDetail'); if (!host || !p) return;
    $$('[data-run]', host).forEach(function (b) {
      b.addEventListener('click', function () {
        var r = b.dataset.run;
        if (r === 'due') { selectTab('drills'); startDrill('due'); }
        if (r === 'motif') { selectTab('drills'); renderDrillHome(); $('#drillMotif').value = b.dataset.motif; startDrill('motif'); }
        if (r === 'calc') { selectTab('drills'); startDrill('all'); }
        if (r === 'eg') { selectTab('drills'); renderDrillHome(); startEndgame(b.dataset.eg); }
        if (r === 'spar') { selectTab('sparring'); $('#sparColor').value = b.dataset.color; startSpar(b.dataset.color); }
        if (r === 'review') selectTab('review');
      });
    });
    var md = $('#markDone', host);
    if (md) md.addEventListener('click', function () {
      if (S.completed[p.date]) delete S.completed[p.date]; else S.completed[p.date] = Date.now();
      Store.set('completed', S.completed);
      renderCalendar();
    });
  }

  function markDone(kind) {
    var k = Training.dateKey(new Date());
    S.completed[k] = Date.now();
    Store.set('completed', S.completed);
  }

  /* ---------- review (justification transcript) ---------- */
  var revBoard = null;
  function renderReviewHome() {
    var sel = $('#revGame');
    if (!S.games.length) { sel.innerHTML = '<option>No games loaded</option>'; return; }
    sel.innerHTML = S.games.slice(0, 60).map(function (g, i) {
      var done = S.transcripts[g.id] ? ' ✓' : '';
      return '<option value="' + i + '">' + new Date(g.date).toLocaleDateString() + ' · ' +
        (g.myColor === 'w' ? 'W' : 'B') + ' vs ' + esc(g.oppName) + ' (' + (g.oppRating || '?') + ') · ' +
        g.result + ' · ' + esc((g.openingName || '').slice(0, 34)) + done + '</option>';
    }).join('');
  }

  function startReview() {
    var idx = +$('#revGame').value;
    var game = S.games[idx];
    if (!game) return;
    var myPlies = game.moves.map(function (m, i) { return m.color === game.myColor ? i : -1; })
      .filter(function (i) { return i >= 0; });
    S.review = {
      game: game, plies: myPlies, cursor: 0,
      transcript: S.transcripts[game.id] || {},
      errors: (S.profile ? S.profile.errors : []).filter(function (e) { return e.gameId === game.id; })
    };
    $('#revStage').classList.remove('hidden');
    if (!revBoard) revBoard = new Board($('#revBoard'), boardOpts({ interactive: false }));
    revBoard.flipped = game.myColor === 'b';
    renderReviewStep();
  }

  function renderReviewStep() {
    var r = S.review;
    if (!r) return;
    if (r.cursor >= r.plies.length) { finishReview(); return; }
    var ply = r.plies[r.cursor];
    var mv = r.game.moves[ply];
    revBoard.setFen(mv.fenBefore);
    var err = r.errors.filter(function (e) { return e.ply === ply + 1; })[0];
    r.current = { ply: ply, mv: mv, err: err };

    $('#revProgress').textContent = 'Move ' + Math.ceil((ply + 1) / 2) + ' · ' + (r.cursor + 1) + ' of ' + r.plies.length;
    $('#revPrompt').innerHTML = '<h3>You are about to play your ' + ordinal(r.cursor + 1) + ' move.</h3>' +
      '<p class="tiny soft">Do not scroll ahead. Write what you calculated: your candidate moves, the lines, what your opponent was threatening, and your evaluation at the end of the line.</p>';
    var prior = r.transcript[ply];
    $('#revText').value = prior ? prior.text : '';
    $('#revFeedback').innerHTML = prior ? renderFeedback(prior) : '';
    $('#revMoves').innerHTML = moveListHtml(r.game, ply);
  }

  function ordinal(n) {
    var s = ['th', 'st', 'nd', 'rd'], v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  }

  function moveListHtml(game, uptoPly) {
    var h = '';
    game.moves.forEach(function (m, i) {
      if (i > uptoPly) return;
      if (m.color === 'w') h += '<span class="num">' + Math.ceil((i + 1) / 2) + '.</span> ';
      var cls = m.judgment === 'Blunder' ? 'blunder' : m.judgment === 'Mistake' ? 'mistake' : m.judgment === 'Inaccuracy' ? 'inacc' : '';
      h += '<button class="' + cls + '"' + (i === uptoPly ? ' aria-current="true"' : '') + '>' + esc(m.san) + '</button> ';
    });
    return h || '<span class="soft">Start of game.</span>';
  }

  function submitJustification() {
    var r = S.review; if (!r || !r.current) return;
    var text = $('#revText').value;
    var c = r.current;
    var ctx = {
      best: c.err ? c.err.best : null,
      cpLoss: c.err ? c.err.cpLoss : 0,
      refutation: c.err && c.err.line ? String(c.err.line).split(/\s+/)[1] : null
    };
    var score = Coach.scoreJustification(text, ctx);
    var entry = { text: text, san: c.mv.san, score: score, cpLoss: ctx.cpLoss, best: ctx.best, at: Date.now() };
    entry.notes = Coach.respond(entry, ctx);
    r.transcript[c.ply] = entry;
    S.transcripts[r.game.id] = r.transcript;
    Store.set('transcripts', S.transcripts);
    $('#revFeedback').innerHTML = renderFeedback(entry);
    var g = new Chess(c.mv.fenBefore);
    var mv = g.moveFromSan(c.mv.san);
    if (mv) { g.makeMove(mv); revBoard.setFen(g.fen(), { from: mv.fromSq, to: mv.toSq }); }
  }

  function renderFeedback(entry) {
    var s = entry.score;
    var h = '<div class="sheet" style="margin-top:.6rem">';
    h += '<div class="row tiny mono" style="gap:1rem;margin-bottom:.4rem">' +
      '<span>concrete ' + s.concreteness + '</span><span>candidates ' + s.candidates + '</span>' +
      '<span>opponent ' + s.opponentAwareness + '</span><span>evaluation ' + s.evaluation + '</span>' +
      '<span>' + s.lines + ' variations</span></div>';
    entry.notes.forEach(function (n) {
      h += '<div class="coach-note' + (entry.cpLoss < 30 ? ' ok' : '') + '">' + esc(n) + '</div>';
    });
    if (entry.cpLoss >= 80) {
      h += '<p class="tiny">You played <span class="mono" style="color:var(--red)">' + esc(entry.san) + '</span>' +
        (entry.best ? ', the engine wanted <span class="mono" style="color:var(--olive)">' + esc(entry.best) + '</span>' : '') +
        ', cost ' + (entry.cpLoss / 100).toFixed(1) + ' pawns.</p>';
    } else {
      h += '<p class="tiny">You played <span class="mono">' + esc(entry.san) + '</span>. The engine has no complaint about the move.</p>';
    }
    return h + '</div>';
  }

  function finishReview() {
    var r = S.review;
    var summary = Coach.summarizeGame(r.game, r.transcript, S.profile ? S.profile.errors : [], S.profile);
    var h = '<div class="sheet"><h3>Session summary</h3>';
    summary.narrative.forEach(function (n) { h += '<p>' + esc(n) + '</p>'; });
    h += '<h4 style="margin-top:.9rem">Homework</h4><ul>';
    summary.homework.forEach(function (x) { h += '<li>' + esc(x) + '</li>'; });
    h += '</ul>';
    h += '<div class="row" style="margin-top:.8rem"><button id="llmBtn">Ask the coach for a written verdict</button>' +
      '<button id="revRestart">Review another game</button></div>';
    h += '<div id="llmOut"></div></div>';
    $('#revPrompt').innerHTML = '<h3>Game complete.</h3>';
    $('#revFeedback').innerHTML = h;
    $('#revText').value = ''; $('#revText').disabled = true;
    $('#llmBtn').addEventListener('click', function () { askLLM(r, summary); });
    $('#revRestart').addEventListener('click', function () {
      $('#revText').disabled = false; S.review = null; $('#revStage').classList.add('hidden'); renderReviewHome();
    });
  }

  function askLLM(r, summary) {
    var prompt = Coach.buildPrompt(r.game, r.transcript, summary, S.profile);
    var out = $('#llmOut');
    if (!S.settings.apiKey) {
      out.innerHTML = '<div class="notice warn" style="margin-top:.7rem">No API key set, so here is the prompt instead. Paste it into any assistant.' +
        '<textarea rows="10" style="margin-top:.5rem">' + esc(prompt) + '</textarea></div>';
      return;
    }
    out.innerHTML = '<p class="tiny soft"><span class="spin"></span> Writing.</p>';
    Coach.callLLM(prompt, { apiKey: S.settings.apiKey, model: S.settings.model })
      .then(function (text) {
        out.innerHTML = '<div class="notice" style="margin-top:.7rem;white-space:pre-wrap">' + esc(text) + '</div>';
      })
      .catch(function (e) { out.innerHTML = '<div class="notice bad">' + esc(e.message) + '</div>'; });
  }

  /* ---------- scout any profile ---------- */
  function scout() {
    var user = Data.parseHandle($('#scoutHandle').value);
    if (!user) { flash('Paste a Lichess profile link or username to scout.', 'bad'); return; }
    var out = $('#scoutOut');
    out.innerHTML = '<p class="soft"><span class="spin"></span> Reading ' + esc(user) + '.</p>';
    Promise.all([
      Data.fetchProfile(user).catch(function () { return null; }),
      Data.fetchGames({ user: user, days: 90, max: 200, perfType: $('#scoutPerf').value })
    ]).then(function (res) {
      var prof = res[0], games = res[1];
      if (!games.length) { out.innerHTML = '<div class="empty">No rated games for ' + esc(user) + ' in that time control in the last 90 days.</div>'; return; }
      var perfKey = $('#scoutPerf').value;
      var rating = prof && prof.perfs && prof.perfs[perfKey] ? prof.perfs[perfKey].rating : null;
      var p = Analysis.buildProfile(games, rating);
      S.scout = { user: user, profile: p };
      out.innerHTML = scoutReport(user, p);
    }).catch(function (e) {
      out.innerHTML = '<div class="notice bad">' + esc(e.message) + '</div>';
    });
  }

  function scoutReport(user, p) {
    var cal = p.calibration;
    var top = p.motifs.filter(function (m) { return m.motif !== 'positional' && m.motif !== 'unclassified'; }).slice(0, 4);
    var worstPhase = ['opening', 'middlegame', 'endgame'].sort(function (a, b) {
      return p.phases[b].acplInPhase - p.phases[a].acplInPhase; })[0];
    var weakOpenings = p.openings.filter(function (o) { return o.games >= 3 && o.scorePct < 45; }).slice(0, 3);

    var h = '<div class="sheet"><h3>' + esc(user) + '</h3>' +
      '<p>Measured at <b>' + cal.trueStrength + ' ± ' + cal.marginOfError + '</b>' +
      (cal.lichessRating ? ' against a listed rating of ' + cal.lichessRating : '') +
      ', from ' + cal.windowGames + ' games in the last 90 days' +
      (cal.analysedSample ? ' (' + cal.analysedSample + ' with engine analysis)' : '') + '.</p>';
    h += '<p>Most expensive phase: <b>' + worstPhase + '</b> at ' + p.phases[worstPhase].acplInPhase + ' centipawns lost per move.</p>';
    if (top.length) {
      h += '<p>Recurring weaknesses: ' + top.map(function (m) {
        return '<span class="tag red">' + esc(m.motif) + ' ×' + m.count + '</span>'; }).join(' ') + '</p>';
    }
    if (weakOpenings.length) {
      h += '<p>Openings under water: ' + weakOpenings.map(function (o) {
        return esc(o.name) + ' as ' + (o.color === 'w' ? 'White' : 'Black') + ' (' + o.scorePct + '%)'; }).join('; ') + '.</p>';
    }
    if (p.clock.pressureRate > 25) h += '<p>' + p.clock.pressureRate + '% of their errors come with under fifteen percent of the clock left.</p>';
    h += '<h4 style="margin-top:.8rem">What this player should work on</h4><ol>';
    if (top[0]) h += '<li>Pattern work on ' + esc(top[0].motif) + ', which alone has cost ' + Math.round(top[0].cpLost / 100) + ' pawns.</li>';
    h += '<li>Concentrate calculation training in the ' + worstPhase + ', where the loss per move is highest.</li>';
    if (p.clock.pressureRate > 25) h += '<li>Clock discipline before anything else; a third of the damage is self-inflicted by the clock.</li>';
    if (weakOpenings[0]) h += '<li>Repair or replace ' + esc(weakOpenings[0].name) + '.</li>';
    h += '</ol>';
    h += '<button id="scoutAdopt">Load this profile as mine</button></div>';
    return h;
  }

  /* ---------- settings + io ---------- */
  function initSettings() {
    var s = S.settings;
    $('#setMinutes').value = s.minutes; $('#setTier').value = s.endgameTier;
    $('#setHour').value = s.hour; $('#setKey').value = s.apiKey || '';
    $('#setPerf').value = s.perf || 'rapid';
    $('#setBoardTheme').value = s.boardTheme || 'cyan';
    $('#setPieceSet').value = s.pieceSet || 'glyph';
    $('#setShowCoords').checked = s.showCoords !== false;
    $('#saveSettings').addEventListener('click', function () {
      S.settings = { minutes: +$('#setMinutes').value, endgameTier: +$('#setTier').value,
        hour: +$('#setHour').value, apiKey: $('#setKey').value, perf: $('#setPerf').value,
        boardTheme: $('#setBoardTheme').value, pieceSet: $('#setPieceSet').value,
        showCoords: $('#setShowCoords').checked,
        uiScale: S.settings.uiScale || '1' };
      Store.set('settings', S.settings);
      applyBoardSettings();
      flash('Settings saved.');
      renderCalendar();
    });
    $('#exportAll').addEventListener('click', function () {
      download('dvoretsky-lab-backup.json', JSON.stringify({
        handle: S.handle, games: compact(S.games), cards: S.cardState,
        transcripts: S.transcripts, completed: S.completed, settings: S.settings,
        track: S.track
      }), 'application/json');
    });
    $('#importFile').addEventListener('change', function (e) {
      var f = e.target.files[0]; if (!f) return;
      var fr = new FileReader();
      fr.onload = function () {
        var txt = fr.result;
        if (/^\s*\{/.test(txt)) {
          try {
            var d = JSON.parse(txt);
            if (d.games) { S.games = hydrate(d.games); saveGames(); }
            if (d.cards) { S.cardState = d.cards; Store.set('cards', d.cards); }
            if (d.track) { S.track = d.track; Store.set('track', d.track); }
            if (d.transcripts) { S.transcripts = d.transcripts; Store.set('transcripts', d.transcripts); }
            if (d.completed) { S.completed = d.completed; Store.set('completed', d.completed); }
            rebuild();
            flash('Backup restored.');
          } catch (err) { flash('That JSON did not parse.', 'bad'); }
        } else {
          var user = Data.parseHandle($('#handle').value) || '';
          var games = Data.importPGN(txt, user);
          if (!games.length) { flash('No games found in that PGN.', 'bad'); return; }
          S.games = games.concat(S.games).slice(0, 400);
          saveGames(); rebuild();
          flash('Imported ' + games.length + ' games from PGN.' +
            (games.some(function (g) { return g.analysed; }) ? '' : ' None carry engine evaluations, so error mining will be empty — export from Lichess with analysis included.'));
        }
      };
      fr.readAsText(f);
      e.target.value = '';
    });
    $('#wipe').addEventListener('click', function () {
      if (!confirm('Delete all local data for this app?')) return;
      Store.keys().forEach(Store.del);
      location.reload();
    });
  }

  function download(name, text, mime) {
    var blob = new Blob([text], { type: mime || 'text/plain' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  /* ---------- boot ---------- */
  /* ---------- reading comfort ----------
     One scale on <html>; every size in the stylesheet is in rem, so the whole
     interface grows together instead of the body text outrunning its boxes. */
  function applyScale(v) {
    document.documentElement.style.setProperty('--ui-scale', v);
    measureMasthead();
  }

  /* The board sticks under the masthead, so it needs the masthead's real height
     rather than a guess that breaks as soon as the type size changes. */
  function measureMasthead() {
    var m = document.querySelector('.masthead');
    if (!m) return;
    document.documentElement.style.setProperty('--mast-h', m.offsetHeight + 'px');
  }

  function initChrome() {
    var sel = $('#uiScale');
    var saved = S.settings.uiScale || '1';
    sel.value = saved;
    applyScale(saved);
    sel.addEventListener('change', function () {
      S.settings.uiScale = sel.value;
      Store.set('settings', S.settings);
      applyScale(sel.value);
    });

    var mast = document.querySelector('.masthead');
    var folded = false;
    function onScroll() {
      var y = window.scrollY || 0;
      if (!folded && y > 170) { folded = true; mast.classList.add('compact'); measureMasthead(); }
      else if (folded && y < 60) { folded = false; mast.classList.remove('compact'); measureMasthead(); }
    }
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', measureMasthead);
    if (window.ResizeObserver) new ResizeObserver(measureMasthead).observe(mast);
    measureMasthead();
  }

  // Board display options (colour theme, piece style, coordinates) live in
  // S.settings and apply globally: boardTheme via a data-attribute on <html>
  // that css/app.css keys its board-square variables off of, the rest via
  // Board.prototype.setDisplayOptions on whichever boards currently exist.
  function boardOpts(extra) {
    return Object.assign({ pieceSet: S.settings.pieceSet || 'glyph', showCoords: S.settings.showCoords !== false }, extra || {});
  }
  function applyBoardSettings() {
    document.documentElement.setAttribute('data-board-theme', S.settings.boardTheme || 'cyan');
    var opts = { pieceSet: S.settings.pieceSet || 'glyph', showCoords: S.settings.showCoords !== false };
    [sparBoard, drillBoard, revBoard].forEach(function (b) { if (b) b.setDisplayOptions(opts); });
  }

  function boot() {
    applyBoardSettings();
    initChrome();
    initTabs();
    initSparring();
    initDrillControls();
    initSettings();
    $('#handle').value = S.handle;
    $('#sync').addEventListener('click', sync);
    $('#handle').addEventListener('keydown', function (e) { if (e.key === 'Enter') sync(); });
    $('#scoutBtn').addEventListener('click', scout);
    $('#revStart').addEventListener('click', startReview);
    $('#revSubmit').addEventListener('click', submitJustification);
    $('#revNext').addEventListener('click', function () {
      if (!S.review) return;
      if (!S.review.transcript[S.review.current.ply]) { flash('Write your justification first. That is the exercise.', 'warn'); return; }
      S.review.cursor++; renderReviewStep();
    });
    $('#revSkip').addEventListener('click', function () { if (S.review) { S.review.cursor++; renderReviewStep(); } });
    $('#sparCoach').addEventListener('change', function () { refreshAdvice(); });
    document.addEventListener('click', function (e) {
      if (e.target && e.target.id === 'scoutAdopt' && S.scout) {
        S.profile = S.scout.profile;
        renderRuler(); renderStrength();
        flash('Loaded ' + esc(S.scout.user) + '\u2019s profile into the workspace. Sync your own account to switch back.');
      }
    });

    loadGames();
    if (S.games.length) rebuild();
    else { renderRuler(); renderStrength(); }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
