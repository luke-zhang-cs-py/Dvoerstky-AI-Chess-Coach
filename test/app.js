// Checks for the app's own logic outside the engine: PGN import, error mining around mates,
// the opening book and tree, the calendar and its .ics file, the Stockfish score display.
// Each was written to fail on the code before its fix (9 October 2026 audit). Run: node test/app.js
globalThis.window = globalThis;
require('../js/core.js'); require('../js/engine.js'); require('../js/data.js');
require('../js/analysis.js'); require('../js/training.js'); require('../js/sparring.js');
require('../js/stockfish-reader.js');
const { Chess, Analysis, Training, Sparring, Data, StockfishReader } = globalThis;

let failed = 0, passed = 0, skipped = 0;
function check(name, ok, detail) {
  if (ok) passed++; else failed++;
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail !== undefined ? '  [' + detail + ']' : ''));
}
// A check that cannot run here. In CI (CI is set) nothing may be skipped, so a skip fails.
function skip(name, why) {
  if (process.env.CI) return check(name, false, 'skipped in CI: ' + why);
  skipped++;
  console.log('SKIP ' + name + '  [' + why + ']');
}
const sans = g => g.moves.map(m => m.san).join(' ');

// ---------------------------------------------------------------- PGN import: where games end
{
  const a = '[Event "A"]\n[White "luke"]\n[Black "x"]\n[Result "1-0"]\n\n1. e4 e5 2. Nf3 1-0';
  const b = '[Event "B"]\n[White "y"]\n[Black "luke"]\n[Result "0-1"]\n\n1. d4 d5 2. c4 0-1';
  const r = Data.importPGN(a + '\n' + b, 'luke');
  check('pgn: games one newline apart are two games', r.length === 2 && sans(r[0]) === 'e4 e5 Nf3' && r[1].myColor === 'b',
    r.length + ' games: ' + r.map(sans).join(' | '));
  const c = '[Event "C"]\n[White "luke"]\n[Black "x"]\n[Result "1-0"]\n\n1. e4 {Good.\n\n[Plan] push d4} e5 2. Nf3 1-0';
  const rc = Data.importPGN(c, 'luke');
  check('pgn: a comment whose paragraph starts with "[" does not cut the game', rc.length === 1 && sans(rc[0]) === 'e4 e5 Nf3',
    rc.length + ' games: ' + rc.map(sans).join(' | '));
  const bare = Data.importPGN('1. e4 e5 *\n\n1. d4 d5 *', 'luke');
  check('pgn: two tagless games, each ended by its result, are two games', bare.length === 2 && sans(bare[1]) === 'd4 d5',
    bare.length + ' games');
}

// ---------------------------------------------------------------- PGN import: whose game, what result
{
  const g = Data.importPGN('1. e4 e5 2. Nf3 Nc6 3. Bb5 a6', 'luke')[0];
  check('pgn: a game that names no player is read as White, and marked as a guess',
    g.myColor === 'w' && g.colourGuessed === true, g.myColor + ' ' + g.colourGuessed);
  const sparText = '[White "' + Data.MIRROR_NAME + '"]\n[Black "You"]\n[Result "*"]\n\n1. e4 e5 2. Nf3 *';
  const s = Data.importPGN(sparText, '')[0];
  check('pgn: the Sparring tab\'s game text, played as Black, imports as Black with no handle set',
    s.myColor === 'b' && s.oppName === Data.MIRROR_NAME && !s.colourGuessed, s.myColor + ' vs ' + s.oppName);

  const star = '[Event "Casual Rapid game"]\n[White "luke"]\n[Black "opp"]\n[WhiteElo "1800"]\n[BlackElo "2000"]\n[Result "*"]\n\n1. e4 e5 *';
  const u = Data.importPGN(star, 'luke')[0];
  check('pgn: an unfinished game ("*") has no score', u.score === null, u.score);
  const three = [u, Object.assign({}, u, { id: 'b' }), Object.assign({}, u, { id: 'c' })];
  check('pgn: ...so it adds nothing to the performance rating', Analysis.performanceRating(three) === null,
    JSON.stringify(Analysis.performanceRating(three)));
  check('pgn: a "Casual" event is not rated', u.rated === false, u.rated);
  const rated = Data.importPGN(star.replace('Casual', 'Rated'), 'luke')[0];
  const unknown = Data.importPGN(star.replace('Casual Rapid game', 'Live Chess'), 'luke')[0];
  check('pgn: a "Rated" event is rated; an event that says neither is unknown', rated.rated === true && unknown.rated === null,
    rated.rated + ' / ' + unknown.rated);

  const tree = Analysis.buildOpeningTree(three.concat(three.map((x, i) => Object.assign({}, x, { id: 'w' + i, score: 1 }))));
  const e4 = tree.childList.filter(n => n.san === 'e4')[0];
  check('pgn: an unfinished game does not count as a loss in the opening tree', e4 && e4.games === 6 && e4.scorePct === 100,
    e4 && e4.games + ' games, ' + e4.scorePct + '%');
}

