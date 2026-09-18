"""Isolation test: bypass Sparring.Mirror's error-injection entirely and just
play engine.js's own top-ranked move (rankAsync's ranked[0]) against a weak
Stockfish. If even "always play the best move found" loses badly, the bug is
in engine.js's search itself, not in Mirror's error model."""
import chess
import chess.engine
from playwright.sync_api import sync_playwright
import calibrate as c

with sync_playwright() as p, chess.engine.SimpleEngine.popen_uci(str(c.STOCKFISH_PATH)) as sf:
    browser = p.chromium.launch(args=["--no-sandbox"])
    page = browser.new_page()
    page.goto(c.APP_URL)
    page.wait_for_selector("text=Dvoretsky Lab")

    page.evaluate("() => { window.__engine = new Engine(); window.__game = new Chess(); }")
    sf.configure({"UCI_LimitStrength": True, "UCI_Elo": 1320})
    board = chess.Board()
    engine_is_white = True

    ply = 0
    while ply < 80:
        over = c.page_game_over(page)
        if over:
            print("GAME OVER:", over)
            break
        engine_to_move = (board.turn == chess.WHITE) == engine_is_white
        ply += 1
        if engine_to_move:
            res = page.evaluate(
                """async () => {
                    var r = await window.__engine.rankAsync(window.__game, 3, 900);
                    if (!r.length) return null;
                    var m = r[0].move;
                    return { uci: m.fromSq + m.toSq + (m.promo ? Chess.SYM[m.promo] : ''),
                             san: r[0].san, score: r[0].score, nodes: window.__engine.nodes };
                }"""
            )
            if res is None:
                print("engine: no move"); break
            print(f"ply {ply} ENGINE: san={res['san']} score={res['score']} nodes={res['nodes']}")
            board.push_uci(res["uci"])
            uci = res["uci"]
        else:
            result = sf.play(board, chess.engine.Limit(time=c.STOCKFISH_MOVETIME_S))
            uci = result.move.uci()
            print(f"ply {ply} STOCKFISH@1320: uci={uci}")
            board.push(result.move)
        c.apply_uci_in_page(page, uci)

    print("\nfinal fen:", board.fen())
    browser.close()
