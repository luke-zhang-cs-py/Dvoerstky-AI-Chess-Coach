"""Sanity check: Mirror at a strong target Elo vs. Stockfish forced to its
weakest possible setting (UCI_Elo=1320, the documented floor). If Elo
limiting and the harness both work, Mirror should win most of these."""
import chess
import chess.engine
from playwright.sync_api import sync_playwright
import calibrate as c

with sync_playwright() as p, chess.engine.SimpleEngine.popen_uci(str(c.STOCKFISH_PATH)) as sf:
    browser = p.chromium.launch(args=["--no-sandbox"])
    page = browser.new_page()
    page.goto(c.APP_URL)
    page.wait_for_selector("text=Dvoretsky Lab")

    scores = []
    for g in range(4):
        mirror_is_white = g % 2 == 0
        c.new_position(page, 2400)
        board = chess.Board()
        sf.configure({"UCI_LimitStrength": True, "UCI_Elo": 1320})

        ply = 0
        while ply < c.MAX_PLIES:
            over = c.page_game_over(page)
            if over:
                break
            mirror_to_move = (board.turn == chess.WHITE) == mirror_is_white
            ply += 1
            if mirror_to_move:
                res = c.mirror_move_uci(page, ply)
                if res is None:
                    break
                uci = res["uci"]
                board.push_uci(uci)
            else:
                result = sf.play(board, chess.engine.Limit(time=c.STOCKFISH_MOVETIME_S))
                if result.move is None:
                    break
                uci = result.move.uci()
                board.push(result.move)
            c.apply_uci_in_page(page, uci)

        over = c.page_game_over(page) or "adjudicated"
        if over == "checkmate":
            mate_victim_is_white = board.turn == chess.WHITE
            mirror_score = 1.0 if (mate_victim_is_white != mirror_is_white) else 0.0
        elif over in ("stalemate", "fifty", "material"):
            mirror_score = 0.5
        else:
            sf.configure({"UCI_LimitStrength": False})
            mirror_score = round(c.adjudicate_score(sf, board, mirror_is_white), 3)
        print(f"game {g} mirror_white={mirror_is_white} plies={ply} term={over} mirror_score={mirror_score}")
        scores.append(mirror_score)

    print(f"\nMirror@2400 vs Stockfish@1320(floor): {sum(scores)}/{len(scores)}")
    browser.close()