// ---------------------------------------------------------------- PGN import: variants
{
  const zh = '[Variant "Crazyhouse"]\n[White "luke"]\n[Black "x"]\n[Result "1-0"]\n\n1. e4 d5 2. exd5 Qxd5 3. Nc3 Qa5 4. P@d4 Nf6 1-0';
  const std = '[Variant "Standard"]\n[White "luke"]\n[Black "x"]\n[Result "1-0"]\n\n1. d4 d5 1-0';
  const r = Data.importPGN(zh + '\n\n' + std, 'luke');
  check('pgn: a variant game is left out, and the import says why',
    r.length === 1 && sans(r[0]) === 'd4 d5' && r.skipped.length === 1 && r.skipped[0].reason === 'variant' && r.skipped[0].variant === 'Crazyhouse',
    r.length + ' games; skipped ' + JSON.stringify(r.skipped));
  const c960 = '[Variant "Chess960"]\n[SetUp "1"]\n[FEN "bbqnnrkr/pppppppp/8/8/8/8/PPPPPPPP/BBQNNRKR w HFhf - 0 1"]\n[White "luke"]\n[Black "x"]\n[Result "1-0"]\n\n1. e4 e5 2. Ng3 Ng6 1-0';
  let n960;
  try { n960 = Data.importPGN(c960, 'luke').length; } catch (e) { n960 = 'threw ' + e.message; }
  check('pgn: a Chess960 game is left out', n960 === 0, n960);
  const fromPos = '[Variant "From Position"]\n[SetUp "1"]\n[FEN "4k3/8/8/8/8/8/4P3/4K3 w - - 0 1"]\n[White "luke"]\n[Black "x"]\n[Result "1-0"]\n\n1. e4 Kd7 1-0';
  check('pgn: a standard game set up from a position is kept', Data.importPGN(fromPos, 'luke').length === 1);
}

// ---------------------------------------------------------------- mining: a forced mate thrown away
{
  const c = new Chess(), moves = [];
  ['e4', 'e5', 'Qh5', 'Nc6', 'Bc4', 'Nf6'].forEach(function (s) {
    const before = c.fen(), m = c.move(s);
    moves.push({ san: m.san, color: m.color === Chess.WHITE ? 'w' : 'b', fenBefore: before, fenAfter: c.fen() });
  });
  [30, 30, 0, 20, 30, 10000].forEach((e, i) => { moves[i].evalAfter = e; });
  moves[5].mateAfter = 1;   // after 3...Nf6?? White mates with Qxf7#
  const g = new Chess(c.fen()), next = g.move('Qxe5+');
  moves.push({ san: next.san, color: 'w', fenBefore: c.fen(), fenAfter: g.fen(), evalAfter: 800, serverBest: 'h5f7' });
  const errs = Analysis.mineErrors([{ id: 'm', myColor: 'w', moves: moves, analysed: true, date: Date.now() }]);
  check('mining: missing a mate for a +8 position is a mistake, as Lichess judges it',
    errs.length === 1 && errs[0].played === 'Qxe5+' && errs[0].severity === 'mistake' && errs[0].best === 'Qxf7#',
    errs.map(e => e.played + ' ' + e.severity + ' best ' + e.best).join(', ') || 'none');
  moves[6].evalAfter = 1100;   // still +11: the mate is gone, the game is not
  const mild = Analysis.mineErrors([{ id: 'm', myColor: 'w', moves: moves, analysed: true, date: Date.now() }]);
  check('mining: ...and an inaccuracy when the position stays above +10',
    mild.length === 1 && mild[0].severity === 'inaccuracy', mild.map(e => e.severity).join());
  moves[6].evalAfter = 10000; moves[6].mateAfter = 3;   // a slower mate is still a mate
  check('mining: a slower mate is not an error', Analysis.mineErrors([{ id: 'm', myColor: 'w', moves: moves, analysed: true, date: Date.now() }]).length === 0);
}

