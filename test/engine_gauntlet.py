r"""The house engine from the outside: four checks that drive tools/uci.js over UCI,
the way a GUI would, with python-chess as an independent referee.

    python test/engine_gauntlet.py legality  [--positions 1000] [--movetime 100] [--slack 150]
    python test/engine_gauntlet.py mates     [--movetime 1000] [--min-mate1 N] [--min-mate2 N]
    python test/engine_gauntlet.py random    [--games 100] [--movetime 50]
    python test/engine_gauntlet.py stockfish --stockfish path\to\stockfish.exe [--games 20] [--sf-movetime 100]
    python test/engine_gauntlet.py all       --stockfish path\to\stockfish.exe
    python test/engine_gauntlet.py make-mates --stockfish path\to\stockfish.exe   # rebuild the mate EPDs

  legality   1,000 positions -- random games, the EPD suites, random but valid piece
             placements, and hand-picked edge cases (en passant out of a pin, castling
             through check, underpromotion, double check). Every answer must be a
             well-formed UCI move that python-chess agrees is legal, sent within the
             movetime plus --slack ms (pipe latency, a loaded machine), and "0000"
             exactly when the game is over. The slowest reply is reported. Checked by a move
             generator the engine does not share, so a bug in js/core.js cannot hide.
  mates      test/epd/mate1.epd and mate2.epd. A mate-in-1 is solved by mating. A
             mate-in-2 is solved when the first move still forces mate (proved by
             brute force, so any mating line counts, not only the one in the file)
             and the engine then mates against every defence it is shown. Fewer
             solved than --min-mate1 / --min-mate2 is a hard failure.
  random     games against a random mover and a greedy capturer, colours alternating.
             Fails on a crash, a freeze, an illegal move, or a game that runs to the
             ply cap; reports the score, game lengths, and draws while winning.
  stockfish  games against Stockfish at a fixed short movetime. For each game: how many
             moves the engine survives before it is really down material (2+ pawns
             below where it started, for 4 plies running, so a recapture next move does
             not count), and before its first blunder (a referee Stockfish at fixed
             depth says the move lost 200+ cp).

Exit code 1 on any hard failure: an illegal or malformed move, a freeze, a crash, a
reply later than movetime + slack, a game run to the ply cap, or a mate suite below
its --min-mate threshold. Otherwise strength is reported, not asserted. --json FILE writes the numbers.
Needs Node on PATH (or --node) and `pip install chess`.
"""
from __future__ import annotations

import argparse
import json
import os
import queue
import random
import re
import statistics
import subprocess
import sys
import threading
import time
from dataclasses import dataclass, field

import chess

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, ".."))
EPD_DIR = os.path.join(HERE, "epd")
UCI_MOVE = re.compile(r"^[a-h][1-8][a-h][1-8][qrbn]?$")
VALUES = {chess.PAWN: 1, chess.KNIGHT: 3, chess.BISHOP: 3, chess.ROOK: 5, chess.QUEEN: 9}

# Edge cases worth naming. Each is a position where a careless move generator goes wrong.
EDGE_CASES = {
    "en passant out of a pin is illegal": "8/8/8/KPp4r/8/8/8/6k1 w - c6 0 2",
    "en passant that removes a checker": "8/8/8/2k5/3Pp3/8/8/4K3 b - d3 0 1",
    "castling through an attacked square": "4k3/8/8/8/8/8/5r2/R3K2R w KQ - 0 1",
    "castling out of check": "4k3/8/8/8/8/8/4r3/R3K2R w KQ - 0 1",
    "queenside castling with b1 attacked": "4k3/8/8/8/8/8/1r6/R3K2R w KQ - 0 1",
    "promotion with capture choices": "1n2k3/P7/8/8/8/8/8/4K3 w - - 0 1",
    "underpromotion to avoid stalemate": "8/1P6/k7/8/1K6/8/8/8 w - - 0 1",   # b8=Q stalemates; b8=R wins
    "all four promotions": "8/4P1pk/6pp/8/8/8/8/4K3 w - - 0 1",
    "double check: only the king may move": "4k3/8/8/1B6/8/8/4R3/4K3 b - - 0 1",
    "pinned piece cannot leave the line": "4k3/4r3/8/8/8/8/4N3/4K3 w - - 0 1",
    "queen trade beside both kings": "8/8/8/3k4/3q4/3Q4/8/3K4 w - - 0 1",
    "only king moves, lone kings": "8/8/4k3/8/8/3K4/8/8 w - - 0 1",
    "kiwipete": "r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1",
    "perft position 3": "8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1",
    "perft position 4": "r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1",
    "perft position 5": "rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8",
    "fifty-move counter at 99": "8/8/4k3/8/8/3K4/R7/8 w - - 99 120",
    "black to move, all four castling rights": "r3k2r/8/8/8/8/8/8/R3K2R b KQkq - 0 1",
}
GAME_OVER = {
    "checkmate": "6k1/5ppp/8/8/8/8/5PPP/r5K1 w - - 0 1",
    "stalemate": "7k/5Q2/6K1/8/8/8/8/8 b - - 0 1",
}


