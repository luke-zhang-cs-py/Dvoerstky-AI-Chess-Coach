// Regression checks for bugs found in the September 2026 audit. One check per
// bug, each written to fail on the code before its fix. Run: node test/regress.js
globalThis.window = globalThis;
require('../js/core.js'); require('../js/engine.js'); require('../js/data.js');
require('../js/analysis.js'); require('../js/training.js'); require('../js/coach.js');
require('../js/sparring.js');
const { Chess, Engine, Analysis, Training, Coach, Sparring, Data } = globalThis;

let failed = 0, passed = 0;
function check(name, ok, detail) {
  if (ok) passed++; else failed++;
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail !== undefined ? '  [' + detail + ']' : ''));
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
    // Run with TZ=America/Toronto: clocks go back on 1 Nov 2026.
    const plans = Training.planRange(new Date(2026, 9, 25), 14, null, [], {});
    const dates = plans.map(p => p.date);
    const unique = new Set(dates).size;
    check('training: 14 days across the clock change are 14 different dates', unique === 14 && dates[13] === '2026-11-07',
          dates.slice(5, 9).join(' ') + ' ... ' + dates[13]);
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
    check('coach: one further loss is not called "two"', !/^Two further/.test(turn) || out.turningPoints.length === 3, turn);
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

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exitCode = failed ? 1 : 0;
})();
