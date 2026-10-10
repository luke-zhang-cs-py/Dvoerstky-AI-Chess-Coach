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
        page.on("dialog", lambda d: d.accept())
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
    def lichess_row(gid, perf, days_ago):
        return json.dumps({"id": gid, "rated": True, "speed": perf, "perf": perf, "createdAt": NOW - DAY * days_ago, "status": "resign",
                           "winner": "white", "moves": "e4 e5 Nf3", "players": {"white": {"user": {"name": "luke"}, "rating": 1700},
                                                                                "black": {"user": {"name": "opp"}, "rating": 1700}}})
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
    p2.click('#drillBoard [data-sq="d1"]'); p2.click('#drillBoard [data-sq="d4"]')
    p2.click("#drillQuit")
    p2.wait_for_timeout(2000)   # past the engine's 1.4 s budget: its reply arrives with no drill to land in
    home = not p2.evaluate("document.querySelector('#drillHome').classList.contains('hidden')")
    check("drills: the Strength tab's Drill works as the visit's first drill; an empty pattern queue says so; concepts cannot be set up",
          first_drill and "Nothing in that queue right now." in empty_queue and "wrong-bishop" in concept, "%s | %s" % (empty_queue[:40], concept))
    check("drills: quitting an endgame while the engine replies leaves the drills page, and the late reply lands nowhere", home)
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
    check("page: no uncaught errors throughout", not errors, errors[:3])

    if COV:
        snap()
        with open(COV, "w", encoding="utf-8") as f: json.dump({"result": snapshots}, f)
    b.close()

print("\n%d passed, %d failed" % (results.count(True), results.count(False)))
sys.exit(0 if all(results) else 1)