// ---------------------------------------------------------------- book and tree: games set up from a position
{
  const pgn = '[White "luke"]\n[Black "x"]\n[SetUp "1"]\n[FEN "4k3/8/8/8/8/8/4P3/4K3 w - - 0 1"]\n[Result "1-0"]\n\n1. e4 Kd7 2. e5 Ke6 1-0';
  const games = Data.importPGN(pgn + '\n\n' + pgn.replace('[Black "x"]', '[Black "y"]'), 'luke');
  const book = Analysis.buildBook(games);
  const startKey = Chess.START.split(' ').slice(0, 4).join(' ');
  const fenKey = '4k3/8/8/8/8/8/4P3/4K3 w - -';
  check('book: moves from a set-up position are not booked as moves from the initial one',
    book[startKey] === undefined && book[fenKey] && book[fenKey].e4 && book[fenKey].e4.n === 2,
    JSON.stringify(book[startKey]) + ' / ' + JSON.stringify(book[fenKey]));
  const tree = Analysis.buildOpeningTree(games);
  check('tree: a game set up from a position is not an opening', tree.childList.length === 0,
    tree.childList.map(n => n.san).join());
  const m = new Sparring.Mirror({ calibration: { trueStrength: 1800 } }, { book: book });
  check('book: ...so the mirror has no book move from the initial position', m.bookMove(new Chess()) === null);
}

// ---------------------------------------------------------------- calendar: a card is due on its day
{
  const reviewedAt = new Date(2026, 9, 12, 19, 0).getTime();   // Monday 12 October, 19:00
  const card = Training.newCard('g1:10', { fen: '8/8/8/8/8/8/8/K6k w - - 0 1', cpLoss: 300 });
  Training.review(card, 2, reviewedAt);                         // first rep, "Got it": two days
  const plans = Training.planRange(new Date(2026, 9, 11), 7, { motifs: [], phases: null }, [card], {});
  const counts = plans.map(p => { const r = p.items.filter(i => i.type === 'recall')[0]; return r ? r.count : '-'; });
  check('calendar: a card due at 19:00 on Wednesday is listed on Wednesday, not Thursday',
    plans[3].date === '2026-10-14' && counts[3] === 1 && counts[2] === 0, counts.join(' '));
}

