r"""Everything the app tells a player, checked against Stockfish 19.

    python test/stockfish_check.py path/to/stockfish.exe [--quick]

A native Stockfish (not the one inside the page) is the referee:

  1. endgames   -- does each study's claim hold ("White to play and win")?
  2. imports    -- do the evaluations read out of a PGN agree with Stockfish,
                   sign included? A sign error would turn every mistake into a
                   good move.
  3. drills     -- for each mistake mined from the sample games: does
                   Stockfish agree it cost what the app says, and is there one
                   clear answer, or several moves the drill would reject
                   although they are just as good?
  4. reader     -- the Stockfish 10 reader in the page (1 s a position):
                   do its verdicts (good / inaccuracy / mistake / blunder)
                   match Stockfish 19's?
  5. advice     -- the house engine's first choice at its app budget: how
                   much does Stockfish say it gives away?

Needs Node (for the app's own code) and Playwright (for the reader). Exits 1 if any
endgame study's claim is WRONG; the other sections are measurements, reported only.
"""
import json, os, statistics, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, ".."))
SF = sys.argv[1]
QUICK = "--quick" in sys.argv
NODE = os.environ.get("NODE", "node")
DEPTH = 14 if QUICK else 18


class Stockfish:
    def __init__(self, path):
        self.p = subprocess.Popen([path], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, bufsize=1)
        self.send("uci"); self.wait("uciok")
        self.send("setoption name Threads value 4"); self.send("setoption name Hash value 256")
        self.send("isready"); self.wait("readyok")

    def send(self, s): self.p.stdin.write(s + "\n"); self.p.stdin.flush()
    def readline(self):
        line = self.p.stdout.readline()
        if not line:   # Stockfish has exited: say so, rather than read nothing forever
            raise SystemExit("Stockfish exited (code %s) after: %s" % (self.p.poll(), getattr(self, "last", "?")))
        return line

    def wait(self, token):
        while True:
            line = self.readline()
            if line.startswith(token): return line

    def analyse(self, fen, depth=DEPTH, movetime=None, multipv=1, searchmoves=None):
        """[(uci, cp_for_side_to_move)] best first; mate scores as +/-(100000 - plies)."""
        self.last = "%s %s" % (fen, searchmoves or "")
        self.send("setoption name MultiPV value %d" % multipv)
        self.send("position fen " + fen)
        self.send(("go movetime %d" % movetime if movetime else "go depth %d" % depth) +
                  (" searchmoves " + " ".join(searchmoves) if searchmoves else ""))
        lines = {}
        while True:
            line = self.readline()
            if line.startswith("bestmove"): break
            if not line.startswith("info") or " pv " not in line or "bound" in line: continue
            t = line.split()
            k = int(t[t.index("multipv") + 1]) if "multipv" in t else 1
            i = t.index("score")
            cp = int(t[i + 2]) if t[i + 1] == "cp" else (100000 - abs(int(t[i + 2]))) * (1 if int(t[i + 2]) > 0 else -1)
            lines[k] = (t[t.index("pv") + 1], cp)
        return [lines[k] for k in sorted(lines)]

    def close(self): self.send("quit")


def node(script, payload=None):
    # In the system's temp directory, not test/: a run that dies must not leave a stray
    # .js beside the suites, where CI's test/*.js loop would run it. ROOT makes the
    # requires absolute, so the script's own location does not matter.
    f = tempfile.NamedTemporaryFile("w", suffix=".js", delete=False)
    f.write("globalThis.window = globalThis;\nconst ROOT = %s;\n" % json.dumps(ROOT) + script); f.close()
    try:
        out = subprocess.run([NODE, f.name], input=json.dumps(payload or {}), capture_output=True, text=True, timeout=3600)
        if out.returncode: raise SystemExit(out.stderr[-2000:])
        return json.loads(out.stdout)
    finally:
        os.unlink(f.name)


def clamp(cp): return max(-1000, min(1000, cp))
def grade(loss): return "blunder" if loss >= 300 else "mistake" if loss >= 100 else "inaccuracy" if loss >= 50 else "good"

sf = Stockfish(SF)
report = {}

