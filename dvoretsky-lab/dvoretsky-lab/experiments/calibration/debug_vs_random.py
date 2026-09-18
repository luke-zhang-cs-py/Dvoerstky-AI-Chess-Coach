"""Mirror@2400 vs. a purely random legal-move opponent, entirely in-page
(no Stockfish, no python-chess -- rules out any bridging bug)."""
from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    browser = p.chromium.launch(args=["--no-sandbox"])
    page = browser.new_page()
    page.goto("http://localhost:8000/index.html")
    page.wait_for_selector("text=Dvoretsky Lab")

    for g in range(4):
        mirror_white = g % 2 == 0
        out = page.evaluate(
            """async (mirrorWhite) => {
                var mirror = new Sparring.Mirror({}, { targetElo: 2400, budgetMs: 600, maxDepth: 3 });
                var game = new Chess();
                var ply = 0;
                while (ply < 150) {
                    var over = game.gameOver();
                    if (over) return { over: over, ply: ply, turn: game.turn };
                    ply++;
                    var mirrorTurn = (game.turn === Chess.WHITE) === mirrorWhite;
                    if (mirrorTurn) {
                        var res = await mirror.chooseMove(game, ply);
                        if (!res) return { over: 'no-move', ply: ply };
                        game.makeMove(res.move);
                    } else {
                        var legal = game.generate();
                        var mv = legal[Math.floor(Math.random() * legal.length)];
                        game.makeMove(mv);
                    }
                }
                return { over: 'adjudicated', ply: ply };
            }""",
            mirror_white,
        )
        print(f"game {g} mirror_white={mirror_white}: {out}")
    browser.close()
