// Benchmark: a fixed search of fixed positions, like Stockfish's `bench`.
//   node tools/bench.js [depth]        (default depth 4)
// Prints nodes per second, and a signature: the total node count. The search
// has no clock here, so the count is exactly the same on any machine, and it
// changes only when the search itself does. A speed-only change keeps the
// signature and moves NPS; a pruning change moves the signature.
globalThis.window = globalThis;
const Chess = require('../js/core.js');
const Engine = require('../js/engine.js');

const DEPTH = +(process.argv[2] || 4);
const POSITIONS = [
  ['start', 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'],
  ['kiwipete', 'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1'],
  ['italian', 'r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/2N2N2/PPPP1PPP/R1BQK2R w KQkq - 6 5'],
  ['caro-kann advance', 'rn1qkbnr/pp2pppp/2p5/3pPb2/3P4/8/PPP2PPP/RNBQKBNR w KQkq - 1 4'],
  ['qgd middlegame', 'r1bq1rk1/pp1nbppp/2p1pn2/3p2B1/2PP4/2NBPN2/PP3PPP/R2QK2R w KQ - 2 8'],
  ['open middlegame', 'r4rk1/1pp1qppp/p1np1n2/2b1p1B1/2B1P1b1/P1NP1N2/1PP1QPPP/R4RK1 w - - 0 10'],
  ['rook endgame', '8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1'],
  ['pawn endgame', '8/8/4k3/3p4/3P4/4K3/8/8 w - - 0 1'],
];

let nodes = 0, ms = 0;
console.log(`depth ${DEPTH}\n`);
for (const [name, fen] of POSITIONS) {
  const e = new Engine();                       // a fresh table each time, so every run is the same
  const t0 = process.hrtime.bigint();
  const r = e.rank(new Chess(fen), DEPTH, 0);    // 0: no deadline
  const took = Number(process.hrtime.bigint() - t0) / 1e6;
  nodes += e.nodes; ms += took;
  console.log(`${name.padEnd(18)} ${String(e.nodes).padStart(9)} nodes ${took.toFixed(0).padStart(6)} ms ` +
              `${String(Math.round(e.nodes / took * 1000)).padStart(8)} nps   best ${r[0].san}`);
}
console.log(`\nTotal: ${nodes} nodes in ${ms.toFixed(0)} ms = ${Math.round(nodes / ms * 1000)} nodes/second`);
console.log(`Signature: ${nodes}`);