# ---------------------------------------------------------------- 1. endgame studies
CLAIMS = {  # id: (side to move's expected result, what it means)
    "lucena": ("win", "White wins"), "saavedra": ("win", "White wins"), "breakthrough": ("win", "White wins"),
    "bn-mate": ("win", "White mates"), "two-bishops": ("win", "White mates"),
    "philidor": ("draw", "Black holds"), "vancura": ("draw", "Black holds"), "reti": ("draw", "White holds"),
    "behind-passer": ("draw", "a draw with best play (a lesson in rook placement)"),
}
studies = node("""require(ROOT + '/js/core.js'); require(ROOT + '/js/training.js');
process.stdout.write(JSON.stringify(Training.ENDGAMES.filter(e => e.fen).map(e => ({ id: e.id, fen: e.fen, goal: e.goal }))));""")
rows = []
for s in studies:
    if s["id"] == "opposition":
        w = sf.analyse(s["fen"], depth=30)[0][1]
        b = sf.analyse(s["fen"].replace(" w ", " b "), depth=30)[0][1]
        ok = abs(w) < 80 and b <= -300          # White to move draws; Black to move loses
        rows.append((s["id"], "draw with White to move, loss for Black to move", "W %+d / B %+d" % (w, b), ok))
        continue
    want, words = CLAIMS[s["id"]]
    cp = sf.analyse(s["fen"], depth=30 if not QUICK else 22)[0][1]
    if s["id"] == "bn-mate":
        ok = cp >= 100   # a forced win in theory (KBN v K), deeper than depth 30 sees without tablebases
    else:
        ok = cp >= 300 if want == "win" else abs(cp) < 80 if want == "draw" else cp >= 100
    rows.append((s["id"], words, "%+d" % cp, ok))
print("\n1. Endgame studies (Stockfish 19, depth 30; score for the side to move)")
for r in rows: print("   %-14s %-44s %10s  %s" % (r[0], r[1], r[2], "ok" if r[3] else "WRONG"))
report["endgames"] = {"checked": len(rows), "correct": sum(1 for r in rows if r[3])}
rows_endgames = rows   # `rows` is reused below; the exit code reads these

# ---------------------------------------------------------------- the sample games, read by the app
data = node("""require(ROOT + '/js/core.js'); require(ROOT + '/js/engine.js'); require(ROOT + '/js/data.js'); require(ROOT + '/js/analysis.js');
const fs = require('fs');
const games = Data.importPGN(fs.readFileSync(ROOT + '/experiments/move_predictor/ermactually_games.pgn', 'utf8'), '');
const analysed = games.filter(g => g.analysed);
const evals = [];
analysed.forEach(g => g.moves.forEach(m => { if (m.evalAfter != null && Math.abs(m.evalAfter) < 9000) evals.push({ fen: m.fenAfter, white: m.evalAfter }); }));
const errors = Analysis.mineErrors(games).map(e => ({ fen: e.fen, played: e.played, cpLoss: e.cpLoss, severity: e.severity, myColor: e.myColor }));
const mine = [];
analysed.forEach(g => g.moves.forEach(m => { if (m.color === g.myColor) mine.push({ fen: m.fenBefore, san: m.san }); }));
process.stdout.write(JSON.stringify({ evals, errors, mine }));""")