// ---------------------------------------------------------------- the .ics file
{
  const plans = Training.planRange(new Date(2026, 9, 11), 1, { motifs: [] }, [], {});
  const starts = hour => Training.toICS(plans, { hour: hour }).split('\r\n').filter(l => /^DT(START|END)/.test(l));
  const bad = ['7pm', undefined, null, NaN, 30, -1, 7.5].map(h => [h, starts(h)]);
  check('ics: an hour that is not one (text, missing, 30, -1, 7.5) never writes NaN, and falls back to 19:00',
    bad.every(([, l]) => !l.join().includes('NaN') && l[0] === 'DTSTART:20261011T190000'),
    bad.filter(([, l]) => l[0] !== 'DTSTART:20261011T190000').map(([h, l]) => h + ' -> ' + l[0]).join('; '));
  const late = starts(23);
  check('ics: blocks that run past midnight end on the next day', late[late.length - 1].startsWith('DTEND:20261012T00'),
    late[late.length - 1]);
  // A floating 02:00 on the night the clocks go forward (in a zone that has one: CI runs
  // in America/Toronto) must stay 02:00; a local Date moves it to 03:00.
  let dst = null;
  for (let d = new Date(2027, 0, 1); d.getFullYear() === 2027 && !dst; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) {
    if (new Date(d.getFullYear(), d.getMonth(), d.getDate(), 2, 0).getHours() !== 2) dst = d;
  }
  if (dst) {
    const line = Training.toICS(Training.planRange(dst, 1, { motifs: [] }, [], {}), { hour: 2 }).split('\r\n').filter(l => /^DTSTART/.test(l))[0];
    const want = 'DTSTART:' + Training.dateKey(dst).replace(/-/g, '') + 'T020000';
    check('ics: 02:00 on the day the clocks go forward stays 02:00', line === want, line + ' (want ' + want + ')');
  } else {
    skip('ics: 02:00 on the day the clocks go forward stays 02:00',
         'no clock change in this time zone (' + Intl.DateTimeFormat().resolvedOptions().timeZone + '); run with TZ=America/Toronto');
  }
}

// ---------------------------------------------------------------- Stockfish: a position already mated
{
  const info = StockfishReader.parseInfo('info depth 0 score mate 0');
  const shown = Sparring.cpDisplay(StockfishReader.whiteCp(info, false));   // Black to move, and mated
  check('stockfish: "score mate 0" reads as the result, not as mate in 1', shown === '1-0', shown);
  check('stockfish: ...and mate in 1 still reads as #1', Sparring.cpDisplay(StockfishReader.whiteCp({ kind: 'mate', value: 1 }, true)) === '#1');
}

// ---------------------------------------------------------------- Lichess sync: one game from the API
{
  // Luke has Black against the computer and walks into Qxf7#. Lichess sends the evals
  // from White's side, one per ply, the clock in centiseconds, and its judgment and best move.
  const api = { id: 'abcd1234', rated: true, speed: 'blitz', perf: 'blitz', createdAt: 1000, lastMoveAt: 2000, status: 'mate', winner: 'white',
    players: { white: { aiLevel: 5 }, black: { user: { name: 'Luke' }, rating: 1900, ratingDiff: -6, analysis: { acpl: 31, accuracy: 74, blunder: 1 } } },
    pgn: '[Event "Rated blitz game"]\n\n1. e4 e5 2. Qh5 Nc6 3. Bc4 Nf6 4. Qxf7# 1-0',
    analysis: [{ eval: 30 }, { eval: 25 }, { eval: 0 }, { eval: 20 }, { eval: 20 },
               { mate: 1, best: 'g7g6', variation: 'g6 Qf3', judgment: { name: 'Blunder', comment: 'Checkmate is now unavoidable.' } }],
    clocks: [18003, 18003, 17500, 17700], clock: { initial: 180, increment: 2 }, opening: { eco: 'C20', name: "King's Pawn Game: Wayward Queen Attack", ply: 3 } };
  const g = Data.normalizeLichess(api, 'luke');
  check('lichess: the side with the handle (any case) is mine; the computer is named by its level',
    g.myColor === 'b' && g.myName === 'Luke' && g.oppName === 'Stockfish L5' && g.score === 0 && g.result === '1-0',
    [g.myColor, g.myName, g.oppName, g.score, g.result].join(' '));
  check('lichess: the moves come from the PGN, every one', g.moves.map(m => m.san).join(' ') === 'e4 e5 Qh5 Nc6 Bc4 Nf6 Qxf7#',
    g.moves.map(m => m.san).join(' '));
  const nf6 = g.moves[5];
  check('lichess: a mate in the analysis is the +-10000 eval and the mate count, with the judgment and best move',
    nf6.evalAfter === 10000 && nf6.mateAfter === 1 && nf6.judgment === 'Blunder' && nf6.serverBest === 'g7g6' && nf6.serverLine === 'g6 Qf3',
    JSON.stringify({ e: nf6.evalAfter, m: nf6.mateAfter, j: nf6.judgment, b: nf6.serverBest }));
  check('lichess: plies past the analysis have no eval; ordinary ones have no mate', g.moves[6].evalAfter === undefined &&
    g.moves[2].evalAfter === 0 && g.moves[2].mateAfter === null, g.moves[6].evalAfter + ' / ' + g.moves[2].evalAfter);
  check('lichess: clocks are read in seconds, only as far as they go', g.moves[2].clock === 175 && g.moves[3].clock === 177 &&
    g.moves[4].clock === undefined && g.clockInitial === 180 && g.clockIncrement === 2, g.moves.map(m => m.clock).join());
  check('lichess: my analysis summary, the opening and the rating change are kept',
    g.analysed && g.acpl === 31 && g.accuracy === 74 && g.oppAcpl === null && JSON.stringify(g.counts) === '{"inaccuracy":0,"mistake":0,"blunder":1}' &&
    g.eco === 'C20' && g.openingPly === 3 && g.myRating === 1900 && g.oppRating === undefined && g.ratingDiff === -6 && g.url === 'https://lichess.org/abcd1234',
    JSON.stringify([g.acpl, g.counts, g.eco, g.openingPly, g.ratingDiff]));
  const errs = Analysis.mineErrors([g]);
  check('lichess: ...and mining reads it: Nf6 into a mate in one is a blunder, Lichess\'s move the answer',
    errs.length === 1 && errs[0].played === 'Nf6' && errs[0].severity === 'blunder' && errs[0].best === 'g6' && errs[0].judgment === 'Blunder',
    errs.map(e => e.played + ' ' + e.severity + ' ' + e.best).join());
  const bare = Data.normalizeLichess({ id: 'x2', players: { white: { user: { name: 'luke' } }, black: {} }, moves: 'e4 e5 Nf3' }, 'luke');
  check('lichess: a game sent as bare moves with no winner is a draw against an anonymous player, not analysed',
    bare.moves.length === 3 && bare.score === 0.5 && bare.result === '1/2-1/2' && bare.oppName === 'Anonymous' && !bare.analysed && bare.counts === null,
    [bare.moves.length, bare.score, bare.oppName].join(' '));
  const broken = Data.normalizeLichess({ id: 'x3', players: { white: { user: { name: 'luke' } }, black: {} }, moves: 'e4 e5 Ke3' }, 'luke');
  check('lichess: moves that cannot be played leave the game with none, rather than a wrong half', broken.moves.length === 0, broken.moves.length);
}