# ---------------------------------------------------------------- one UCI process
class EngineFrozen(Exception):
    pass


def unthrottle(pid: int) -> None:
    """Windows runs a windowless child at reduced speed (power throttling, "EcoQoS"):
    measured here, node searched 66k nodes/s spawned from Python against 127k from a
    terminal. Every timed result would then measure the power policy, so opt out."""
    if sys.platform != "win32":
        return
    import ctypes
    from ctypes import wintypes

    class ThrottlingState(ctypes.Structure):
        _fields_ = [("Version", wintypes.ULONG), ("ControlMask", wintypes.ULONG), ("StateMask", wintypes.ULONG)]

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.OpenProcess.restype = wintypes.HANDLE
    handle = kernel32.OpenProcess(0x0200 | 0x1000, False, pid)  # SET_INFORMATION | QUERY_LIMITED_INFORMATION
    if not handle:
        return
    state = ThrottlingState(1, 1, 0)  # execution-speed throttling: we decide, and it is off
    kernel32.SetProcessInformation(handle, 4, ctypes.byref(state), ctypes.sizeof(state))  # ProcessPowerThrottling
    kernel32.CloseHandle(handle)


class Uci:
    """A UCI engine with a reader thread, so a hung search is a timeout, not a hang."""

    def __init__(self, cmd: list[str], name: str, options: dict[str, str] | None = None) -> None:
        self.cmd, self.name, self.options = cmd, name, options or {}
        self.start()

    def start(self) -> None:
        self.proc = subprocess.Popen(
            self.cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            text=True, bufsize=1, cwd=ROOT,
        )
        unthrottle(self.proc.pid)
        self.lines: queue.Queue[str | None] = queue.Queue()
        threading.Thread(target=self._pump, daemon=True).start()
        self.send("uci")
        self.wait_for("uciok", 20)
        for key, value in self.options.items():
            self.send(f"setoption name {key} value {value}")
        self.ready()

    def _pump(self) -> None:
        for line in self.proc.stdout:  # type: ignore[union-attr]
            self.lines.put(line.strip())
        self.lines.put(None)  # the process closed its output: it exited

    def send(self, line: str) -> None:
        self.proc.stdin.write(line + "\n")  # type: ignore[union-attr]
        self.proc.stdin.flush()  # type: ignore[union-attr]

    def wait_for(self, prefix: str, timeout: float) -> str:
        deadline = time.monotonic() + timeout
        while True:
            left = deadline - time.monotonic()
            if left <= 0:
                raise EngineFrozen(f"{self.name}: no '{prefix}' within {timeout:.1f} s")
            try:
                line = self.lines.get(timeout=left)
            except queue.Empty:
                continue
            if line is None:
                raise EngineFrozen(f"{self.name} exited (code {self.proc.poll()})")
            if line.startswith(prefix):
                return line

    def ready(self) -> None:
        self.send("isready")
        self.wait_for("readyok", 20)

    def best(self, board: chess.Board, movetime: int, timeout: float, as_moves: bool = False) -> tuple[str, float]:
        """The raw bestmove token and seconds taken. as_moves sends startpos + moves."""
        if as_moves and board.move_stack:
            start = board.root()
            head = "startpos" if start.fen() == chess.STARTING_FEN else "fen " + start.fen()
            self.send(f"position {head} moves " + " ".join(m.uci() for m in board.move_stack))
        else:
            self.send("position fen " + board.fen())
        t0 = time.monotonic()
        self.send(f"go movetime {movetime}")
        line = self.wait_for("bestmove", timeout)
        parts = line.split()
        return (parts[1] if len(parts) > 1 else ""), time.monotonic() - t0

    def restart(self) -> None:
        self.close()
        self.start()

    def close(self) -> None:
        try:
            self.send("quit")
            self.proc.wait(timeout=2)
        except Exception:
            pass
        if self.proc.poll() is None:
            self.proc.kill()


