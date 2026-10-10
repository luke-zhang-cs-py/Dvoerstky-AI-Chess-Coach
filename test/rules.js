// The special rules, one at a time: castling rights, en passant, promotion, the
// fifty-move rule, threefold repetition, dead positions -- and whether the
// engine's search knows about the draws. Perft proves the move generator
// matches Stockfish in bulk; this names each rule so a failure says which.
//   node test/rules.js
globalThis.window = globalThis;
const Chess = require('../js/core.js');
const Engine = require('../js/engine.js');

let passed = 0, failed = 0;
function check(name, ok, detail) {
  ok ? passed++ : failed++;
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail !== undefined ? '  [' + detail + ']' : ''));
}
const sans = g => g.generate().map(m => g.san(m));
const play = (g, list) => list.forEach(s => { if (!g.move(s)) throw new Error('illegal in test: ' + s); });

// ---------------------------------------------------------------- castling
{
  const g = new Chess('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1');
  check('castling: both sides available with full rights', sans(g).includes('O-O') && sans(g).includes('O-O-O'));
  g.move('O-O');
  check('castling: the rook lands on f1 and the king on g1', g.get('g1') && g.get('g1').type === 'k' && g.get('f1') && g.get('f1').type === 'r');
  const k = new Chess('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1');
  play(k, ['Ke2', 'Ke7', 'Ke1', 'Ke8']);
  check('castling: a king that moved and came back has lost both rights', !sans(k).some(s => s.startsWith('O-O')), sans(k).filter(s => s.startsWith('O')).join());
  const r = new Chess('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1');
  play(r, ['Rh2', 'Rh7', 'Rh1', 'Rh8']);
  check('castling: a rook that moved loses only its own side', !sans(r).includes('O-O') && sans(r).includes('O-O-O'), sans(r).filter(s => s.startsWith('O')).join());
  const c = new Chess('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1');
  play(c, ['Rxa8+']);
  check('castling: capturing a rook on its square ends that right for the other side', !c.fen().split(' ')[2].includes('q'), c.fen().split(' ')[2]);
  check('castling: never out of check', !sans(new Chess('4k3/8/8/8/8/8/4r3/R3K2R w KQ - 0 1')).some(s => s.startsWith('O-O')));
  check('castling: never through an attacked square', !sans(new Chess('4k3/8/8/8/8/8/5r2/R3K2R w KQ - 0 1')).includes('O-O'));
  check('castling: never into check', !sans(new Chess('4k3/8/8/8/8/8/6r1/R3K2R w KQ - 0 1')).includes('O-O'));
  check('castling: queenside is allowed with b1 attacked (the king never crosses it)',
        sans(new Chess('4k3/8/8/8/8/8/1r6/R3K2R w KQ - 0 1')).includes('O-O-O'));
}

// ---------------------------------------------------------------- en passant
{
  const g = new Chess('4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1');
  check('en passant: available straight after the double push', sans(g).includes('exd6'));
  g.move('exd6');
  check('en passant: the captured pawn leaves d5, not d6', !g.get('d5') && g.get('d6').type === 'p');
  const late = new Chess('4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1');
  play(late, ['Kd1', 'Kd8']);
  check('en passant: gone one move later', !sans(late).includes('exd6'));
  check('en passant: not when it would expose the king along the rank',
        !sans(new Chess('8/8/8/K2pP2r/8/8/8/7k w - d6 0 1')).includes('exd6'));
  // e5 is pinned to the king on b2 by the bishop on h8; exd6 would leave the diagonal
  check('en passant: not when the capturing pawn is pinned on a diagonal',
        !sans(new Chess('4k2b/8/8/3pP3/8/8/1K6/8 w - d6 0 1')).includes('exd6'));
  check('en passant: ...but the same capture is fine with no pin',
        sans(new Chess('4k3/8/8/3pP3/8/8/1K6/8 w - d6 0 1')).includes('exd6'));
  // A FEN's en passant square was taken on trust. With no black pawn on e5, d5xe6 "en passant"
  // emptied e5 and undoing it put a black pawn there from nowhere.
  const ghost = new Chess('4k3/8/8/3P4/8/8/8/4K3 w - e6 0 1');
  const ghostBefore = ghost.fen();
  const ghostEp = ghost.generate().filter(m => m.flags & Chess.FLAG.EP);
  check('en passant: a FEN square with no pawn that just passed is dropped, and nothing is added',
        ghostEp.length === 0 && ghost.fen() === ghostBefore && ghostBefore.split(' ')[3] === '-', ghostBefore);
  // e3 is Black's en passant square, not White's: d2xe3 "en passant" removed White's own queen on e2.
  const own = new Chess('4k3/8/8/8/8/8/3PQ3/4K3 w - e3 0 1');
  const ownEp = own.generate().filter(m => m.flags & Chess.FLAG.EP);
  check('en passant: a square on the wrong rank is dropped, and the queen stays', ownEp.length === 0 &&
        own.generate().every(m => { own.makeMove(m); const q = own.get('e2') || own.get(m.toSq); own.undoMove(); return q; }),
        ownEp.map(m => m.fromSq + m.toSq).join());
  // The generator itself asks for the pawn too, whatever set the square.
  const raw = new Chess('4k3/8/8/3P4/8/8/8/4K3 w - - 0 1');
  raw.ep = Chess.sq0x88('e6');
  check('en passant: the generator needs an enemy pawn beside the capturing one', !raw.generate().some(m => m.flags & Chess.FLAG.EP));
}