// ---------------------------------------------------------------- local storage: only this app's keys
{
  const mem = {};
  globalThis.localStorage = {
    get length() { return Object.keys(mem).length; }, key: i => Object.keys(mem)[i],
    getItem: k => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = String(v); }, removeItem: k => { delete mem[k]; }
  };
  mem['other:app'] = '1';
  Data.Store.set('games', [1, 2]); Data.Store.set('settings', { hour: 7 });
  check('store: values go in under "dvor:" as JSON and come back', mem['dvor:games'] === '[1,2]' && Data.Store.get('settings').hour === 7);
  check('store: keys() lists this app\'s keys only, without the prefix', Data.Store.keys().sort().join() === 'games,settings', Data.Store.keys().join());
  Data.Store.del('games');
  check('store: del() removes the key, and get() then gives the default', !('dvor:games' in mem) && Data.Store.get('games', 'none') === 'none' &&
    mem['other:app'] === '1');
  mem['dvor:bad'] = '{not json';
  check('store: a value that is not JSON reads as the default', Data.Store.get('bad', 42) === 42);
  delete globalThis.localStorage;
}

// ---------------------------------------------------------------- the Stockfish reader: stopping, and failing to start
(async () => {
  const posted = [];
  let terminated = 0;
  class SilentWorker {   // answers "isready" and nothing else: a read stays in hand
    postMessage(cmd) { posted.push(cmd); if (cmd === 'isready') setTimeout(() => this.onmessage({ data: 'readyok' }), 1); }
    terminate() { terminated++; }
  }
  const realWorker = globalThis.Worker;
  globalThis.Worker = SilentWorker;
  const r = new StockfishReader.Reader('/* engine */');
  await r.start();
  const inHand = r.read(Chess.START, { movetime: 50, multipv: 3 }), waiting = r.read(Chess.START, { movetime: 50 });
  check('reader: a read asking for three lines sets MultiPV before it searches',
    posted.indexOf('setoption name MultiPV value 3') > -1 && posted.indexOf('setoption name MultiPV value 3') < posted.indexOf('go movetime 50'),
    posted.join(' | '));
  r.terminate();   // what becomes of the two reads is test/regress.js's check
  check('reader: terminate() stops the search and ends the worker', terminated === 1 && r.worker === null && !r.isReady &&
    posted[posted.length - 1] === 'stop', terminated + ' ' + posted[posted.length - 1]);
  await r.start();
  check('reader: ...and start() afterwards makes a new worker', r.isReady && r.worker instanceof SilentWorker);

  class BrokenWorker { postMessage() { setTimeout(() => this.onerror({ message: 'Uncaught SyntaxError' }), 1); } terminate() {} }
  globalThis.Worker = BrokenWorker;
  const broken = new StockfishReader.Reader('not javascript');
  const started = broken.start().then(() => 'started', e => e.message);
  const queued = broken.read(Chess.START).then(() => 'read', e => e.message);
  const res = await Promise.all([started, queued]);
  check('reader: a worker that fails to start rejects start() and every read waiting on it, saying why',
    res[0] === 'Stockfish did not start: Uncaught SyntaxError' && res[1] === res[0] && broken.queue.length === 0, res.join(' | '));
  globalThis.Worker = class { constructor() { throw new Error('Workers are blocked'); } };
  const blocked = await new StockfishReader.Reader('x').start().then(() => 'started', e => e.message);
  check('reader: a browser that refuses the worker rejects start()', blocked === 'Workers are blocked', blocked);

  // Two lines asked for: Stockfish's info lines come in any order, the reader returns them by rank.
  class TwoLineWorker {
    postMessage(cmd) {
      const say = (l, t) => setTimeout(() => this.onmessage({ data: l }), t);
      if (cmd === 'isready') say('readyok', 1);
      if (cmd.startsWith('go')) {
        say('info depth 10 multipv 2 score cp 15 pv d2d4 d7d5', 2);
        say('info depth 10 multipv 1 score mate 2 pv e2e4 e7e5', 3);
        say('bestmove e2e4', 4);
      }
    }
    terminate() {}
  }
  globalThis.Worker = TwoLineWorker;
  const two = new StockfishReader.Reader('x');
  await two.start();
  const read = await two.read(Chess.START.replace(' w ', ' b '), { multipv: 2 });
  check('reader: several lines come back best first, from White' + "'" + 's side, the top one as the reading',
    read.lines.length === 2 && read.lines[0].pv[0] === 'e2e4' && read.lines[1].cp === -15 && read.mate === -2 && read.best === 'e2e4' && read.depth === 10,
    JSON.stringify(read.lines.map(l => [l.pv[0], l.cp, l.mate])));

  // Rating history: Lichess refusing, or the network failing, is an empty history, not an error.
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => Promise.resolve({ ok: false, status: 404 });
  const refused = await Data.fetchRatingHistory('nobody');
  globalThis.fetch = () => Promise.reject(new Error('offline'));
  const offline = await Data.fetchRatingHistory('nobody');
  globalThis.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve([{ name: 'Blitz', points: [] }]) });
  const ok = await Data.fetchRatingHistory('somebody');
  globalThis.fetch = realFetch;
  check('rating history: refused or offline reads as no history; an answer is passed through',
    Array.isArray(refused) && !refused.length && Array.isArray(offline) && !offline.length && ok[0].name === 'Blitz', JSON.stringify([refused, offline, ok]));
  globalThis.Worker = realWorker;
})().catch(e => check('reader: the checks ran to the end', false, e.stack)).then(() => {
  console.log('\n' + passed + ' passed, ' + failed + ' failed' + (skipped ? ', ' + skipped + ' skipped' : ''));
  process.exitCode = failed ? 1 : 0;
});