class Referee(Uci):
    """Stockfish as a judge: centipawns for the side to move at a fixed depth."""

    def analyse(self, board: chess.Board, depth: int) -> tuple[int, int | None]:
        """(centipawns, mate in n or None) for the side to move, from the deepest line."""
        self.send("position fen " + board.fen())
        self.send(f"go depth {depth}")
        cp, mate = 0, None
        while True:
            line = self.wait_for("", 60)
            m = re.search(r"\bscore (cp|mate) (-?\d+)", line)
            if m and line.startswith("info"):
                n = int(m.group(2))
                if m.group(1) == "cp":
                    cp, mate = n, None
                else:
                    cp, mate = (100000 - abs(n)) * (1 if n > 0 else -1), n
            if line.startswith("bestmove"):
                return cp, mate

    def score(self, board: chess.Board, depth: int) -> int:
        return self.analyse(board, depth)[0]


def house(args: argparse.Namespace) -> Uci:
    return Uci([args.node, os.path.join(ROOT, "tools", "uci.js")], "house", {"Move Overhead": "20"})


# ---------------------------------------------------------------- positions
def random_game_position(rng: random.Random) -> chess.Board:
    board = chess.Board()
    for _ in range(rng.randint(1, 160)):
        moves = list(board.legal_moves)
        if not moves:
            break
        board.push(rng.choice(moves))
        if board.is_game_over():
            board.pop()
            break
    return board


def random_placement(rng: random.Random) -> chess.Board:
    """Random but valid: kings apart, no pawns on the back ranks, side not to move not in check.

    A third of them start with the kings and some rooks at home, so castling rights are
    tested; a third end with a double pawn push, so a real en passant square is. Left to
    chance, a king and rook at home turn up about once in 500 placements, and an en
    passant square never."""
    while True:
        board = chess.Board(None)
        squares = rng.sample(chess.SQUARES, 64)
        flavour = rng.choice(["plain", "castling", "en passant"])
        if flavour == "castling":
            for color, king_sq, corners in ((chess.WHITE, chess.E1, (chess.A1, chess.H1)),
                                            (chess.BLACK, chess.E8, (chess.A8, chess.H8))):
                board.set_piece_at(king_sq, chess.Piece(chess.KING, color))
                squares.remove(king_sq)
                for corner in corners:
                    if rng.random() < 0.7:
                        board.set_piece_at(corner, chess.Piece(chess.ROOK, color))
                        squares.remove(corner)
        else:
            board.set_piece_at(squares.pop(), chess.Piece(chess.KING, chess.WHITE))
            board.set_piece_at(squares.pop(), chess.Piece(chess.KING, chess.BLACK))
        for _ in range(rng.randint(0, 14)):
            piece = chess.Piece(rng.choice([1, 1, 1, 2, 3, 4, 5]), rng.choice([chess.WHITE, chess.BLACK]))
            sq = squares.pop()
            if piece.piece_type == chess.PAWN and chess.square_rank(sq) in (0, 7):
                continue
            board.set_piece_at(sq, piece)
        board.turn = rng.choice([chess.WHITE, chess.BLACK])
        # Castling rights where the king and rook stand at home.
        board.castling_rights = chess.BB_CORNERS
        board.castling_rights = board.clean_castling_rights()
        if flavour == "en passant" and not double_push(board, rng):
            continue
        if board.is_valid() and not board.is_game_over():
            return board


def double_push(board: chess.Board, rng: random.Random) -> bool:
    """Make the side to move's last move a double pawn push beside one of its
    pawns, so the position carries a real en passant square. False if none fits."""
    mover, taker = not board.turn, board.turn
    files = list(range(8))
    rng.shuffle(files)
    for f in files:
        start = chess.square(f, 1 if mover == chess.WHITE else 6)
        middle = chess.square(f, 2 if mover == chess.WHITE else 5)
        dest = chess.square(f, 3 if mover == chess.WHITE else 4)
        beside = [chess.square(f + d, chess.square_rank(dest)) for d in (-1, 1) if 0 <= f + d < 8]
        if any(board.piece_at(sq) for sq in (start, middle, dest)) or not beside:
            continue
        side_sq = rng.choice(beside)
        if board.piece_at(side_sq):
            continue
        board.set_piece_at(start, chess.Piece(chess.PAWN, mover))
        board.set_piece_at(side_sq, chess.Piece(chess.PAWN, taker))
        board.turn = mover
        move = chess.Move(start, dest)
        if board.is_valid() and board.is_legal(move):
            board.push(move)
            board.clear_stack()   # the placement is the start position, as for the others
            return True
        board.turn = taker
        board.remove_piece_at(start)
        board.remove_piece_at(side_sq)
    return False


