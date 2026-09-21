"""
Calibration study: does Sparring.Mirror, asked for targetElo=X, actually play
at strength X?

Ground truth: real Stockfish, set to the SAME Elo via its own officially
calibrated UCI_LimitStrength + UCI_Elo mode (not the coarser 0-20 "Skill
Level" knob, which isn't Stockfish's own Elo estimate). If the app's
ACPL<->Elo curve and Mirror's error model are accurate, Mirror-at-X vs.
Stockfish-at-X should score close to 50% over many games.

Drives the REAL browser code (js/sparring.js's Sparring.Mirror, unmodified)
via Playwright -- this is not a reimplementation or simulation of the app's
logic, it's the actual engine making the actual decisions.

Usage:
    python -m http.server 8000   (from the dvoretsky-lab/dvoretsky-lab dir)
    python calibrate.py
"""
import json
import time
from pathlib import Path

import chess
import chess.engine
from playwright.sync_api import sync_playwright

HERE = Path(__file__).parent
STOCKFISH_PATH = HERE / "stockfish" / "stockfish-windows-x86-64-universal.exe"
APP_URL = "http://localhost:8000/index.html"
RESULTS_PATH = HERE / "results.jsonl"

ELO_CHECKPOINTS = [1600, 2000, 2400]
GAMES_PER_CHECKPOINT = 8           # 4 as White, 4 as Black
MIRROR_BUDGET_MS = 600             # below the app's 900ms default purely for run time;
MIRROR_MAX_DEPTH = 3               # noted explicitly in the report, since it's a real deviation
STOCKFISH_MOVETIME_S = 0.15
MAX_PLIES = 120                    # safety cap; adjudicate_score() handles games that hit it


def new_position(page, mirror_elo):
    page.evaluate(
        """(elo) => {
            window.__mirror = new Sparring.Mirror({}, { targetElo: elo, budgetMs: %d, maxDepth: %d });
            window.__game = new Chess();
        }""" % (MIRROR_BUDGET_MS, MIRROR_MAX_DEPTH),
        mirror_elo,
    )


def mirror_move_uci(page, ply):
    """Ask the in-page Mirror for a move; returns (uci, san) or None if no legal moves."""
    return page.evaluate(
        """async (ply) => {
            var g = window.__game;
            var result = await window.__mirror.chooseMove(g, ply);
            if (!result) return null;
            var m = result.move;
            var uci = m.fromSq + m.toSq + (m.promo ? Chess.SYM[m.promo] : '');
            return { uci: uci, san: result.san };
        }""",
        ply,
    )


def apply_uci_in_page(page, uci):
    ok = page.evaluate("(u) => !!window.__game.move(u)", uci)
    if not ok:
        raise RuntimeError(f"page rejected move {uci!r} -- board desynced from python-chess")


def page_game_over(page):
    return page.evaluate("() => window.__game.gameOver()")


def adjudicate_score(sf, board, mirror_is_white):
    """For games truncated at MAX_PLIES rather than actually finished: ask
    Stockfish (at full strength, not Elo-limited -- this is scoring, not
    playing) to evaluate the final position, and convert to a fractional
    score via the standard cp->win-probability logistic. Scoring every
    truncated game as a flat 0.5 draw would bias the whole study toward
    50% regardless of which side was actually winning."""
    info = sf.analyse(board, chess.engine.Limit(time=0.5))
    score = info["score"].white()
    cp = score.score(mate_score=10000)
    if cp is None:
        cp = 10000 if score.mate() and score.mate() > 0 else -10000
    white_win_prob = 1 / (1 + 10 ** (-cp / 400))
    return white_win_prob if mirror_is_white else 1 - white_win_prob


def play_one_game(page, sf, mirror_elo, mirror_is_white):
    new_position(page, mirror_elo)
    board = chess.Board()
    sf.configure({"UCI_LimitStrength": True, "UCI_Elo": mirror_elo})

    ply = 0
    while ply < MAX_PLIES:
        over = page_game_over(page)
        if over:
            break
        mirror_to_move = (board.turn == chess.WHITE) == mirror_is_white
        ply += 1
        if mirror_to_move:
            res = mirror_move_uci(page, ply)
            if res is None:
                break
            uci = res["uci"]
            board.push_uci(uci)
        else:
            result = sf.play(board, chess.engine.Limit(time=STOCKFISH_MOVETIME_S))
            if result.move is None:
                break
            uci = result.move.uci()
            board.push(result.move)
        apply_uci_in_page(page, uci)

    over = page_game_over(page) or ("adjudicated" if ply >= MAX_PLIES else "unknown")
    if over == "checkmate":
        # side that just moved delivered mate; board.turn is who's stuck
        mate_victim_is_white = board.turn == chess.WHITE
        mirror_won = mate_victim_is_white != mirror_is_white
        mirror_score = 1.0 if mirror_won else 0.0
    elif over in ("stalemate", "fifty", "material"):
        mirror_score = 0.5
    else:  # adjudicated / unknown: game didn't actually conclude, so score by position, not a flat draw
        sf.configure({"UCI_LimitStrength": False})
        mirror_score = round(adjudicate_score(sf, board, mirror_is_white), 3)
    return {"plies": ply, "termination": over, "mirror_score": mirror_score}


def main():
    with sync_playwright() as p, chess.engine.SimpleEngine.popen_uci(str(STOCKFISH_PATH)) as sf:
        browser = p.chromium.launch(args=["--no-sandbox"])
        page = browser.new_page()
        page.goto(APP_URL)
        page.wait_for_selector("text=Dvoretsky Lab")

        with open(RESULTS_PATH, "w", encoding="utf-8") as out:
            for elo in ELO_CHECKPOINTS:
                scores = []
                for g in range(GAMES_PER_CHECKPOINT):
                    mirror_is_white = g % 2 == 0
                    t0 = time.time()
                    try:
                        r = play_one_game(page, sf, elo, mirror_is_white)
                    except Exception as e:
                        r = {"plies": None, "termination": f"error: {e}", "mirror_score": None}
                    r.update(elo=elo, game=g, mirror_is_white=mirror_is_white, seconds=round(time.time() - t0, 1))
                    out.write(json.dumps(r) + "\n")
                    out.flush()
                    print(f"elo={elo} game={g} white={mirror_is_white} "
                          f"score={r['mirror_score']} term={r['termination']} ({r['seconds']}s)")
                    if r["mirror_score"] is not None:
                        scores.append(r["mirror_score"])
                if scores:
                    print(f">>> elo={elo}: mirror scored {sum(scores)}/{len(scores)} "
                          f"({100*sum(scores)/len(scores):.0f}%) vs Stockfish@{elo}\n")
        browser.close()


if __name__ == "__main__":
    main()
