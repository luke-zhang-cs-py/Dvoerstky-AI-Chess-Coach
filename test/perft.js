const Chess = require('../js/core.js');

function perft(g, depth) {
  if (depth === 0) return 1;
  const ms = g.generate();
  if (depth === 1) return ms.length;
  let n = 0;
  for (const m of ms) { g.makeMove(m); n += perft(g, depth - 1); g.undoMove(); }
  return n;
}

const suites = [
  ['startpos', Chess.START, [20, 400, 8902, 197281]],
  ['kiwipete', 'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1', [48, 2039, 97862]],
  ['pos3', '8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1', [14, 191, 2812, 43238]],
  ['pos4', 'r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1', [6, 264, 9467]],
  ['pos5', 'rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8', [44, 1486, 62379]],
  ['pos6', 'r4rk1/1pp1qppp/p1np1n2/2b1p1B1/2B1P1b1/P1NP1N2/1PP1QPPP/R4RK1 w - - 0 10', [46, 2079, 89890]],
];

let fail = 0;
for (const [name, fen, expected] of suites) {
  for (let d = 1; d <= expected.length; d++) {
    const g = new Chess(fen);
    const got = perft(g, d);
    const ok = got === expected[d - 1];
    if (!ok) fail++;
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name} d${d}: got ${got} want ${expected[d - 1]}`);
  }
}

// SAN + PGN roundtrip
const pgnTest = `[Event "Test"][White "A"][Black "B"][Result "1-0"]
1. e4 c6 2. d4 d5 3. Nc3 dxe4 4. Nxe4 Bf5 5. Ng3 Bg6 6. h4 h6 7. Nf3 Nd7 8. h5 Bh7 9. Bd3 Bxd3 10. Qxd3 e6 11. Bf4 Ngf6 12. O-O-O Be7 13. Ne4 Qa5 14. Kb1 O-O 1-0`;
const parsed = Chess.parsePGN(pgnTest);
console.log(`${parsed.moves.length === 28 ? 'PASS' : 'FAIL'} pgn moves: ${parsed.moves.length} (want 28)`);
console.log(`${parsed.moves[22].san === 'O-O-O' ? 'PASS' : 'FAIL'} long castling san: ${parsed.moves[22].san}`);
console.log(`${parsed.moves[27].san === 'O-O' ? 'PASS' : 'FAIL'} short castling san: ${parsed.moves[27].san}`);

// underpromotion + ep
const g2 = new Chess('8/1P6/8/2pP4/8/8/8/K6k w - c6 0 1');
const sans = g2.moves().map(m => g2.san(m)).sort();
console.log(`${sans.includes('dxc6') ? 'PASS' : 'FAIL'} en passant san present`);
console.log(`${sans.includes('b8=N+') || sans.includes('b8=N') ? 'PASS' : 'FAIL'} underpromotion present`);

console.log(fail === 0 ? '\nALL PERFT PASS' : `\n${fail} FAILURES`);
