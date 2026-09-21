"""Call Mirror.chooseMove() many times on a fixed position at a fixed
targetElo, and compare the ACTUAL intended loss against what the error model
was configured to produce, to see where the gap is."""
from playwright.sync_api import sync_playwright
import calibrate as c

with sync_playwright() as p:
    browser = p.chromium.launch(args=["--no-sandbox"])
    page = browser.new_page()
    page.goto(c.APP_URL)
    page.wait_for_selector("text=Dvoretsky Lab")

    target_elo = 2400
    fen = "r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4"  # normal-ish middlegame-ish opening
    page.evaluate(
        """(elo) => {
            window.__mirror = new Sparring.Mirror({}, { targetElo: elo, budgetMs: 600, maxDepth: 3 });
        }""",
        target_elo,
    )

    results = page.evaluate(
        """async (fen) => {
            var out = [];
            for (var i = 0; i < 8; i++) {
                var g = new Chess(fen);
                var ranked = await window.__mirror.engine.rankAsync(g, 3, 600);
                var res = await window.__mirror.chooseMove(g, 10);
                var pickedScore = null;
                for (var j = 0; j < ranked.length; j++) {
                    if (ranked[j].move.fromSq === res.move.fromSq && ranked[j].move.toSq === res.move.toSq) { pickedScore = ranked[j].score; break; }
                }
                out.push({
                    san: res.san, intendedLoss: res.intendedLoss, complexity: res.complexity,
                    blunderTurn: res.blunderTurn, best: ranked.length ? ranked[0].score : null,
                    pickedScore: pickedScore, nRanked: ranked.length
                });
            }
            return out;
        }""",
        fen,
    )
    baseAcpl = page.evaluate("(elo) => Analysis.acplFromElo(elo)", target_elo)
    print(f"targetElo={target_elo} -> Analysis.acplFromElo = {baseAcpl:.1f} cp (this is errorModel's un-scaled baseline)")
    for r in results:
        real_loss = None if r["pickedScore"] is None or r["best"] is None else r["best"] - r["pickedScore"]
        print(r, " real_loss(best-picked)=", real_loss)
    browser.close()
