// Checks for the titled-player comparison (js/titled.js). Run: node test/titled.js
globalThis.window = globalThis;
require('../js/titled.js');
const { Titled } = globalThis;

let failed = 0, passed = 0;
function check(name, ok, detail) {
  if (ok) passed++; else failed++;
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail !== undefined ? '  [' + JSON.stringify(detail) + ']' : ''));
}
const byUser = Object.fromEntries(Titled.players().map((p) => [p.user, p]));

(async () => {
  // ---------------------------------------------------------------- the list itself
  check('every listed player is in the snapshot, with a CM, FM, IM or GM title',
    Titled.PLAYERS.every((p) => ['CM', 'FM', 'IM', 'GM'].includes((Titled.SNAPSHOT.players[p.user] || {}).t)));
  check('every title from CM to GM is represented',
    ['CM', 'FM', 'IM', 'GM'].every((t) => Titled.players().some((p) => p.title === t)));
  check('the default picks are one of each title', Titled.DEFAULT_PICKS.map((u) => byUser[u].title).join() === 'CM,FM,IM,GM',
    Titled.DEFAULT_PICKS.map((u) => byUser[u].title));
  check('players sort CM, FM, IM, GM', Titled.players().map((p) => Titled.TITLE_ORDER.indexOf(p.title))
    .every((v, i, a) => i === 0 || a[i - 1] <= v));
  check('the snapshot is dated', /^\d{4}-\d{2}-\d{2}$/.test(Titled.SNAPSHOT.date), Titled.SNAPSHOT.date);
  check('the FIDE floors are 2200, 2300, 2400, 2500', Titled.TITLE_FLOORS.map((f) => f.rating).join() === '2200,2300,2400,2500');

  // ---------------------------------------------------------------- established ratings only
  const magnus = Titled.range(byUser.DrNykterstein.rows, 'all');
  check('a GM with no Lichess rapid or classical games is not shown at a placeholder 1500',
    magnus && magnus.lo === 3243 && magnus.hi === 3243 && magnus.points.length === 1, magnus);
  const rosen = Titled.range(byUser.EricRosen.rows, 'all');
  check('a range across speeds uses established speeds only (provisional classical left out)',
    rosen.lo === 2544 && rosen.hi === 2760 && rosen.points.map((p) => p.speed).join() === 'bullet,blitz,rapid', rosen);
  check('fewer than MIN_GAMES games is not established', !Titled.speedOf([2400, Titled.MIN_GAMES - 1, 0]).established
    && Titled.speedOf([2400, Titled.MIN_GAMES, 0]).established);
  check('provisional is never established, however many games', !Titled.speedOf([2400, 5000, 1]).established);
  check('no established rating at a speed reads as nothing, not as a number', Titled.range(byUser.DrNykterstein.rows, 'rapid') === null);
  check('no established rating anywhere reads as nothing', Titled.rangeAcross({ rapid: [1500, 0, 1] }) === null);

  // ---------------------------------------------------------------- one speed and its 12 months
  const bortnyk = Titled.range(byUser['Night-King96'].rows, 'bullet');
  check('one speed: the current rating with its 12-month low and high', bortnyk.rating === 3375 && bortnyk.lo === 3168
    && bortnyk.hi === 3375 && bortnyk.history && bortnyk.last === '2026-09-29', bortnyk);
  const rosenBlitz = Titled.range(byUser.EricRosen.rows, 'blitz');
  check('no public history: a point at the current rating, marked as such', rosenBlitz.lo === 2544 && rosenBlitz.hi === 2544
    && !rosenBlitz.history, rosenBlitz);
  check('the whisker always includes the current rating', (() => {
    const r = Titled.rangeAt({ blitz: [2600, 100, 0, 2400, 2500, '2026-09-01'] }, 'blitz');
    return r.lo === 2400 && r.hi === 2600;
  })());

  // ---------------------------------------------------------------- rating history
  const today = new Date(2026, 9, 1);
  const hist = [
    { name: 'Bullet', points: [[2025, 0, 5, 2100], [2025, 9, 2, 2200], [2026, 3, 1, 2350], [2026, 8, 30, 2300]] },
    { name: 'Blitz', points: [[2023, 1, 1, 1900], [2024, 2, 14, 2000], [2024, 5, 1, 1950]] },
    { name: 'Puzzles', points: [[2026, 0, 1, 2500]] },
    { name: 'Rapid', points: [] },
  ];
  const ranges = Titled.historyRanges(hist, today);
  check('history: the last 12 months for a speed still played (months are 0-based)', ranges.bullet
    && ranges.bullet.lo === 2200 && ranges.bullet.hi === 2350 && ranges.bullet.last === '2026-09-30', ranges.bullet);
  check('history: a speed no longer played uses its last active year, dated', ranges.blitz
    && ranges.blitz.lo === 1950 && ranges.blitz.hi === 2000 && ranges.blitz.last === '2024-06-01', ranges.blitz);
  check('history: puzzles and empty speeds are ignored', !('rapid' in ranges) && Object.keys(ranges).length === 2, Object.keys(ranges));
  check('history: garbage in, nothing out', Object.keys(Titled.historyRanges('nope', today)).length === 0
    && Object.keys(Titled.historyRanges([{ name: 'Bullet', points: [['x', 'y']] }], today)).length === 0);
  const merged = Titled.withHistory(Titled.rowsFromPerfs({ bullet: { rating: 2310, games: 900 }, blitz: { rating: 2000, games: 5, prov: true } }), ranges);
  check('profile perfs plus history become the same rows as the snapshot',
    JSON.stringify(merged.bullet) === JSON.stringify([2310, 900, 0, 2200, 2350, '2026-09-30']) && merged.blitz[2] === 1, merged);

  // ---------------------------------------------------------------- comparing
  check('gap: how far your top sits below their bottom', Titled.gap({ lo: 1800, hi: 2050 }, { lo: 2334, hi: 2612 }) === 284);
  check('gap: overlapping ranges give zero or less', Titled.gap({ lo: 2300, hi: 2700 }, { lo: 2334, hi: 2612 }) <= 0);
  check('gap: nothing to compare gives nothing', Titled.gap(null, { lo: 1, hi: 2 }) === null && Titled.gap({ lo: 1, hi: 2 }, null) === null);
  const sc = Titled.scale([{ lo: 1850, hi: 1990 }, magnus, null]);
  check('scale: wide enough for every bar and every title floor, in hundreds', sc.lo <= 1800 && sc.hi >= 3300
    && sc.lo % 100 === 0 && sc.hi % 100 === 0, [sc.lo, sc.hi]);
  check('scale: positions stay on the track', sc.pos(-5000) === 0 && sc.pos(99999) === 100 && sc.pos(sc.lo) === 0);

  // ---------------------------------------------------------------- saved data is untrusted
  const hostile = { date: '2026-10-01', players: { EricRosen: { t: '<img src=x onerror=alert(1)>',
    s: { blitz: ['<b>2900</b>', 5000, 0], bullet: [2800, '<i>', 0, '1;x', null, 'javascript:'] } } } };
  const fromHostile = Titled.players(hostile).find((p) => p.user === 'EricRosen');
  check('a tampered live title is dropped', fromHostile.title === null, fromHostile.title);
  check('tampered ratings become numbers or nothing', !('blitz' in fromHostile.rows)
    && JSON.stringify(fromHostile.rows.bullet) === JSON.stringify([2800, 0, 0, null, null, null]), fromHostile.rows);
  check('a live refresh replaces the snapshot, other players keep theirs',
    Titled.players({ date: 'd', players: { EricRosen: { t: 'IM', s: { blitz: [2600, 9400, 0] } } } }).find((p) => p.user === 'EricRosen')
      .rows.blitz[0] === 2600 && Titled.players({ players: {} }).find((p) => p.user === 'Fins').rows.blitz[0] === 2700);

  // ---------------------------------------------------------------- live refresh
  const calls = [];
  let active = 0, most = 0;
  const fake = async (url, init) => {
    active++; most = Math.max(most, active);
    calls.push({ url, body: init && init.body });
    await new Promise((r) => setTimeout(r, 5));
    active--;
    if (url.endsWith('/api/users')) {
      return { ok: true, json: async () => [
        { username: 'EricRosen', title: 'IM', perfs: { blitz: { rating: 2550, games: 9400 } } },
        { username: 'Fins', title: 'IM', closed: true, perfs: {} },
      ] };
    }
    if (url.includes('EricRosen')) return { ok: true, json: async () => [{ name: 'Blitz', points: [[2026, 8, 1, 2500], [2026, 8, 20, 2580]] }] };
    return { ok: false, json: async () => [] };
  };
  const live = await Titled.refresh(['EricRosen', 'Fins', 'Nobody'], { fetch: fake, pause: 1, today });
  check('refresh: one batched lookup, then one history request per open account',
    calls.length === 2 && calls[0].body === 'EricRosen,Fins,Nobody' && /EricRosen\/rating-history$/.test(calls[1].url), calls.map((c) => c.url));
  check('refresh: one request at a time', most === 1, most);
  check('refresh: closed or missing accounts are left out', Object.keys(live.players).join() === 'EricRosen', Object.keys(live.players));
  check('refresh: live rows carry the 12-month range', JSON.stringify(live.players.EricRosen.s.blitz) === JSON.stringify([2550, 9400, 0, 2500, 2580, '2026-09-20'])
    && live.date === '2026-10-01', live.players.EricRosen);
  let failedLookup = null;
  await Titled.refresh(['EricRosen'], { fetch: async () => ({ ok: false, status: 429 }), pause: 1 }).catch((e) => { failedLookup = e.message; });
  check('refresh: a refused lookup is an error the page can show', /429/.test(failedLookup || ''), failedLookup);
  const flaky = await Titled.refresh(['EricRosen'], { pause: 1, today, fetch: async (url) => {
    if (url.endsWith('/api/users')) return { ok: true, json: async () => [{ username: 'EricRosen', title: 'IM', perfs: { blitz: { rating: 2550, games: 9400 } } }] };
    throw new Error('network');
  } });
  check('refresh: a failed history request keeps the current rating', flaky.players.EricRosen.s.blitz[0] === 2550
    && flaky.players.EricRosen.s.blitz[3] === null, flaky.players.EricRosen);

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