// ---------------------------------------------------------------- the FEN itself
{
  const refuses = fen => { try { new Chess(fen); return false; } catch (e) { return true; } };
  // King on d1 with a K right: "O-O" took the king to f1 and the g1 rook to e1.
  const off = new Chess('4k3/8/8/8/8/8/8/3K2R1 w K - 0 1');
  check('fen: a castling right without king and rook at home is dropped',
        !sans(off).some(s => s.startsWith('O-O')) && off.fen().split(' ')[2] === '-', off.fen());
  const rookOff = new Chess('r3k2r/8/8/8/8/8/7R/R3K3 w KQkq - 0 1');
  check('fen: ...per side: no rook on h1, no K, the rest kept', rookOff.fen().split(' ')[2] === 'Qkq', rookOff.fen());
  check('fen: a rank of more than 8 squares is refused (p8, 45)',
        refuses('4k3/p8/8/8/8/8/8/4K3 w - - 0 1') && refuses('4k3/45/8/8/8/8/8/4K3 w - - 0 1'));
  check('fen: a rank of fewer than 8 squares is refused', refuses('4k3/7/8/8/8/8/8/4K3 w - - 0 1'));
  check('fen: the side to move must be w or b', refuses('4k3/8/8/8/8/8/8/4K3 x - - 0 1'));
  check('fen: the en passant field must be a square', refuses('4k3/8/8/8/8/8/8/4K3 w - e9 0 1') && refuses('4k3/8/8/8/8/8/8/4K3 w - zz 0 1'));
  check('fen: exactly one king a side', refuses('8/8/8/8/8/8/8/8 w - - 0 1') && refuses('4k3/8/8/8/8/8/8/3KK3 w - - 0 1') &&
        refuses('8/8/8/8/8/8/8/4K3 w - - 0 1'));
  check('fen: the halfmove clock must be a whole number, not negative', refuses('4k3/8/8/8/8/8/8/4K3 w - - -5 1') &&
        refuses('4k3/8/8/8/8/8/8/4K3 w - - x 1'));
}

// ---------------------------------------------------------------- promotion
{
  const g = new Chess('4k3/1P6/8/8/8/8/8/4K3 w - - 0 1');
  const promos = sans(g).filter(s => s.startsWith('b8'));
  check('promotion: all four pieces are offered', ['b8=Q+', 'b8=R+', 'b8=B', 'b8=N'].every(s => promos.includes(s)), promos.join(' '));
  const x = new Chess('r3k3/1P6/8/8/8/8/8/4K3 w - - 0 1');
  check('promotion: capturing and promoting at once', sans(x).includes('bxa8=Q+'), sans(x).filter(s => s.includes('=')).join(' '));
  check('promotion: a pawn on the seventh cannot just step forward', !sans(g).includes('b8'));
  x.move('bxa8=N');
  check('promotion: the chosen piece is the one that appears', x.get('a8').type === 'n');
}

// ---------------------------------------------------------------- the fifty-move rule
{
  const g = new Chess('4k3/8/8/8/8/8/4P3/R3K3 w - - 98 80');
  g.move('Ra2');
  check('fifty moves: not yet at 99 plies', g.gameOver() !== 'fifty', g.halfmoves);
  g.move('Kd8');
  check('fifty moves: drawn at 100 plies without a capture or pawn move', g.gameOver() === 'fifty', g.gameOver());
  const p = new Chess('4k3/8/8/8/8/8/4P3/R3K3 w - - 99 80');
  p.move('e4');
  check('fifty moves: a pawn move resets the count', p.halfmoves === 0 && p.gameOver() !== 'fifty', p.halfmoves);
  const m = new Chess('7k/8/6K1/8/8/8/8/R7 w - - 99 80');
  m.move('Ra8#');
  check('fifty moves: mate on the hundredth ply is still mate', m.gameOver() === 'checkmate', m.gameOver());
}