def epd_positions(rng: random.Random, n: int) -> list[tuple[str, chess.Board]]:
    boards = []
    for name in ("wac.epd", "bk.epd", "bt2630.epd", "sts.epd"):
        with open(os.path.join(EPD_DIR, name), encoding="utf-8") as f:
            for line in f:
                if line.strip():
                    board, _ = chess.Board.from_epd(line.strip())
                    boards.append((name, board))
    return rng.sample(boards, min(n, len(boards)))


def legality_positions(total: int, seed: int) -> list[tuple[str, chess.Board]]:
    rng = random.Random(seed)
    out = [(f"edge: {k}", chess.Board(v)) for k, v in EDGE_CASES.items()]
    out += epd_positions(rng, total // 5)
    placements = total // 5
    out += [("random placement", random_placement(rng)) for _ in range(placements)]
    while len(out) < total:
        out.append(("random game", random_game_position(rng)))
    return out[:total]


# ---------------------------------------------------------------- 1. legality
def check_answer(board: chess.Board, token: str) -> str | None:
    """None if the token is a legal move here, else what is wrong with it."""
    if not UCI_MOVE.match(token):
        return f"malformed move {token!r}"
    move = chess.Move.from_uci(token)
    if move not in board.legal_moves:
        piece = board.piece_at(move.from_square)
        what = "an empty square" if piece is None else f"a {piece.symbol()}"
        return f"illegal move {token} (from {what})"
    return None


def run_legality(args: argparse.Namespace) -> dict:
    positions = legality_positions(args.positions, args.seed)
    engine = house(args)
    # One untimed search first: the first "go" pays for the worker thread's start and the
    # JIT warming up (over 200 ms here), which no later move pays and a GUI never times.
    engine.best(chess.Board(), args.movetime, args.timeout)
    failures, times = [], []
    slowest: tuple[float, str, str] | None = None
    kinds: dict[str, int] = {}
    try:
        for i, (kind, board) in enumerate(positions):
            label = "edge" if kind.startswith("edge") else kind
            kinds[label] = kinds.get(label, 0) + 1
            try:
                token, took = engine.best(board, args.movetime, args.timeout, as_moves=bool(i % 2))
            except EngineFrozen as exc:
                failures.append({"kind": kind, "fen": board.fen(), "error": str(exc)})
                engine.restart()
                continue
            times.append(took)
            if slowest is None or took > slowest[0]:
                slowest = (took, kind, board.fen())
            problem = check_answer(board, token)
            if problem:
                failures.append({"kind": kind, "fen": board.fen(), "error": problem})
            elif 1000 * took > args.movetime + args.slack:
                failures.append({"kind": kind, "fen": board.fen(),
                                 "error": f"late: {1000 * took:.0f} ms against {args.movetime} + {args.slack} ms"})
            if (i + 1) % 100 == 0:
                print(f"  {i + 1} positions, {len(failures)} failure(s)", flush=True)
        for kind, fen in GAME_OVER.items():
            token, _ = engine.best(chess.Board(fen), args.movetime, args.timeout)
            if token != "0000":
                failures.append({"kind": f"game over: {kind}", "fen": fen, "error": f"answered {token!r}, not 0000"})
    finally:
        engine.close()
    for f in failures[:20]:
        print(f"  FAIL [{f['kind']}] {f['fen']}: {f['error']}")
    result = {
        "positions": len(positions) + len(GAME_OVER),
        "by_kind": kinds,
        "failures": failures,
        "median_ms": round(1000 * statistics.median(times)) if times else None,
        "max_ms": round(1000 * max(times)) if times else None,
        "slowest": {"kind": slowest[1], "fen": slowest[2]} if slowest else None,
        "slack_ms": args.slack,
    }
    print(f"legality: {result['positions'] - len(failures)} of {result['positions']} answers legal and on time "
          f"({', '.join(f'{v} {k}' for k, v in kinds.items())}, plus {len(GAME_OVER)} game-over checks); "
          f"median {result['median_ms']} ms, slowest {result['max_ms']} ms at {args.movetime} ms a move "
          f"(limit {args.movetime + args.slack} ms)")
    if slowest:
        print(f"  slowest reply: [{slowest[1]}] {slowest[2]}")
    return result


# ---------------------------------------------------------------- 2. mates
def mates_in_one(board: chess.Board) -> list[chess.Move]:
    found = []
    for move in board.legal_moves:
        board.push(move)
        if board.is_checkmate():
            found.append(move)
        board.pop()
    return found


def forces_mate_in(board: chess.Board, n: int) -> bool:
    """Brute force: can the side to move force mate within n of its own moves?"""
    for move in list(board.legal_moves):
        board.push(move)
        if board.is_checkmate():
            board.pop()
            return True
        if n > 1 and not board.is_game_over() and all(_after(board, r, n - 1) for r in list(board.legal_moves)):
            board.pop()
            return True
        board.pop()
    return False


def _after(board: chess.Board, reply: chess.Move, n: int) -> bool:
    board.push(reply)
    ok = forces_mate_in(board, n)
    board.pop()
    return ok


def read_epd(name: str) -> list[tuple[str, chess.Board]]:
    out = []
    with open(os.path.join(EPD_DIR, name), encoding="utf-8") as f:
        for line in f:
            if line.strip():
                board, ops = chess.Board.from_epd(line.strip())
                out.append((str(ops.get("id", board.fen())), board))
    return out


def run_mates(args: argparse.Namespace) -> dict:
    engine = house(args)
    result: dict = {}
    hard: list[str] = []
    try:
        for n, name in ((1, "mate1.epd"), (2, "mate2.epd")):
            suite = read_epd(name)
            solved, misses = 0, []
            for ident, board in suite:
                ok, why = _solve_mate(engine, board, n, args, hard)
                solved += ok
                if not ok:
                    misses.append(f"{ident}: {why}")
            for miss in misses[:10]:
                print(f"  miss {miss}")
            need = getattr(args, f"min_mate{n}")
            result[f"mate_in_{n}"] = {"solved": solved, "total": len(suite), "misses": misses, "min_solved": need}
            print(f"mate in {n}: solved {solved} of {len(suite)} at {args.movetime} ms a move"
                  + (f" (at least {need} required)" if need else ""))
            if solved < need:
                hard.append(f"mate in {n}: solved {solved}, below the {need} required")
    finally:
        engine.close()
    result["hard_failures"] = hard
    return result


def _solve_mate(engine: Uci, board: chess.Board, n: int, args: argparse.Namespace, hard: list[str]) -> tuple[bool, str]:
    board = board.copy()
    for step in range(n):
        try:
            token, _ = engine.best(board, args.movetime, args.timeout)
        except EngineFrozen as exc:
            hard.append(f"{board.fen()}: {exc}")
            engine.restart()
            return False, "froze"
        problem = check_answer(board, token)
        if problem:
            hard.append(f"{board.fen()}: {problem}")
            return False, problem
        board.push(chess.Move.from_uci(token))
        if board.is_checkmate():
            return True, ""
        left = n - step - 1
        if left == 0 or board.is_game_over():
            return False, f"played {token}, no mate"
        # Still a forced mate in `left` against every defence? Then play one and ask again.
        replies = list(board.legal_moves)
        if not all(_after(board, r, left) for r in replies):
            if all(_after(board, r, left + 1) for r in replies):
                return False, f"played {token}: still a forced mate, but a move slower"
            return False, f"played {token}, which lets the forced mate go"
        board.push(replies[0])
    return False, "no mate"


def make_mates(args: argparse.Namespace) -> None:
    """Rebuild mate1.epd and mate2.epd: Stockfish screens, brute force proves."""
    if not args.stockfish:
        raise SystemExit("make-mates needs --stockfish")
    sf = Referee([args.stockfish], "stockfish", {"Threads": "2", "Hash": "64"})
    rng = random.Random(args.seed)
    found: dict[int, dict[str, chess.Board]] = {1: {}, 2: {}}
    # Where they come from: the tactics suites, then games in which a shallow Stockfish
    # attacks a random mover, which builds mating nets far more often than random play.
    candidates = [b for _, b in epd_positions(rng, 10**6)]
    rng.shuffle(candidates)
    attempts = 0
    while (len(found[1]) < args.mate_count or len(found[2]) < args.mate_count) and attempts < 4000:
        attempts += 1
        board = candidates.pop() if candidates else _attack_game(sf, rng)
        if board is None or board.is_game_over():
            continue
        _, mate = sf.analyse(board, 10)  # a cheap screen; the brute force below is the proof
        key = board.epd()
        if mate == 1 and mates_in_one(board) and len(found[1]) < args.mate_count:
            found[1][key] = board
        elif (mate == 2 and len(found[2]) < args.mate_count and not mates_in_one(board)
              and forces_mate_in(board, 2)):
            found[2][key] = board
    sf.close()
    for n in (1, 2):
        path = os.path.join(EPD_DIR, f"mate{n}.epd")
        with open(path, "w", encoding="utf-8", newline="\n") as f:
            for i, board in enumerate(found[n].values(), 1):
                f.write(board.epd(id=f"mate{n}.{i:03d}") + "\n")
        print(f"wrote {len(found[n])} positions to {os.path.relpath(path, ROOT)}")


def _attack_game(sf: Referee, rng: random.Random) -> chess.Board | None:
    """Stockfish (depth 1) against a random mover; return a position just before the end."""
    board = chess.Board()
    attacker = rng.choice([chess.WHITE, chess.BLACK])
    history = []
    while not board.is_game_over() and board.ply() < 200:
        if board.turn == attacker:
            sf.send("position fen " + board.fen())
            sf.send("go depth 1")
            move = chess.Move.from_uci(sf.wait_for("bestmove", 30).split()[1])
        else:
            move = rng.choice(list(board.legal_moves))
        history.append(board.copy())
        board.push(move)
    if not board.is_checkmate():
        return None
    # The attacker to move, 1 or 3 plies before mate: a mate in 1 or a likely mate in 2.
    back = rng.choice([1, 3])
    return history[-back] if len(history) >= back else None


# ---------------------------------------------------------------- 3. random / baseline
def random_player(board: chess.Board, rng: random.Random) -> chess.Move:
    return rng.choice(list(board.legal_moves))


def greedy_player(board: chess.Board, rng: random.Random) -> chess.Move:
    """A one-ply baseline: mate if it can, else the biggest capture, else random."""
    moves = list(board.legal_moves)
    for move in moves:
        if board.gives_check(move):
            board.push(move)
            mate = board.is_checkmate()
            board.pop()
            if mate:
                return move
    def gain(m: chess.Move) -> int:
        victim = board.piece_at(m.to_square)
        return VALUES.get(victim.piece_type, 0) if victim else (1 if board.is_en_passant(m) else 0)
    best = max(gain(m) for m in moves)
    return rng.choice([m for m in moves if gain(m) == best])


def material(board: chess.Board, color: bool) -> int:
    return sum(VALUES.get(p.piece_type, 0) * (1 if p.color == color else -1) for p in board.piece_map().values())


@dataclass
class Game:
    result: str = "*"
    reason: str = ""
    plies: int = 0
    house_color: bool = chess.WHITE
    moves: list[str] = field(default_factory=list)


def play_baseline(engine: Uci, opponent, house_color: bool, args: argparse.Namespace,
                  rng: random.Random, hard: list[str]) -> Game:
    board = chess.Board()
    game = Game(house_color=house_color)
    while True:
        if board.is_game_over(claim_draw=True):
            outcome = board.outcome(claim_draw=True)
            game.result = outcome.result() if outcome else "1/2-1/2"
            game.reason = outcome.termination.name.lower() if outcome else "draw"
            break
        if board.ply() >= args.max_plies:
            game.result, game.reason = "1/2-1/2", f"ply cap ({args.max_plies})"
            hard.append(f"game ran to the ply cap: {' '.join(game.moves[-20:])}")
            break
        if board.turn == house_color:
            try:
                token, _ = engine.best(board, args.movetime, args.timeout, as_moves=True)
            except EngineFrozen as exc:
                hard.append(f"froze at {board.fen()}: {exc}")
                engine.restart()
                game.result, game.reason = ("0-1" if house_color else "1-0"), "froze"
                break
            problem = check_answer(board, token)
            if problem:
                hard.append(f"{board.fen()}: {problem}")
                game.result, game.reason = ("0-1" if house_color else "1-0"), "illegal move"
                break
            move = chess.Move.from_uci(token)
        else:
            move = opponent(board, rng)
        game.moves.append(board.san(move))
        board.push(move)
    game.plies = board.ply()
    return game


def score_for_house(game: Game) -> float:
    if game.result == "1/2-1/2" or game.result == "*":
        return 0.5
    white_won = game.result == "1-0"
    return 1.0 if white_won == (game.house_color == chess.WHITE) else 0.0


def run_random(args: argparse.Namespace) -> dict:
    rng = random.Random(args.seed)
    engine = house(args)
    result: dict = {}
    hard: list[str] = []
    try:
        for name, opponent, games in (("random", random_player, args.games), ("greedy", greedy_player, args.games // 2)):
            played = []
            t0 = time.monotonic()
            for i in range(games):
                engine.send("ucinewgame")
                engine.ready()
                played.append(play_baseline(engine, opponent, chess.WHITE if i % 2 == 0 else chess.BLACK, args, rng, hard))
            wins = sum(score_for_house(g) == 1 for g in played)
            draws = [g for g in played if score_for_house(g) == 0.5]
            losses = sum(score_for_house(g) == 0 for g in played)
            lengths = [g.plies for g in played if score_for_house(g) == 1]
            reasons: dict[str, int] = {}
            for g in draws:
                reasons[g.reason] = reasons.get(g.reason, 0) + 1
            result[name] = {
                "games": games, "wins": wins, "draws": len(draws), "losses": losses,
                "draw_reasons": reasons,
                "median_plies_to_win": statistics.median(lengths) if lengths else None,
                "longest_win_plies": max(lengths) if lengths else None,
                "seconds": round(time.monotonic() - t0),
            }
            print(f"vs {name}: +{wins} ={len(draws)} -{losses} of {games}"
                  f"{' (draws: ' + ', '.join(f'{v} {k}' for k, v in reasons.items()) + ')' if reasons else ''}; "
                  f"median win in {result[name]['median_plies_to_win']} plies, "
                  f"longest {result[name]['longest_win_plies']}; {result[name]['seconds']} s")
    finally:
        engine.close()
    for h in hard[:10]:
        print(f"  FAIL {h}")
    result["hard_failures"] = hard
    return result


# ---------------------------------------------------------------- 4. Stockfish
def openings() -> list[list[str]]:
    with open(os.path.join(ROOT, "tools", "games.js"), encoding="utf-8") as f:
        text = f.read()
    block = text[text.index("OPENINGS = [") : text.index("];", text.index("OPENINGS = ["))]
    return [line.split() for line in re.findall(r"'([^']+)'", block)]


def run_stockfish(args: argparse.Namespace) -> dict:
    if not args.stockfish:
        raise SystemExit("the stockfish check needs --stockfish path/to/stockfish")
    engine = house(args)
    opponent = Uci([args.stockfish], "stockfish", {"Threads": "1", "Hash": "16"})
    referee = Referee([args.stockfish], "referee", {"Threads": "2", "Hash": "64"})
    lines = openings()
    games, hard = [], []
    try:
        for i in range(args.offset, args.offset + args.games):
            house_color = chess.WHITE if i % 2 == 0 else chess.BLACK
            board = chess.Board()
            for san in lines[(i // 2) % len(lines)]:
                board.push_san(san)
            start_ply = board.ply()
            start_material = material(board, house_color)
            engine.send("ucinewgame"); engine.ready()
            opponent.send("ucinewgame"); opponent.ready()
            first_blunder = material_lost = None
            behind_run = 0
            reason = ""
            house_moves = 0
            while not board.is_game_over(claim_draw=True) and board.ply() < start_ply + args.max_plies:
                move_no = (board.ply() - start_ply) // 2 + 1  # the house engine's moves since the opening
                if board.turn == house_color:
                    before = referee.score(board, args.ref_depth) if first_blunder is None else None
                    try:
                        token, _ = engine.best(board, args.movetime, args.timeout, as_moves=True)
                    except EngineFrozen as exc:
                        hard.append(f"froze at {board.fen()}: {exc}"); engine.restart(); reason = "froze"; break
                    problem = check_answer(board, token)
                    if problem:
                        hard.append(f"{board.fen()}: {problem}"); reason = "illegal move"; break
                    board.push(chess.Move.from_uci(token))
                    house_moves += 1
                    if before is not None and not board.is_game_over():
                        after = -referee.score(board, args.ref_depth)
                        # A blunder: 200+ cp thrown away, in a game that was not already lost.
                        if before > -500 and before - after >= 200:
                            first_blunder = move_no
                else:
                    token, _ = opponent.best(board, args.sf_movetime, 30)
                    board.push(chess.Move.from_uci(token))
                behind = material(board, house_color) - start_material <= -2
                behind_run = behind_run + 1 if behind else 0
                if behind_run >= 4 and material_lost is None:
                    material_lost = move_no
            outcome = board.outcome(claim_draw=True)
            result = outcome.result() if outcome else ("1/2-1/2" if not reason else ("0-1" if house_color else "1-0"))
            reason = reason or (outcome.termination.name.lower() if outcome else "ply cap")
            game = Game(result=result, reason=reason, plies=board.ply() - start_ply, house_color=house_color)
            games.append({
                "opening": " ".join(lines[(i // 2) % len(lines)]),
                "house": "white" if house_color else "black",
                "result": result, "reason": reason, "score": score_for_house(game),
                "house_moves": house_moves,
                "first_blunder_move": first_blunder, "material_lost_move": material_lost,
            })
            g = games[-1]
            print(f"  game {i + 1:>3} ({g['house']}, {g['opening']}): {result} by {reason}; "
                  f"first blunder at move {first_blunder or '-'}, down material from move {material_lost or '-'}, "
                  f"{house_moves} moves", flush=True)
    finally:
        engine.close(); opponent.close(); referee.close()
    score = sum(g["score"] for g in games)

    def med(key: str) -> float | None:
        # A game with no blunder survives all its moves: count it at its length (a lower bound).
        vals = [g[key] if g[key] is not None else g["house_moves"] for g in games]
        return statistics.median(vals) if vals else None

    summary = {
        "games": games, "score": score, "of": len(games),
        "median_moves_to_first_blunder": med("first_blunder_move"),
        "median_moves_before_material_loss": med("material_lost_move"),
        "games_without_blunder": sum(g["first_blunder_move"] is None for g in games),
        "games_without_material_loss": sum(g["material_lost_move"] is None for g in games),
        "hard_failures": hard,
    }
    print(f"vs Stockfish at {args.sf_movetime} ms a move (house {args.movetime} ms): {score} of {len(games)}; "
          f"median moves to first blunder {summary['median_moves_to_first_blunder']}, "
          f"before losing material {summary['median_moves_before_material_loss']}; "
          f"{summary['games_without_blunder']} game(s) with no blunder, "
          f"{summary['games_without_material_loss']} never down material")
    for h in hard[:10]:
        print(f"  FAIL {h}")
    return summary


# ---------------------------------------------------------------- main
def main() -> int:
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0], formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("check", choices=["legality", "mates", "random", "stockfish", "all", "make-mates"])
    p.add_argument("--node", default=os.environ.get("NODE", "node"))
    p.add_argument("--stockfish", default=os.environ.get("STOCKFISH"))
    p.add_argument("--positions", type=int, default=1000)
    p.add_argument("--games", type=int, default=None, help="random: 100 (and half as many vs greedy); stockfish: 20")
    p.add_argument("--movetime", type=int, default=None, help="house engine ms a move (legality 100, mates 1000, games 50/100)")
    p.add_argument("--offset", type=int, default=0, help="stockfish: start at this game (to split a long run)")
    p.add_argument("--sf-movetime", type=int, default=100)
    p.add_argument("--ref-depth", type=int, default=12)
    p.add_argument("--max-plies", type=int, default=400)
    p.add_argument("--timeout", type=float, default=15.0, help="seconds before a search counts as frozen")
    p.add_argument("--slack", type=int, default=150, help="legality: ms past the movetime a reply may take before it is late")
    p.add_argument("--min-mate1", type=int, default=0, help="mates: fewer mates in 1 solved is a hard failure")
    p.add_argument("--min-mate2", type=int, default=0, help="mates: fewer mates in 2 solved is a hard failure")
    p.add_argument("--mate-count", type=int, default=100)
    p.add_argument("--seed", type=int, default=1)
    p.add_argument("--json", help="write the results here")
    args = p.parse_args()

    if args.check == "make-mates":
        make_mates(args)
        return 0
    defaults = {"legality": 100, "mates": 1000, "random": 50, "stockfish": 100}
    todo = ["legality", "mates", "random"] + (["stockfish"] if args.stockfish else []) if args.check == "all" else [args.check]
    games_arg, movetime_arg = args.games, args.movetime
    results, hard = {}, 0
    for check in todo:
        args.movetime = movetime_arg or defaults[check]
        args.games = games_arg or (20 if check == "stockfish" else 100)
        print(f"\n== {check}")
        r = {"legality": run_legality, "mates": run_mates, "random": run_random, "stockfish": run_stockfish}[check](args)
        results[check] = r
        hard += len(r.get("failures", [])) + len(r.get("hard_failures", []))
    if args.json:
        with open(args.json, "w", encoding="utf-8") as f:
            json.dump(results, f, indent=2)
    print(f"\n{'PASS' if hard == 0 else 'FAIL'}: {hard} hard failure(s) (illegal, malformed, late, frozen, crashed, "
          f"looping, or a mate suite below its threshold)")
    return 1 if hard else 0


if __name__ == "__main__":
    sys.exit(main())