# ---------------------------------------------------------------- 2. imported evaluations
sample = data["evals"][:: max(1, len(data["evals"]) // (40 if QUICK else 120))]
diffs, signs = [], 0
for e in sample:
    stm = sf.analyse(e["fen"])[0][1]
    white = stm if " w " in e["fen"] else -stm
    diffs.append(abs(clamp(white) - clamp(e["white"])))
    if abs(white) > 150 and abs(e["white"]) > 150 and (white > 0) != (e["white"] > 0): signs += 1
print("\n2. Evaluations imported from the PGN, against Stockfish 19 (White's view)")
print("   %d positions: median difference %.0f cp, %d with the sign the wrong way round" % (len(sample), statistics.median(diffs), signs))
report["imports"] = {"positions": len(sample), "median_diff_cp": statistics.median(diffs), "sign_errors": signs}

# ---------------------------------------------------------------- 3. mined mistakes, as drills
def uci_of(fen, san):
    return node("""const Chess = require(ROOT + '/js/core.js'); const q = JSON.parse(require('fs').readFileSync(0, 'utf8'));
process.stdout.write(JSON.stringify(q.map(([f, s]) => { const g = new Chess(f), m = g.moveFromSan(s); return m ? m.fromSq + m.toSq + (m.promo ? Chess.SYM[m.promo] : '') : null; })));""",
                [[fen, san]])[0]
import math
def chances(cp): return 2 / (1 + math.exp(-0.00368208 * max(-3000, min(3000, cp)))) - 1   # Lichess's curve
def by_chances(drop): return "blunder" if drop >= 0.3 else "mistake" if drop >= 0.2 else "inaccuracy" if drop >= 0.1 else "fine"
agree, ambiguous, rows = 0, 0, []
for e in data["errors"]:
    top = sf.analyse(e["fen"], multipv=3)
    played = uci_of(e["fen"], e["played"])
    p = sf.analyse(e["fen"], searchmoves=[played])[0][1] if played else None
    drop = chances(top[0][1]) - chances(p) if p is not None else None
    truth = by_chances(drop) if drop is not None else "?"
    same = truth == e["severity"] or (truth in ("mistake", "blunder") and e["severity"] in ("mistake", "blunder"))
    agree += 1 if same else 0
    # a second move as good as the best, in winning chances: a drill wanting one move would mark it wrong
    alt = len(top) > 1 and chances(top[0][1]) - chances(top[1][1]) <= 0.03 and truth != "fine"
    ambiguous += 1 if alt else 0
    rows.append((e["played"], e["severity"], truth, alt))
print("\n3. Mistakes mined from the sample games: the app's grade / Stockfish 19's (both by winning chances)")
for r in rows[:12]: print("   played %-7s app %-10s Stockfish %-10s%s" % (r[0], r[1], r[2], "  (a second move is as good)" if r[3] else ""))
print("   %d of %d graded the same (or both mistake-or-worse); %d real mistakes have a second answer as good as the best,"
      % (agree, len(rows), ambiguous))
print("   which a drill that accepts only one move would mark wrong.")
report["drills"] = {"mistakes": len(rows), "agree": agree, "ambiguous": ambiguous}

# ---------------------------------------------------------------- 5. the house engine's advice
picks = data["mine"][:: max(1, len(data["mine"]) // (20 if QUICK else 60))]
house = node("""const Chess = require(ROOT + '/js/core.js'), Engine = require(ROOT + '/js/engine.js');
const q = JSON.parse(require('fs').readFileSync(0, 'utf8'));
process.stdout.write(JSON.stringify(q.map(f => { const r = new Engine().rank(new Chess(f), 3, 800); return r.length ? r[0].uci : null; })));""",
             [m["fen"] for m in picks])
losses = []
for m, mv in zip(picks, house):
    if not mv: continue
    best = sf.analyse(m["fen"])[0][1]
    got = sf.analyse(m["fen"], searchmoves=[mv])[0][1]
    losses.append(max(0, clamp(best) - clamp(got)))
within = sum(1 for x in losses if x <= 50)
print("\n5. House engine's first choice (depth 3, 800 ms), priced by Stockfish 19")
print("   %d positions from the sample games: median cost %.0f cp; %d%% within 50 cp of best; %d blunders (300+)"
      % (len(losses), statistics.median(losses), 100 * within / len(losses), sum(1 for x in losses if x >= 300)))
report["advice"] = {"positions": len(losses), "median_cost_cp": statistics.median(losses), "within50": within,
                    "blunders": sum(1 for x in losses if x >= 300)}

# ---------------------------------------------------------------- 4. the page's Stockfish reader
from playwright.sync_api import sync_playwright
reader_sample = data["mine"][:: max(1, len(data["mine"]) // (10 if QUICK else 40))]
ucis = node("""const Chess = require(ROOT + '/js/core.js'); const q = JSON.parse(require('fs').readFileSync(0, 'utf8'));
process.stdout.write(JSON.stringify(q.map(([f, s]) => { const g = new Chess(f), m = g.moveFromSan(s); return m ? m.fromSq + m.toSq + (m.promo ? Chess.SYM[m.promo] : '') : null; })));""",
            [[m["fen"], m["san"]] for m in reader_sample])
with sync_playwright() as p:
    b = p.chromium.launch(); pg = b.new_page()
    pg.goto("file:///" + os.path.join(ROOT, "index.html").replace("\\", "/")); pg.wait_for_timeout(800)
    verdicts = pg.evaluate("""async q => { const r = new StockfishReader.Reader(window.STOCKFISH_SOURCE); await r.start();
      const out = [];
      for (const [fen, uci] of q) {
        const best = await r.read(fen, { movetime: 1000 });
        const played = best.best === uci ? best : await r.read(fen, { movetime: 1000, searchmoves: [uci] });
        const white = fen.split(' ')[1] === 'w', c = x => Math.max(-1000, Math.min(1000, x));
        out.push(Math.max(0, Math.round((white ? 1 : -1) * (c(best.cp) - c(played.cp)))));
      }
      r.terminate(); return out; }""", [[m["fen"], u] for m, u in zip(reader_sample, ucis) if u])
    b.close()
same, near, total = 0, 0, 0
for (m, u), rl in zip([(m, u) for m, u in zip(reader_sample, ucis) if u], verdicts):
    best = sf.analyse(m["fen"])[0][1]
    got = sf.analyse(m["fen"], searchmoves=[u])[0][1]
    truth = max(0, clamp(best) - clamp(got))
    total += 1; same += 1 if grade(rl) == grade(truth) else 0
    near += 1 if abs(rl - truth) <= 50 else 0
print("\n4. The page's Stockfish 10 reader (1 s a position) against Stockfish 19 (depth %d)" % DEPTH)
print("   %d of your moves: same verdict %d (%d%%); cost within 50 cp %d (%d%%)"
      % (total, same, 100 * same / total, near, 100 * near / total))
report["reader"] = {"moves": total, "same_verdict": same, "within50": near}

sf.close()
json.dump(report, open(os.path.join(tempfile.gettempdir(), "stockfish_check.json"), "w"), indent=1)
wrong = [r[0] for r in rows_endgames if not r[3]]
if wrong:
    print()
    print("FAIL: endgame claims Stockfish 19 does not support: " + ", ".join(wrong))
    sys.exit(1)
print()
print("PASS: every endgame claim holds")
