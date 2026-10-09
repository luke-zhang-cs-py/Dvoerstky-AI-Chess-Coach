// Regression checks for bugs found in the September and October 2026 audits: at least one
// check per bug, written to fail on the code before its fix (notes/CODE_AUDIT_2026-10.md
// records the one that did not, and how it was tightened).
// Run: TZ=America/Toronto node test/regress.js (the clock-change check needs a zone with one)
globalThis.window = globalThis;
require('../js/core.js'); require('../js/engine.js'); require('../js/data.js');
require('../js/analysis.js'); require('../js/training.js'); require('../js/coach.js');
require('../js/sparring.js');
const Games = require('../tools/games.js');
const { Chess, Engine, Analysis, Training, Coach, Sparring, Data } = globalThis;

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
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  // ---------------------------------------------------------------- engine
  {
    // A move played on the live game while rankAsync is between slices must
    // not be interleaved with the search's own makeMove/undoMove.
    const fen = 'r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3';
    const g = new Chess(fen);
    const p = new Engine().rankAsync(g, 3, 800);
    await sleep(1);
    g.move('Bc4');
    await p;
    const want = new Chess(fen); want.move('Bc4');
    check('engine: a move during rankAsync leaves the board intact', g.fen() === want.fen(), g.fen());
    g.undoMove();
    check('engine: ...and it still undoes cleanly', g.fen() === fen, g.fen());
  }
  {
    // A depth where the deadline cut off any root move -- even the last -- is
    // not a finished depth.
    const e = new Engine(), g = new Chess();
    const orig = e.search, depthsSeen = [];
    let calls = 0;
    e.search = function (gg, d, a, b, stop) {
      calls++;
      if (d === 1 && calls > 20 + 19) throw { timeout: true };   // 20th root move at depth 2
      return orig.call(this, gg, d, a, b, stop);
    };
    const r = await e.rankAsync(g, 2, 5000, d => depthsSeen.push(d));
    check('engine: a depth cut short is not reported complete', depthsSeen.join() === '1', depthsSeen.join());
    check('engine: no candidate is ever -Infinity', r.every(x => Number.isFinite(x.score)),
          r.filter(x => !Number.isFinite(x.score)).map(x => x.san).join());
  }
  {
    const e = new Engine(), g = new Chess();
    e.search = function () { throw { timeout: true }; };   // nothing finishes, not even depth 1
    const r = await e.rankAsync(g, 3, 50);
    check('engine: with no depth finished, every move still has a finite score',
          r.length === 20 && r.every(x => Number.isFinite(x.score)), r.length);
    const s = new Engine(); s.search = e.search;
    const r2 = s.rank(g, 3, 50);
    check('engine: ...in the synchronous rank() too', r2.every(x => Number.isFinite(x.score)));
  }

  // ---------------------------------------------------------------- PGN / FEN
  {
    const p = Chess.parsePGN('[Event "x"]\n[Result "0-1"]\n\n1. e4 { [%eval 0.3] [%clk 0:03:00] } 1... e5 { [%eval 0.25] } 2. Nf3 0-1');
    check('pgn: [%eval] survives tag stripping', p.moves[0].comment && /%eval 0\.3/.test(p.moves[0].comment), p.moves[0].comment);
    check('pgn: a comment belongs to the move before it', p.moves[1].comment && /0\.25/.test(p.moves[1].comment) && !p.moves[2].comment,
          p.moves.map(m => m.comment).join(' | '));
    const games = Data.importPGN('[White "me"]\n[Black "them"]\n[Result "1-0"]\n\n1. e4 { [%eval 0.3] } e5 { [%eval 0.2] } 1-0\n', 'me');
    check('pgn: an imported game with %eval counts as analysed', games[0].analysed === true && games[0].moves[0].evalAfter === 30,
          games[0].analysed + ' ' + games[0].moves[0].evalAfter);
  }
  {
    const p = Chess.parsePGN('1. e4 e5 (1... c5 2. Nf3 (2. c3 d5) d6 3. d4) 2. Nf3 *');
    check('pgn: nested variations stay out of the main line', p.moves.map(m => m.san).join(' ') === 'e4 e5 Nf3', p.moves.map(m => m.san).join(' '));
    const c = Chess.parsePGN('1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. 0-0 Nf6 5. d3 d6 *');
    check('pgn: 0-0 is read as castling', c.moves.length === 10 && c.moves[6].san === 'O-O', c.moves.map(m => m.san).join(' '));
    const q = Chess.parsePGN('[FEN "7k/P7/8/8/8/8/8/K7 w - - 0 1"]\n[SetUp "1"]\n\n1. a8Q+ Kh7 *');
    check('pgn: a [FEN] start position is honoured, and a8Q reads as a8=Q', q.moves.length === 2 && q.moves[0].san === 'a8=Q+',
          q.moves.map(m => m.san).join(' '));
    const x = Chess.parsePGN('[Result "<img src=x onerror=alert(1)>"]\n\n1. e4 e5');
    check('pgn: a Result tag that is not a result is not passed through', x.result === '*', x.result);
  }
  {
    check('fen: a board with no side-to-move field is White to move', new Chess('8/8/8/8/8/8/8/K6k').turnColor() === 'w');
    let threw = null;
    try { new Chess('8/8/8/K6k w - - 0 1'); } catch (e) { threw = e.message; }
    check('fen: too few ranks is a clear error, not a TypeError', threw && !/Cannot read/.test(threw), threw);
    threw = null;
    try { new Chess('8/8/8/8/8/8/8/K5Xk w - - 0 1'); } catch (e) { threw = e.message; }
    check('fen: an unknown piece letter is refused', !!threw, threw);
  }
  {
    // A PGN of one player's games, no handle given: the player in every game is "me".
    const two = '[White "ermactually"]\n[Black "a"]\n[Result "1-0"]\n\n1. e4 e5 1-0\n\n' +
                '[White "b"]\n[Black "ermactually"]\n[Result "0-1"]\n\n1. d4 d5 0-1\n';
    const g0 = Data.importPGN(two, '');
    check('pgn import: with no handle, the recurring player is found in both colours',
          g0.map(g => g.myColor).join() === 'w,b' && g0.every(g => g.score === 1), g0.map(g => g.myColor + g.score).join());
    const g1 = Data.importPGN(two, 'someone-else');
    check('pgn import: a handle that matches nobody falls back the same way', g1.map(g => g.myColor).join() === 'w,b',
          g1.map(g => g.myColor).join());
  }

  // ---------------------------------------------------------------- analysis
  {
    // Ply 3 (White) has no eval; ply 4 (Black = me) must not be charged for
    // the swing White's unrecorded move caused.
    const fens = []; const g = new Chess();
    ['e4', 'e5', 'Nf3', 'Nc6'].forEach(s => { fens.push(g.fen()); g.move(s); });
    const mv = (san, color, ev, i) => ({ san, color, evalAfter: ev, fenBefore: fens[i] });
    const game = { id: 'gap', myColor: 'b', analysed: true, date: Date.now(), score: 0, moves: [
      mv('e4', 'w', 30, 0), mv('e5', 'b', 30, 1), mv('Nf3', 'w', undefined, 2), mv('Nc6', 'b', 400, 3)] };
    const errs = Analysis.mineErrors([game]);
    check('analysis: a missing eval does not charge the other side\'s move to me', errs.length === 0,
          errs.map(e => e.ply + ':' + e.cpLoss).join());
    const prof = Analysis.buildProfile([game], null, Date.now());
    check('analysis: ...nor does the phase breakdown', prof.phases.opening.totalLoss === 0, prof.phases.opening.totalLoss);
  }
  {
    let threw = null;
    try { Analysis.buildProfile([{ id: 1, date: Date.now(), myColor: 'w', score: 1 }], null, Date.now()); }
    catch (e) { threw = e.message; }
    check('analysis: a game without a move list does not throw', threw === null, threw);
    check('analysis: an ACPL of 0 is perfect play, not missing data', Analysis.eloFromAcpl(0) === 2900, Analysis.eloFromAcpl(0));
    check('analysis: ...and a missing ACPL is still missing', Analysis.eloFromAcpl(null) === null && Analysis.eloFromAcpl(NaN) === null);
  }
  {
    // Re1+ skewers the king to the queen behind it: the king must move, the queen falls.
    const motifs = Analysis.classifyMotifs('8/4q3/8/8/4k3/8/8/R5K1 w - - 0 1', 'Kh2', 'Re1+');
    check('analysis: king in front of the queen is a skewer, not a pin',
          motifs.indexOf('skewer') > -1 && motifs.indexOf('pin') < 0, motifs.join());
  }

  // ---------------------------------------------------------------- sparring
  {
    const profile = { calibration: { trueStrength: 2000 },
      phases: { opening: { plies: 100, blunders: 1 }, middlegame: { plies: 100, blunders: 1 }, endgame: { plies: 100, blunders: 1 } },
      style: { captureRate: 0.2, checkRate: 0.1, pawnMoveRate: 0.6, earlyQueenRate: 0.9, castlesEarly: 1, sampleMoves: 500 } };
    const m = new Sparring.Mirror(profile, { book: {}, targetElo: 2000, budgetMs: 150, maxDepth: 2 });
    const sans = [];
    const orig = m.styleBonus;
    m.styleBonus = function () { sans.push(arguments[0] && arguments[0].san); return orig.apply(this, arguments); };
    await m.chooseMove(new Chess(), 1);
    check('sparring: style habits see each candidate\'s SAN', sans.length > 0 && sans.every(Boolean),
          sans.filter(s => !s).length + ' of ' + sans.length + ' without SAN');
    const pawn = orig.call(m, { move: { captured: 0 }, san: 'e4' }, 1);
    check('sparring: a pawn-pusher\'s mirror prefers pawn moves', pawn > 0, pawn.toFixed(1));
  }

  // ---------------------------------------------------------------- training
  {
    // Needs a time zone whose clocks change between 25 Oct and 8 Nov 2026: run with
    // TZ=America/Toronto (clocks go back on 1 Nov), as CI does. In a zone without daylight
    // saving the dates are unique whatever the code does, so the check would prove nothing.
    const plans = Training.planRange(new Date(2026, 9, 25), 14, null, [], {});
    const dates = plans.map(p => p.date);
    const unique = new Set(dates).size;
    const name = 'training: 14 days across the clock change are 14 different dates';
    if (new Date(2026, 9, 25).getTimezoneOffset() === new Date(2026, 10, 8).getTimezoneOffset())
      skip(name, 'no clock change in this time zone (' + Intl.DateTimeFormat().resolvedOptions().timeZone + '); run with TZ=America/Toronto');
    else check(name, unique === 14 && dates[13] === '2026-11-07', dates.slice(5, 9).join(' ') + ' ... ' + dates[13]);
    const ics = Training.toICS(plans, { hour: 19 });
    const events = ics.split('BEGIN:VEVENT').length - 1;
    const stamps = (ics.match(/\r\nDTSTAMP:\d{8}T\d{6}Z/g) || []).length;
    check('training: every VEVENT carries the DTSTAMP RFC 5545 requires', events > 0 && stamps === events, stamps + '/' + events);
    const longest = Math.max(...ics.split('\r\n').map(l => Buffer.byteLength(l)));
    check('training: no .ics line is longer than 75 octets', longest <= 75, longest);
    const uids = ics.match(/UID:[^\r]+/g) || [];
    check('training: UIDs are unique', new Set(uids).size === uids.length, uids.length);
  }
  // ---------------------------------------------------------------- coach
  {
    const s = t => Coach.scoreJustification(t, {});
    check('coach: "prophylaxis" counts as thinking about the opponent', s('This is prophylaxis').opponentAwareness === 1, s('This is prophylaxis').opponentAwareness);
    check('coach: "the alternative" counts as a candidate', s('the alternative is to wait').candidates === 1, s('the alternative is to wait').candidates);
    check('coach: an evaluation symbol counts as an evaluation', s('after the exchange it is ±').evaluation === 1 && s('White is +- here').evaluation === 1,
          s('after the exchange it is ±').evaluation + ',' + s('White is +- here').evaluation);
    check('coach: an ordinary "or" is not a candidate list', s('I moved the knight because it was more active or so').candidates < 1,
          s('I moved the knight because it was more active or so').candidates);
    check('coach: "Nf3 or d4" is a candidate list', s('Nf3 or d4 here').candidates === 1, s('Nf3 or d4 here').candidates);
  }
  {
    const game = { id: 'c', myColor: 'w', openingName: 'Test Opening', moves: [] };
    const errs = [
      { gameId: 'c', phase: 'opening', moveNo: 9, cpLoss: 300, myColor: 'w', motifs: [] },
      { gameId: 'c', phase: 'opening', moveNo: 4, cpLoss: 120, myColor: 'w', motifs: [] }];
    const out = Coach.summarizeGame(game, [], errs, null);
    const opening = out.narrative[0];
    check('coach: the opening line names the first error, not the costliest', / at move 4\./.test(opening), opening);
    const turn = out.narrative.find(l => /further/i.test(l)) || '';
    check('coach: one further loss is called "One further"', /^One further/.test(turn), turn);
  }

  // ---------------------------------------------------------------- mistakes, judged by winning chances
  {
    const g = new Chess(); const fens = [];
    ['e4', 'e5', 'Nf3', 'Nc6'].forEach(s => { fens.push(g.fen()); g.move(s); });
    const game = (evals) => ({ id: 'wc', myColor: 'w', analysed: true, date: Date.now(), score: 0,
      moves: ['e4', 'e5', 'Nf3', 'Nc6'].map((san, i) => ({ san, color: i % 2 ? 'b' : 'w', evalAfter: evals[i], fenBefore: fens[i] })) });
    // Already lost at -7.6: Nf3 walks into mate. Lichess's own judgement: not a mistake, the game was gone.
    const lost = Analysis.mineErrors([game([-700, -760, -10000, -10000])]);
    check('mistakes: a move in an already lost position is not mined as a mistake', !lost.some(e => e.played === 'Nf3'),
          lost.map(e => e.played + ' ' + e.cpLoss + ' ' + e.severity).join());
    // Throwing away a winning position is exactly what a drill is for.
    const thrown = Analysis.mineErrors([game([30, 520, 0, 0])]);
    check('mistakes: throwing away a won position is mined, as a blunder',
          thrown.length === 1 && thrown[0].played === 'Nf3' && thrown[0].severity === 'blunder',
          thrown.map(e => e.played + ' ' + e.severity).join());
    // Near equality nothing changes: 30 -> -90 is 120 cp and a real (small) mistake.
    const small = Analysis.mineErrors([game([30, 30, -90, -90])]);
    check('mistakes: near equality a 120 cp slip still counts', small.length === 1, small.map(e => e.severity).join());
  }

  // ---------------------------------------------------------------- the analysis window
  {
    const now = Date.UTC(2026, 8, 26), DAY = 86400000;
    const g = (id, ageDays, score) => ({ id, date: now - ageDays * DAY, myColor: 'w', score, oppRating: 2000, moves: [] });
    const games = [g('new', 3, 1), g('mid', 60, 1), g('old', 400, 0)];
    const all = Analysis.calibrateStrength(games, null, now);
    check('window: with no window chosen, every game counts', all.windowGames === 3 && all.windowDays === 0,
          all.windowGames + ' games, windowDays ' + all.windowDays);
    const d90 = Analysis.calibrateStrength(games, null, now, 90);
    check('window: a 90-day window leaves out the 400-day-old game', d90.windowGames === 2 && d90.windowDays === 90, d90.windowGames);
    const d7 = Analysis.buildProfile(games, null, now, { windowDays: 7 });
    check('window: the whole profile follows the window, not just the rating', d7.calibration.windowGames === 1 && d7.windowDays === 7,
          d7.calibration.windowGames + ' / ' + d7.windowDays);
    const pre = [{ date: now - 400 * DAY, phase: 'opening', motifs: [], cpLoss: 200, gameId: 'old' },
                 { date: now - 3 * DAY, phase: 'opening', motifs: [], cpLoss: 150, gameId: 'new' }];
    const p = Analysis.buildProfile(games, null, now, { windowDays: 30, errors: pre });
    check('window: errors mined once can be passed in, and are cut to the window', p.errors.length === 1 && p.errors[0].gameId === 'new',
          p.errors.map(e => e.gameId).join());
  }
  {
    const urls = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = u => { urls.push(String(u)); return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve('') }); };
    await Data.fetchGames({ user: 'x', days: 0, perfType: 'all' });
    await Data.fetchGames({ user: 'x', days: 30, perfType: 'blitz' });
    globalThis.fetch = realFetch;
    const q0 = new URL(urls[0]).searchParams, q1 = new URL(urls[1]).searchParams;
    check('fetch: "all time" asks Lichess for the whole history', !q0.has('since'), q0.get('since'));
    check('fetch: "all" time controls means every standard-chess speed, no variants',
          q0.get('perfType') === 'ultraBullet,bullet,blitz,rapid,classical,correspondence', q0.get('perfType'));
    check('fetch: a chosen window and speed still pass through', q1.get('perfType') === 'blitz' &&
          Math.abs(+q1.get('since') - (Date.now() - 30 * 86400000)) < 60000, q1.get('perfType') + ' ' + q1.get('since'));
  }

  // ---------------------------------------------------------------- formats
  {
    // Lichess sorts a game by estimated duration: base + 40 x increment, in seconds.
    const want = { '15+0': 'ultraBullet', '60+1': 'bullet', '120+1': 'bullet', '180+0': 'blitz', '180+2': 'blitz',
                   '600+5': 'rapid', '1500+0': 'classical', '-': 'correspondence' };
    const got = {};
    Object.keys(want).forEach(tc => {
      const g = Data.importPGN('[White "me"]\n[Black "you"]\n[TimeControl "' + tc + '"]\n[Result "1-0"]\n\n1. e4 e5 1-0\n', 'me')[0];
      got[tc] = g.perf;
    });
    check('formats: a PGN\'s time control lands in the Lichess format it was played in',
          Object.keys(want).every(tc => got[tc] === want[tc]), JSON.stringify(got));
  }

  // ---------------------------------------------------------------- the Stockfish reader
  {
    const SR = require('../js/stockfish-reader.js');
    const i = SR.parseInfo('info depth 12 seldepth 17 multipv 1 score cp 114 nodes 110726 nps 30435 hashfull 51 time 3638 pv f1b5 a7a6 b5c6');
    check('reader: an info line gives depth, score and the line', i && i.depth === 12 && i.kind === 'cp' && i.value === 114 && i.pv.join() === 'f1b5,a7a6,b5c6',
          JSON.stringify(i));
    const bmc = SR.parseInfo('info depth 8 seldepth 9 multipv 1 score cp 178 nodes 5512 nps 14505 time 380 pv d2d4 e5d4 f3d4 d7d5 f1b5 bmc 1');
    check('reader: the trailing "bmc" Stockfish 10 writes does not hide the line', bmc && bmc.pv.join(' ') === 'd2d4 e5d4 f3d4 d7d5 f1b5',
          bmc && bmc.pv.join(' '));
    check('reader: a bound from a failed search window is not a score',
          SR.parseInfo('info depth 12 seldepth 17 multipv 1 score cp 100 lowerbound nodes 1 pv f1b5') === null);
    check('reader: scores turn to White\'s side when Black is to move', SR.whiteCp({ kind: 'cp', value: 50 }, false) === -50);
    const m3 = SR.whiteCp({ kind: 'mate', value: 3 }, true);
    check('reader: mate in 3 reads as #3 on the house engine\'s scale', Sparring.cpDisplay(m3) === '#3', Sparring.cpDisplay(m3));
    check('reader: being mated now is the bottom of the scale', SR.whiteCp({ kind: 'mate', value: 0 }, true) === -SR.MATE);

    // A scripted stand-in for the worker: answers each "go" for the position it was given.
    const sent = [];
    const answers = { 'w': ['info depth 9 multipv 1 score cp 30 pv e2e4 e7e5', 'bestmove e2e4'],
                      'b': ['info depth 9 multipv 1 score cp 20 pv e7e5', 'bestmove e7e5'] };
    let side = 'w';
    class FakeWorker {
      postMessage(cmd) {
        sent.push(cmd);
        const reply = l => setTimeout(() => this.onmessage({ data: l }), 5);
        if (cmd === 'isready') reply('readyok');
        if (cmd.startsWith('position fen')) side = cmd.split(' ')[3];
        if (cmd.startsWith('go')) answers[side].forEach((l, k) => setTimeout(() => this.onmessage({ data: l }), 10 + k));
      }
      terminate() {}
    }
    const realWorker = globalThis.Worker;
    globalThis.Worker = FakeWorker;
    const r = new SR.Reader('/* engine */');
    await r.start();
    const g = new Chess(); const f0 = g.fen(); g.move('e4'); const f1 = g.fen();
    const [a, b] = await Promise.all([r.read(f0, { movetime: 100 }), r.read(f1, { movetime: 100 })]);
    check('reader: positions are read in order, one at a time', a.best === 'e2e4' && b.best === 'e7e5' &&
          sent.filter(c => c.startsWith('go')).length === 2, a.best + ' ' + b.best);
    check('reader: Black-to-move scores come back from White\'s side', a.cp === 30 && b.cp === -20, a.cp + ' ' + b.cp);
    const dropped = r.read(f0, { movetime: 100 }), queued = r.read(f1, { movetime: 100 });
    r.clear();
    const d = await Promise.all([dropped, queued]);
    check('reader: clear() drops the queue and the position in hand', d[0] === null && d[1] === null, JSON.stringify(d));
    globalThis.Worker = realWorker;
  }

  // ---------------------------------------------------------------- deeper searches
  {
    // From depth 5 every root move scored +Infinity: null-move pruning with an
    // infinite window (beta = +Infinity, so beta - 1 is too) "failed high" on
    // nothing, and a mate in one was lost among equal infinities.
    const e = new Engine();
    const r = e.rank(new Chess('6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1'), 6, 20000);
    check('engine: a depth-6 search still plays the mate in one', r[0].san === 'Ra8#', r.slice(0, 2).map(x => x.san + ' ' + x.score).join(' | '));
    const m = new Engine().rank(new Chess('r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/2N2N2/PPPP1PPP/R1BQK2R w KQkq - 6 5'), 5, 60000);
    const shown = [3, 5].map(d => Sparring.cpDisplay(new Engine().rank(new Chess('6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1'), d, 20000)[0].score));
    check('engine: a mate in one is shown as #1, whatever the depth', shown.every(s => s === '#1'), shown.join(', '));
    check('engine: no score from a deep search is infinite', m.every(x => Number.isFinite(x.score)) && r.every(x => Number.isFinite(x.score)),
          m.filter(x => !Number.isFinite(x.score)).length + ' infinite');
  }

  // ---------------------------------------------------------------- timing a solution (test/tactics.js)
  {
    // The EPD suites time when the engine found its move from rank()'s onDepth. rankAsync
    // yields with setTimeout, which Windows rounds up to ~15 ms: nine times slower at depth 1.
    const seen = [];
    const fen = 'r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/2N2N2/PPPP1PPP/R1BQK2R w KQkq - 6 5';
    const r = new Engine().rank(new Chess(fen), 3, 0, (d, rs) => seen.push({ d, san: rs[0].san, score: rs[0].score }));
    check('engine: rank() reports each completed depth, in order', seen.map(s => s.d).join() === '1,2,3', seen.map(s => s.d).join());
    // The deadline was checked only when the shared node count hit a multiple of 512 on
    // entering search(); quiescence counts nodes without checking, so searches ran up to
    // 400 ms late and the engine lost fast games on time. Counted in nodes, not ms, so the
    // check doesn't depend on the machine: with the deadline already past, how far does it go?
    const epd = require('fs').readFileSync(require('path').join(__dirname, 'epd', 'wac.epd'), 'utf8').split('\n').filter(Boolean);
    let past = 0;
    epd.slice(0, 60).forEach(line => {
      const e = new Engine();
      e.keyAt = {};
      try { e.search(new Chess(line.split(' ').slice(0, 4).join(' ') + ' 0 1'), 6, -32000, 32000, 1); } catch (x) { if (!x.timeout) throw x; }
      past = Math.max(past, e.nodes);
    });
    check('engine: a search past its deadline stops within 1,000 nodes', past < 1000, past + ' nodes');
    check('engine: the last depth reported is the answer rank() returns',
          seen.length && seen[seen.length - 1].san === r[0].san && seen[seen.length - 1].score === r[0].score,
          JSON.stringify(seen[seen.length - 1]) + ' vs ' + r[0].san + ' ' + r[0].score);
  }

  // ---------------------------------------------------------------- two searches on one engine
  {
    // The sparring hint and the live advice share one engine. Each rankAsync installed
    // the positions of its own game on the engine for repetition, and a search that
    // started while another was between slices replaced them: the first one lost the
    // game's history, and a queen down it no longer saw ...Ng8 as the draw.
    const g = new Chess('rnb1kbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
    ['Nf3', 'Nf6', 'Ng1', 'Ng8', 'Nf3', 'Nf6', 'Ng1'].forEach(s => g.move(s));
    const e = new Engine();
    const [r] = await Promise.all([e.rankAsync(g, 3, 8000), e.rankAsync(new Chess(), 3, 8000)]);
    check('engine: a second search on the same engine leaves the first its repetitions',
          r[0].san === 'Ng8' && r[0].score === 0, r.slice(0, 2).map(x => x.san + ' ' + x.score).join(' | '));
  }

  // ---------------------------------------------------------------- tools/match.js and tools/sprt.js
  {
    // Both loops stopped at ply 200 before asking the rules, so a mate on the last ply was a draw.
    const mated = { gameOver: () => 'checkmate', turnColor: () => 'b', history: { length: Games.MAX_PLIES } };
    const end = Games.gameEnd(mated);
    check('tools: a mate on the last allowed ply is scored as a mate', end && end.result === '1-0', JSON.stringify(end));
    const quiet = n => ({ gameOver: () => null, turnColor: () => 'w', history: { length: n } });
    check('tools: the ply limit is a draw, and not a ply before it',
          Games.gameEnd(quiet(Games.MAX_PLIES)).result === '1/2-1/2' && Games.gameEnd(quiet(Games.MAX_PLIES - 1)) === null);

    // An opponent that exits at once crashed the match with an unhandled EPIPE on its stdin,
    // instead of aborting that game and reporting it. A relative script path does it: an
    // engine given by absolute path runs from its own folder, where tools/uci.js is not.
    const path = require('path');
    const run = require('child_process').spawnSync(process.execPath, [path.join(__dirname, '..', 'tools', 'match.js'),
      '--opponent', 'name=Broken cmd=' + process.execPath + ' arg=tools/uci.js', '--games', '2', '--concurrency', '2'],
      { encoding: 'utf8', timeout: 60000 });
    check('tools: an engine that dies at the start aborts its games, not the match',
          run.status === 0 && /2 aborted/.test(run.stdout), 'exit ' + run.status + ' ' + (run.stderr || '').split('\n')[0]);
  }

  // ================================================================ October 2026 audit
  {
    // A PGN set up from a position (a [FEN] tag) where White is already a rook down: the first
    // move is quiet and the eval does not move, so nothing was lost on it.
    const pgn = '[White "me"]\n[Black "them"]\n[Result "*"]\n[SetUp "1"]\n[FEN "r3k3/8/8/8/8/8/8/4K3 w - - 0 1"]\n\n' +
      '1. Kd2 { [%eval -5.0] } Ke7 { [%eval -5.0] } *\n';
    const games = Data.importPGN(pgn, 'me');
    const errs = Analysis.mineErrors(games), prof = Analysis.buildProfile(games, null, Date.now());
    const lost = prof.phases.opening.totalLoss + prof.phases.middlegame.totalLoss + prof.phases.endgame.totalLoss;
    check('analysis: a game set up from a FEN is not judged against the opening\'s +0.2',
      games.length === 1 && errs.length === 0 && lost === 0, errs.map(e => e.played + ' ' + e.cpLoss).join() + ' / ' + lost);
  }

  // ================================================================ 5 October 2026 audit
  {
    // chess.com exports put "Chess.com" in Site (the game's page is in Link); other tools write
    // "?" or a city. The id was Site's last segment, so every game in such a file had one id:
    // the second file imported was all "already loaded", and transcripts and drills keyed by id
    // ran games together.
    const game = (white, black, moves, tags) => '[Event "Live Chess"]\n' + (tags || '[Site "Chess.com"]\n') +
      '[White "' + white + '"]\n[Black "' + black + '"]\n[Result "*"]\n\n' + moves + ' *\n';
    const a = Data.importPGN(game('me', 'x', '1. e4 e5 2. Nf3') + '\n' + game('y', 'me', '1. d4 d5'), 'me');
    // The game-end test was /\b(...|\*)\s*$/, and there is no \b between a space and "*": a
    // game with an unknown result ("*", an unfinished or set-up game) swallowed the next one.
    check('pgn: a game ending "*" does not swallow the game after it',
      a.length === 2 && a[0].moves.length === 3 && a[1].moves.length === 2, a.map(g => g.moves.length).join());
    const b = Data.importPGN(game('me', 'z', '1. c4 e5'), 'me');
    const ids = a.concat(b).map(g => g.id);
    check('pgn: games from a file whose Site is not a link get an id each',
      ids.length === 3 && new Set(ids).size === 3, ids.join());
    const again = Data.importPGN(game('me', 'z', '1. c4 e5'), 'me');
    // On the old code every game here was "Chess.com", so "the same id" alone passed there too:
    // the id must also be the game's own, not Site's, and not another game's.
    check('pgn: ...and the same game imported again has the same id, its own',
      again[0].id === b[0].id && again[0].id !== 'Chess.com' && again[0].id !== a[0].id && again[0].id !== a[1].id,
      again[0].id + ' vs ' + a.map(g => g.id).join());
    const linked = Data.importPGN(game('me', 'x', '1. e4', '[Site "Chess.com"]\n[Link "https://www.chess.com/game/live/123456"]\n'), 'me');
    check('pgn: a chess.com game is known by its Link', linked[0].id === '123456' && /chess\.com\/game/.test(linked[0].url), linked[0].id);
    const li = Data.importPGN(game('me', 'x', '1. e4', '[Site "https://lichess.org/AbCd1234"]\n'), 'me');
    check('pgn: a Lichess game keeps its id from Site', li[0].id === 'AbCd1234' && li[0].url === 'https://lichess.org/AbCd1234', li[0].id);
  }
  {
    // The transcript is keyed by the 0-based ply. The prompt numbered moves Math.ceil(ply / 2),
    // so White's first move was "Move 0" and every White move one behind the board.
    const g = { myColor: 'w', result: '1-0', openingName: 'x', moves: [] };
    const t = { 0: { san: 'e4', text: 'a' }, 1: { san: 'e5', text: 'b' }, 2: { san: 'Nf3', text: 'c' }, 3: { san: 'Nc6', text: 'd' } };
    const nums = Coach.buildPrompt(g, t, {}, null).split('\n').filter(l => /^- Move/.test(l)).map(l => l.match(/Move (\d+)/)[1]);
    check('coach: the prompt numbers moves as the board does', nums.join() === '1,1,2,2', nums.join());
  }
  {
    // An answer with no text (a refusal, a max_tokens stop before any text) was shown as an
    // empty verdict box.
    const keep = globalThis.fetch;
    globalThis.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve({ content: [], stop_reason: 'refusal' }) });
    const msg = await Coach.callLLM('p', { apiKey: 'k' }).then(t => 'resolved ' + JSON.stringify(t), e => e.message);
    globalThis.fetch = keep;
    check('coach: an answer with no text is an error that says why, not an empty verdict', /refusal/.test(msg), msg);
  }

  // ================================================================ 9 October 2026 audit
  {
    // A move the parser could not read was skipped, and the game went on from the wrong
    // position: here 2. Qxf7 is impossible, so "Nc6" was played by White.
    let err = null;
    try { Chess.parsePGN('1. e4 e5 2. Qxf7 Nc6 *'); } catch (e) { err = e; }
    check('pgn: a move that cannot be read is an error that names it, not skipped', err && /Qxf7/.test(err.message), err ? err.message : 'no error');
    // ...and the importer skips that game and keeps the others.
    const two = '[White "me"]\n[Black "x"]\n[Result "*"]\n\n1. e4 e5 2. Qxf7 Nc6 *\n\n' +
      '[White "me"]\n[Black "y"]\n[Result "*"]\n\n1. d4 d5 *\n';
    let imported = null;
    try { imported = Data.importPGN(two, 'me'); } catch (e) { imported = e.message; }
    check('pgn: the importer skips a game with an unreadable move and keeps the rest',
          Array.isArray(imported) && imported.length === 1 && imported[0].moves.length === 2, JSON.stringify(imported && imported.length));
    const sans = p => p.moves.map(m => m.san).join(' ');
    const semi = Chess.parsePGN('1. e4 e5 ; 2. Nc3 was the other try\n2. Nf3 Nf6 *');
    check('pgn: a ";" comment runs to the end of the line', sans(semi) === 'e4 e5 Nf3 Nf6', sans(semi));
    const pct = Chess.parsePGN('1. e4 e5\n% d4 is an escape line, not a move\n2. Nf3 *');
    check('pgn: a "%" escape line is skipped', sans(pct) === 'e4 e5 Nf3', sans(pct));
    const lower = Chess.parsePGN('[FEN "8/4P3/8/8/8/k7/8/K7 w - - 0 1"]\n\n1. e8=q Kb3 2. Qe3+ *');
    check('pgn: a lowercase promotion piece (e8=q)', sans(lower) === 'e8=Q Kb3 Qe3+', sans(lower));
    const lan = Chess.parsePGN('1. e4 e5 2. Ng1f3 Nb8-c6 3. Bf1-b5 a7a6 4. Bb5xc6 dxc6 *');
    check('pgn: long algebraic with the from-square (Ng1f3, Nb8-c6, Bb5xc6)', sans(lan) === 'e4 e5 Nf3 Nc6 Bb5 a6 Bxc6 dxc6', sans(lan));
    const multi = Chess.parsePGN('[Event "a"]\n\n1. e4 e5 1-0\n\n[Event "b"]\n\n1. d4 d5 0-1');
    check('pgn: two games in one string: the first one, its own tags and result',
          sans(multi) === 'e4 e5' && multi.tags.Event === 'a' && multi.result === '1-0', sans(multi) + ' / ' + multi.tags.Event + ' / ' + multi.result);
  }
  {
    // Quiescence stood pat in check: Black's queen on a8 is forked by the knight and the
    // static score counted it as safe; and a mating capture scored as the rook it won.
    const e = new Engine();
    const fork = e.quiesce(new Chess('q3k3/2N5/8/8/8/8/8/6K1 b - - 0 1'), -Infinity, Infinity, 4);
    check('engine: quiescence in check searches the evasions instead of standing pat', fork < 0, fork);
    const mate = e.quiesce(new Chess('1r4k1/5ppp/8/8/8/8/5PPP/1R4K1 w - - 0 1'), -Infinity, Infinity, 4);
    check('engine: quiescence sees a mate (Rxb8#)', Engine.mateIn(mate) === 1, mate);
    // The deadline was checked in search() only, so a long quiescence tree ran on past it.
    const q = new Engine(); q.clockTicks = 127;   // the next tick reads the clock
    let threw = null;
    try { q.quiesce(new Chess('r1q1k2r/1Q3Q2/2Q3Q1/8/8/1q3q2/2q3q1/R3K2R w KQkq - 0 1'), -Infinity, Infinity, 4, 1); } catch (x) { threw = x; }
    check('engine: quiescence checks the deadline too', !!(threw && threw.timeout), JSON.stringify(threw));
    // Anything above 9000 read as a mate: eight extra queens is about +9700.
    const r = new Engine().rank(new Chess('QQQQQQQQ/1Q6/8/8/8/5k2/8/K7 w - - 0 1'), 2, 0);
    const fake = r.filter(x => Engine.mateIn(x.score) !== null && Math.abs(x.score) < 29000);
    check('engine: a large material score is not read as a mate', Engine.mateIn(9725) === null && fake.length === 0,
          fake.map(x => x.san + ' ' + x.score).join());
  }
  {
    // tools/sprt.js and tools/match.js, required in a child: before the fix, requiring them ran them.
    const path = require('path'), cp = require('child_process');
    const probe = (file, expr) => {
      const code = 'globalThis.window = globalThis; const m = require(' + JSON.stringify(path.join(__dirname, '..', 'tools', file)) +
        '); console.log(JSON.stringify(' + expr + '));';
      const out = cp.spawnSync(process.execPath, ['-e', code], { encoding: 'utf8', timeout: 20000 });
      try { return JSON.parse(out.stdout.trim().split('\n').pop()); } catch (e) { return null; }
    };
    // The LLR was 0 whenever either side had no win, so a clean sweep never decided.
    const llr = probe('sprt.js', '[m.llr(60, 40, 0, 0, 20), m.llr(0, 40, 60, 0, 20), m.llr(0, 40, 0, 0, 20)]');
    const up = Math.log(0.95 / 0.05), down = Math.log(0.05 / 0.95);
    check('tools: SPRT accepts H1 at +60 =40 -0 and H0 at +0 =40 -60',
          llr && llr[0] >= up && llr[1] <= down && llr[2] === 0, JSON.stringify(llr));
    // The default house engine was a spec string re-split on spaces: Node under
    // "C:\Program Files" became cmd=C:\Program.
    const house = probe('match.js', 'm.house');
    check('tools: match.js runs the default house engine with Node\'s own path, spaces and all',
          house && house.cmd === process.execPath && house.args.length === 1 && /uci\.js$/.test(house.args[0]), JSON.stringify(house));
  }
  {
    // tools/uci.js: the FEN ran six tokens, so "position fen <4 fields> moves ..." read "moves"
    // as a FEN field and dropped the moves; the search blocked the input, so isready went
    // unanswered and stop did nothing; "go infinite" and "go nodes" were ignored.
    // The time limits are loose on purpose: the old code never answered at all (20 s), and a
    // busy machine or CI runner can take a few hundred ms to schedule the reply.
    const path = require('path');
    const p = require('child_process').spawn(process.execPath, [path.join(__dirname, '..', 'tools', 'uci.js')]);
    const lines = [], t0 = Date.now();
    let buf = '', exitedAt = null;
    p.stdout.setEncoding('utf8');
    p.stdout.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { lines.push({ at: Date.now() - t0, text: buf.slice(0, i).trim() }); buf = buf.slice(i + 1); } });
    p.on('exit', () => { exitedAt = Date.now() - t0; });
    const send = l => { try { p.stdin.write(l + '\n'); } catch (e) { /* gone */ } };
    const waitFor = async (re, ms, from) => {
      const end = Date.now() + ms;
      for (;;) {
        const hit = lines.slice(from || 0).find(l => re.test(l.text));
        if (hit || Date.now() > end || exitedAt !== null) return hit || null;
        await sleep(10);
      }
    };
    send('uci'); await waitFor(/^uciok/, 20000);
    send('position fen 4k3/8/8/8/8/8/8/R3K3 w Q - moves e1c1 e8e7'); send('go depth 2');
    const b1 = await waitFor(/^bestmove/, 20000);
    const after = new Chess('4k3/8/8/8/8/8/8/R3K3 w Q - 0 1'); after.move('e1c1'); after.move('e8e7');
    const mv = b1 && b1.text.split(/\s+/)[1];
    check('uci: "position fen" with four fields still plays the moves after it',
          !!mv && after.generate().some(m => m.fromSq + m.toSq === mv.slice(0, 4)), b1 && b1.text);
    let from = lines.length;
    send('position startpos'); send('go infinite'); await sleep(150);
    const asked = Date.now() - t0; send('isready');
    const ready = await waitFor(/^readyok/, 3000, from);
    const early = lines.slice(from).find(l => /^bestmove/.test(l.text));
    check('uci: isready is answered during a search', ready && ready.at - asked < 1000 && !early,
          ready ? (ready.at - asked) + ' ms' + (early ? ', after a bestmove' : '') : 'no readyok');
    await sleep(1500);
    const tooSoon = lines.slice(from).find(l => /^bestmove/.test(l.text));
    check('uci: "go infinite" sends no bestmove before stop', !tooSoon, tooSoon && tooSoon.text + ' at ' + tooSoon.at + ' ms');
    from = lines.length; const stopped = Date.now() - t0; send('stop');
    const b2 = await waitFor(/^bestmove/, 3000, from);
    check('uci: stop ends the search with a bestmove at once', b2 && b2.at - stopped < 1000, b2 ? (b2.at - stopped) + ' ms' : 'none');
    from = lines.length; send('go nodes 3000');
    await waitFor(/^bestmove/, 10000, from);
    const info = lines.slice(from).find(l => /^info .*\bnodes (\d+)/.test(l.text));
    const nodes = info ? +info.text.match(/\bnodes (\d+)/)[1] : NaN;
    check('uci: "go nodes N" stops at N nodes', nodes > 0 && nodes <= 3000, info && info.text);
    send('go infinite'); await sleep(150);
    const quitAt = Date.now() - t0; send('quit');
    for (let i = 0; i < 300 && exitedAt === null; i++) await sleep(10);
    check('uci: quit during a search exits at once', exitedAt !== null && exitedAt - quitAt < 1500,
          exitedAt === null ? 'still running' : (exitedAt - quitAt) + ' ms');
    if (exitedAt === null) p.kill();
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed' + (skipped ? ', ' + skipped + ' skipped' : ''));
  process.exitCode = failed ? 1 : 0;
})();