// ---------------------------------------------------------------- threefold repetition
{
  const base = 'rnbqkbnr/ppppppp1/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';   // White a pawn up
  const g = new Chess(base);
  play(g, ['Nf3', 'Nf6', 'Ng1', 'Ng8']);
  check('repetition: twice is not a draw', g.gameOver() !== 'repetition', g.gameOver());
  play(g, ['Nf3', 'Nf6', 'Ng1', 'Ng8']);
  check('repetition: the third time is a draw', g.gameOver() === 'repetition', g.gameOver());
  check('repetition: counting leaves the game exactly as it was', g.fen() === new Chess(base).fen().replace(' 0 1', ' 8 5'), g.fen());
  const c = new Chess('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1');
  play(c, ['Ke2', 'Ke7', 'Ke1', 'Ke8', 'Ke2', 'Ke7', 'Ke1', 'Ke8']);
  check('repetition: the same squares with fewer castling rights are a different position',
        c.gameOver() !== 'repetition', c.gameOver());
  // after 1.e4 there is an en passant square in the FEN but no capture onto it
  const e = new Chess('4k3/8/8/8/8/8/4P3/4K1N1 w - - 0 1');
  play(e, ['e4', 'Kd7', 'Nf3', 'Ke8', 'Ng1', 'Kd7', 'Nf3', 'Ke8', 'Ng1']);
  check('repetition: an en passant square nobody can use does not make positions differ',
        e.gameOver() === 'repetition', e.gameOver());
}

// ---------------------------------------------------------------- dead positions
{
  check('dead: king against king', new Chess('4k3/8/8/8/8/8/8/4K3 w - - 0 1').gameOver() === 'material');
  check('dead: a lone knight', new Chess('4k3/8/8/8/8/8/8/4KN2 w - - 0 1').gameOver() === 'material');
  check('dead: a lone bishop', new Chess('4k3/8/8/8/8/8/8/4KB2 w - - 0 1').gameOver() === 'material');
  check('dead: bishops on the same colour, one each', new Chess('4kb2/8/8/8/8/8/8/2B1K3 w - - 0 1').gameOver() === 'material',
        new Chess('4kb2/8/8/8/8/8/8/2B1K3 w - - 0 1').gameOver());
  check('not dead: bishops on opposite colours can still mate', new Chess('4k1b1/8/8/8/8/8/8/2B1K3 w - - 0 1').gameOver() === null);
  check('not dead: a single pawn', new Chess('4k3/8/8/8/8/8/4P3/4K3 w - - 0 1').gameOver() === null);
  check('stalemate is not mate', new Chess('7k/5Q2/6K1/8/8/8/8/8 b - - 0 1').gameOver() === 'stalemate');
}

// ---------------------------------------------------------------- the endgame studies are real positions
{
  require('../js/training.js');
  const illegal = globalThis.Training.ENDGAMES.filter(e => e.fen).filter(e => {
    const g = new Chess(e.fen), them = g.turn === Chess.WHITE ? Chess.BLACK : Chess.WHITE;
    return g.kings[them] < 0 || g.attacked(g.turn, g.kings[them]);   // the side not to move may not be in check
  }).map(e => e.id);
  check('studies: every endgame position could arise in a game', illegal.length === 0, illegal.join());
}

// ---------------------------------------------------------------- the engine knows the draws
{
  // Black is a queen down and can repeat the position a third time with ...Ng8: a draw beats -9.
  const g = new Chess('rnb1kbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
  play(g, ['Nf3', 'Nf6', 'Ng1', 'Ng8', 'Nf3', 'Nf6', 'Ng1']);
  const r = new Engine().rank(g, 3, 4000);
  check('engine: a queen down, it takes the threefold repetition', r[0].san === 'Ng8' && r[0].score === 0,
        r.slice(0, 3).map(x => x.san + ' ' + x.score).join(' | '));
  check('engine: searching leaves the game untouched', g.history.length === 7, g.history.length);

  // The same shuffle with Black a queen *up*: ...Ng8 is a draw, which is the last thing it wants.
  const w = new Chess('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNB1KBNR w KQkq - 0 1');
  play(w, ['Nf3', 'Nf6', 'Ng1', 'Ng8', 'Nf3', 'Nf6', 'Ng1']);
  const r2 = new Engine().rank(w, 3, 4000);
  const draw = r2.find(x => x.san === 'Ng8');
  check('engine: a queen up, it sees ...Ng8 as the draw it is and plays something else',
        r2[0].san !== 'Ng8' && draw && draw.score === 0, r2.slice(0, 2).map(x => x.san + ' ' + x.score).join(' | ') + ' | Ng8 ' + (draw && draw.score));
}

// ---------------------------------------------------------------- verbose moves
{
  const g = new Chess('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1');
  const v = g.moves({ verbose: true });
  check('moves: verbose moves carry their SAN, castling and checks included',
        v.length === g.generate().length && v.some(m => m.san === 'O-O-O') && v.some(m => m.san === 'Rxa8+') && v.every(m => m.san === g.san(m)),
        v.slice(0, 4).map(m => m.san).join());
  check('moves: without verbose they carry none', g.moves().every(m => m.san === undefined));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exitCode = failed ? 1 : 0;
