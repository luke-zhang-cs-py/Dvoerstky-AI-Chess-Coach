"""Drive index.html in Chromium and check the UI fixes from the September 2026 audit.

    pip install playwright && playwright install chromium
    python test/ui_check.py [--coverage out.json]

Each check is written to fail on the code before its fix. With --coverage the
page's precise V8 block coverage is written out for test/coverage_report.py.
"""
import json, os, re, sys, tempfile
from urllib.parse import parse_qs, urlparse
from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
APP = os.path.join(HERE, "..", "index.html")
PGN = os.path.join(HERE, "..", "experiments", "move_predictor", "ermactually_games.pgn")
COV = sys.argv[sys.argv.index("--coverage") + 1] if "--coverage" in sys.argv else None

results = []
def check(name, ok, detail=""):
    results.append(ok)
    print(("PASS " if ok else "FAIL ") + name + ("  [%s]" % detail if detail != "" else ""))

def write_tmp(name, text):
    path = os.path.join(tempfile.mkdtemp(), name)
    with open(path, "w", encoding="utf-8") as f: f.write(text)
    return path

def movable(pg, board):
    return pg.evaluate("document.querySelectorAll('#%s .sq.movable').length" % board)

with sync_playwright() as p:
    b = p.chromium.launch(channel=os.environ.get("PW_CHANNEL") or None)   # PW_CHANNEL=msedge uses an installed Edge
    ctx = b.new_context(viewport={"width": 1280, "height": 900}, accept_downloads=True)
    pg = ctx.new_page()
    errors = []
    pg.on("pageerror", lambda e: errors.append(str(e)))
    pg.on("dialog", lambda d: d.accept())
    # Lichess is never reached: an empty answer for games, a small profile.
    pg.route("**/lichess.org/api/games/**", lambda r: r.fulfill(status=200, body="", content_type="application/x-ndjson"))
    pg.route("**/lichess.org/api/user/**", lambda r: r.fulfill(status=200, body='{"perfs":{}}', content_type="application/json"))
    cdp = None
    if COV:
        cdp = ctx.new_cdp_session(pg)
        cdp.send("Profiler.enable")
        cdp.send("Profiler.startPreciseCoverage", {"callCount": True, "detailed": True})
    snapshots = []
    def snap():
        # Precise coverage belongs to the current document and is dropped on
        # navigation, so take it before every reload and add the pieces up.
        if cdp: snapshots.extend(cdp.send("Profiler.takePreciseCoverage")["result"])
    def reload():
        snap(); pg.reload()
    pg.goto("file:///" + os.path.abspath(APP).replace("\\", "/"))
    pg.wait_for_timeout(500)

    # ---- import your own games
    pg.set_input_files("#importFile", PGN); pg.wait_for_timeout(2500)
    first = pg.inner_text("#flash")
    pg.set_input_files("#importFile", PGN); pg.wait_for_timeout(2500)
    again = pg.inner_text("#flash")
    n_games = pg.evaluate("document.querySelectorAll('#revGame option').length")
    check("import: the same PGN twice does not double the games", "33 already loaded" in again and n_games == 33,
          "%d games; %s" % (n_games, again[:60]))
    check("import: evals in the PGN reach error mining", "None carry engine evaluations" not in first, first[:70])

    # ---- boards: eight equal ranks, however many pieces a rank holds, at any width
    SHAPE = """id => { const b = document.querySelector(id).getBoundingClientRect();
      const sq = [...document.querySelectorAll(id + ' .sq')].map(s => s.getBoundingClientRect());
      const w = sq.map(r => r.width), h = sq.map(r => r.height);
      return { board: Math.round(b.width), boardH: Math.round(b.height), n: sq.length,
               spread: Math.max(...h) - Math.min(...h), squareness: Math.max(...sq.map(r => Math.abs(r.width - r.height))),
               bottom: Math.round(b.bottom), viewH: innerHeight }; }"""
    pg.click("button.tab[data-tab=review]"); pg.wait_for_timeout(200); pg.click("#revStart"); pg.wait_for_timeout(500)
    shapes = {}
    for w in (1440, 1100, 820):
        pg.set_viewport_size({"width": w, "height": 900}); pg.wait_for_timeout(300)
        pg.click("button.tab[data-tab=review]"); pg.wait_for_timeout(200)
        shapes["review@%d" % w] = pg.evaluate(SHAPE, "#revBoard")
        pg.click("button.tab[data-tab=sparring]"); pg.wait_for_timeout(200)
        if w == 1440: pg.select_option("#sparColor", "w"); pg.click("#sparStart"); pg.wait_for_timeout(300)
        shapes["sparring@%d" % w] = pg.evaluate(SHAPE, "#sparBoard")
    pg.set_viewport_size({"width": 1280, "height": 900})
    bad = {k: v for k, v in shapes.items() if v["n"] != 64 or v["spread"] > 1.5 or v["squareness"] > 1.5}
    check("boards: every rank is the same height and every square is square", not bad,
          bad or " ".join("%s=%d" % (k, v["board"]) for k, v in shapes.items()))
    check("boards: on a wide screen the board has room to move (at least 540px)",
          shapes["review@1440"]["board"] >= 540 and shapes["sparring@1440"]["board"] >= 540,
          shapes["review@1440"]["board"])
    check("boards: stacked on a narrow screen, the board still fits the window's height",
          shapes["review@820"]["boardH"] <= 900 - 100, shapes["review@820"]["boardH"])

    # ---- sync: every Lichess format to choose from, right next to the button
    opts = pg.evaluate("[...document.querySelectorAll('#syncPerf option')].map(o => o.value)")
    check("sync: the format is chosen next to Sync, from all games or any Lichess format",
          opts == ["all", "ultraBullet", "bullet", "blitz", "rapid", "classical", "correspondence"], opts)
    asked_fmt = []
    pg.route("**/lichess.org/api/games/**", lambda r: (asked_fmt.append(r.request.url), r.fulfill(status=200, body="", content_type="application/x-ndjson")))
    pg.select_option("#syncPerf", "blitz"); pg.fill("#handle", "ermactually"); pg.click("#sync"); pg.wait_for_timeout(1200)
    check("sync: picking blitz asks Lichess for blitz only", bool(asked_fmt) and "perfType=blitz" in asked_fmt[-1] and "rapid" not in asked_fmt[-1],
          asked_fmt[-1][-80:] if asked_fmt else "no request")
    reload(); pg.wait_for_timeout(600)
    check("sync: the chosen format is remembered", pg.input_value("#syncPerf") == "blitz", pg.input_value("#syncPerf"))
    pg.select_option("#syncPerf", "all")
    pg.unroute("**/lichess.org/api/games/**")
    pg.route("**/lichess.org/api/games/**", lambda r: r.fulfill(status=200, body="", content_type="application/x-ndjson"))

    # ---- an empty sync keeps what is loaded
    pg.fill("#handle", "ermactually"); pg.click("#sync"); pg.wait_for_timeout(1500)
    n_after = pg.evaluate("document.querySelectorAll('#revGame option').length")
    check("sync: an empty answer from Lichess keeps the 33 imported games", n_after == 33,
          "%d; %s" % (n_after, pg.inner_text("#flash")[:60]))

    # ---- sparring: a game after a resignation is playable
    pg.click("button.tab[data-tab=sparring]")
    pg.select_option("#sparColor", "w"); pg.click("#sparStart"); pg.wait_for_timeout(300)
    before = movable(pg, "sparBoard")
    pg.click("#sparResign"); pg.click("#sparStart"); pg.wait_for_timeout(300)
    check("sparring: after resigning, the next game can be played", movable(pg, "sparBoard") == before > 0,
          "%d then %d movable" % (before, movable(pg, "sparBoard")))

    # ---- sparring: takeback of the mirror's only move as Black does not stall
    pg.select_option("#sparColor", "b"); pg.click("#sparStart")
    pg.wait_for_function("document.querySelector('#sparMoves').innerText.trim().length > 3", timeout=15000)
    pg.wait_for_timeout(300)
    pg.wait_for_function("document.querySelectorAll('#sparMoves button').length >= 1", timeout=15000)
    pg.wait_for_timeout(300)
    pg.click("#sparTakeback")
    try:
        pg.wait_for_function("document.querySelectorAll('#sparMoves button').length >= 1", timeout=8000)
        moved = True
    except Exception:
        moved = False
    check("sparring: taking back as Black lets the mirror move again", moved, pg.inner_text("#sparMoves").strip()[:20])

    # ---- sparring: a new game started while the mirror thinks is not overwritten
    reload(); pg.wait_for_timeout(600)
    pg.set_input_files("#importFile", PGN); pg.wait_for_timeout(2500)   # on the old code the empty sync wiped them
    pg.click("button.tab[data-tab=sparring]")
    # Make the mirror take a full second, so the restart below is sure to land while it thinks.
    pg.evaluate("""() => { const real = Sparring.Mirror.prototype.chooseMove;
      Sparring.Mirror.prototype.chooseMove = function () {
        const answer = real.apply(this, arguments);
        return new Promise(r => setTimeout(() => r(answer), 1000));
      }; }""")
    pg.select_option("#sparColor", "w"); pg.click("#sparStart"); pg.wait_for_timeout(200)
    pg.click('#sparBoard [data-sq="a2"]'); pg.click('#sparBoard [data-sq="a3"]')
    pg.wait_for_timeout(400)   # the mirror is now thinking about 1.a3
    pg.click("#sparStart")
    start = "a1 a2 a7 a8 b1 b2 b7 b8 c1 c2 c7 c8 d1 d2 d7 d8 e1 e2 e7 e8 f1 f2 f7 f8 g1 g2 g7 g8 h1 h2 h7 h8"
    wrong = None
    for _ in range(40):   # watch the board, not just its final state
        pieces = pg.evaluate("[...document.querySelectorAll('#sparBoard .sq')].filter(s => s.querySelector('.piece')).map(s => s.dataset.sq).sort().join(' ')")
        if pieces != start: wrong = pieces; break
        pg.wait_for_timeout(100)
    check("sparring: an old game's reply does not land on the new board", wrong is None, (wrong or "start position throughout")[:60])

    # ---- drills need a card: one game where White misses Qxf7# (a backup in the app's own format)
    rows = [["e4", 30], ["e5", 30], ["Qh5", 0], ["Nc6", 20], ["Bc4", 20], ["Nf6", 10000], ["d3", -50, "Blunder", "h5f7"]]
    game = {"id": "mate-miss", "source": "lichess", "url": "https://lichess.org/abcdefgh", "speed": "rapid", "perf": "rapid",
            "rated": True, "date": 1790000000000, "endedAt": 1790000000000, "status": "resign", "myColor": "w",
            "myName": "me", "oppName": "them", "myRating": 1800, "oppRating": 1800, "score": 0, "result": "0-1",
            "openingName": "Test", "analysed": True,
            "m": [[r[0], r[1], r[2] if len(r) > 2 else "", r[3] if len(r) > 3 else "", "", ""] for r in rows]}
    pg.set_input_files("#importFile", write_tmp("one-card.json", json.dumps({"games": [game]})))
    pg.wait_for_timeout(1200)

    # ---- drills: a queue opened and quit without a single card graded is not a day's practice
    pg.evaluate("localStorage.removeItem('dvor:completed')"); reload(); pg.wait_for_timeout(600)
    pg.click("button.tab[data-tab=drills]"); pg.wait_for_timeout(300)
    pg.click("[data-start=all]"); pg.wait_for_timeout(300); pg.click("#drillQuit"); pg.wait_for_timeout(300)
    unplayed_counts = pg.evaluate("Object.keys(JSON.parse(localStorage.getItem('dvor:completed') || '{}')).length")

    # ---- drills: an endgame study does not hijack the next puzzle
    pg.click("button.tab[data-tab=drills]"); pg.wait_for_timeout(300)
    pg.select_option("#egPick", "two-bishops"); pg.click("[data-start=endgame]"); pg.wait_for_timeout(300)
    pg.click('#drillBoard [data-sq="e1"]'); pg.click('#drillBoard [data-sq="e2"]')
    pg.wait_for_function("/Engine plays/.test(document.querySelector('#drillFeedback').innerText)", timeout=15000)
    fb = pg.inner_text("#drillFeedback")
    shown = fb.split("Evaluation ")[1].split(" ")[0].rstrip(".") if "Evaluation " in fb else ""
    winning = shown.startswith("#") or (shown[:1] == "+" and float(shown[1:]) > 3)
    check("endgame: two bishops against a bare king reads as winning for White", winning, fb[:80])
    pg.click("#drillQuit"); pg.wait_for_timeout(300)
    played_counts = pg.evaluate("Object.keys(JSON.parse(localStorage.getItem('dvor:completed') || '{}')).length")
    pg.click("[data-start=all]"); pg.wait_for_timeout(400)
    pg.click('#drillBoard [data-sq="a2"]'); pg.click('#drillBoard [data-sq="a3"]'); pg.wait_for_timeout(1500)
    fb = pg.inner_text("#drillFeedback")
    check("drills: a puzzle move is graded, not answered by the engine", fb.startswith("Not a3"), fb[:60])
    pg.click("#drillQuit"); pg.wait_for_timeout(200)
    check("drills: playing an endgame counts as practice; quitting a queue unplayed does not",
          played_counts == 1 and unplayed_counts == 0, "%d / %d" % (played_counts, unplayed_counts))

    # ---- review: the text box is usable for a second review
    pg.click("button.tab[data-tab=review]"); pg.wait_for_timeout(200)
    pg.evaluate("document.querySelector('#revText').disabled = true")
    pg.click("#revStart"); pg.wait_for_timeout(300)
    check("review: starting a review enables the text box", not pg.is_disabled("#revText"))

    # ---- board: underpromotion is possible, and Escape cancels
    picked = pg.evaluate("""() => new Promise(done => {
      const el = document.createElement('div'); el.className = 'board'; el.style.width = '320px';
      document.body.appendChild(el);
      const bd = new Board(el, { fen: '7k/P7/8/8/8/8/8/K7 w - - 0 1',
        onMove: (m, g) => done({ promo: Chess.SYM[m.promo], picker: !!el.querySelector('.promo-pick') }) });
      el.querySelector('[data-sq=a7]').click(); el.querySelector('[data-sq=a8]').click();
      const shown = !!el.querySelector('.promo-pick');
      el.querySelector('[data-promo=n]').click();
      if (!shown) done({ promo: 'no picker' });
    })""")
    check("board: a promotion asks, and a knight can be chosen", picked.get("promo") == "n", picked)

    # ---- the analysis window: all time by default, a slider to narrow it
    pg.evaluate("localStorage.setItem('dvor:settings', JSON.stringify({minutes: 60, endgameTier: 2, hour: 19, apiKey: '', perf: 'rapid'}))")
    reload(); pg.wait_for_timeout(600)
    st = pg.evaluate("JSON.parse(localStorage.getItem('dvor:settings'))")
    check("window: settings from before the slider move to all speeds, all time", st.get("perf") == "all" and st.get("windowDays") == 0, st)
    pg.set_input_files("#importFile", PGN); pg.wait_for_timeout(2500)
    pg.click("button.tab[data-tab=strength]"); pg.wait_for_timeout(200)
    cap = lambda: pg.inner_text("#rulerCaption")
    count = lambda: int(re.search(r":\s*(\d+)\s*games", cap()).group(1))
    total = count()
    check("window: the default is all time, and it counts every loaded game",
          pg.inner_text("#winLabel") == "All time" and cap().startswith("All time")
          and total == pg.evaluate("document.querySelectorAll('#revGame option').length"), cap()[:40])
    def slide(i):
        pg.evaluate("""i => { const r = document.querySelector('#winDays'); r.value = String(i);
          r.dispatchEvent(new Event('input')); r.dispatchEvent(new Event('change')); }""", i)
        pg.wait_for_timeout(700)
    slide(2)   # 30 days
    narrow = count()
    check("window: moving the slider to 30 days re-measures on fewer games", pg.inner_text("#winLabel") == "Last 30 days"
          and cap().startswith("Last 30 days") and narrow < total, "%s -> %d games" % (pg.inner_text("#winLabel"), narrow))
    check("window: the calibration card names the window", "Performance, last 30 days" in pg.inner_text("#strengthBody"))
    slide(9)
    check("window: all the way right is all time again", count() == total and pg.inner_text("#winLabel") == "All time", count())
    slide(4)   # 90 days
    reload(); pg.wait_for_timeout(700)
    check("window: the chosen window survives a reload", pg.inner_text("#winLabel") == "Last 90 days"
          and pg.input_value("#winDays") == "4", pg.inner_text("#winLabel"))
    slide(9)
    asked = []
    pg.unroute("**/lichess.org/api/games/**")
    pg.route("**/lichess.org/api/games/**", lambda r: (asked.append(r.request.url), r.fulfill(status=200, body="", content_type="application/x-ndjson")))
    pg.fill("#handle", "ermactually"); pg.click("#sync"); pg.wait_for_timeout(1500)
    q = parse_qs(urlparse(asked[0]).query) if asked else {}
    check("window: sync on all time asks for the whole history, every standard speed, up to 1000 games",
          "since" not in q and q.get("perfType") == ["ultraBullet,bullet,blitz,rapid,classical,correspondence"]
          and q.get("max") == ["1000"], {k: v[0][:40] for k, v in q.items() if k in ("since", "perfType", "max")})

    # ---- strength: compared with titled players (CM to GM), on the same Lichess scale
    pg.click("button.tab[data-tab=strength]"); pg.wait_for_timeout(300)
    rows = lambda: pg.evaluate(r"[...document.querySelectorAll('#titledBody .cmp-row')].map(r => r.innerText.replace(/\s+/g, ' ').trim())")
    shown = rows()
    check("titled: one CM, FM, IM and GM are shown by default, beside you and your measured strength",
          all(any(n in r for r in shown) for n in ["Tryfon Gavriel", "Nate Solon", "Eric Rosen", "Magnus Carlsen"])
          and shown[0].startswith("You") and any(r.startswith("Measured strength") for r in shown), shown)
    check("titled: Magnus is shown at his bullet rating, never at a placeholder 1500",
          any("Magnus Carlsen" in r and r.endswith("3243") for r in shown) and not any("1500" in r for r in shown), [r for r in shown if "Magnus" in r])
    check("titled: the FIDE title floors are drawn", pg.evaluate("[...document.querySelectorAll('.cmp-floor b')].map(b => b.textContent).join()") == "CM,FM,IM,GM")
    pg.select_option("#cmpSpeed", "rapid"); pg.wait_for_timeout(200)
    rapid = pg.inner_text("#titledSheet")
    check("titled: one speed shows that speed, and names who has no established rating there",
          "No established rapid rating on Lichess:" in rapid and "Magnus Carlsen" in rapid.split("No established rapid rating on Lichess:")[1]
          and any("Eric Rosen" in r and r.endswith("2574") for r in rows()), rows())
    pg.check('[data-pick="AnishGiri"]'); pg.uncheck('[data-pick="Kingscrusher-YouTube"]'); pg.wait_for_timeout(200)
    focused = pg.evaluate("document.activeElement && document.activeElement.dataset && document.activeElement.dataset.pick")
    check("titled: choosing players changes the chart, and focus stays on the checkbox",
          "Anish Giri" in pg.inner_text("#titledSheet") and not any("Tryfon Gavriel" in r for r in rows()) and focused == "Kingscrusher-YouTube", focused)
    reload(); pg.wait_for_timeout(700); pg.click("button.tab[data-tab=strength]"); pg.wait_for_timeout(300)
    check("titled: the chosen players and speed survive a reload", pg.input_value("#cmpSpeed") == "rapid"
          and pg.is_checked('[data-pick="AnishGiri"]') and not pg.is_checked('[data-pick="Kingscrusher-YouTube"]'))
    asked_users = []
    pg.route("**/lichess.org/api/users", lambda r: (asked_users.append(r.request.post_data), r.fulfill(status=200, content_type="application/json",
             body=json.dumps([{"username": "EricRosen", "title": "IM", "perfs": {"rapid": {"rating": 2611, "games": 2000}}}]))))
    pg.click("#cmpRefresh")
    pg.wait_for_function("document.querySelector('#cmpStatus') && /Live ratings/.test(document.querySelector('#cmpStatus').textContent)", timeout=20000)
    check("titled: refresh reads the chosen players from Lichess and shows the live numbers",
          asked_users and "EricRosen" in asked_users[0] and "AnishGiri" in asked_users[0]
          and any("Eric Rosen" in r and r.endswith("2611") for r in rows()), [asked_users[:1], [r for r in rows() if "Rosen" in r]])
    pg.select_option("#cmpSpeed", "all"); pg.check('[data-pick="Kingscrusher-YouTube"]'); pg.uncheck('[data-pick="AnishGiri"]')

    # ---- the Stockfish reader: a real engine, in a worker, from file://
    pg.click("button.tab[data-tab=sparring]")
    pg.select_option("#sparColor", "w"); pg.click("#sparStart")
    try:
        pg.wait_for_function("document.querySelector('.sf-eval')", timeout=40000)
        now = pg.inner_text("#sfNow")
    except Exception:
        now = pg.inner_text("#sfNow")
    check("stockfish: it starts in a worker from file:// and reads the start position",
          "depth" in now and "Stockfish plays" in now, now.replace("\n", " | ")[:90])
    pg.click('#sparBoard [data-sq="e2"]'); pg.click('#sparBoard [data-sq="e4"]')
    pg.wait_for_function("document.querySelectorAll('#sparMoves button').length >= 2", timeout=30000)
    try:
        pg.wait_for_function("""(() => { const rows = [...document.querySelectorAll('.sf-log tbody tr')];
            return rows.length >= 2 && rows.every(r => /good|inaccuracy|mistake|blunder/.test(r.innerText)); })()""", timeout=60000)
        graded = True
    except Exception:
        graded = False
    check("stockfish: your move and the mirror's reply both get a verdict", graded,
          pg.inner_text("#sfLog").replace("\n", " | ")[:120])
    try:
        pg.wait_for_function("/House engine:/.test(document.querySelector('#sfNow').innerText)", timeout=40000)
        house = True
    except Exception:
        house = False
    check("stockfish: the house engine's evaluation is shown beside Stockfish's", house, pg.inner_text("#sfNow")[:120])
    pg.uncheck("#sfOn"); pg.wait_for_timeout(300)
    check("stockfish: switching it off says so", "Stockfish is off" in pg.inner_text("#sfNow"))
    pg.check("#sfOn")

    # ---- board themes from the chess sites
    SITE = {"lichess-brown": ("rgb(240, 217, 181)", "rgb(181, 136, 99)"), "lichess-blue": ("rgb(222, 227, 230)", "rgb(140, 162, 173)"),
            "chesscom-green": ("rgb(235, 236, 208)", "rgb(119, 149, 86)"), "chesscom-brown": ("rgb(237, 214, 176)", "rgb(184, 135, 98)"),
            "chesscom-blue": ("rgb(234, 233, 210)", "rgb(75, 115, 153)")}
    groups = pg.evaluate("[...document.querySelectorAll('#setBoardTheme optgroup')].map(g => g.label)")
    check("themes: the board colours are grouped by site", groups == ["This app", "Lichess", "Chess.com"], groups)
    looks = {}
    for theme in SITE:
        pg.click("button.tab[data-tab=settings]"); pg.select_option("#setBoardTheme", theme); pg.click("#saveSettings")
        pg.click("button.tab[data-tab=sparring]"); pg.wait_for_timeout(150)
        looks[theme] = pg.evaluate("""() => { const s = n => document.querySelector('#sparBoard [data-sq=' + n + ']');
          return [getComputedStyle(s('h1')).backgroundColor, getComputedStyle(s('a1')).backgroundColor,
                  s('e1').querySelector('.piece').textContent]; }""")
    check("themes: each site's board has that site's square colours",
          all(tuple(looks[k][:2]) == v for k, v in SITE.items()), {k: v[:2] for k, v in looks.items() if tuple(v[:2]) != SITE[k]})
    check("themes: site boards draw white pieces solid, so they read on light squares",
          all(v[2] == "\u265a" for v in looks.values()), [v[2] for v in looks.values()])
    pg.click("button.tab[data-tab=settings]"); pg.select_option("#setBoardTheme", "cyan"); pg.click("#saveSettings")
    pg.click("button.tab[data-tab=sparring]"); pg.wait_for_timeout(150)
    check("themes: the app's own theme still draws white as outlines", pg.evaluate(
          "document.querySelector('#sparBoard [data-sq=e1] .piece').textContent") == "\u2654")
    pg.click("button.tab[data-tab=settings]"); pg.select_option("#setBoardTheme", "lichess-brown"); pg.click("#saveSettings")
    reload(); pg.wait_for_timeout(600); pg.click("button.tab[data-tab=sparring]"); pg.wait_for_timeout(150)
    check("themes: the chosen site theme survives a reload", pg.evaluate(
          "getComputedStyle(document.querySelector('#sparBoard [data-sq=h1]')).backgroundColor") == SITE["lichess-brown"][0])
    pg.click("button.tab[data-tab=settings]"); pg.select_option("#setBoardTheme", "cyan"); pg.click("#saveSettings")

    # ---- backup: no API key in the file, and a hostile backup cannot run script
    pg.click("button.tab[data-tab=settings]")
    pg.fill("#setKey", "sk-ant-TESTKEY"); pg.click("#saveSettings")
    with pg.expect_download() as dl:
        pg.click("#exportAll")
    backup = open(dl.value.path(), encoding="utf-8").read()
    check("backup: the API key is not written into the backup", "sk-ant-TESTKEY" not in backup)

    bad = json.loads(backup)
    g0 = bad["games"][0]
    g0["result"] = '<img src=x onerror="window.__x=(window.__x||[]).concat(\'result\')">'
    g0["oppRating"] = '<img src=x onerror="window.__x=(window.__x||[]).concat(\'rating\')">'
    g0["url"] = "javascript:window.__x='url'"
    bad["track"] = [{"day": "2026-09-01", "measured": 1800, "moe": 50, "n": 3},
                    {"day": "2026-09-02", "measured": 1810, "moe": 50,
                     "n": '<img src=x onerror="window.__x=(window.__x||[]).concat(\'track\')">'}]
    bad["cards"] = {"k": {"history": 5}}
    # settings reach innerHTML as the window's label and the speed in a sync notice, and a
    # stored justification's rubric numbers as its feedback
    hostile = lambda tag: '<img src=x onerror="window.__x=(window.__x||[]).concat(\'%s\')">' % tag
    bad["settings"]["windowDays"] = hostile("window")
    bad["settings"]["perf"] = hostile("perf")
    first_ply = "0" if g0["myColor"] == "w" else "1"   # the first move the review asks about
    bad["transcripts"] = {g0["id"]: {first_ply: {"text": "x", "san": "e4", "cpLoss": 0,
                                                 "score": {"concreteness": hostile("transcript")}, "notes": []}}}
    pg.set_input_files("#importFile", write_tmp("hostile-backup.json", json.dumps(bad)))
    pg.wait_for_timeout(1500)
    for tab in ["strength", "review", "drills"]:
        pg.click("button.tab[data-tab=%s]" % tab); pg.wait_for_timeout(200)
    pg.click("button.tab[data-tab=review]"); pg.select_option("#revGame", "0"); pg.click("#revStart"); pg.wait_for_timeout(300)
    pg.fill("#handle", "ermactually"); pg.click("#sync"); pg.wait_for_timeout(1500)   # no games come back: the notice names the speed
    fired = pg.evaluate("window.__x || null")
    check("backup: markup in an imported backup never runs", fired is None, fired)
    js_links = pg.evaluate("[...document.querySelectorAll('a[href]')].filter(a => /^javascript:/i.test(a.getAttribute('href'))).length")
    check("backup: no javascript: link survives import", js_links == 0, js_links)
    check("backup: settings and the key survive a restore", pg.evaluate(
        "JSON.parse(localStorage.getItem('dvor:settings')).apiKey") == "sk-ant-TESTKEY")
    check("page: no uncaught errors throughout", not errors, errors[:3])

    if COV:
        snap()
        with open(COV, "w", encoding="utf-8") as f: json.dump({"result": snapshots}, f)
    b.close()

print("\n%d passed, %d failed" % (results.count(True), results.count(False)))
sys.exit(0 if all(results) else 1)
