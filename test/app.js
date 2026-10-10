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

// ---------------------------------------------------------------- October 2026 coverage round: the calendar and its cards
{
  // "Hard" is the third grade: a smaller step each time, and a lower ease.
  const card = Training.newCard('h');
  const t0 = Date.UTC(2026, 9, 1);
  Training.review(card, 1, t0); const i1 = card.interval, e1 = card.ease;
  Training.review(card, 1, t0); const i2 = card.interval;
  Training.review(card, 1, t0); const i3 = card.interval;
  check('srs: "Hard" gives 1 day, then 3, then 0.7 of interval x ease, and lowers the ease each time',
    i1 === 1 && i2 === 3 && i3 === Math.round(3 * card.ease * 0.7) && Math.abs(e1 - 2.26) < 1e-9 && card.ease < e1, [i1, i2, i3, card.ease].join());
  for (let k = 0; k < 30; k++) Training.review(card, 2, t0 + k);
  check('srs: the history keeps the last 30 grades, oldest dropped', card.history.length === 30 && card.history[0].g === 2 && card.history[0].t === t0,
    card.history.length + ' ' + JSON.stringify(card.history[0]));
  check('srs: a card never reviewed has no retention yet', Training.retention(Training.newCard('n')) === null);
  const noLoss = Training.newCard('a', {}), big = Training.newCard('b', { cpLoss: 300 }), small = Training.newCard('c', { cpLoss: 90 });
  check('srs: due cards go costliest first, a card with no recorded loss last',
    Training.dueCards([noLoss, small, big], Date.now() + 1000).map((c) => c.id).join() === 'b,c,a'
    && Training.dueCards([big, noLoss, small], Date.now() + 1000).map((c) => c.id).join() === 'b,c,a');

  // Monday is recall (10 min), motif (15) and calculation (20): 30 minutes keeps the first two.
  const monday = new Date(2026, 9, 12, 12).getTime();
  const plan = Training.planDay(monday, { motifs: [] }, [], { minutesBudget: 30 });
  check('plan: a budget keeps the blocks that fit, in order, and leaves out the one that does not',
    plan.items.map((i) => i.type).join() === 'recall,motif', plan.items.map((i) => i.type).join());
  // A tier below every study (a value no setting gives) still sets a study with a position.
  const day = Training.planRange(monday - 3 * 86400000, 7, { motifs: [] }, [], { endgameTier: 0.5 })
    .map((p) => p.items.find((i) => i.type === 'endgame')).find(Boolean);
  const study = day && Training.ENDGAMES.find((e) => e.id === day.payload.endgameId);
  check('plan: an endgame tier below every study falls back to any study with a position', !!study && !!study.fen, day && day.payload.endgameId);

  // The .ics file with no options: 19:00. A block with no label has an empty summary, and a
  // line folded just before an emoji keeps the emoji's two halves together.
  const label = 'x'.repeat(65) + '\u{1F3C1} finish';
  const ics = Training.toICS([{ date: '2026-10-12', items: [{ minutes: 30, note: 'n' }, { label, minutes: 15, note: 'n' }] }]);
  const lines = ics.split('\r\n');
  const summaries = ics.replace(/\r\n /g, '').split('\r\n').filter((l) => l.startsWith('SUMMARY:'));
  check('ics: no options is 19:00; no label is an empty summary; a fold never splits a character',
    lines.includes('DTSTART:20261012T190000') && summaries[0] === 'SUMMARY:' && summaries[1] === 'SUMMARY:' + label
    && lines.every((l) => !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(l))
    && lines.some((l) => l.startsWith(' \u{1F3C1}')), JSON.stringify(summaries));
}
// ---------------------------------------------------------------- October 2026 coverage round: decks, plans and imports
{
  // A deck built with no cards yet, and a plan built with no options.
  const errs = [{ key: 'g:3', best: 'Nf3', played: 'Ba6', cpLoss: 300, phase: 'middlegame' }, { key: 'g:5', best: 'Qd2', played: 'Qd2' }, { key: 'g:7', played: 'h4' }];
  const deck = Training.buildDeck(errs);
  check('deck: only a mistake with a better known move becomes a card', deck.length === 1 && deck[0].id === 'g:3' && deck[0].meta.solution === 'Nf3',
    deck.map((c) => c.id).join());
  const plain = Training.planDay(new Date(2026, 9, 14, 12).getTime(), null, deck);
  check('plan: no profile and no options still gives the day\'s blocks', plain.weekday === 'Wednesday' && plain.items.length === 3, plain.items.map((i) => i.type).join());
  // Five minutes fits no block: the day keeps its first one anyway.
  const tight = Training.planDay(new Date(2026, 9, 12, 12).getTime(), { motifs: [] }, [], { minutesBudget: 5 });
  check('plan: a budget smaller than any block keeps the first block', tight.items.map((i) => i.type).join() === 'recall', tight.items.map((i) => i.type).join());
  // Cards with no recorded motifs or loss: a motif drill finds none of them, the calculation set takes none.
  const bare = [1, 2, 3, 4, 5].map((i) => Training.newCard('b' + i, { phase: 'middlegame' }));
  const days = Training.planRange(new Date(2026, 9, 11, 12).getTime(), 7, { motifs: [{ motif: 'pin', count: 3 }], phases: { middlegame: { acplInPhase: 50 }, opening: { acplInPhase: 10 } } }, bare, {});
  const items = days.flatMap((d) => d.items);
  check('plan: cards with no motifs or loss go in no motif drill and no calculation set',
    items.filter((i) => i.type === 'motif').every((i) => i.count === 0 && i.payload.motif === 'pin')
    && items.filter((i) => i.type === 'calculation').every((i) => i.count === 0), items.map((i) => i.type + i.count).join());
}
{
  // PGN import: a game the handle is not in (and the mirror not in either) is White's, a draw is half;
  // a [%clk] comment is read; a game whose tags come right after its moves with no result is two games.
  const r = Data.importPGN('[White "a"]\n[Black "b"]\n[Result "1/2-1/2"]\n\n1. e4 { [%clk 0:05:03.2] } e5 1/2-1/2', 'luke');
  check('pgn: a game without the handle is read as White\'s, a draw scores half, a clock comment is read',
    r.length === 1 && r[0].myColor === 'w' && r[0].score === 0.5 && Math.abs(r[0].moves[0].clock - 303.2) < 1e-9, JSON.stringify([r[0].myColor, r[0].score, r[0].moves[0].clock]));
  const mirror = Data.importPGN('[White "' + Data.MIRROR_NAME + '"]\n[Black "You"]\n[Result "0-1"]\n\n1. e4 e5 0-1', '');
  check('pgn: a sparring game against the mirror is the other side\'s', mirror[0].myColor === 'b' && mirror[0].score === 1, mirror[0].myColor);
  const pair = Data.importPGN('[White "luke"]\n[Black "x"]\n[Result "1-0"]\n\n1. e4 e5 1-0\n\n[White "' + Data.MIRROR_NAME + '"]\n[Black "someone"]\n[Result "1-0"]\n\n1. d4 d5 1-0', 'luke');
  check('pgn: in a game without your name, the side the mirror is not on is yours', pair.length === 2 && pair[0].myColor === 'w' && pair[1].myColor === 'b' && pair[1].score === 0,
    pair.map((g) => g.myColor + g.score).join());
  const split = Data.splitGames('[Event "A"]\n\n1. e4 e5 ; a remark\n[Event "B"]\n\n1. d4 d5 *');
  check('pgn: tags straight after unfinished moves start the next game; a ; remark is not moves', split.length === 2, split.length);
  const speeds = ['abc', '+5'].map((tc) => Data.importPGN('[TimeControl "' + tc + '"]\n\n1. e4 *', '')[0].speed);
  check('pgn: a time control that is not a number is read as rapid', speeds.join() === 'rapid,rapid', speeds.join());
  check('handle: a lichess.org/name link is that name; /tv and friends are not players',
    Data.parseHandle('https://lichess.org/DrNykterstein') === 'DrNykterstein' && Data.parseHandle('lichess.org/training') === null);
  const noName = Data.normalizeLichess({ id: 'x7', players: { white: {}, black: { user: { name: 'luke' } } }, moves: 'e4' }, 'luke');
  check('lichess: a white player with no name and no computer level is Anonymous', noName.oppName === 'Anonymous' && noName.myColor === 'b', noName.oppName);
}
// ---------------------------------------------------------------- every module loads in plain Node, with no window
{
  // The suites set globalThis.window first; a tool that does not (tools/uci.js, a REPL) gets each
  // module on globalThis instead. engine.js first: with no Chess yet, it requires core.js itself.
  const path = require('path');
  const files = ['engine', 'core', 'data', 'analysis', 'training', 'coach', 'sparring', 'stockfish-reader', 'titled', 'board'];
  const code = files.map((f) => 'require(' + JSON.stringify(path.join(__dirname, '..', 'js', f + '.js')) + ');').join('') +
    'process.stdout.write(JSON.stringify(["Chess","Engine","Data","Analysis","Training","Coach","Sparring","StockfishReader","Titled","Board"]' +
    '.filter(function (k) { return typeof globalThis[k] === "undefined"; }).concat([typeof window])));';
  const run = require('child_process').spawnSync(process.execPath, ['-e', code], { encoding: 'utf8' });
  check('modules: each loads in plain Node with no window and registers on globalThis', run.status === 0 && run.stdout === '["undefined"]',
    (run.stdout || '') + (run.stderr || '').slice(0, 200));
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
  // October 2026 coverage round. A game the handle is not in, the computer as Black, no handle given.
  const notMine = Data.normalizeLichess({ id: 'x4', winner: 'black', players: { white: { user: { name: 'someone' }, rating: 2000, analysis: { acpl: 20 } },
    black: { aiLevel: 3 } }, pgn: '1. e4 e5 2. Ke3 0-1' });
  check('lichess: a game the handle is not in has no side of mine; an unreadable PGN leaves no moves',
    notMine.myColor === null && notMine.oppName === 'someone' && notMine.myName === 'Stockfish L3' && notMine.oppAcpl === 20
    && notMine.acpl === null && notMine.moves.length === 0, JSON.stringify([notMine.myColor, notMine.myName, notMine.oppName, notMine.oppAcpl]));
  const mated = Data.normalizeLichess({ id: 'x5', players: { white: { user: { name: 'luke' }, analysis: { acpl: 12 } }, black: {} },
    moves: 'f3 e5 g4 Qh4#', analysis: [{ eval: -40 }, { eval: -60 }, { mate: -1 }, {}] }, 'luke');
  const none = Data.normalizeLichess({ id: 'x6', players: { white: { user: { name: 'luke' } }, black: {} } }, 'luke');
  check('lichess: being mated is -10000; a ply with no eval and no mate is null; missing counts are zero; no moves at all is none',
    mated.moves[2].evalAfter === -10000 && mated.moves[2].mateAfter === -1 && mated.moves[3].evalAfter === null && mated.moves[3].mateAfter === null
    && JSON.stringify(mated.counts) === '{"inaccuracy":0,"mistake":0,"blunder":0}' && none.moves.length === 0,
    JSON.stringify([mated.moves[2].evalAfter, mated.moves[3].evalAfter, mated.counts, none.moves.length]));
  check('handle: text that is no Lichess link or name is no handle', Data.parseHandle('not a handle!') === null && Data.parseHandle('https://lichess.org/tv') === null);
  const split = Data.splitGames('[Event "A"]\n{a note before the other tags}\n[White "luke"]\n\n1. e4 e5 1-0\n');
  check('pgn: a line holding only a comment is not moves, so the tags after it stay in the same game', split.length === 1, split.length);
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
  // Delete everything, then a save that was already queued fires before the reload: nothing may come back.
  Data.Store.set('cards', { a: 1 }); Data.Store.wipe(); Data.Store.set('games', [3]); Data.Store.set('cards', { b: 2 });
  check('store: after wipe() nothing of this app is left, and a late save writes nothing', Data.Store.keys().length === 0,
        Data.Store.keys().join());
  // A storage that refuses even to delete (a locked-down browser) is not an error.
  globalThis.localStorage = { removeItem() { throw new Error('denied'); } };
  let delThrew = false;
  try { Data.Store.del('x'); } catch (e) { delThrew = true; }
  check('store: a storage that refuses deletes is passed over quietly', !delThrew);
  Data.Store.wiped = false;
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

  // October 2026 coverage round. A reader never started: sending, clearing and ending are no-ops.
  const idle = new StockfishReader.Reader('x');
  let idleThrew = null;
  try { idle.send('uci'); idle.clear(); idle.terminate(); idle.onLine('readyok'); } catch (e) { idleThrew = e.message; }
  check('reader: before start, send, clear and terminate do nothing; a stray readyok just marks it ready',
    idleThrew === null && idle.isReady === true && idle.worker === null, idleThrew);
  // Stockfish talks about more than scores: those lines are passed over, not read as one.
  class ChattyWorker {
    postMessage(cmd) {
      const say = (l, t) => setTimeout(() => this.onmessage({ data: l }), t);
      if (cmd === 'isready') say('readyok', 1);
      if (cmd.startsWith('go')) {
        say('info string NNUE evaluation using nn-1111.nnue', 2);
        say('info depth 12 currmove e2e4 currmovenumber 1', 3);
        say('option name Threads type spin default 1 min 1 max 1024', 4);
        say('info depth 12 seldepth 18 multipv 1 score cp 31 nodes 9000 pv e2e4 e7e5', 5);
        say('bestmove e2e4 ponder e7e5', 6);
      }
    }
    terminate() {}
  }
  globalThis.Worker = ChattyWorker;
  const chatty = new StockfishReader.Reader('x');
  await chatty.start();
  const heard = await chatty.read(Chess.START);
  check('reader: info lines without a score and other output are ignored; the scored line is the reading',
    heard.lines.length === 1 && heard.cp === 31 && heard.depth === 12 && heard.best === 'e2e4', JSON.stringify(heard.lines));
  // The worker failing in the middle of a read: that read is rejected, even with no message.
  class DyingWorker {
    postMessage(cmd) {
      if (cmd === 'isready') setTimeout(() => this.onmessage({ data: 'readyok' }), 1);
      if (cmd.startsWith('go')) setTimeout(() => this.onerror({}), 2);
    }
    terminate() {}
  }
  globalThis.Worker = DyingWorker;
  const dying = new StockfishReader.Reader('x');
  await dying.start();
  const lost = await dying.read(Chess.START).then(() => 'read', (e) => e.message);
  check('reader: a worker that dies mid-read rejects that read, saying "worker error" when it gives no message',
    lost === 'Stockfish did not start: worker error' && dying.current === null, lost);
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
  // No time control asked for: Lichess is not told one (the caller filters), and no window means no "since".
  const asked = [];
  globalThis.fetch = (u) => { asked.push(new URL(String(u)).searchParams); return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve('') }); };
  await Data.fetchGames({ user: 'x' });
  globalThis.fetch = realFetch;
  check('fetch: with no time control and no window, neither is sent', !asked[0].has('perfType') && !asked[0].has('since') && asked[0].get('max') === '300',
    asked[0].toString());
  // A line of the export that is not JSON (a cut-off stream) is passed over; the rest are read.
  const goodRow = JSON.stringify({ id: 'ok1', players: { white: { user: { name: 'x' } }, black: {} }, moves: 'e4' });
  globalThis.fetch = () => Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve('{"id": "cut\n' + goodRow + '\n') });
  const partly = await Data.fetchGames({ user: 'x' });
  globalThis.fetch = realFetch;
  check('fetch: a line that is not JSON is skipped, the next game is read', partly.length === 1 && partly[0].id === 'ok1', partly.map((g) => g.id).join());
  // A position with no move to read (Stockfish says "bestmove (none)" and no score), and a mate
  // seen with White to move; an info line with a score but no depth is not a reading.
  class EdgeWorker {
    postMessage(cmd) {
      const say = (l, t) => setTimeout(() => this.onmessage({ data: l }), t);
      if (cmd === 'isready') say('readyok', 1);
      if (cmd.startsWith('position')) this.fen = cmd;
      if (cmd.startsWith('go') && /8\/8\/8\/8\/8\/8\/8\/k6K/.test(this.fen || '')) say('bestmove (none)', 2);
      else if (cmd.startsWith('go')) { say('info depth 5 multipv 1 score mate -3 pv e2e4', 2); say('bestmove e2e4', 3); }
    }
    terminate() {}
  }
  globalThis.Worker = EdgeWorker;
  const edge = new StockfishReader.Reader('x');
  await edge.start();
  const nothing = await edge.read('8/8/8/8/8/8/8/k6K w - - 0 1');
  const mated = await edge.read(Chess.START);
  check('reader: no move and no score reads as no best move at depth 0; a mate against White to move is -3 from White\'s side',
    nothing.best === null && nothing.depth === 0 && nothing.cp === 0 && nothing.lines.length === 0
    && mated.mate === -3 && mated.cp === -(StockfishReader.MATE - 5) && StockfishReader.parseInfo('info score cp 20 pv e2e4') === null,
    JSON.stringify([nothing.best, nothing.depth, mated.mate, mated.cp]));
  // Lichess answers that the sync shows as they are: no account, rate-limited; a token is sent; progress is reported.
  const sent = [];
  const statusFetch = (status) => (u, init) => { sent.push(init); return Promise.resolve({ ok: status === 200, status, text: () => Promise.resolve('') }); };
  const why = [];
  for (const status of [404, 429]) {
    globalThis.fetch = statusFetch(status);
    await Data.fetchGames({ user: 'ghost' }).catch((e) => why.push(e.message));
  }
  globalThis.fetch = statusFetch(200);
  let progress = null;
  await Data.fetchGames({ user: 'x', token: 'tok' }, (n) => { progress = n; });
  globalThis.fetch = realFetch;
  check('fetch: no account and rate-limiting each say so; a token goes in the header; progress is reported',
    why[0] === 'No Lichess account found for "ghost".' && /rate-limiting/.test(why[1]) && sent[2].headers.Authorization === 'Bearer tok' && progress === 0,
    JSON.stringify([why, sent[2].headers.Authorization, progress]));
  globalThis.Worker = realWorker;
})().catch(e => check('reader: the checks ran to the end', false, e.stack)).then(() => {
  console.log('\n' + passed + ' passed, ' + failed + ' failed' + (skipped ? ', ' + skipped + ' skipped' : ''));
  process.exitCode = failed ? 1 : 0;
});
