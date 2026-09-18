import chess
import chess.engine
from playwright.sync_api import sync_playwright
import calibrate as c

with sync_playwright() as p, chess.engine.SimpleEngine.popen_uci(str(c.STOCKFISH_PATH)) as sf:
    browser = p.chromium.launch(args=["--no-sandbox"])
    page = browser.new_page()
    page.goto(c.APP_URL)
    page.wait_for_selector("text=Dvoretsky Lab")

    mirror_elo = 2000
    mirror_is_white = True
    c.new_position(page, mirror_elo)
    board = chess.Board()
    sf.configure({"UCI_LimitStrength": True, "UCI_Elo": mirror_elo})

    ply = 0
    while ply < 30:
        over = c.page_game_over(page)
        if over:
            print("GAME OVER:", over)
            break
        mirror_to_move = (board.turn == chess.WHITE) == mirror_is_white
        ply += 1
        page_fen_before = page.evaluate("() => window.__game.fen()")
        if page_fen_before.split(" ")[0] != board.fen().split(" ")[0]:
            print(f"!!! DESYNC before ply {ply}: page={page_fen_before}  python={board.fen()}")
            break
        if mirror_to_move:
            res = c.mirror_move_uci(page, ply)
            if res is None:
                print("mirror: no move returned"); break
            uci, san = res["uci"], res["san"]
            print(f"ply {ply} MIRROR ({'w' if board.turn else 'b'}): san={san} uci={uci}")
            try:
                board.push_uci(uci)
            except Exception as e:
                print(f"!!! python-chess rejected mirror move {uci}: {e}")
                break
        else:
            result = sf.play(board, chess.engine.Limit(time=c.STOCKFISH_MOVETIME_S))
            uci = result.move.uci()
            print(f"ply {ply} STOCKFISH ({'w' if board.turn else 'b'}): uci={uci}")
            board.push(result.move)
        c.apply_uci_in_page(page, uci)

    print("\nfinal python fen:", board.fen())
    print("final page fen:  ", page.evaluate("() => window.__game.fen()"))
    browser.close()
