"""Drive index.html in Chromium and check the UI fixes from the September and October 2026 audits.

    pip install playwright && playwright install chromium
    python test/ui_check.py [--coverage out.json]

Each check is written to fail on the code before its fix. With --coverage the
page's precise V8 block coverage is written out for test/coverage_report.py.
"""
import json, os, re, sys, tempfile, time
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
    # With --coverage, V8 must not reuse a script compiled for an earlier page: code from its compilation
    # cache is counted per function only (no blocks), so after a reload nothing would say which lines ran.
    # (--no-flush-bytecode as well made the run seven times slower; the report leaves out the odd
    # function V8 still counts that way, and says so.)
    b = p.chromium.launch(channel=os.environ.get("PW_CHANNEL") or None,   # PW_CHANNEL=msedge uses an installed Edge
                          args=["--js-flags=--no-compilation-cache"] if COV else [])
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
    pg.wait_for_function("document.querySelectorAll('#sparMoves .mv').length >= 1", timeout=15000)
    pg.wait_for_timeout(300)
    pg.click("#sparTakeback")
    try:
        pg.wait_for_function("document.querySelectorAll('#sparMoves .mv').length >= 1", timeout=8000)
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

    # ---- board: the keyboard at the edges, on a flipped board and with the picker open; a board with no onMove
    keys = pg.evaluate("""() => {
      const el = document.createElement('div'); el.className = 'board'; el.style.width = '320px';
      el.setAttribute('aria-label', 'Test board');
      document.body.appendChild(el);
      const bd = new Board(el, { fen: '7k/P7/8/8/8/8/8/K7 w - - 0 1', flipped: true, showCoords: false, onMove: () => {} });
      const key = (target, k) => target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
      const sq = n => el.querySelector('[data-sq=' + n + ']');
      const at = () => document.activeElement.dataset.sq || document.activeElement.tagName;
      const out = { label: el.getAttribute('aria-label'), coords: el.querySelectorAll('.coord').length };
      sq('e4').focus(); key(sq('e4'), 'ArrowUp'); out.flippedUp = at();           // flipped: up the screen is down the board
      sq('h1').focus(); key(sq('h1'), 'ArrowLeft'); out.edge = at();              // flipped h1 is the right-hand edge... seen from Black
      key(sq('h1'), 'Tab'); out.otherKey = at();                                   // not an arrow, Enter or Space: nothing
      key(el, 'Enter'); out.offSquare = bd.selected;                               // a key on the board itself, off the squares
      sq('a7').click(); sq('a8').click();                                          // the picker opens
      key(el.querySelector('[data-promo=q]'), 'Enter'); out.keyOnPicker = !!el.querySelector('.promo-pick');
      key(el, 'Escape'); out.escaped = !el.querySelector('.promo-pick') && bd.pendingPromotion === null;
      bd.setDisplayOptions({}); out.optsKept = bd.flipped && !bd.showCoords && bd.pieceSet === 'glyph';
      bd.cursor = null; sq('b2').focus(); bd.render(); out.noCursor = at();       // the cursor lost: a new one, and focus on it
      const plain = document.createElement('div'); plain.className = 'board'; document.body.appendChild(plain);
      const pb = new Board(plain);
      plain.querySelector('[data-sq=e2]').click(); plain.querySelector('[data-sq=e5]').click();
      out.notTarget = pb.selected;                                                 // e5 is no move for e2: the selection drops
      plain.querySelector('[data-sq=e2]').click(); plain.querySelector('[data-sq=e2]').click();
      out.reclick = pb.selected;                                                   // the selected piece clicked again: put down
      plain.querySelector('[data-sq=e2]').click(); plain.querySelector('[data-sq=e4]').click();
      out.noOnMove = [pb.selected, pb.game.fen().split(' ')[0].slice(-8)];         // a legal move with no onMove: nothing played
      // The picker with no onMove, and the picker closed by a click on the board; a click between squares; a board you cannot move on.
      const promo = document.createElement('div'); promo.className = 'board'; document.body.appendChild(promo);
      const pp = new Board(promo, { fen: '1r5k/P7/8/8/8/8/8/K7 w - - 0 1' });
      promo.querySelector('[data-sq=a7]').click();
      out.capture = promo.querySelector('[data-sq=b8]').classList.contains('occupied');   // a capture target is marked as such
      promo.querySelector('[data-sq=b8]').click(); promo.querySelector('[data-promo=r]').click();
      out.pickNoOnMove = !promo.querySelector('.promo-pick') && pp.pendingPromotion === null;
      promo.querySelector('[data-sq=a7]').click(); promo.querySelector('[data-sq=a8]').click();
      promo.querySelector('[data-sq=h1]').click();
      out.clickedAway = !promo.querySelector('.promo-pick') && pp.pendingPromotion === null;
      promo.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      out.between = pp.selected;
      const still = document.createElement('div'); still.className = 'board'; document.body.appendChild(still);
      const sb = new Board(still, { interactive: false, flipped: true, pieceSet: 'letters' });
      out.readOnlyStart = sb.cursor;                                               // nothing can move: the corner, h8 when flipped
      sb.setDisplayOptions();
      out.letters = still.querySelector('[data-sq=e1] .piece').textContent;
      still.querySelector('[data-sq=e2]').click();
      out.readOnly = [sb.selected, sb.cursor];
      el.remove(); plain.remove(); promo.remove(); still.remove();
      return out;
    }""")
    check("board: a flipped board turns the arrows round, stops at the edge, and ignores other keys",
          keys["flippedUp"] == "e3" and keys["edge"] == "h1" and keys["otherKey"] == "h1" and keys["offSquare"] is None, keys)
    check("board: Enter on the picker is the picker's own; Escape closes it", keys["keyOnPicker"] and keys["escaped"], keys)
    check("board: a label it is given is kept, coordinates can be off, and empty display options change nothing",
          keys["label"] == "Test board" and keys["coords"] == 0 and keys["optsKept"], keys)
    check("board: a click on no legal target drops the selection; with no onMove, a move plays nothing",
          keys["notTarget"] is None and keys["noOnMove"] == [None, "RNBQKBNR"], keys)
    check("board: a cursor that was lost goes back on a piece that can move, with the focus", keys["noCursor"] == "a1", keys)
    check("board: a capture is marked; the picker closes with no onMove or a click away; a piece clicked twice is put down; a read-only board only moves the cursor",
          keys["capture"] and keys["pickNoOnMove"] and keys["clickedAway"] and keys["between"] is None and keys["readOnly"] == [None, "e2"]
          and keys["readOnlyStart"] == "h8" and keys["reclick"] is None and keys["letters"] == "K", keys)
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
    pg.wait_for_timeout(100); pg.select_option("#cmpSpeed", "blitz"); pg.wait_for_timeout(100)   # the sheet redrawn mid-refresh
    check("titled: while a refresh is reading Lichess, a redrawn sheet cannot start a second one",
          pg.is_disabled("#cmpRefresh"), pg.inner_text("#cmpStatus"))
    pg.select_option("#cmpSpeed", "rapid")
    pg.wait_for_function("document.querySelector('#cmpStatus') && /Live ratings/.test(document.querySelector('#cmpStatus').textContent)", timeout=20000)
    check("titled: refresh reads the chosen players from Lichess and shows the live numbers",
          asked_users and "EricRosen" in asked_users[0] and "AnishGiri" in asked_users[0]
          and any("Eric Rosen" in r and r.endswith("2611") for r in rows()), [asked_users[:1], [r for r in rows() if "Rosen" in r]])
    check("titled: when Lichess answers for some of the players, the status says which numbers are live",
          "1 of 4 players" in pg.inner_text("#cmpStatus"), pg.inner_text("#cmpStatus"))
    for u in ["CheckRaiseMate", "EricRosen", "DrNykterstein", "AnishGiri"]: pg.uncheck('[data-pick="%s"]' % u)
    pg.click("#cmpRefresh"); pg.wait_for_timeout(100)
    reading = pg.inner_text("#cmpStatus")
    pg.wait_for_function("!document.querySelector('#cmpRefresh').disabled", timeout=20000)
    check("titled: with nobody chosen, refresh says how many players it reads (the defaults)", "Reading 4 players" in reading, reading)
    for u in ["Kingscrusher-YouTube", "CheckRaiseMate", "EricRosen", "DrNykterstein"]: pg.check('[data-pick="%s"]' % u)
    pg.select_option("#cmpSpeed", "all")
    pg.evaluate("""localStorage.setItem('dvor:titledLive', JSON.stringify({ date: '2026-10-01',
                   players: { EricRosen: { t: 'NM', s: { blitz: [2550, 9400, 0] } } } }))""")
    reload(); pg.wait_for_timeout(700); pg.click("button.tab[data-tab=strength]"); pg.wait_for_timeout(300)
    check("titled: a player whose live title is not CM to GM can still be unchecked",
          pg.evaluate("document.querySelectorAll('[data-pick=\"EricRosen\"]').length") == 1 and any("Eric Rosen" in r for r in rows()), rows())
    pg.evaluate("localStorage.removeItem('dvor:titledLive')")

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
    pg.wait_for_function("document.querySelectorAll('#sparMoves .mv').length >= 2", timeout=30000)
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
    # The checks below pass trivially if the import threw and nothing was restored, so first
    # prove it was: the restore's own message, and the backup's games, transcript and trajectory
    # now in storage.
    restored = pg.evaluate("""([id, ply]) => {
      const get = k => JSON.parse(localStorage.getItem('dvor:' + k) || 'null');
      const t = get('transcripts') || {}, track = get('track') || [], games = get('games') || [];
      return { flash: document.querySelector('#flash').innerText.trim(), transcript: !!(t[id] && t[id][ply]),
               track: track.some(p => p.day === '2026-09-01'), game: games.some(g => g.id === id) }; }""", [g0["id"], first_ply])
    check("backup: the hostile backup was restored (so the checks on it test something)",
          restored["flash"] == "Backup restored." and restored["transcript"] and restored["track"] and restored["game"], restored)
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

    # ---- October 2026 audit: storage read back raw, set-up positions, local days, ratings of the right account
    # each tampered key on its own reload, so one failure cannot hide another
    def tampered(key, value, tabs):
        seen = len(errors)
        pg.evaluate("([k, v]) => localStorage.setItem(k, v)", [key, value])
        reload(); pg.wait_for_timeout(1500)
        for tab in tabs:
            pg.click("button.tab[data-tab=%s]" % tab); pg.wait_for_timeout(300)
        return errors[seen:]
    tampered("dvor:lichessRating", json.dumps('<img src=x onerror="window.__r=1">'), ["strength"])
    check("storage: a tampered saved rating never runs as markup", pg.evaluate("window.__r || null") is None)
    pg.evaluate("localStorage.setItem('dvor:lichessRating', '1800')")
    new_errors = tampered("dvor:track", '{"x":1}', ["strength"])
    check("storage: a tampered trajectory does not break the next measurement",
          not new_errors and pg.evaluate("Array.isArray(JSON.parse(localStorage.getItem('dvor:track')))"), new_errors[:2])
    pg.evaluate("localStorage.setItem('dvor:track', '[]')")
    new_errors = tampered("dvor:completed", "null", ["calendar"])
    check("storage: a tampered record of days done does not break the calendar",
          not new_errors and pg.evaluate("document.querySelectorAll('button.day[data-day]').length") > 0, new_errors[:2])
    pg.evaluate("localStorage.setItem('dvor:completed', '{}')")

    # A game set up from a position, imported in the evening: it survives a reload as itself,
    # and the trajectory's mark is dated by the local day, not by UTC's.
    tzs = ctx.new_cdp_session(pg); tzs.send("Emulation.setTimezoneOverride", {"timezoneId": "America/Toronto"})
    pg.clock.set_fixed_time("2026-10-02T01:30:00Z")   # 21:30 on 1 October in Toronto
    fen_pgn = ('[Event "x"]\n[Site "https://lichess.org/fenstart1"]\n[White "fenwhite"]\n[Black "fenblack"]\n[Result "*"]\n'
               '[SetUp "1"]\n[FEN "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1"]\n\n1... e5 2. Nf3 Nc6 *\n')
    pg.set_input_files("#importFile", write_tmp("fen.pgn", fen_pgn)); pg.wait_for_timeout(2000)
    days = pg.evaluate("(JSON.parse(localStorage.getItem('dvor:track')) || []).map(p => p.day)")
    check("trajectory: an evening sync is marked on that day, not on tomorrow's UTC date",
          days and days[-1] == "2026-10-01" and "2026-10-02" not in days, days[-3:])
    reload(); pg.wait_for_timeout(1500)
    pg.click("button.tab[data-tab=settings]")
    with pg.expect_download() as dl:
        pg.click("#exportAll")
    saved = [g for g in json.load(open(dl.value.path(), encoding="utf-8"))["games"] if g.get("id") == "fenstart1"]
    sans = [m[0] for m in saved[0]["m"]] if saved else None
    check("games: a game set up from a FEN is still that game after a reload",
          sans == ["e5", "Nf3", "Nc6"] and saved[0].get("fen", "").startswith("rnbqkbnr/pppppppp/8/8/4P3"), sans)

    # Your Lichess ratings beside the titled players belong to the account just synced.
    held = []
    def user_api(route):
        url = route.request.url
        name = urlparse(url).path.split("/")[3]
        if url.endswith("/rating-history"):
            if name == "alice": held.append(route); return   # answered late, after bob's sync
            return route.fulfill(status=200, content_type="application/json", body="[]")
        if name == "carol": return route.fulfill(status=404, content_type="application/json", body="{}")
        route.fulfill(status=200, content_type="application/json",
                      body=json.dumps({"perfs": {"blitz": {"rating": {"alice": 1900, "bob": 1700}.get(name, 1500), "games": 500}}}))
    def games_api(route):
        name = urlparse(route.request.url).path.split("/")[-1]
        g = {"id": "sync" + name, "rated": True, "speed": "blitz", "perf": "blitz", "createdAt": 1790000000000,
             "status": "resign", "winner": "white", "moves": "e4 e5 Nf3",
             "players": {"white": {"user": {"name": name}, "rating": 1800}, "black": {"user": {"name": "opp"}, "rating": 1800}}}
        route.fulfill(status=200, content_type="application/x-ndjson", body=json.dumps(g) + "\n")
    pg.unroute("**/lichess.org/api/games/**"); pg.route("**/lichess.org/api/games/**", games_api)
    pg.unroute("**/lichess.org/api/user/**"); pg.route("**/lichess.org/api/user/**", user_api)
    you = lambda: pg.evaluate(r"((document.querySelector('#titledBody .cmp-row.you') || {}).innerText || '').replace(/\s+/g, ' ')")
    pg.click("button.tab[data-tab=strength]")
    for name in ["alice", "bob"]:
        pg.fill("#handle", name); pg.click("#sync"); pg.wait_for_timeout(1500)
    check("titled: alice's rating history was held back until after bob's sync (the race is staged)", len(held) == 1, len(held))
    if held: held[0].fulfill(status=200, content_type="application/json", body=json.dumps([{"name": "Blitz", "points": [[2026, 8, 1, 1950]]}]))
    pg.wait_for_timeout(800)
    row = you()
    check("titled: a late rating history for the last account does not replace the one just synced",
          "bob" in row and "1700" in row and "alice" not in row, row)
    pg.fill("#handle", "carol"); pg.click("#sync"); pg.wait_for_timeout(1500)
    row = you()
    check("titled: after a sync whose profile lookup failed, another account's ratings are not shown as yours",
          row.startswith("You") and "bob" not in row and "alice" not in row, row)

    # ---- 9 October 2026 audit: each scenario on a fresh page of its own, seeded through storage
    DAY = 86400000
    NOW = int(time.time() * 1000)
    TODAY = time.strftime("%Y.%m.%d")
    def blunder_game(gid, days_ago=1, my="w"):
        # 1.e4 e5 2.Ba6?? bxa6 3.Nf3, evals from White's side; Lichess's best for ply 3 is g1f3
        return {"id": gid, "source": "lichess", "url": "https://lichess.org/" + gid, "speed": "rapid", "perf": "rapid",
                "rated": True, "date": NOW - days_ago * DAY, "endedAt": NOW - days_ago * DAY, "status": "resign",
                "myColor": my, "myName": "luke", "oppName": "opp", "myRating": 1800, "oppRating": 1800,
                "score": 0, "result": "0-1", "eco": "C20", "openingName": "King's Pawn Game", "openingPly": 2,
                "analysed": True, "acpl": 60,
                "m": [["e4", 30, "", "", "", "", ""], ["e5", 30, "", "", "", "", ""],
                      ["Ba6", -300, "Blunder", "g1f3", "", "Nf3 Nc6", ""], ["bxa6", -300, "", "", "", "", ""],
                      ["Nf3", -300, "", "", "", "", ""]]}
    def small_error_game(gid, days_ago=1):
        g = blunder_game(gid, days_ago)
        g["m"] = [["e4", 30, "", "", "", "", ""], ["e5", 30, "", "", "", "", ""],
                  ["Qh5", -80, "Inaccuracy", "g1f3", "", "Nf3", ""], ["Nc6", -80, "", "", "", "", ""]]
        return g
    page_cov = {}
    def snap_page(page):
        if id(page) in page_cov: snapshots.extend(page_cov[id(page)].send("Profiler.takePreciseCoverage")["result"])
    def fresh(seed, hash_="", routes=None):
        """A new context (its own storage), seeded once before the page's scripts run."""
        c = b.new_context(viewport={"width": 1280, "height": 900}, accept_downloads=True)
        c.route("**/lichess.org/**", lambda r: r.fulfill(status=200, body="", content_type="application/x-ndjson"))
        for pat, fn in (routes or {}).items(): c.route(pat, fn)
        page = c.new_page()
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.accept_dialogs = lambda d: d.accept()   # kept, so a check can swap in its own answer
        page.on("dialog", page.accept_dialogs)
        if COV:
            # Each fresh page is its own document: measure it too, and take its coverage
            # before the context closes (or the page reloads), or it goes unrecorded.
            pcdp = c.new_cdp_session(page)
            pcdp.send("Profiler.enable")
            pcdp.send("Profiler.startPreciseCoverage", {"callCount": True, "detailed": True})
            page_cov[id(page)] = pcdp
            real_close = c.close
            def close_measured(*a, **k):
                snap_page(page)
                return real_close(*a, **k)
            c.close = close_measured
        js = "".join("localStorage.setItem(%s, %s);" % (json.dumps("dvor:" + k), json.dumps(json.dumps(v))) for k, v in seed.items())
        page.add_init_script('if (!sessionStorage.getItem("seeded")) { localStorage.clear(); %s sessionStorage.setItem("seeded", "1"); }' % js)
        page.goto("file:///" + os.path.abspath(APP).replace("\\", "/") + hash_)
        page.wait_for_timeout(500)
        return c, page
    stored_games = lambda page: page.evaluate("JSON.parse(localStorage.getItem('dvor:games'))")

    # Import: a PGN on top of synced games keeps the synced ones (the cap sync uses, newest kept).
    c2, p2 = fresh({"games": [blunder_game("s%03d" % i, 2 + i % 300) for i in range(600)], "handle": "luke"})
    p2.set_input_files("#importFile", write_tmp("one.pgn", '[Event "Rated Rapid game"]\n[Site "https://lichess.org/newgame1"]\n'
        '[Date "%s"]\n[White "luke"]\n[Black "x"]\n[Result "1-0"]\n\n1. e4 e5 2. Nf3 1-0\n' % TODAY))
    p2.wait_for_timeout(2500)
    g2 = stored_games(p2)
    dates = [g["date"] for g in g2]
    check("import: a one-game PGN on 600 synced games keeps all 601, newest first",
          len(g2) == 601 and g2[0]["id"] == "newgame1" and dates == sorted(dates, reverse=True), "%d games, first %s" % (len(g2), g2[0]["id"]))
    c2.close()
    c2, p2 = fresh({"games": [blunder_game("s%04d" % i, 2 + i) for i in range(1000)], "handle": "luke"})
    p2.set_input_files("#importFile", write_tmp("one.pgn", '[Site "https://lichess.org/newgame2"]\n[Date "%s"]\n[White "luke"]\n[Black "x"]\n'
        '[Result "1-0"]\n\n1. e4 e5 1-0\n' % TODAY))
    p2.wait_for_timeout(3000)
    g2 = stored_games(p2)
    check("import: past the cap, the oldest game goes, and the notice says so",
          len(g2) == 1000 and g2[0]["id"] == "newgame2" and "s0999" not in [g["id"] for g in g2] and "1 of the oldest" in p2.inner_text("#flash"),
          "%d; %s" % (len(g2), p2.inner_text("#flash")[:90]))
    p2.set_input_files("#importFile", write_tmp("zh.pgn", '[Variant "Crazyhouse"]\n[White "luke"]\n[Black "x"]\n[Result "1-0"]\n\n'
        '1. e4 d5 2. exd5 Qxd5 3. Nc3 Qa5 4. P@d4 1-0\n'))
    p2.wait_for_timeout(800)
    check("import: a variant game is refused, and the notice says why", "only standard chess" in p2.inner_text("#flash")
          and "Crazyhouse" in p2.inner_text("#flash"), p2.inner_text("#flash")[:90])
    c2.close()

    # Cards: review history for a game no longer loaded survives the next rebuild.
    gone = {"gone1:3": {"id": "gone1:3", "ease": 2.7, "interval": 40, "reps": 5, "lapses": 0, "due": NOW + 30 * DAY,
                        "last": NOW - 10 * DAY, "history": [{"t": NOW - 10 * DAY, "g": 3}]}}
    c2, p2 = fresh({"games": [blunder_game("new1", 1)], "cards": gone})
    kept = p2.evaluate("JSON.parse(localStorage.getItem('dvor:cards'))")
    check("cards: a card whose game is not loaded keeps its schedule", "gone1:3" in kept and kept["gone1:3"]["interval"] == 40
          and "new1:3" in kept, sorted(kept))
    c2.close()

    # Review: a game older than the window is still reviewed against its mined errors.
    c2, p2 = fresh({"games": [blunder_game("old1", 200)], "settings": {"windowDays": 7, "hour": 19, "minutes": 60, "endgameTier": 2}})
    p2.click("button.tab[data-tab=review]"); p2.select_option("#revGame", "0"); p2.click("#revStart")
    p2.fill("#revText", "e4 because it is natural"); p2.click("#revSubmit"); p2.click("#revNext")
    p2.fill("#revText", "Ba6 develops, his reply bxa6 I missed"); p2.click("#revSubmit")
    fb = p2.inner_text("#revFeedback")
    check("review: an error outside the Strength window is still named", "the engine wanted Nf3, cost 3.3 pawns" in fb, fb.strip()[-80:])
    check("review: the move list is text, not buttons that do nothing",
          p2.evaluate("document.querySelectorAll('#revMoves button').length") == 0 and p2.evaluate("document.querySelectorAll('#revMoves .mv').length") >= 3)
    c2.close()

    # Sparring: a restart as White within the mirror's delay; the mirror must not play White's move.
    c2, p2 = fresh({"games": [blunder_game("a1", 1)]})
    p2.click("button.tab[data-tab=sparring]"); p2.uncheck("#sfOn")
    p2.evaluate("""() => { const c = document.querySelector('#sparColor'), s = document.querySelector('#sparStart');
      c.value = 'b'; s.click(); c.value = 'w'; s.click(); }""")
    p2.wait_for_timeout(3000)
    check("sparring: a game restarted as White before the mirror's first move has no move played for you",
          p2.evaluate("document.querySelectorAll('#sparMoves .mv').length") == 0, p2.inner_text("#sparMoves")[:30])
    p2.click('#sparBoard [data-sq="e2"]'); p2.click('#sparBoard [data-sq="e4"]')
    p2.wait_for_function("document.querySelectorAll('#sparMoves .mv').length >= 2", timeout=20000)
    pgn = p2.input_value("#sparPgn")
    check("sparring: the game text names the players and the result, so an import knows your side",
          '[White "You"]' in pgn and '[Black "Dvoretsky Lab mirror"]' in pgn and '[Result "*"]' in pgn and pgn.rstrip().endswith("*"), pgn[:120])
    p2.click("#sparResign")
    check("sparring: ...and after resigning, the result is the mirror's", '[Result "0-1"]' in p2.input_value("#sparPgn"))
    p2.click("button.tab[data-tab=settings]")
    p2.set_input_files("#importFile", write_tmp("spar.pgn", p2.input_value("#sparPgn")))
    p2.wait_for_timeout(1500)
    imp = [g for g in stored_games(p2) if g["oppName"] == "Dvoretsky Lab mirror"]
    check("sparring: that text imports as your game, with your colour and result", bool(imp) and imp[0]["myColor"] == "w" and imp[0]["score"] == 0,
          str(imp and (imp[0]["myColor"], imp[0]["score"])))
    c2.close()

    # Stockfish: a restart before the first read finishes still gets the new game's position read.
    c2, p2 = fresh({"games": [blunder_game("a1", 1)]})
    p2.click("button.tab[data-tab=sparring]"); p2.select_option("#sfTime", "1000"); p2.select_option("#sparColor", "w")
    p2.click("#sparStart"); p2.wait_for_timeout(300); p2.click("#sparStart")
    try:
        p2.wait_for_function("/depth/.test(document.querySelector('#sfNow').innerText)", timeout=30000); read_ok = True
    except Exception:
        read_ok = False
    check("stockfish: starting again while the first read runs does not leave the reading stuck", read_ok,
          " ".join(p2.inner_text("#sfNow").split())[:70])
    c2.close()

    # Calendar: "Run it" on a calculation set runs that set, not every card.
    c2, p2 = fresh({"games": [blunder_game("b%d" % i, 1) for i in range(6)] + [small_error_game("s%d" % i, 1) for i in range(30)],
                    "settings": {"windowDays": 0, "minutes": 60, "hour": 19, "endgameTier": 2}})
    p2.click("button.tab[data-tab=calendar]")
    ran = None
    for d in p2.query_selector_all("[data-day]"):
        d.click()
        btn = p2.query_selector("#dayDetail .block.calculation [data-run]")
        if btn:
            n = int(re.search(r"(\d+) positions", p2.inner_text("#dayDetail .block.calculation")).group(1))
            btn.click(); p2.wait_for_timeout(300)
            ran = (n, p2.inner_text("#drillProgress"))
            break
    check("calendar: a calculation set's Run it drills the positions it lists", bool(ran) and ran[1] == "1 of %d" % ran[0], str(ran))
    c2.close()

    # Drills: after "Show the move" the card cannot be graded as found.
    c2, p2 = fresh({"games": [blunder_game("a1", 1)]})
    p2.click("button.tab[data-tab=drills]"); p2.click("[data-start=due]"); p2.click("#drillReveal")
    open_grades = p2.evaluate("[...document.querySelectorAll('#drillGrades button')].filter(b => !b.disabled).map(b => b.dataset.grade).join()")
    check("drills: after a reveal only Missed it and Hard can be chosen", open_grades == "0,1", open_grades)
    p2.click('[data-grade="0"]')
    card = p2.evaluate("JSON.parse(localStorage.getItem('dvor:cards'))['a1:3']")
    check("drills: ...and the card loses its interval", card["interval"] == 0 and card["lapses"] == 1, card)
    c2.close()

    # Storage full: a justification that cannot be saved says so.
    c2, p2 = fresh({"games": [blunder_game("a1", 1)]})
    p2.evaluate("""() => { let n = 1 << 22, i = 0;
      while (n > 16) { try { localStorage.setItem('junk' + (i++), 'x'.repeat(n)); } catch (e) { n >>= 1; } } }""")
    p2.click("button.tab[data-tab=review]"); p2.select_option("#revGame", "0"); p2.click("#revStart")
    p2.fill("#revText", "Candidates e4 or d4; his reply e5; equal. " * 20); p2.click("#revSubmit")
    check("storage: a justification that does not fit says it was not saved",
          p2.evaluate("!document.querySelector('#flash').classList.contains('hidden')") and "not saved" in p2.inner_text("#flash"),
          p2.inner_text("#flash")[:80])
    c2.close()

    # Keyboard: the board is one tab stop, arrows cover all 64 squares, focus survives a move.
    c2, p2 = fresh({"games": [blunder_game("a1", 1)]})
    p2.click("button.tab[data-tab=drills]"); p2.select_option("#egPick", "lucena"); p2.click("[data-start=endgame]")
    stops = p2.evaluate("[...document.querySelectorAll('#drillBoard [data-sq]')].map(s => s.tabIndex)")
    check("keyboard: every square is focusable, and exactly one is in the tab order",
          len(stops) == 64 and stops.count(0) == 1 and stops.count(-1) == 63, "%d squares, %d tab stops" % (len(stops), stops.count(0)))
    labels = p2.evaluate("['c8', 'd1', 'e4'].map(n => document.querySelector('#drillBoard [data-sq=' + n + ']').getAttribute('aria-label'))")
    check("keyboard: squares are named with what stands on them", labels == ["c8, white king", "d1, white rook", "e4, empty"], labels)
    p2.focus('#drillBoard [data-sq=d1]'); p2.keyboard.press("ArrowUp"); p2.keyboard.press("ArrowUp"); p2.keyboard.press("ArrowRight")
    at = p2.evaluate("document.activeElement.dataset.sq || document.activeElement.tagName")
    check("keyboard: arrow keys move over the squares, empty ones included", at == "e3", at)
    p2.focus('#drillBoard [data-sq=d1]'); p2.keyboard.press("Enter")
    p2.focus('#drillBoard [data-sq=d4]'); p2.keyboard.press("Enter")
    after_move = p2.evaluate("document.activeElement.dataset.sq || document.activeElement.tagName")
    p2.wait_for_function("/Engine plays/.test(document.querySelector('#drillFeedback').innerText)", timeout=15000)
    after_reply = p2.evaluate("document.activeElement.dataset.sq || document.activeElement.tagName")
    check("keyboard: after a move, and after the reply, focus is on the square the piece went to",
          after_move == "d4" and after_reply == "d4", "%s / %s" % (after_move, after_reply))
    c2.close()

    # Tabs: a hash that is not a tab shows Strength; tabs are wired to their panels and to the arrows.
    c2, p2 = fresh({}, "#nosuchtab")
    check("tabs: an unknown hash falls back to Strength", p2.evaluate("document.querySelectorAll('.panel.active').length") == 1
          and p2.evaluate("(document.querySelector('.panel.active') || {}).id") == "panel-strength")
    wired = p2.evaluate("[...document.querySelectorAll('.tab')].every(t => document.getElementById(t.getAttribute('aria-controls')))")
    p2.focus("button.tab[data-tab=strength]"); p2.keyboard.press("ArrowRight")
    moved = p2.evaluate("[document.activeElement.dataset.tab, (document.querySelector('.panel.active') || {}).id, "
                        "[...document.querySelectorAll('.tab')].filter(t => t.tabIndex === 0).length]")
    check("tabs: each controls its panel, and the arrow keys move between them", wired and moved == ["sparring", "panel-sparring", 1], moved)
    c2.close()

    # Settings: a stored blob missing a key reads over the defaults; a bad hour keeps the old one.
    c2, p2 = fresh({"settings": {"windowDays": 0, "minutes": 60}, "games": [blunder_game("a1", 1)]})
    p2.click("button.tab[data-tab=settings]")
    shown_hour = p2.input_value("#setHour")
    p2.fill("#setHour", "7pm"); p2.click("#saveSettings")
    st = p2.evaluate("JSON.parse(localStorage.getItem('dvor:settings'))")
    check("settings: missing keys read as the defaults, and an hour of \"7pm\" keeps the saved 19",
          shown_hour == "19" and st["hour"] == 19 and "kept the old value" in p2.inner_text("#flash"), "%r; %s" % (shown_hour, st.get("hour")))
    p2.fill("#setMinutes", "0"); p2.click("#saveSettings")
    check("settings: minutes of 0 keep the saved value", p2.evaluate("JSON.parse(localStorage.getItem('dvor:settings')).minutes") == 60)
    p2.click("button.tab[data-tab=calendar]")
    with p2.expect_download() as dl:
        p2.click("#icsBtn")
    ics = open(dl.value.path(), encoding="utf-8").read()
    check("settings: the calendar file has no NaN in it", "NaN" not in ics and "T190000" in ics,
          [l for l in ics.splitlines() if l.startswith("DTSTART")][:1])
    c2.close()

    # Scout: a profile loaded as yours stays theirs when the window moves.
    def scout_games(route):
        rows = [json.dumps({"id": "sc%d" % i, "rated": True, "speed": "rapid", "perf": "rapid", "createdAt": NOW - DAY,
                "status": "resign", "winner": "white", "moves": "e4 e5 Nf3 Nc6",
                "players": {"white": {"user": {"name": "scoutee"}, "rating": 1700}, "black": {"user": {"name": "opp"}, "rating": 1700}}})
                for i in range(5)]
        route.fulfill(status=200, body="\n".join(rows) + "\n", content_type="application/x-ndjson")
    c2, p2 = fresh({"games": [blunder_game("own%d" % i, 1) for i in range(3)]}, routes={"**/lichess.org/api/games/user/scoutee**": scout_games})
    p2.click("button.tab[data-tab=scout]"); p2.fill("#scoutHandle", "scoutee"); p2.click("#scoutBtn")
    p2.wait_for_selector("#scoutAdopt", timeout=10000); p2.click("#scoutAdopt"); p2.wait_for_timeout(300)
    p2.evaluate("""() => { const r = document.querySelector('#winDays'); r.value = '0';
      r.dispatchEvent(new Event('input')); r.dispatchEvent(new Event('change')); }""")
    p2.wait_for_timeout(700)
    cap2 = p2.inner_text("#rulerCaption")
    check("scout: after loading a scouted profile, moving the window re-measures their games, not yours",
          re.search(r"Last 7 days:\s*5\s*games", cap2) is not None, cap2[:60])
    c2.close()

    # ---- October 2026 coverage round: paths no check walked before
    # Scout: a player whose games carry Lichess's analysis gets the full report; a failed read says why.
    def scout_analysed(route):
        rows = [json.dumps({"id": "sa%d" % i, "rated": True, "speed": "rapid", "perf": "rapid", "createdAt": NOW - DAY * (i + 1),
                "status": "resign", "winner": "black", "moves": "e4 e5 Ba6 bxa6 Nf3", "opening": {"eco": "C20", "name": "King's Pawn Game"},
                "analysis": [{"eval": 30}, {"eval": 30}, {"eval": -300, "best": "g1f3", "judgment": {"name": "Blunder"}}, {"eval": -300}, {"eval": -300}],
                "players": {"white": {"user": {"name": "analysed"}, "rating": 1700}, "black": {"user": {"name": "opp"}, "rating": 1700}}})
                for i in range(4)]
        route.fulfill(status=200, body="\n".join(rows) + "\n", content_type="application/x-ndjson")
    c2, p2 = fresh({}, routes={"**/lichess.org/api/games/user/analysed**": scout_analysed,
                               "**/lichess.org/api/games/user/broken**": lambda r: r.fulfill(status=500, body="")})
    p2.click("button.tab[data-tab=scout]"); p2.click("#scoutBtn")
    check("scout: no handle, no request, and the notice says what to paste", "Paste a Lichess profile link" in p2.inner_text("#flash"))
    p2.fill("#scoutHandle", "https://lichess.org/@/analysed"); p2.click("#scoutBtn")
    p2.wait_for_selector("#scoutAdopt", timeout=10000)
    rep = p2.inner_text("#scoutOut")
    check("scout: the report names the recurring weakness and the opening that loses",
          "Recurring weaknesses:" in rep and "left material loose" in rep and "Openings under water: King's Pawn Game as White (0%)" in rep
          and "Repair or replace King's Pawn Game" in rep, " ".join(rep.split())[:200])
    p2.fill("#scoutHandle", "broken"); p2.click("#scoutBtn")
    p2.wait_for_function("/Lichess returned 500/.test(document.querySelector('#scoutOut').innerText)", timeout=10000)
    check("scout: a failed read is shown in the report's place", "Lichess returned 500." in p2.inner_text("#scoutOut"))
    c2.close()

    # Review to the end: the session summary, then the written verdict (no key: the prompt; a key: the API's text).
    def anthropic(route):
        cors = {"Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "POST"}
        if route.request.method == "OPTIONS": return route.fulfill(status=204, headers=cors)
        key = route.request.headers.get("x-api-key")
        if key == "sk-bad": return route.fulfill(status=401, headers=cors, body='{"error":"invalid x-api-key"}')
        route.fulfill(status=200, headers=cors, content_type="application/json",
                      body=json.dumps({"content": [{"type": "text", "text": "Your habit is skipping his replies."}], "stop_reason": "end_turn"}))
    c2, p2 = fresh({"games": [blunder_game("rv1", 1)]}, routes={"**/api.anthropic.com/**": anthropic})
    p2.click("button.tab[data-tab=review]"); p2.select_option("#revGame", "0"); p2.click("#revStart")
    p2.click("#revNext")
    check("review: Next before writing anything asks for the justification first", "Write your justification first" in p2.inner_text("#flash")
          and p2.inner_text("#revProgress").endswith("1 of 3"), p2.inner_text("#revProgress"))
    for note in ["e4 or d4, his reply e5, equal", "Ba6 because it felt natural", "Nf3 or d3, his threat is bxa6 kept, worse"]:
        p2.fill("#revText", note); p2.click("#revSubmit"); p2.click("#revNext")
    summary = p2.inner_text("#revFeedback")
    check("review: after the last move, the summary names the turning point and sets homework",
          "Game complete." in p2.text_content("#revPrompt") and "The game turned on move 2. You played Ba6 where Nf3 held" in summary
          and "find Nf3 from a cold start" in summary and p2.is_disabled("#revText"), " ".join(summary.split())[:160])
    p2.click("#llmBtn")
    prompt = p2.input_value("#llmOut textarea")
    check("review: with no API key the verdict button hands over the prompt, the notes in it",
          "No API key set" in p2.inner_text("#llmOut") and '- Move 2 (Ba6): "Ba6 because it felt natural" [cost 330cp; engine preferred Nf3]' in prompt,
          [l for l in prompt.splitlines() if l.startswith("- Move")][:3])
    p2.evaluate("() => { const s = JSON.parse(localStorage.getItem('dvor:settings') || '{}'); s.apiKey = 'sk-good'; localStorage.setItem('dvor:settings', JSON.stringify(s)); }")
    p2.click("button.tab[data-tab=settings]"); p2.fill("#setKey", "sk-good"); p2.click("#saveSettings")
    p2.click("button.tab[data-tab=review]"); p2.click("#llmBtn")
    p2.wait_for_function("/habit/.test(document.querySelector('#llmOut').innerText)", timeout=10000)
    check("review: with a key, the model's verdict is shown", p2.inner_text("#llmOut").strip() == "Your habit is skipping his replies.", p2.inner_text("#llmOut")[:80])
    p2.click("button.tab[data-tab=settings]"); p2.fill("#setKey", "sk-bad"); p2.click("#saveSettings")
    p2.click("button.tab[data-tab=review]"); p2.click("#llmBtn")
    p2.wait_for_function("/API 401/.test(document.querySelector('#llmOut').innerText)", timeout=10000)
    check("review: a refused key is shown as the API's error", "API 401" in p2.inner_text("#llmOut"), p2.inner_text("#llmOut")[:80])
    p2.click("#revRestart")
    check("review: Review another game closes the summary and frees the text box",
          p2.evaluate("document.querySelector('#revStage').classList.contains('hidden')") and not p2.is_disabled("#revText"))
    p2.click("#revStart"); p2.click("#revSkip")
    check("review: Skip moves on to the next of your moves without a note", p2.inner_text("#revProgress").endswith("2 of 3"), p2.inner_text("#revProgress"))
    c2.close()

    # Drills: the right move is accepted and graded; a pattern queue; the Strength tab's Drill buttons.
    no_best = blunder_game("nb1", 2)
    no_best["m"][2] = ["Ba6", -300, "Blunder", "", "", "", ""]   # Lichess gave no better move: no puzzle
    c2, p2 = fresh({"games": [blunder_game("a1", 1), no_best]})
    p2.click("button.tab[data-tab=drills]"); p2.click("[data-start=all]")
    p2.click('#drillBoard [data-sq="g1"]'); p2.click('#drillBoard [data-sq="f3"]'); p2.wait_for_timeout(200)
    grades = p2.evaluate("[...document.querySelectorAll('#drillGrades button')].map(b => (b.disabled ? '-' : '') + b.dataset.grade + (b.classList.contains('primary') ? '*' : '')).join()")
    check("drills: the right move at the first try is Correct, every grade open, Instant suggested",
          p2.inner_text("#drillFeedback").startswith("Correct: Nf3.") and grades == "0,1,2,3*", "%s; %s" % (p2.inner_text("#drillFeedback")[:40], grades))
    p2.click('[data-grade="3"]'); p2.wait_for_timeout(200)
    card = p2.evaluate("JSON.parse(localStorage.getItem('dvor:cards'))['a1:3']")
    done = p2.evaluate("Object.keys(JSON.parse(localStorage.getItem('dvor:completed') || '{}')).length")
    check("drills: grading it schedules the card two days on, ends the queue and logs the day",
          card["reps"] == 1 and card["interval"] == 2 and card["history"][-1]["g"] == 3 and done == 1
          and not p2.evaluate("document.querySelector('#drillHome').classList.contains('hidden')"), "%s; done %d" % ({k: card[k] for k in ("reps", "interval")}, done))
    motif = p2.evaluate("[...document.querySelectorAll('#drillMotif option')].map(o => o.value).filter(Boolean)[0] || ''")
    p2.select_option("#drillMotif", motif); p2.click("[data-start=motif]")
    check("drills: a pattern chosen from the list drills the cards with that pattern", bool(motif) and p2.inner_text("#drillProgress") == "1 of 1",
          "%s: %s" % (motif, p2.inner_text("#drillProgress")))
    p2.click("#drillQuit")
    p2.click("button.tab[data-tab=strength]"); p2.wait_for_timeout(200)
    p2.click('[data-jump="nb1:3"]')
    check("strength: Drill on a mistake with no known better move says it cannot be a puzzle", "cannot be a puzzle" in p2.inner_text("#flash"))
    p2.click('[data-jump="a1:3"]'); p2.wait_for_timeout(200)
    check("strength: Drill on a mistake opens that position as a puzzle",
          p2.evaluate("(document.querySelector('.panel.active') || {}).id") == "panel-drills" and p2.inner_text("#drillProgress") == "1 of 1"
          and "You played Ba6 here" in p2.inner_text("#drillPrompt"), p2.inner_text("#drillPrompt")[:80])
    c2.close()

    # Calendar: a day marked done and unmarked; the endgame, sparring and review blocks open their tabs.
    c2, p2 = fresh({"games": [blunder_game("b%d" % i, 1) for i in range(4)], "settings": {"windowDays": 0, "minutes": 120, "hour": 19, "endgameTier": 2}})
    p2.click("button.tab[data-tab=calendar]")
    p2.click("[data-day]"); day = p2.get_attribute("[data-day]", "data-day")
    p2.click("#markDone")
    marked = p2.evaluate("d => d in JSON.parse(localStorage.getItem('dvor:completed') || '{}')", day)
    p2.click('[data-day="%s"]' % day); p2.click("#markDone")
    unmarked = p2.evaluate("d => !(d in JSON.parse(localStorage.getItem('dvor:completed') || '{}'))", day)
    check("calendar: a day can be marked done, and unmarked", marked and unmarked, "%s %s" % (marked, unmarked))
    opened = {}
    for kind in ("eg", "spar", "review"):
        p2.click("button.tab[data-tab=calendar]")
        for d in p2.query_selector_all("[data-day]"):
            d.click()
            btn = p2.query_selector('#dayDetail [data-run="%s"]' % kind)
            if btn:
                colour = btn.get_attribute("data-color")
                btn.click(); p2.wait_for_timeout(300)
                panel = p2.evaluate("(document.querySelector('.panel.active') || {}).id")
                opened[kind] = (panel, p2.inner_text("#drillProgress") if kind == "eg" else
                                p2.input_value("#sparColor") == colour if kind == "spar" else True)
                break
    check("calendar: Set up, Play and Open review take the block to its tab, ready",
          opened.get("eg") == ("panel-drills", "Endgame study") and opened.get("spar") == ("panel-sparring", True)
          and opened.get("review") == ("panel-review", True), opened)
    c2.close()

    # Sparring: taking back as White leaves your turn; Stockfish that cannot start says so.
    c2, p2 = fresh({"games": [blunder_game("a1", 1)]})
    p2.evaluate("window.STOCKFISH_SOURCE = 'throw new Error(\"sf-start-check\")'")
    p2.click("button.tab[data-tab=sparring]"); p2.select_option("#sparColor", "w"); p2.click("#sparStart")
    p2.click('#sparBoard [data-sq="e2"]'); p2.click('#sparBoard [data-sq="e4"]')
    p2.wait_for_function("document.querySelectorAll('#sparMoves .mv').length >= 2", timeout=20000)
    corner = lambda: p2.evaluate("document.querySelector('#sparBoard [data-sq]').dataset.sq")
    unflipped = corner(); p2.click("#sparFlip"); flipped = corner(); p2.click("#sparFlip")
    check("sparring: Flip turns the board round, and back", unflipped == "a8" and flipped == "h1" and corner() == "a8",
          "%s, %s, %s" % (unflipped, flipped, corner()))
    p2.click("#sparTakeback"); p2.wait_for_timeout(500)
    check("sparring: a takeback as White undoes both moves and it is your move again",
          p2.evaluate("document.querySelectorAll('#sparMoves .mv').length") == 0 and movable(p2, "sparBoard") > 0, movable(p2, "sparBoard"))
    p2.uncheck("#sparCoach")
    off = p2.inner_text("#sparAdvice")
    p2.click("#sparHint")
    p2.wait_for_function("(t => t && !/Live advice is off|Reading the position/.test(t))(document.querySelector('#sparAdvice').innerText)", timeout=20000)
    check("sparring: with live advice off it says so, and One hint still reads the position once",
          "Live advice is off" in off and "Live advice is off" not in p2.inner_text("#sparAdvice") and not p2.is_checked("#sparCoach"),
          " ".join(p2.inner_text("#sparAdvice").split())[:80])
    try:
        p2.wait_for_function("/Stockfish did not start/.test(document.querySelector('#sfNow').innerText)", timeout=10000); sf_said = True
    except Exception:
        sf_said = False
    check("stockfish: a worker that fails to start is reported, not waited on", sf_said, p2.inner_text("#sfNow")[:80])
    errors[:] = [e for e in errors if "sf-start-check" not in e]   # the error that check provoked on purpose
    c2.close()

    # Failures that reach the screen: Lichess down for a sync and for the titled refresh; an unreadable game.
    c2, p2 = fresh({"games": [blunder_game("a1", 1)]}, routes={"**/lichess.org/api/games/**": lambda r: r.fulfill(status=500, body=""),
                                                              "**/lichess.org/api/users": lambda r: r.fulfill(status=503, body="")})
    p2.fill("#handle", "luke"); p2.press("#handle", "Enter")   # Enter in the handle box syncs, as the button does
    p2.wait_for_function("/Could not reach Lichess/.test(document.querySelector('#flash').innerText)", timeout=10000)
    check("sync: Lichess failing is reported with its status, and the games stay", "Lichess returned 500." in p2.inner_text("#flash")
          and len(stored_games(p2)) == 1 and not p2.is_disabled("#sync"), p2.inner_text("#flash")[:80])
    p2.click("button.tab[data-tab=strength]"); p2.click("#cmpRefresh")
    p2.wait_for_function("/Could not reach Lichess/.test((document.querySelector('#cmpStatus') || {}).textContent || '')", timeout=10000)
    check("titled: a refresh Lichess refuses keeps the snapshot and says so",
          "Lichess answered 503." in p2.inner_text("#cmpStatus") and "2026-10-01 ratings" in p2.inner_text("#cmpStatus")
          and not p2.is_disabled("#cmpRefresh"), p2.inner_text("#cmpStatus"))
    p2.set_input_files("#importFile", write_tmp("bad.pgn", '[White "luke"]\n[Black "x"]\n[Result "1-0"]\n\n1. e4 e5 2. Ke3 1-0\n\n'
                                                '[White "luke"]\n[Black "y"]\n[Result "1-0"]\n\n1. d4 d5 1-0\n'))
    p2.wait_for_timeout(1200)
    check("import: a game whose moves cannot be read is left out, and the notice counts it",
          "Left out 1 game whose moves could not be read." in p2.inner_text("#flash"), p2.inner_text("#flash")[:120])
    c2.close()

    # Chrome: text size, the Home and End keys on the tabs, and deleting everything.
    c2, p2 = fresh({"games": [blunder_game("a1", 1)]})
    p2.select_option("#uiScale", "1.25")
    check("chrome: a larger text size is applied and remembered",
          p2.evaluate("document.documentElement.style.getPropertyValue('--ui-scale')") == "1.25"
          and p2.evaluate("JSON.parse(localStorage.getItem('dvor:settings')).uiScale") == "1.25")
    p2.focus("button.tab[data-tab=sparring]"); p2.keyboard.press("End")
    end = p2.evaluate("document.activeElement.dataset.tab"); p2.keyboard.press("Home")
    check("tabs: End and Home go to the last and first tab", end == "settings" and p2.evaluate("document.activeElement.dataset.tab") == "strength",
          "%s, %s" % (end, p2.evaluate("document.activeElement.dataset.tab")))
    p2.evaluate("localStorage.setItem('not-this-app', 'kept')")
    # The confirmed delete reloads the page. Pause on the call to location.reload itself: storage is
    # read at that moment, and as a reload drops the page's coverage, the coverage is taken there too.
    dbg = page_cov.get(id(p2)) or c2.new_cdp_session(p2)
    dbg.send("Debugger.enable")
    dbg.send("Debugger.setBreakpointOnFunctionCall",
             {"objectId": dbg.send("Runtime.evaluate", {"expression": "location.reload"})["result"]["objectId"]})
    at_reload = []
    def on_reload(ev):
        at_reload.append(dbg.send("Runtime.evaluate", {"returnByValue": True, "expression":
            "Object.keys(localStorage).filter(k => k.startsWith('dvor:'))"})["result"]["value"])
        snap_page(p2)
        dbg.send("Debugger.resume")
    dbg.on("Debugger.paused", on_reload)
    p2.evaluate("window.confirm = () => false"); p2.click("button.tab[data-tab=settings]"); p2.click("#wipe")
    kept = p2.evaluate("localStorage.getItem('dvor:games') !== null") and not at_reload
    p2.evaluate("window.confirm = () => true")
    with p2.expect_navigation(): p2.click("#wipe")
    left = p2.evaluate("Object.keys(localStorage).filter(k => k.startsWith('dvor:'))")
    check("settings: Delete everything asks first, then removes this app's data and nothing else",
          kept and left == [] and p2.evaluate("localStorage.getItem('not-this-app')") == "kept", left)
    check("settings: the confirmed delete has emptied storage when it reloads, and reloads once", at_reload == [[]], at_reload)
    c2.close()

    # Delete everything where the reload does not happen (a "Leave site?" prompt answered Stay): the page lives on, and its
    # saves must work again once it is used, or the app reports success on every later save while writing nothing. Time
    # alone must not let them through: a reload that is only slow passes the same time, and its late saves would put the
    # deleted data back (CI saw it: a timer resumed saves and the games and cards were there after the reload).
    c2, p2 = fresh({"games": [blunder_game("w1", 1)]})
    left_prompts = []
    p2.remove_listener("dialog", p2.accept_dialogs)
    def stay_on_page(d):
        if d.type == "beforeunload": left_prompts.append(1); d.dismiss()
        else: d.accept()
    p2.on("dialog", stay_on_page)
    p2.evaluate("window.addEventListener('beforeunload', e => { e.preventDefault(); e.returnValue = ''; })")
    p2.evaluate("window.__tab = 'still here'")
    p2.click("button.tab[data-tab=settings]"); p2.click("#wipe")
    emptied = p2.evaluate("Object.keys(localStorage).filter(k => k.startsWith('dvor:'))") == []
    probe = "() => { Data.Store.set('probe', 1); return localStorage.getItem('dvor:probe') !== null; }"
    p2.wait_for_timeout(3000)   # longer than the 2.5 s timer this replaced
    held = not p2.evaluate(probe)
    p2.click("button.tab[data-tab=strength]")
    saves_again = p2.evaluate(probe)
    check("settings: if the reload after Delete everything does not happen, saves wait for the page to be used, then work",
          left_prompts and emptied and p2.evaluate("window.__tab") == "still here" and held and saves_again,
          "prompts %d, emptied %s, held %s, saves %s" % (len(left_prompts), emptied, held, saves_again))
    c2.close()

    # ---- October 2026 coverage round, second part: what the page did that no check watched
    def stored(page, key, default=None):
        return page.evaluate("k => JSON.parse(localStorage.getItem('dvor:' + k) || 'null')", key) or default
    def strong_game(gid, days_ago=1):
        g = blunder_game(gid, days_ago)
        g.update({"oppRating": 2700, "score": 1, "result": "1-0", "acpl": 8,
                  "m": [["e4", 30, "", "", "", "", ""], ["e5", 30, "", "", "", "", ""], ["Nf3", 35, "", "", "", "", ""]]})
        return g
    def line_game(gid, sans, days_ago=1, my="w"):
        g = blunder_game(gid, days_ago, my)
        g.update({"analysed": False, "acpl": None, "m": [[s, "", "", "", "", "", ""] for s in sans]})
        return g

    # Trajectory: three or more marks over two weeks or more give a trend; flat, rising, already there.
    weak = [blunder_game("tw%d" % i, 1 + i) for i in range(4)]
    strong = [strong_game("ts%d" % i, 1 + i) for i in range(6)]
    c2, p2 = fresh({"games": weak}); mark = stored(p2, "track")[-1]; m_weak = mark["measured"]; c2.close()
    import datetime   # days counted from the page's own today, whatever zone Python thinks it is in
    def day_ago(n): return (datetime.date.fromisoformat(mark["day"]) - datetime.timedelta(days=n)).isoformat()
    c2, p2 = fresh({"games": strong}); m_strong = stored(p2, "track")[-1]["measured"]; c2.close()
    def trajectory(games, marks):
        c, p = fresh({"games": games, "track": [{"day": day_ago(d), "measured": v, "moe": 50, "rating": None, "n": 4} for d, v in marks]})
        p.click("button.tab[data-tab=strength]")
        text = " ".join(p.inner_text("#strengthBody").split())
        c.close()
        return text
    flat = trajectory(weak, [(60, m_weak), (30, m_weak)])
    need = 2200 - m_weak
    soon = trajectory(weak, [(30, m_weak - 2 * need), (15, m_weak - need)])          # 2 x need a month: under a month
    later = trajectory(weak, [(30, m_weak - need / 2), (15, m_weak - need / 4)])      # need / 2 a month: two months
    there = trajectory(strong, [(60, m_strong - 200), (30, m_strong - 100)])
    check("trajectory: level marks over two months read as flat, with the sign", "the measured strength is flat (+0 per month)" in flat, flat[:120])
    check("trajectory: a fast climb says under a month, a slower one a number of months",
          m_weak < 2200 and "2200 arrives in roughly under a month" in soon and "2200 arrives in roughly 2.0 months" in later,
          "%s | %s" % (soon[soon.find("Measured strength is rising"):][:110], later[later.find("arrives"):][:60]))
    check("trajectory: rising and already measuring at 2200 or more says so", m_strong >= 2200 and "already measuring at or above 2200" in there, m_strong)
    c2, p2 = fresh({"games": weak, "track": [{"day": day_ago(400 - i), "measured": 1900, "n": 4} for i in range(400)]})
    kept = stored(p2, "track")
    check("trajectory: the marks are capped at the last 400", len(kept) == 400 and kept[-1]["day"] == day_ago(0) and kept[0]["day"] == day_ago(399),
          "%d, %s .. %s" % (len(kept), kept[0]["day"], kept[-1]["day"]))
    c2.close()

    # Sync: "all" anchors to the speed most games were played at; a chosen speed to its own rating.
    def lichess_row(gid, speed, days_ago, **extra):   # extra: keys of the row to set or replace
        return json.dumps(dict({"id": gid, "rated": True, "speed": speed, "perf": speed,"createdAt": NOW - DAY * days_ago, "status": "resign",
                                "winner": "white", "moves": "e4 e5 Nf3", "players": {"white": {"user": {"name": "luke"}, "rating": 1700},
                                                                                     "black": {"user": {"name": "opp"}, "rating": 1700}}}, **extra))
    def mixed_games(route):
        rows = [lichess_row("mb1", "blitz", 1), lichess_row("mb2", "blitz", 2), lichess_row("mr1", "rapid", 3)]
        nop = json.loads(rows[2]); del nop["perf"]; rows.append(json.dumps(dict(nop, id="mn1")))   # one with no speed named
        route.fulfill(status=200, body="\n".join(rows) + "\n", content_type="application/x-ndjson")
    profile = lambda r: r.fulfill(status=200, content_type="application/json",
                                  body=json.dumps({"perfs": {"blitz": {"rating": 1650, "games": 300}, "rapid": {"rating": 1910, "games": 40}}}))
    c2, p2 = fresh({}, routes={"**/lichess.org/api/games/user/luke**": mixed_games, "**/lichess.org/api/user/luke": profile})
    p2.fill("#handle", "not a handle!"); p2.click("#sync")
    bad_handle = p2.inner_text("#flash")
    p2.fill("#handle", "luke"); p2.click("#sync")
    p2.wait_for_function("/Loaded 4 games/.test(document.querySelector('#flash').innerText)", timeout=10000)
    anchored_all = stored(p2, "lichessRating")
    p2.select_option("#syncPerf", "rapid")
    p2.click("#sync"); p2.wait_for_function("!document.querySelector('#sync').disabled", timeout=10000)
    anchored_rapid = stored(p2, "lichessRating")
    check("sync: a handle that cannot be read is refused before any request", "does not look like a Lichess username" in bad_handle, bad_handle)
    check("sync: with every speed, the rating anchor is the speed most games were at; with one speed, that speed's",
          anchored_all == 1650 and anchored_rapid == 1910, "%s, %s" % (anchored_all, anchored_rapid))
    c2.close()

    # The window note: games synced for 30 days do not reach "all time"; with no games, the slider still answers.
    c2, p2 = fresh({"games": weak, "syncedDays": 30})
    short_note = p2.inner_text("#winNote")
    c2.close()
    c2, p2 = fresh({})
    p2.evaluate("""() => { const r = document.querySelector('#winDays'); r.value = '2';
      r.dispatchEvent(new Event('input')); r.dispatchEvent(new Event('change')); }""")
    empty_note = p2.inner_text("#winNote")
    no_games_label = p2.inner_text("#winLabel")
    c2.close()
    check("window: games synced for 30 days say they do not reach all time; with no games the window still moves",
          short_note.startswith("Loaded games only go back 30 days.") and empty_note == "" and no_games_label == "Last 30 days",
          "%s | %r | %s" % (short_note[:50], empty_note, no_games_label))

    # Backups: a damaged one restores what it can; one that is not JSON says so.
    damaged = {"cards": {"a1:3": "not a card", "ok:1": {"id": "ok:1", "reps": 2}}, "transcripts": {"x": "nope", "y": {"zz": {}, "4": "no", "5": {"text": None, "score": 3}}},
               "track": [{"day": day_ago(3), "measured": 1800}], "lichessRating": 1750}
    c2, p2 = fresh({"games": weak})
    p2.set_input_files("#importFile", write_tmp("damaged.json", json.dumps(damaged))); p2.wait_for_timeout(500)
    restored = p2.inner_text("#flash")
    cards = stored(p2, "cards", {}); transcripts = stored(p2, "transcripts", {})
    games_kept = len(stored(p2, "games", []))
    p2.set_input_files("#importFile", write_tmp("broken.json", "{ this is not json")); p2.wait_for_timeout(300)
    broken = p2.inner_text("#flash")
    check("backup: a damaged backup keeps the good cards, drops the bad entries, and leaves out what it lacks",
          restored.startswith("Backup restored.") and "a1:3" not in cards and cards.get("ok:1", {}).get("reps") == 2
          and transcripts.get("x") is None and list(transcripts.get("y", {}).keys()) == ["5"] and transcripts["y"]["5"]["text"] == ""
          and games_kept == 4 and stored(p2, "lichessRating") == 1750, "%s %s %s" % (restored[:30], sorted(cards), transcripts))
    check("backup: a file that starts like JSON but is not is refused, saying so", "That JSON did not parse." in broken, broken)
    c2.close()

    # PGN import: games that name no player are read as White's, and the notice says how many.
    c2, p2 = fresh({})
    p2.set_input_files("#importFile", write_tmp("nameless.pgn", "1. e4 e5 2. Nf3 *\n\n1. d4 d5 2. c4 *\n")); p2.wait_for_timeout(800)
    nameless = " ".join(p2.inner_text("#flash").split())
    check("import: games with no player names are read as White's, and the notice counts them",
          "2 name no player, so they were read as played with White" in nameless, nameless[:160])
    c2.close()

    # Stockfish missing (a build without it): the panel says so instead of waiting.
    c2, p2 = fresh({"games": [blunder_game("sx1", 1)]})
    p2.evaluate("delete window.STOCKFISH_SOURCE")
    p2.click("button.tab[data-tab=sparring]"); p2.select_option("#sparColor", "w"); p2.click("#sparStart")
    p2.wait_for_function("/cannot start a Web Worker here/.test(document.querySelector('#sfNow').innerText)", timeout=10000)
    check("stockfish: with no Stockfish in the page, the panel says it is not available", "Stockfish is not available" in p2.inner_text("#sfNow"))
    c2.close()

    # Sparring to the end, with the mirror's own book: Fool's mate both ways, and a threefold repetition.
    fools = [line_game("fm%d" % i, ["f3", "e5", "g4", "Qh4#"], 1 + i) for i in range(3)]
    c2, p2 = fresh({"games": fools})
    p2.click("button.tab[data-tab=sparring]"); p2.uncheck("#sfOn")
    p2.select_option("#sparColor", "w"); p2.click("#sparStart")
    def spar_move(page, a, b, plies):
        page.click('#sparBoard [data-sq="%s"]' % a); page.click('#sparBoard [data-sq="%s"]' % b)
        page.wait_for_function("n => document.querySelectorAll('#sparMoves .mv').length >= n", arg=plies, timeout=20000)
    spar_move(p2, "f2", "f3", 2); spar_move(p2, "g2", "g4", 4)
    p2.wait_for_function("/Checkmate/.test(document.querySelector('#sparStatus').innerText)", timeout=20000)
    lost = p2.inner_text("#sparStatus")
    p2.check("#sfOn")   # Stockfish reads this game: the last position has no move to read
    p2.select_option("#sparColor", "b"); p2.click("#sparStart")
    p2.wait_for_function("document.querySelectorAll('#sparMoves .mv').length >= 1", timeout=20000)
    spar_move(p2, "e7", "e5", 3); spar_move(p2, "d8", "h4", 4)
    won = p2.inner_text("#sparStatus")
    p2.wait_for_function("/No legal moves: the game is over/.test(document.querySelector('#sfNow').innerText)", timeout=40000)
    p2.click("#sparHint")   # the game is over: no advice to ask for
    hint_after = p2.inner_text("#sparStatus")
    check("sparring: the mirror mating you is 'Checkmate. You lost.'; you mating it is 'Checkmate. You won.'",
          lost.startswith("Checkmate. You lost.") and won.startswith("Checkmate. You won.") and hint_after == won, "%s | %s" % (lost[:30], won[:30]))
    c2.close()
    knights = [line_game("kn%d" % i, ["Nf3", "Nf6", "Ng1", "Ng8"] * 3, 1 + i) for i in range(3)]
    c2, p2 = fresh({"games": knights})
    p2.click("button.tab[data-tab=sparring]"); p2.uncheck("#sfOn")
    p2.select_option("#sparColor", "b"); p2.click("#sparStart")
    p2.wait_for_function("document.querySelectorAll('#sparMoves .mv').length >= 1", timeout=20000)
    spar_move(p2, "g8", "f6", 3); spar_move(p2, "f6", "g8", 5); spar_move(p2, "g8", "f6", 7)
    p2.click('#sparBoard [data-sq="f6"]'); p2.click('#sparBoard [data-sq="g8"]')
    p2.wait_for_function("/Drawn/.test(document.querySelector('#sparStatus').innerText)", timeout=20000)
    check("sparring: the same position three times is a draw by repetition", p2.inner_text("#sparStatus").startswith("Drawn by threefold repetition."),
          p2.inner_text("#sparStatus")[:60])
    c2.close()

    # Stockfish's verdict on the mirror's engine moves (no book here), against what it meant to give up.
    c2, p2 = fresh({"games": [blunder_game("sv%d" % i, 1 + i) for i in range(2)]})
    p2.click("button.tab[data-tab=sparring]"); p2.select_option("#sparColor", "w"); p2.click("#sparStart")
    p2.click('#sparBoard [data-sq="d2"]'); p2.click('#sparBoard [data-sq="d4"]')
    p2.wait_for_function("/Mirror, engine moves: -?\\d+ cp lost per move over 1 read/.test(document.querySelector('#sfLog').innerText)", timeout=60000)
    verdict = " ".join(p2.inner_text("#sfLog").split())
    check("stockfish: the mirror's engine move is scored, next to what it meant to give up",
          re.search(r"Mirror, engine moves: \d+ cp lost per move over 1 read, where it meant to give up \d+\. The (house engine reads|gap is)", verdict) is not None,
          verdict[:160])
    c2.close()

    # Drills: an empty queue, the concepts with no position, the Strength tab's Drill as the first drill of the visit,
    # and quitting an endgame while the engine is still replying.
    c2, p2 = fresh({"games": [blunder_game("dq1", 1)]})
    p2.click("button.tab[data-tab=strength]"); p2.wait_for_timeout(200)
    p2.click('[data-jump="dq1:3"]')
    first_drill = p2.evaluate("(document.querySelector('.panel.active') || {}).id") == "panel-drills" and p2.inner_text("#drillProgress") == "1 of 1"
    p2.click("#drillQuit")
    p2.click("[data-start=motif]")
    empty_queue = p2.inner_text("#flash")
    concept = p2.evaluate("[...document.querySelectorAll('#egPick option')].filter(o => o.disabled).map(o => o.value)")
    p2.select_option("#egPick", "lucena"); p2.click("[data-start=endgame]")
    # Watch the engine's answer arrive: the wrapper settles just before the app's own handler, which runs a tick later.
    p2.evaluate("""() => { window.__replied = false; const real = Engine.prototype.rankAsync;
      Engine.prototype.rankAsync = function () { return real.apply(this, arguments).then(r => { window.__replied = true; return r; }); }; }""")
    p2.click('#drillBoard [data-sq="d1"]'); p2.click('#drillBoard [data-sq="d4"]')
    p2.click("#drillQuit")
    DRILL_STATE = "() => [document.querySelector('#drillBoard').innerHTML, document.querySelector('#drillFeedback').innerHTML].join('|')"
    state_at_quit = p2.evaluate(DRILL_STATE)
    p2.wait_for_function("window.__replied === true", timeout=20000)   # the reply is in, with no drill to land in
    p2.evaluate("() => new Promise(r => setTimeout(r, 0))")           # and the app's handler for it has run
    state_after = p2.evaluate(DRILL_STATE)
    home = not p2.evaluate("document.querySelector('#drillHome').classList.contains('hidden')")
    check("drills: the Strength tab's Drill works as the visit's first drill; an empty pattern queue says so; concepts cannot be set up",
          first_drill and "Nothing in that queue right now." in empty_queue and "wrong-bishop" in concept, "%s | %s" % (empty_queue[:40], concept))
    check("drills: quitting an endgame while the engine replies leaves the drills page, and the late reply lands nowhere",
          home and "Engine replying" in state_at_quit and state_after == state_at_quit, state_after[-120:])
    c2.close()

    # The app started after the page has loaded (a script added late): it still boots.
    root_url = "file:///" + os.path.abspath(os.path.join(HERE, "..")).replace("\\", "/") + "/"
    late = write_tmp("late.html", open(APP, encoding="utf-8").read()
                     .replace('<script src="js/ui.js"></script>',
                              "<script>addEventListener('load', function () { var s = document.createElement('script'); s.src = 'js/ui.js'; document.body.appendChild(s); });</script>")
                     .replace('src="js/', 'src="' + root_url + 'js/').replace("src = 'js/", "src = '" + root_url + "js/").replace('href="css/', 'href="' + root_url + 'css/'))
    c2, p2 = fresh({})
    snap_page(p2)   # its first page is replaced: keep what it ran
    p2.goto("file:///" + late.replace("\\", "/")); p2.wait_for_function("document.querySelectorAll('.panel.active').length === 1", timeout=10000)
    check("boot: the app starts even when its script runs after the page has loaded",
          p2.evaluate("document.readyState") == "complete" and p2.evaluate("(document.querySelector('.panel.active') || {}).id") == "panel-strength")
    c2.close()
    # A Stockfish that disagrees with the house engine by five pawns (a stand-in worker): "the gap".
    FAKE_SF = r"""onmessage = function (e) {
      var c = String(e.data), sm = / searchmoves (\S+)/.exec(c);
      if (c === 'uci') postMessage('uciok');
      else if (c === 'isready') postMessage('readyok');
      else if (c.indexOf('go') === 0) {
        postMessage('info depth 12 multipv 1 score cp ' + (sm ? -500 : 0) + ' pv ' + (sm ? sm[1] : 'a1a1'));
        postMessage('bestmove ' + (sm ? sm[1] : 'a1a1'));
      }
    };"""
    c2, p2 = fresh({"games": [blunder_game("fk%d" % i, 1 + i) for i in range(2)]})
    p2.evaluate("src => { window.STOCKFISH_SOURCE = src; }", FAKE_SF)
    p2.click("button.tab[data-tab=sparring]"); p2.select_option("#sparColor", "w"); p2.click("#sparStart")
    p2.click('#sparBoard [data-sq="d2"]'); p2.click('#sparBoard [data-sq="d4"]')
    p2.wait_for_function("/Mirror, engine moves/.test(document.querySelector('#sfLog').innerText)", timeout=30000)
    gap = " ".join(p2.inner_text("#sfLog").split())
    check("stockfish: a reading far from what the mirror meant to give up is called the house engine's misjudgement",
          "Mirror, engine moves: 500 cp lost per move over 1 read" in gap and "The gap is the house engine misjudging" in gap
          and "· Stockfish:" not in gap, gap[:200])
    c2.close()

    # Guards a visit can reach: no games yet (sparring, drills, review), a key on a tab that is no
    # tab key, a file dialog closed with no file, a takeback before any game, scout finding no games.
    c2, p2 = fresh({}, routes={"**/lichess.org/api/games/user/nobody**": lambda r: r.fulfill(status=200, body="", content_type="application/x-ndjson")})
    p2.click("button.tab[data-tab=sparring]"); p2.click("#sparTakeback"); p2.click("#sparStart")
    no_profile = p2.inner_text("#flash")
    p2.click("button.tab[data-tab=drills]")
    no_drills = p2.inner_text("#drillHome")
    p2.click("button.tab[data-tab=review]"); p2.click("#revStart")   # no game to review: nothing starts
    p2.focus("button.tab[data-tab=review]"); p2.keyboard.press("a")
    still_review = p2.evaluate("document.activeElement.dataset.tab")
    p2.evaluate("document.querySelector('#importFile').dispatchEvent(new Event('change'))")
    p2.click("button.tab[data-tab=scout]"); p2.fill("#scoutHandle", "nobody"); p2.click("#scoutBtn")
    p2.wait_for_function("/No rated games for nobody/.test(document.querySelector('#scoutOut').innerText)", timeout=10000)
    check("guards: with no games, sparring and drills say to sync first; Start review, a stray key and an empty file pick do nothing",
          "Sync your games first" in no_profile and "Sync first" in no_drills and still_review == "review"
          and not p2.evaluate("document.querySelector('#revStage') && !document.querySelector('#revStage').classList.contains('hidden')"),
          "%s | %s" % (no_profile[:40], no_drills[:60]))
    check("scout: a player with no games in that time control says so", "No rated games for nobody in that time control" in p2.inner_text("#scoutOut"))
    c2.close()

    # Storage full for games and settings: the import, the sync and Settings each say so.
    c2, p2 = fresh({}, routes={"**/lichess.org/api/games/user/luke**": mixed_games, "**/lichess.org/api/user/luke": profile})
    p2.evaluate("""() => { const real = Storage.prototype.setItem;
      Storage.prototype.setItem = function (k, v) {
        if (/^dvor:(games|settings)$/.test(k)) throw new DOMException('full', 'QuotaExceededError');
        return real.call(this, k, v); }; }""")
    p2.set_input_files("#importFile", write_tmp("full.pgn", '[White "luke"]\n[Black "x"]\n[Result "1-0"]\n\n1. e4 e5 2. Nf3 1-0\n')); p2.wait_for_timeout(800)
    import_full = p2.inner_text("#flash")
    p2.fill("#handle", "luke"); p2.click("#sync"); p2.wait_for_function("!document.querySelector('#sync').disabled", timeout=10000)
    sync_full = p2.inner_text("#flash")
    p2.click("button.tab[data-tab=settings]"); p2.click("#saveSettings")
    settings_full = p2.inner_text("#flash")
    check("storage full: an import and a sync keep the storage warning up; Settings say they were not saved",
          import_full.startswith("Local storage is full. Reduce the sync window") and sync_full.startswith("Local storage is full. Reduce the sync window")
          and "settings were not saved" in settings_full, "%s | %s | %s" % (import_full[:40], sync_full[:40], settings_full[:50]))
    c2.close()

    # Stored games that cannot all be read: a game with no id gets one, an unplayable stored move ends the game
    # there, and a games entry that is not a list at all is no games rather than a broken page.
    no_id = blunder_game("x", 1); del no_id["id"]
    cut = blunder_game("cut", 2); cut["m"] = [["e4", 30, "", "", "", "", ""], ["Ke3", 30, "", "", "", "", ""], ["Nf3", 30, "", "", "", "", ""]]
    c2, p2 = fresh({"games": [no_id, cut]})
    p2.set_input_files("#importFile", write_tmp("one_more.pgn", '[White "luke"]\n[Black "y"]\n[Result "1-0"]\n\n1. d4 d5 1-0\n')); p2.wait_for_timeout(800)
    kept_games = [g for g in stored(p2, "games", []) if g.get("eco") == "C20"]   # the two seeded ones, saved again with the import
    c2.close()
    seen = len(errors)
    c2, p2 = fresh({"games": {"not": "a list"}, "cards": "not cards", "transcripts": 7})
    broken_games = p2.evaluate("document.querySelectorAll('#revGame option').length")
    check("stored games: one with no id gets one; an unplayable move ends that game there",
          len(kept_games) == 2 and sorted(len(g["m"]) for g in kept_games) == [1, 5]
          and [g for g in kept_games if len(g["m"]) == 1][0]["id"] == "cut" and re.match(r"^g[0-9a-z]+$", [g for g in kept_games if len(g["m"]) == 5][0]["id"]),
          [(g.get("id"), len(g["m"])) for g in kept_games])
    check("stored data: games, cards and notes that are not what they should be load as none", broken_games == 0 and len(errors) == seen, broken_games)
    c2.close()

    # Trend: three marks inside two weeks are not yet a trend; the window labels count years.
    c2, p2 = fresh({"games": weak, "track": [{"day": day_ago(d), "measured": 1900, "n": 4} for d in (6, 3)]})
    p2.click("button.tab[data-tab=strength]")
    early = " ".join(p2.inner_text("#strengthBody").split())
    labels = []
    for i in (6, 7):
        p2.evaluate("""i => { const r = document.querySelector('#winDays'); r.value = String(i); r.dispatchEvent(new Event('input')); }""", i)
        labels.append(p2.inner_text("#winLabel"))
    check("trajectory: three marks inside two weeks are not yet a trend", "Trend needs at least three marks spanning two weeks. 3 so far." in early,
          early[early.find("Trend"):][:80])
    check("window: a year and two years are named in years", labels == ["Last year", "Last 2 years"], labels)
    c2.close()
    # Scout: a player whose blunders come with the clock nearly gone is told the clock comes first.
    def scout_pressed(route):
        rows = [json.dumps({"id": "sp%d" % i, "rated": True, "speed": "blitz", "perf": "blitz", "createdAt": NOW - DAY * (i + 1),
                "status": "resign", "winner": "black", "moves": "e4 e5 Ba6 bxa6 Nf3", "clock": {"initial": 300, "increment": 0},
                "clocks": [30000, 30000, 2000, 2000, 1900], "opening": {"eco": "C20", "name": "King's Pawn Game"},
                "analysis": [{"eval": 30}, {"eval": 30}, {"eval": -300, "best": "g1f3", "judgment": {"name": "Blunder"}}, {"eval": -300}, {"eval": -300}],
                "players": {"white": {"user": {"name": "pressed"}, "rating": 1700}, "black": {"user": {"name": "opp"}, "rating": 1700}}})
                for i in range(4)]
        route.fulfill(status=200, body="\n".join(rows) + "\n", content_type="application/x-ndjson")
    c2, p2 = fresh({}, routes={"**/lichess.org/api/games/user/pressed**": scout_pressed})
    p2.click("button.tab[data-tab=scout]"); p2.fill("#scoutHandle", "pressed"); p2.click("#scoutBtn")
    p2.wait_for_selector("#scoutAdopt", timeout=10000)
    pressed = " ".join(p2.inner_text("#scoutOut").split())
    check("scout: errors made with under fifteen percent of the clock are counted, and clock discipline comes first",
          "100% of their errors come with under fifteen percent of the clock left." in pressed and "Clock discipline before anything else" in pressed,
          pressed[pressed.find("%") - 20:][:120])
    c2.close()
    # Stored data is untrusted. A serverBest that is no string must not stop the app starting (mining threw on it), and the
    # game's own line stands in for it; a track day that is no calendar day ("2026-13-01") must not write NaN into the page.
    errs_before = len(errors)
    odd_best = []
    for i, best in enumerate((5, {"a": 1}, ["x"], True)):
        g = blunder_game("ob%d" % i, 1 + i); g["m"][2][3] = best
        odd_best.append(g)
    c2, p2 = fresh({"games": odd_best})
    p2.click("button.tab[data-tab=strength]")
    n_loaded = p2.evaluate("document.querySelectorAll('#revGame option').length")
    mined = p2.evaluate("document.querySelector('#panel-strength').innerText")
    check("storage: games whose serverBest is a number, an object, a list or true load, and mining falls back to the line (Nf3)",
          len(errors) == errs_before and n_loaded == 4 and "Nf3" in mined, "%d games, %d new errors" % (n_loaded, len(errors) - errs_before))
    c2.close()
    errs_before = len(errors)
    bad_days = ["2026-13-01", "2026-02-31", "2026-00-10", "2026-1-5", 20261301, None]
    marks = [{"day": d, "measured": 1900, "moe": 50, "n": 4} for d in bad_days] +             [{"day": day_ago(d), "measured": 1900 + (60 - d) * 2, "moe": 50, "rating": None, "n": 4} for d in (60, 30)]
    c2, p2 = fresh({"games": weak, "track": marks})
    p2.click("button.tab[data-tab=strength]")
    strength_text = " ".join(p2.inner_text("#strengthBody").split())
    kept_days = p2.evaluate("(JSON.parse(localStorage.getItem('dvor:track')) || []).map(p => p.day)")
    check("trajectory: a track day that is no calendar day (month 13, February 31...) is dropped, and the page has no NaN",
          "NaN" not in strength_text and "trajectory towards 2200" in strength_text.lower() and not any(d in kept_days for d in bad_days[:4]) and len(errors) == errs_before,
          "%s | %s" % (kept_days, strength_text[strength_text.lower().find("trajectory"):][:80]))
    c2.close()

    # A promotion picker left open when the position changes (Takeback, the next card) must go with the old position.
    c2, p2 = fresh({})
    promo = p2.evaluate("""() => {
      const el = document.createElement('div'); document.body.appendChild(el);
      const moves = [];
      const bd = new Board(el, { fen: '7k/P7/8/8/8/8/8/K7 w - - 0 1', onMove: (m, g) => moves.push(m.fromSq + m.toSq) });
      const open = () => { el.querySelector('[data-sq=a7]').click(); el.querySelector('[data-sq=a8]').click(); return !!el.querySelector('.promo-pick'); };
      const out = { opened: open() };
      bd.setFen('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
      out.afterSetFen = !!el.querySelector('.promo-pick') || bd.pendingPromotion !== null;
      bd.setFen('7k/P7/8/8/8/8/8/K7 w - - 0 1');
      out.reopened = open();
      bd.setGame(new Chess('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'));
      out.afterSetGame = !!el.querySelector('.promo-pick') || bd.pendingPromotion !== null;
      out.moves = moves;
      return out;
    }""")
    check("board: setFen and setGame close a promotion picker left open for the old position",
          promo["opened"] and promo["reopened"] and not promo["afterSetFen"] and not promo["afterSetGame"] and promo["moves"] == [], promo)
    c2.close()

    # ---- October 2026 coverage round, third part: the branches no check took, each with what it does
    def restore_backup(page, name, backup):   # a backup file restored through Settings, waited for by its notice
        page.set_input_files("#importFile", write_tmp(name, json.dumps(backup)))
        page.wait_for_function("document.querySelector('#flash').innerText.trim() === 'Backup restored.'", timeout=10000)
    def pick_review(page, opp):   # the review's list of games, set to the game against opp
        page.evaluate("""opp => { const s = document.querySelector('#revGame');
          s.value = [...s.options].filter(o => o.text.indexOf(' vs ' + opp + ' ') > -1)[0].value; }""", opp)
    # In-page wait(cond, stuck): cond polled every POLL_MS until it holds; after STUCK_MS it fails with stuck().
    POLL_MS, STUCK_MS = 15, 20000
    WAIT_JS = ("const wait = (cond, stuck) => new Promise((res, rej) => { const t0 = Date.now(); (function poll() {"
               " if (cond()) res(); else if (Date.now() - t0 > %d) rej(new Error(stuck())); else setTimeout(poll, %d); })(); });" % (STUCK_MS, POLL_MS))
    # The house engine stops at a deadline, so a slow or busy machine gets a shallower answer (from the start, depth 2
    # says 0 and depth 3 says +48). A check that compares the engine's move or number lifts the deadline first.
    NO_DEADLINE = """() => { const rank = Engine.prototype.rankAsync;
      Engine.prototype.rankAsync = function (g, depth, ms, onDepth) { return rank.call(this, g, depth, Infinity, onDepth); }; }"""
    def stand_in_sf(on_command):
        # A Stockfish stand-in worker: it answers uci and isready and keeps the position (fen; white: White to move);
        # on_command handles every other command c.
        return ("var fen = ''; onmessage = function (e) { var c = String(e.data), white = fen.split(' ')[1] === 'w';"
                " if (c === 'uci') postMessage('uciok'); else if (c === 'isready') postMessage('readyok');"
                " else if (c.indexOf('position fen ') === 0) fen = c.slice(13); else " + on_command + " };")
    # A finished review keeps its buttons on screen. Commit after "Game complete" scored an empty text for the
    # last move and wrote it over that move's justification (and over the session summary).
    c2, p2 = fresh({"games": [blunder_game("rc1", 1)]})
    p2.click("button.tab[data-tab=review]"); p2.click("#revStart")
    for i in range(3):
        p2.fill("#revText", "Candidates for move %d: Nf3 and d4, the line Nf3 Nc6 d4, about equal." % (i + 1))
        p2.click("#revSubmit"); p2.click("#revNext")
    complete = p2.inner_text("#revPrompt")
    p2.click("#revSubmit"); p2.click("#revNext"); p2.click("#revSkip")
    last_note = (stored(p2, "transcripts", {}).get("rc1") or {}).get("4", {}).get("text", "")
    check("review: Commit, Next and Skip after the game is complete leave the last justification and the summary alone",
          complete.lower() == "game complete." and last_note.startswith("Candidates for move 3") and "session summary" in p2.inner_text("#revFeedback").lower()
          and len(errors) == 0, "%r | %r" % (last_note[:30], p2.inner_text("#revFeedback")[:40]))
    c2.close()
    # A backup restored mid-review: the next justification joins the restored ones. It was written into the set the
    # review started with, which put back what the restore had replaced and dropped what it had brought.
    c2, p2 = fresh({"games": [blunder_game("rr1", 1)]})
    p2.click("button.tab[data-tab=review]"); p2.click("#revStart")
    p2.fill("#revText", "Before the restore: Nf3 and d4, the line Nf3 Nc6 d4."); p2.click("#revSubmit"); p2.click("#revNext")
    p2.click("button.tab[data-tab=settings]")
    restore_backup(p2, "mid-review.json", {"transcripts": {"rr1": {"4": {"text": "From the backup.", "san": "Nf3"}}}})
    p2.click("button.tab[data-tab=review]")
    p2.fill("#revText", "After the restore: Ba6 to provoke b5, the line Ba6 bxa6."); p2.click("#revSubmit")
    after_restore = stored(p2, "transcripts", {}).get("rr1", {})
    check("review: a justification written after a backup is restored mid-review keeps the restored ones and brings back none it replaced",
          sorted(after_restore) == ["2", "4"] and after_restore["4"]["text"] == "From the backup."
          and after_restore["2"]["text"].startswith("After the restore"), {k: v.get("text") for k, v in after_restore.items()})
    c2.close()
    # A restored backup's settings are shown where they are set. The form kept the old values, so Save settings
    # put them back over the restored ones; Sync used the restored speed while its list showed the old one.
    c2, p2 = fresh({"games": [blunder_game("rs1", 1)]})
    p2.click("button.tab[data-tab=settings]")
    restore_backup(p2, "settings-backup.json", {"settings": {
        "minutes": 45, "hour": 7, "endgameTier": 3, "boardTheme": "green", "pieceSet": "letters", "showCoords": False,
        "perf": "blitz", "uiScale": "1.25", "windowDays": 30}})
    shown = p2.evaluate("""() => ({ minutes: document.querySelector('#setMinutes').value, hour: document.querySelector('#setHour').value,
      tier: document.querySelector('#setTier').value, theme: document.querySelector('#setBoardTheme').value,
      pieces: document.querySelector('#setPieceSet').value, coords: document.querySelector('#setShowCoords').checked,
      perf: document.querySelector('#syncPerf').value, scale: document.querySelector('#uiScale').value,
      scaleOn: getComputedStyle(document.documentElement).getPropertyValue('--ui-scale').trim(),
      window: document.querySelector('#winLabel').textContent })""")
    p2.click("#saveSettings")
    kept = stored(p2, "settings", {})
    check("settings: a restored backup's settings show in the form, beside Sync and on the slider, and Save keeps them",
          shown == {"minutes": "45", "hour": "7", "tier": "3", "theme": "green", "pieces": "letters", "coords": False, "perf": "blitz",
                    "scale": "1.25", "scaleOn": "1.25", "window": "Last 30 days"}
          and [kept.get(k) for k in ("minutes", "hour", "endgameTier", "boardTheme", "pieceSet", "showCoords", "perf", "windowDays")]
              == [45, 7, 3, "green", "letters", False, "blitz", 30], "%s | %s" % (shown, kept))
    c2.close()

    # Stored data the app did not write as it is: a score that is no result's, no date, a start position that does
    # not load, moves that are not a list, a clock with a fraction; settings with a bad value, an unknown theme,
    # a text size the list does not have (it was kept, and scaled the whole page 50 times), letters for pieces,
    # and no window yet (saved before the window existed, on blitz).
    damaged = blunder_game("dmg1", 1); damaged.update({"score": 7, "fen": "not a position"}); del damaged["date"]; del damaged["endedAt"]
    no_moves = blunder_game("dmg2", 2); no_moves["m"] = "not a list"; del no_moves["endedAt"]
    clocked = blunder_game("dmg3", 3); clocked.update({"clockInitial": 300, "clockIncrement": 0})
    for row, clk in zip(clocked["m"], (290, 288, 20.4, 286, 15)): row[4] = clk
    c2, p2 = fresh({"games": [damaged, no_moves, clocked], "settings": {"minutes": "lots", "hour": 19, "endgameTier": 2, "perf": "blitz",
                    "boardTheme": "Not A Theme!", "pieceSet": "letters", "uiScale": 50},
                    "myRatings": {"user": "bob", "rows": {"blitz": [1900, 500, 0, None, None, None]}}})
    loaded = p2.evaluate("""() => ({ minutes: document.querySelector('#setMinutes').value, theme: document.documentElement.getAttribute('data-board-theme'),
      pieces: document.querySelector('#setPieceSet').value, scale: document.querySelector('#uiScale').value,
      scaleOn: getComputedStyle(document.documentElement).getPropertyValue('--ui-scale').trim(),
      perf: document.querySelector('#syncPerf').value, settings: JSON.parse(localStorage.getItem('dvor:settings')) })""")
    clock_card = " ".join(p2.inner_text("#strengthBody").split())
    you_row = " ".join(p2.inner_text("#titledBody .cmp-row.you").split())
    p2.type("#handle", "b"); p2.wait_for_timeout(200)   # a key that is not Enter does not sync
    typed = [p2.evaluate("document.querySelector('#flash').classList.contains('hidden')"), p2.is_disabled("#sync")]
    p2.click("button.tab[data-tab=settings]")
    with p2.expect_download() as dl:
        p2.click("#exportAll")
    saved = {g["id"]: g for g in json.load(open(dl.value.path(), encoding="utf-8"))["games"]}
    check("stored settings: a bad budget, an unknown theme and a text size the list does not have fall back; letters for pieces are kept",
          loaded["minutes"] == "60" and loaded["theme"] == "cyan" and loaded["pieces"] == "letters" and loaded["scale"] == "1"
          and loaded["scaleOn"] == "1", loaded)
    check("stored settings from before the window move to all time, and a speed other than rapid stays",
          loaded["settings"].get("windowDays") == 0 and loaded["settings"].get("perf") == "blitz" and loaded["perf"] == "blitz", loaded["settings"])
    d1, d2, d3 = saved.get("dmg1", {}), saved.get("dmg2", {}), saved.get("dmg3", {})
    check("stored games: a score that is no result's is a draw, a missing date is today, a missing end is its start",
          d1.get("score") == 0.5 and abs(d1.get("date", 0) - time.time() * 1000) < 120000 and d1.get("endedAt") == d1.get("date")
          and d2.get("endedAt") == d2.get("date") == no_moves["date"], [(d.get("score"), d.get("date"), d.get("endedAt")) for d in (d1, d2)])
    check("stored games: a start position that does not load is the initial one; moves that are not a list are none",
          "fen" not in d1 and [r[0] for r in d1.get("m", [])] == ["e4", "e5", "Ba6", "bxa6", "Nf3"] and d2.get("m") == [], [d1.get("m"), d2.get("m")])
    check("stored games: clocks come back, are saved to the second, and errors under time pressure are counted and called out",
          [r[4] for r in d3.get("m", [])] == [290, 288, 20, 286, 15] and "Errors under time pressure 100%" in clock_card
          and "More than a quarter of your errors arrive with under fifteen percent of the clock" in clock_card,
          [[r[4] for r in d3.get("m", [])], clock_card[clock_card.find("Errors under"):][:40]])
    check("titled: ratings stored for an account while no handle is set are not shown as yours",
          "sync to add your Lichess ratings" in you_row and "bob" not in you_row, you_row)
    check("handle box: typing a letter is not Enter, so nothing is synced", typed == [True, False], typed)
    c2.close()

    # Titled players from stored data: a speed that is none, your ratings under the handle in other capitals, a live
    # player with no title, one with no established rating; one speed with and without a public history; a refresh
    # that fails after an earlier one worked.
    live = {"date": "2026-10-05", "players": {"EricRosen": {"t": None, "s": {"blitz": [2544, 9309, 0, 2500, 2600, None]}}, "Fins": {"t": "IM", "s": {}}}}
    c2, p2 = fresh({"games": [blunder_game("ti%d" % i, 1 + i) for i in range(3)], "handle": "luke", "titledSpeed": "warp", "titledLive": live,
                    "titledPicks": ["Kingscrusher-YouTube", "CheckRaiseMate", "EricRosen", "Fins"],
                    "myRatings": {"user": "LUKE", "rows": {"blitz": [1900, 500, 0, None, None, None]}}},
                   routes={"**/lichess.org/api/users": lambda r: r.fulfill(status=503, body="")})
    p2.click("button.tab[data-tab=strength]")
    speed = p2.evaluate("document.querySelector('#cmpSpeed').value")
    sheet_all = " ".join(p2.inner_text("#titledBody").split())
    eric_tags = p2.evaluate("[...document.querySelectorAll('#titledBody .cmp-name')].filter(n => /Eric Rosen/.test(n.innerText)).map(n => n.querySelector('.tag').innerText)")
    p2.select_option("#cmpSpeed", "blitz")
    rows = p2.evaluate("Object.fromEntries([...document.querySelectorAll('#titledBody tbody tr')].map(r => [r.cells[0].innerText, [r.cells[1].innerText, r.cells[2].innerText]]))")
    p2.click("#cmpRefresh")
    p2.wait_for_function("/Could not reach Lichess/.test(document.querySelector('#cmpStatus').innerText)", timeout=10000)
    check("titled: a stored speed that is none is all speeds; ratings saved under LUKE are luke's",
          speed == "all" and "Lichess, LUKE" in sheet_all, "%s | %s" % (speed, sheet_all[:80]))
    check("titled: a live player with no title shows '?', and one with no established rating is named as such",
          eric_tags == ["?"] and "No established rating on Lichess: John Bartholomew." in sheet_all, "%s | %s" % (eric_tags, sheet_all[-120:]))
    check("titled: one speed shows the current rating with the last game where the history is public, and says when it is not",
          rows.get("Tryfon Gavriel", ["", ""])[1].endswith("now 2334, last played 2026-09-19") and rows.get("Nate Solon", ["", ""])[1].endswith("history not public")
          and rows.get("Eric Rosen", ["", ""]) == ["?", "2500–2600 now 2544"], rows)
    check("titled: a failed refresh after an earlier one keeps the last fetched ratings and says so",
          "Showing the last fetched ratings." in p2.inner_text("#cmpStatus"), p2.inner_text("#cmpStatus"))
    c2.close()

    # Sync: a window of 30 days asks for 300 games and says so when there are none; games whose speed Lichess does
    # not name take the rating of rapid; mostly analysed games are no warning; their clocks are saved.
    asked = []
    def lichess_rows(route):
        asked.append(route.request.url)
        if "luke2" not in route.request.url: return route.fulfill(status=200, body="", content_type="application/x-ndjson")
        rows = [lichess_row("nsp%d" % i, "rapid", i + 1, perf=None, clock={"initial": 600, "increment": 0}, clocks=[60000, 59950, 59025],
                            analysis=[{"eval": 30}, {"eval": 30}, {"eval": 35}],
                            players={"white": {"user": {"name": "luke2"}, "rating": 1800, "analysis": {"acpl": 20}}, "black": {"user": {"name": "opp"}, "rating": 1800}})
                for i in range(2)]
        route.fulfill(status=200, body="\n".join(rows) + "\n", content_type="application/x-ndjson")
    c2, p2 = fresh({"settings": {"windowDays": 30, "minutes": 60, "hour": 19, "endgameTier": 2}},
                   routes={"**/lichess.org/api/games/user/**": lichess_rows,
                           "**/lichess.org/api/user/luke2": lambda r: r.fulfill(status=200, body='{"perfs":{"rapid":{"rating":1850,"games":300}}}', content_type="application/json")})
    p2.fill("#handle", "luke"); p2.click("#sync")
    p2.wait_for_function("/No rated/.test(document.querySelector('#flash').innerText)", timeout=10000)
    empty_note = " ".join(p2.inner_text("#flash").split())
    p2.fill("#handle", "luke2"); p2.click("#sync")
    p2.wait_for_function("/Loaded 2 games/.test(document.querySelector('#flash').innerText)", timeout=10000)
    loaded_note, loaded_cls = p2.inner_text("#flash").strip(), p2.evaluate("document.querySelector('#flash').className")
    check("sync: a 30-day window asks for 300 games, and an empty answer says 'in the last 30 days' with no loaded games to mention",
          len(asked) >= 1 and "max=300" in asked[0] and "for luke in the last 30 days." in empty_note and "unchanged" not in empty_note,
          "%s | %s" % (asked[:1], empty_note[:120]))
    check("sync: games Lichess sends with no speed name take your rapid rating; mostly analysed is no warning; clocks are kept to the second",
          stored(p2, "lichessRating") == 1850 and loaded_note == "Loaded 2 games, 2 with server analysis." and "warn" not in loaded_cls
          and [r[4] for r in stored(p2, "games", [{}])[0].get("m", [])] == [600, 600, 590],
          "%s | %s | %s" % (stored(p2, "lichessRating"), loaded_note, loaded_cls))
    c2.close()

    # Sparring, with a scripted mirror where the point is what the page does with a given reply.
    SCRIPTED = """() => { window.__script = [];
      Sparring.Mirror.prototype.chooseMove = function (g) {
        const s = window.__script.shift(), r = typeof s === 'string' ? { san: s } : s, m = g.moveFromSan(r.san);
        return Promise.resolve({ move: m, san: g.san(m), fromBook: false, intendedLoss: r.loss || 0, blunderTurn: !!r.lapse });
      }; }"""
    def spar_play(page, line, my="w"):
        # Plays line (SAN from the start) to its end: your moves clicked on the board, the mirror's from its script.
        return page.evaluate("async ([line, my]) => {" + WAIT_JS + """
          const count = () => document.querySelectorAll('#sparMoves .mv').length, stuck = () => 'stuck after ' + count() + ' moves';
          const g = new Chess();
          for (let i = 0; i < line.length; i++) {
            const m = g.moveFromSan(line[i]);
            if (count() <= i && (i % 2 === 0) === (my === 'w')) {
              await wait(() => count() === i, stuck);
              document.querySelector('#sparBoard [data-sq=' + m.fromSq + ']').click();
              document.querySelector('#sparBoard [data-sq=' + m.toSq + ']').click();
            }
            g.makeMove(m);
          }
          await wait(() => count() === line.length, stuck);
          return document.querySelector('#sparStatus').innerText;
        }""", [line, my])
    def spar_game(page, line, my="w", script=None):
        page.evaluate("s => { window.__script = s; }", script if script is not None else [s for i, s in enumerate(line) if (i % 2 == 0) != (my == "w")])
        page.select_option("#sparColor", my); page.click("#sparStart")
        return spar_play(page, line, my)
    pgn_result = lambda page: re.search(r'\[Result "([^"]*)"\]', page.evaluate("document.querySelector('#sparPgn').value")).group(1)
    c2, p2 = fresh({"games": [blunder_game("sp%d" % i, 1 + i) for i in range(2)]})
    p2.click("button.tab[data-tab=sparring]"); p2.uncheck("#sfOn"); p2.uncheck("#sparCoach")
    status0 = p2.inner_text("#sparStatus")
    p2.click('#sparBoard [data-sq="e2"]'); p2.click('#sparBoard [data-sq="e4"]'); p2.click("#sparResign")
    untouched = p2.evaluate("[!!document.querySelector('#sparBoard [data-sq=e2] .piece'), !!document.querySelector('#sparBoard [data-sq=e4] .piece'), document.querySelector('#sparMoves').innerText.trim(), document.querySelector('#sparPgn').value]")
    check("sparring: before a game, a move on the board and Resign do nothing",
          untouched == [True, False, "", ""] and p2.inner_text("#sparStatus") == status0, "%s | %r" % (untouched, p2.inner_text("#sparStatus")))
    p2.select_option("#sparColor", "random")
    colours = []
    for roll in (0.9, 0.1):
        p2.evaluate("r => { const real = Math.random; Math.random = () => r; document.querySelector('#sparStart').click(); Math.random = real; }", roll)
        colours.append(p2.inner_text("#sparStatus").split(" against")[0])
        p2.click("#sparResign"); colours.append(pgn_result(p2))
    check("sparring: Random plays Black or White by the roll; resigning as Black is 1-0, as White 0-1",
          colours == ["Playing as Black", "1-0", "Playing as White", "0-1"], colours)
    p2.evaluate(SCRIPTED)
    # Take back at once as Black, before the mirror's first move: its first move and the one the takeback asks for
    # are both scheduled, and the second finds it is your turn. The mirror moves once, never for you.
    p2.select_option("#sparColor", "b")
    # Both are timers, 250 ms from the start and 120 ms from the takeback: a 300 ms one set after them fires after both.
    p2.evaluate("""async () => { window.__script = ['e4', 'd4'];
      document.querySelector('#sparStart').click(); document.querySelector('#sparTakeback').click();
      await new Promise(done => setTimeout(done, 300)); }""")
    once = p2.evaluate("[[...document.querySelectorAll('#sparMoves .mv')].map(m => m.innerText), window.__script.length, document.querySelectorAll('#sparBoard .sq.movable').length]")
    check("sparring: a takeback before the mirror's first move as Black leaves one mirror move, and your turn",
          once[0] == ["e4"] and once[1] == 1 and once[2] > 0, once)
    p2.click("#sparResign")
    won = spar_game(p2, ["e4", "f6", "d4", "g5", "Qh5#"])
    check("sparring: mating the mirror as White is 'Checkmate. You won.' and 1-0", won.startswith("Checkmate. You won.") and pgn_result(p2) == "1-0", won[:40])
    p2.evaluate("s => { window.__script = s; }", [{"san": "e5", "lapse": True}, {"san": "d5", "loss": 120}])
    p2.select_option("#sparColor", "w"); p2.click("#sparStart")
    lapse = spar_play(p2, ["a3", "e5"]); marked = p2.evaluate("[...document.querySelectorAll('#sparMoves .mv.blunder')].map(m => m.innerText)")
    costly = spar_play(p2, ["a3", "e5", "a4", "d5"])
    check("sparring: the mirror's deliberate lapse is said and marked; a move giving up more than 60 cp says how much",
          lapse == "Played e5 — and that one was a deliberate lapse, at the rate you lapse." and marked == ["e5"]
          and costly == "Played d5 (giving up 120 centipawns, within your own error band)", "%s | %s | %s" % (lapse, marked, costly))
    loyd = ["e3", "a5", "Qh5", "Ra6", "Qxa5", "h5", "h4", "Rah6", "Qxc7", "f6", "Qxd7+", "Kf7", "Qxb7", "Qd3", "Qxb8", "Qh7", "Qxc8", "Kg6", "Qe6"]
    stale = spar_game(p2, loyd); stale_result = pgn_result(p2)
    # Two long games found by a seeded random walk over js/core.js's moves: 100 knight moves with no position three
    # times, and captures down to king and knight against king.
    fifty_line = ["Nf3","Nh6","Na3","Na6","Nh4","Nf5","Nf3","Nc5","Nb5","Nb3","Ng5","Na5","Ne6","Ng3","Nc5","Nh5","Nb3","Ng3","N3d4","Nh5",
                  "Nf3","Ng3","Nh4","Nh5","Nf3","Nc6","Nc3","Nd4","Nd5","Nb3","Nf4","Nf6","Nd3","Ng8","Nf4","Nf6","Nd4","Na5","Nb5","Nc4",
                  "Na3","Ne3","Nd3","Nf5","Nb1","Nh5","Nc3","Nf6","Ne5","Nd5","Nf3","Nfe3","Ne5","Nf6","Na4","Neg4","Nc3","Nh5","Nb5","Nh6",
                  "Nc4","Ng3","Nba3","Ng4","Na5","Ne4","Nb5","Nd6","Na3","Nh6","N3c4","Nb5","Ne5","Ng8","Ng6","Nh6","Ne5","Ng4","Ng6","Nd6",
                  "Nc6","Nf6","Nb8","Ng8","Nf4","Ne4","Nh3","Ng3","Ng5","Nf6","Na6","Nfh5","Ne6","Ne4","Ng5","Neg3","Nh3","Ne4","Nc5","Nc3"]
    fifty = spar_game(p2, fifty_line)
    bare_line = ["d4","Nf6","e3","c5","dxc5","Qa5+","Nd2","Qxa2","Rxa2","h6","Rxa7","Rxa7","Ba6","bxa6","Nb3","e6","Qxd7+","Bxd7","Bd2","Bxc5",
                 "Nxc5","Nh5","Nxe6","a5","Nxg7+","Nxg7","Bxa5","Rxa5","b4","Ra3","Nh3","Rxe3+","fxe3","Bxh3","gxh3","Na6","O-O","Nxb4","Rxf7","Nxc2",
                 "Rxg7","Nxe3","Rg6","Nd5","Rxh6","Rxh6","Kf1","Rxh3","Kg1","Rxh2","Kxh2"]
    bare = spar_game(p2, bare_line)
    check("sparring: stalemate, the fifty-move rule and bare kings each end the game as a draw, and say which",
          stale.startswith("Stalemate.") and stale_result == "1/2-1/2" and fifty.startswith("Drawn by the fifty-move rule.")
          and bare.startswith("Drawn: neither side can mate.") and pgn_result(p2) == "1/2-1/2", "%s | %s | %s" % (stale[:30], fifty[:30], bare[:30]))
    spar_game(p2, ["b4", "a5", "Nf3", "axb4", "Nd4", "b3", "Nf3", "bxa2", "Ng1", "axb1=Q"])
    check("sparring: the mirror's promotion is played and written down", "5. Ng1 axb1=Q *" in p2.evaluate("document.querySelector('#sparPgn').value"),
          p2.evaluate("document.querySelector('#sparPgn').value")[-40:])
    p2.check("#sparCoach")
    spar_game(p2, ["e4", "e5", "Nf3", "Qg5"])
    p2.wait_for_function("/only move/.test(document.querySelector('#sparAdvice').innerText)", timeout=20000)
    only = " ".join(p2.inner_text("#sparAdvice").split())
    spar_game(p2, ["f3", "e5", "Kf2", "Qh4+"])
    p2.wait_for_function("document.querySelectorAll('#sparAdvice .side').length === 2", timeout=20000)
    in_check = p2.evaluate("[...document.querySelectorAll('#sparAdvice .side')].map(s => s.innerText.replace(/\\s+/g, ' ').trim())")
    in_check_note = p2.inner_text("#sparAdvice")
    spar_game(p2, ["e4"], my="b")
    p2.wait_for_function("document.querySelectorAll('#sparAdvice .side').length === 2", timeout=20000)
    as_black = p2.evaluate("[...document.querySelectorAll('#sparAdvice .side')].map(s => [!!s.querySelector('.tomove'), s.querySelectorAll('.cand').length])")
    check("advice: a queen left en prise has one move, and the advice names it", "Nxg5 looks like the only move." in only, only[-120:])
    check("advice: in check there is no threat to read for the other side", in_check[1].endswith("No candidates.") and "If it were" not in in_check_note, in_check)
    check("advice: playing Black, Black is the side to move and both sides get candidates", as_black == [[False, 3], [True, 3]], as_black)
    c2.close()

    # Stockfish, a stand-in worker with no principal variation and a score four pawns for Black: its best move is the
    # line; the house engine is the more hopeful for White; the mirror's move that is Stockfish's own costs nothing.
    FAKE_SF2 = stand_in_sf(r"""if (c.indexOf('go') === 0) { var sm = / searchmoves (\S+)/.exec(c);
      postMessage('info depth 12 multipv 1 score cp ' + (white ? -400 : 400)); postMessage('bestmove ' + (sm ? sm[1] : white ? 'e2e4' : 'e7e5')); }""")
    c2, p2 = fresh({"games": [blunder_game("fs%d" % i, 1 + i) for i in range(2)]})
    p2.evaluate("src => { window.STOCKFISH_SOURCE = src; }", FAKE_SF2); p2.evaluate(SCRIPTED)
    p2.click("button.tab[data-tab=sparring]"); p2.evaluate("s => { window.__script = s; }", ["e5"])
    p2.select_option("#sparColor", "w"); p2.click("#sparStart")
    p2.wait_for_function("/House engine/.test(document.querySelector('#sfNow').innerText)", timeout=20000)
    sf_now = " ".join(p2.inner_text("#sfNow").split())
    spar_play(p2, ["e4", "e5"])
    p2.wait_for_function("/Mirror, engine moves/.test(document.querySelector('#sfLog').innerText)", timeout=20000)
    sf_log = " ".join(p2.inner_text("#sfLog").split())
    check("stockfish: with no line, its best move is what it plays; four pawns for Black is the house engine more hopeful for White",
          "Stockfish plays e4" in sf_now and re.search(r"House engine: \S+ — more hopeful for White by \d+\.\d\d\.", sf_now) is not None, sf_now)
    check("stockfish: the mirror's move that is Stockfish's own costs nothing, which is what it meant to give up",
          "Mirror, engine moves: 0 cp lost per move over 1 read, where it meant to give up 0. The house engine reads the position about as Stockfish does." in sf_log,
          sf_log[:200])
    c2.close()
    # A Stockfish that scores the start as the house engine does: the two agree. (The page's own house engine, asked
    # first, gives the number; the stand-in answers with it. With no deadline both readings are from the full depth.)
    c2, p2 = fresh({"games": [blunder_game("fa%d" % i, 1 + i) for i in range(2)]})
    p2.evaluate(NO_DEADLINE)
    house = p2.evaluate("async () => (await Sparring.dualAdvice(new Engine(), new Chess(), { depth: 3, budget: 800 })).evalCp")
    p2.evaluate("src => { window.STOCKFISH_SOURCE = src; }",
                stand_in_sf("if (c.indexOf('go') === 0) { postMessage('info depth 12 multipv 1 score cp %d pv e2e4'); postMessage('bestmove e2e4'); }" % house))
    p2.click("button.tab[data-tab=sparring]"); p2.select_option("#sparColor", "w"); p2.click("#sparStart")
    p2.wait_for_function("/House engine/.test(document.querySelector('#sfNow').innerText)", timeout=20000)
    agree = " ".join(p2.inner_text("#sfNow").split())
    check("stockfish: a reading within 30 cp of the house engine's is called agreement", "agrees with Stockfish." in agree, agree)
    c2.close()
    # A read dropped when Stockfish is switched off, which then fails, is not Stockfish failing: on again, it reads.
    # The stand-in leaves its first search unanswered and throws when told to stop it. Each step waits for what the
    # next needs (the search sent, the failure delivered to the page and to this script), not for a length of time.
    FAKE_SF3 = "var searches = 0; " + stand_in_sf("""if (c === 'stop') throw new Error('the stopped read failed');
      else if (c.indexOf('go') === 0 && ++searches > 1) {
        postMessage('info depth 9 multipv 1 score cp 25 pv ' + (white ? 'e2e4' : 'e7e5')); postMessage('bestmove ' + (white ? 'e2e4' : 'e7e5')); }""")
    # What the page sends its worker, and its errors, each counted once the worker's own listeners have run.
    WATCH_WORKER = """() => { const Real = window.Worker; window.__sent = []; window.__workerErrors = 0;
      window.Worker = function (url) { const w = new Real(url), send = w.postMessage.bind(w);
        w.postMessage = c => { window.__sent.push(String(c)); send(c); };
        w.addEventListener('error', () => setTimeout(() => { window.__workerErrors++; }));
        return w; }; }"""
    c2, p2 = fresh({"games": [blunder_game("fo%d" % i, 1 + i) for i in range(2)]}); errs_before = len(errors)
    p2.evaluate("src => { window.STOCKFISH_SOURCE = src; }", FAKE_SF3); p2.evaluate(WATCH_WORKER)
    p2.click("button.tab[data-tab=sparring]"); p2.uncheck("#sparCoach")
    p2.select_option("#sparColor", "w"); p2.click("#sparStart")
    p2.wait_for_function("window.__sent.some(c => c.indexOf('go') === 0)", timeout=STUCK_MS)
    with p2.expect_event("pageerror", timeout=STUCK_MS):
        p2.uncheck("#sfOn")
    p2.wait_for_function("window.__workerErrors > 0", timeout=STUCK_MS)
    p2.check("#sfOn")
    p2.wait_for_function("/Stockfish plays|did not start/.test(document.querySelector('#sfNow').innerText)", timeout=STUCK_MS)
    worker_errors = errors[errs_before:]; del errors[errs_before:]   # the stand-in's own throw, reported as the page's: expected
    check("stockfish: a read that fails after Stockfish was switched off does not disable it; switched on, it reads",
          "Stockfish plays e4" in p2.inner_text("#sfNow") and worker_errors and all("the stopped read failed" in e for e in worker_errors),
          "%s | %s" % (p2.inner_text("#sfNow")[:80], worker_errors))
    c2.close()

    # Drills and review on harder cards: Black to move, no opening name, short of time, no line after the move; a
    # solution that is no move; two wrong tries; the right move at the second. Review: the 4th move, the judgments
    # marked, a mistake with no better move known.
    black_err = blunder_game("bk1", 1, "b"); black_err.update({"openingName": None, "clockInitial": 300, "clockIncrement": 0,
        "m": [["e4", 30, "", "", 290, "", ""], ["e5", 30, "", "", 290, "", ""], ["Nf3", 30, "", "", 280, "", ""],
              ["Qg5", 900, "Blunder", "b8c6", 10, "", ""], ["Nxg5", 900, "", "", 275, "", ""]]})
    no_move = blunder_game("zz1", 2); no_move["m"][2] = ["Ba6", -300, "Blunder", "", "", "zz9 Nc6", ""]
    judged = blunder_game("rv4", 3); judged.update({"oppName": "judged", "analysed": False,
        "m": [["e4", "", "", "", "", "", ""], ["e5", "", "", "", "", "", ""], ["Nf3", "", "", "", "", "", ""], ["Nc6", "", "Inaccuracy", "", "", "", ""],
              ["Bc4", "", "Mistake", "", "", "", ""], ["Bc5", "", "", "", "", "", ""], ["d3", "", "", "", "", "", ""], ["d6", "", "", "", "", "", ""],
              ["Nc3", "", "", "", "", "", ""]]})
    nobest = blunder_game("nb2", 4); nobest["oppName"] = "nobest"; nobest["m"][2] = ["Ba6", -300, "Blunder", "", "", "", ""]
    unfinished = [line_game("uf%d" % i, ["c4", "c5", "Nc3"], 5 + i) for i in range(2)]
    for g in unfinished: g.update({"result": "*", "score": None})
    c2, p2 = fresh({"games": [black_err, no_move, judged, nobest] + unfinished})
    p2.click("button.tab[data-tab=strength]")
    tree = " ".join(p2.inner_text("#strengthBody").split())
    worst_black = p2.evaluate("[...document.querySelectorAll('#strengthBody tr')].filter(r => r.querySelector('[data-jump=\"bk1:4\"]')).map(r => r.cells[1].innerText)")
    p2.click('[data-jump="bk1:4"]')
    prompt = " ".join(p2.evaluate("document.querySelector('#drillPrompt').textContent").split())
    tries = []
    for sq_from, sq_to in (("a7", "a6"), ("h7", "h6"), ("b8", "c6")):
        p2.click('#drillBoard [data-sq="%s"]' % sq_from); p2.click('#drillBoard [data-sq="%s"]' % sq_to); p2.wait_for_timeout(100)
        tries.append(p2.inner_text("#drillFeedback").strip())
    suggested = p2.evaluate("[...document.querySelectorAll('#drillGrades button.primary')].map(b => b.dataset.grade)")
    p2.click("#drillQuit"); p2.click("button.tab[data-tab=strength]"); p2.click('[data-jump="zz1:3"]')
    board_before = p2.evaluate("document.querySelector('#drillBoard').innerHTML")
    p2.click("#drillReveal")
    revealed = p2.inner_text("#drillFeedback").strip()
    pieces_same = p2.evaluate("b => { const t = document.createElement('div'); t.innerHTML = b; const at = r => [...r.querySelectorAll('.sq')].map(s => s.dataset.sq + (s.querySelector('.piece') || {}).textContent).join(); return at(t) === at(document.querySelector('#drillBoard')); }", board_before)
    open_grades = p2.evaluate("[...document.querySelectorAll('#drillGrades button')].filter(b => !b.disabled).map(b => b.dataset.grade)")
    check("drills: Black to move, no opening, short of time: the card says so", prompt.startswith("Black to move. Find what you missed.")
          and "Your game, move 2," in prompt and " · " not in prompt and "You were short of time." in prompt and worst_black == ["2…"], "%s | %s" % (prompt[:160], worst_black))
    check("drills: two wrong tries get the stronger hint, the right one at the second try suggests Hard, with no line to show",
          tries[0] == "Not a6. Try again — or show the move, and grade the card Missed it or Hard." and tries[1] == "Not h6. Look at what your opponent is allowed to do after it."
          and tries[2] == "Correct: Nc6." and suggested == ["2"], "%s | %s" % (tries, suggested))
    check("drills: a stored solution that is no move is shown as written, with the board left as it was",
          revealed == "The move was zz9. zz9 Nc6" and pieces_same and open_grades == ["0", "1"], "%r | %s | %s" % (revealed, pieces_same, open_grades))
    check("strength: an opening line reached only in unfinished games has no result", "1. c4 2 games no result" in tree, tree[tree.find("1. c4"):][:60])
    p2.click("#drillQuit"); p2.click("button.tab[data-tab=review]")
    pick_review(p2, "judged")
    p2.click("#revStart"); p2.click("#revSkip"); p2.click("#revSkip"); p2.click("#revSkip")
    fourth = " ".join(p2.evaluate("document.querySelector('#revPrompt').textContent").split())
    marks = p2.evaluate("[...document.querySelectorAll('#revMoves .mv')].map(m => m.innerText + ':' + m.className.replace('mv', '').trim())")
    p2.click("#revSkip"); p2.click("#revSkip"); p2.click("#revRestart")
    pick_review(p2, "nobest")
    p2.click("#revStart"); p2.click("#revSkip")
    p2.fill("#revText", "I played Ba6 to provoke b5, the line Ba6 bxa6 and I am lost."); p2.click("#revSubmit")
    no_best_note = " ".join(p2.inner_text("#revFeedback").split())
    check("review: the 4th of your moves is called the 4th", "You are about to play your 4th move." in fourth, fourth[:60])
    check("review: the move list marks inaccuracies and mistakes", "Nc6:inacc" in marks and "Bc4:mistake" in marks, marks)
    check("review: an expensive move with no better move known says what it cost, and no engine move",
          "You played Ba6, cost 3.3 pawns." in no_best_note and "engine wanted" not in no_best_note, no_best_note[-80:])
    c2.close()
    # A card graded after its game went (a backup restored mid-drill) keeps the grade. It has no line: the reveal shows the move alone.
    gone = blunder_game("gone2", 1); gone["m"][2][5] = ""
    c2, p2 = fresh({"games": [gone]})
    p2.click("button.tab[data-tab=strength]"); p2.click('[data-jump="gone2:3"]'); p2.click("#drillReveal")
    bare_reveal = p2.inner_text("#drillFeedback").strip()
    p2.click("button.tab[data-tab=settings]")
    restore_backup(p2, "other-games.json", {"games": [blunder_game("other2", 2)]})
    p2.click("button.tab[data-tab=drills]"); p2.click('[data-grade="0"]')
    kept_card = stored(p2, "cards", {}).get("gone2:3", {})
    check("drills: a card graded after its game was replaced keeps the grade",
          bare_reveal == "The move was Nf3." and [h.get("g") for h in kept_card.get("history", [])] == [0] and kept_card.get("lapses") == 1
          and not p2.evaluate("document.querySelector('#drillHome').classList.contains('hidden')"), "%r | %s" % (bare_reveal, kept_card))
    c2.close()

    # Scout: a listed rating, analysed games, an opening under water as Black; then loaded as yours, the window
    # moved to 30 days and back to all time keeps their games.
    def scout_black(route):
        rows = [lichess_row("sb%d" % i, "blitz", i + 1, moves="e4 c5 Nf3 d6 d4", clock={"initial": 300, "increment": 0},
                            opening={"eco": "B50", "name": "Sicilian Defense"}, analysis=[{"eval": 30}, {"eval": 40}, {"eval": 40}, {"eval": 45}, {"eval": 50}],
                            players={"white": {"user": {"name": "opp"}, "rating": 1800}, "black": {"user": {"name": "scoutb"}, "rating": 1700, "analysis": {"acpl": 40}}})
                for i in range(4)]
        route.fulfill(status=200, body="\n".join(rows) + "\n", content_type="application/x-ndjson")
    c2, p2 = fresh({}, routes={"**/lichess.org/api/games/user/scoutb**": scout_black,
                               "**/lichess.org/api/user/scoutb": lambda r: r.fulfill(status=200, body='{"perfs":{"blitz":{"rating":1750,"games":400}}}', content_type="application/json")})
    p2.click("button.tab[data-tab=scout]"); p2.fill("#scoutHandle", "scoutb"); p2.click("#scoutBtn")
    p2.wait_for_selector("#scoutAdopt", timeout=10000)
    report = " ".join(p2.inner_text("#scoutOut").split())
    p2.click("#scoutAdopt")
    windows = []
    for i in (2, 9):
        p2.evaluate("""i => { const r = document.querySelector('#winDays'); r.value = String(i); r.dispatchEvent(new Event('input')); r.dispatchEvent(new Event('change')); }""", i)
        windows.append(" ".join(p2.inner_text("#rulerCaption").split()))
    check("scout: the listed rating, the analysed games and an opening under water as Black are reported",
          "against a listed rating of 1750" in report and "(4 with engine analysis)" in report and "Sicilian Defense as Black (0%)" in report, report[:240])
    check("scout: a profile loaded as yours keeps its games as the window moves to 30 days and back to all time",
          windows[0].startswith("Last 30 days: 4 games") and windows[1].startswith("All time: 4 games"), windows)
    c2.close()

    # Chrome and imports: no ResizeObserver; the arrow keys on the tabs; one nameless game; several games left out
    # each way; a storage that will not clear; games older than the window; a stored theme the list does not have.
    c2, p2 = fresh({"games": [blunder_game("ch1", 1)], "syncedDays": 30, "settings": {"windowDays": 60, "minutes": 60, "hour": 19, "endgameTier": 2, "boardTheme": "zz"}})
    win_note = p2.inner_text("#winNote")
    snap_page(p2)   # the page is replaced: keep what it ran
    p2.add_init_script("delete window.ResizeObserver"); p2.reload(); p2.wait_for_timeout(500)
    booted = p2.evaluate("[typeof ResizeObserver, document.querySelectorAll('.panel.active').length, getComputedStyle(document.documentElement).getPropertyValue('--mast-h').trim()]")
    p2.focus("button.tab[data-tab=sparring]"); p2.keyboard.press("ArrowLeft")
    left = p2.evaluate("document.activeElement.dataset.tab"); p2.keyboard.press("ArrowRight")
    right = p2.evaluate("document.activeElement.dataset.tab")
    p2.click("button.tab[data-tab=settings]")
    blank_theme = p2.evaluate("document.querySelector('#setBoardTheme').value")
    p2.click("#saveSettings")
    p2.click("button.tab[data-tab=sparring]")
    theme_after = p2.evaluate("[document.documentElement.getAttribute('data-board-theme'), document.querySelector('#sparBoard [data-sq=e1] .piece').textContent]")
    p2.set_input_files("#importFile", write_tmp("one-nameless.pgn", "1. e4 e5 2. Nf3 *\n"))
    p2.wait_for_function("/names no player/.test(document.querySelector('#flash').innerText)", timeout=10000)
    one_nameless = " ".join(p2.inner_text("#flash").split())
    p2.set_input_files("#importFile", write_tmp("mixed.pgn",
        '[Variant "Chess960"]\n[White "a"]\n[Black "b"]\n[Result "*"]\n\n1. e4 *\n\n' * 2 +
        '[White "a"]\n[Black "b"]\n[Result "*"]\n\n1. e4 e5 2. Ke3 *\n\n' * 2 +
        '[White "a"]\n[Black "b"]\n[Result "1-0"]\n\n1. d4 d5 2. c4 1-0\n'))
    p2.wait_for_function("/Left out/.test(document.querySelector('#flash').innerText)", timeout=10000)
    mixed = " ".join(p2.inner_text("#flash").split())
    p2.evaluate("() => { Storage.prototype.__remove = Storage.prototype.removeItem; Storage.prototype.removeItem = function () {}; }")
    p2.click("button.tab[data-tab=settings]"); p2.click("#wipe"); p2.wait_for_timeout(300)
    refused = p2.inner_text("#flash")
    still = p2.evaluate("localStorage.getItem('dvor:games') !== null")
    p2.evaluate("() => { Storage.prototype.removeItem = Storage.prototype.__remove; }")
    check("window: games synced over 30 days, with a 60-day window, say they only go back 30 days",
          win_note == "Loaded games only go back 30 days. Press Sync to fetch the rest of this window.", win_note)
    check("chrome: with no ResizeObserver the page still boots and measures its masthead",
          booted[0] == "undefined" and booted[1] == 1 and booted[2].endswith("px"), booted)
    check("tabs: the left and right arrows move to the neighbouring tabs", left == "strength" and right == "sparring", "%s, %s" % (left, right))
    check("settings: a stored theme the list does not have saves as the default cyan board, outline pieces",
          blank_theme == "" and theme_after == ["cyan", "♔"], "%r %s" % (blank_theme, theme_after))
    check("import: one game with no player names is counted in the singular",
          "1 names no player, so it was read as played with White" in one_nameless, one_nameless[:160])
    check("import: several games left out each way are counted in the plural",
          "Left out 2 games in Chess960" in mixed and "Left out 2 games whose moves could not be read." in mixed, mixed[:200])
    check("delete everything: a storage that will not clear says so, and nothing is reloaded or lost",
          refused.startswith("Could not delete everything: this browser refused to clear its stored data.") and still, refused[:80])
    c2.close()

    # Endgame studies: promoting to a queen in the Saavedra walks into the stalemate; the engine taking the last
    # knight is a draw by material; studied as Black, the evaluation is still White's.
    def eg_play(page, moves):
        return page.evaluate("async (moves) => {" + WAIT_JS + """
          const fb = () => document.querySelector('#drillFeedback').innerText;
          const out = [];
          for (const [a, b, promo] of moves) {
            document.querySelector('#drillBoard [data-sq=' + a + ']').click(); document.querySelector('#drillBoard [data-sq=' + b + ']').click();
            if (promo) document.querySelector('#drillBoard [data-promo=' + promo + ']').click();
            await wait(() => !/Engine replying/.test(fb()), () => 'no reply: ' + fb());
            out.push(fb().trim());
          }
          return out;
        }""", moves)
    c2, p2 = fresh({"games": [blunder_game("eg1", 1)]})
    p2.evaluate(NO_DEADLINE)   # the replies checked below are the engine's depth-4 choices (about 0.3 s each in Node; 1.4 s allowed)
    p2.click("button.tab[data-tab=drills]")
    p2.select_option("#egPick", "saavedra"); p2.click("[data-start=endgame]")
    saavedra = eg_play(p2, [["c6", "c7"], ["b6", "b5"], ["b5", "b4"], ["b4", "b3"], ["b3", "c2"], ["c7", "c8", "q"], ["c8", "c4"]])
    p2.click("#drillQuit"); p2.select_option("#egPick", "bn-mate"); p2.click("[data-start=endgame]")
    bn = eg_play(p2, [["f1", "g3"], ["d1", "c2"]])
    p2.click("#drillQuit"); p2.select_option("#egPick", "philidor"); p2.click("[data-start=endgame]")
    philidor = eg_play(p2, [["b6", "c6"]])
    check("endgame: the Saavedra's queen promotion is met by Rc4+, and taking the rook is stalemate",
          [s.split(".")[0] for s in saavedra[:6]] == ["Engine plays Rd6+", "Engine plays Rd5+", "Engine plays Rd4+", "Engine plays Rd3+", "Engine plays Rd4", "Engine plays Rc4+"]
          and saavedra[6] == "Stalemate.", saavedra)
    check("endgame: the engine taking the last knight ends the study as a draw, said in words",
          bn[0].startswith("Engine plays Kf4.") and bn[1] == "Drawn: neither side can mate.", bn)
    m = re.search(r"Evaluation ([+-]?)(\d+\.\d+|#\d+) \(White’s view\)", philidor[0])
    check("endgame: studied as Black, the evaluation is White's, who has the extra pawn", m is not None and m.group(1) != "-", philidor)
    c2.close()

    check("page: no uncaught errors throughout", not errors, errors[:3])

    if COV:
        snap()
        with open(COV, "w", encoding="utf-8") as f: json.dump({"result": snapshots}, f)
    b.close()

print("\n%d passed, %d failed" % (results.count(True), results.count(False)))
sys.exit(0 if all(results) else 1)
