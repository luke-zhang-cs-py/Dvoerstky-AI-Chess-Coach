"""Smoke check for the single-file build: dist/Dvoretsky-Lab.html loads on its own and works.

    python tools/build_single_file.py && python test/dist_check.py [path/to/built.html]

The built file is opened from a directory of its own, with nothing beside it, so a script
or stylesheet left un-inlined fails to load instead of being found in js/ or css/.
"""
import os, shutil, sys, tempfile
from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
BUILT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "..", "dist", "Dvoretsky-Lab.html")
PGN = os.path.join(HERE, "..", "experiments", "move_predictor", "ermactually_games.pgn")

results = []
def check(name, ok, detail=""):
    results.append(ok)
    print(("PASS " if ok else "FAIL ") + name + ("  [%s]" % (detail,) if detail != "" else ""))

if not os.path.exists(BUILT):
    sys.exit("no built file at %s: run python tools/build_single_file.py first" % BUILT)
alone = os.path.join(tempfile.mkdtemp(), "Dvoretsky-Lab.html")
shutil.copy(BUILT, alone)
html = open(alone, encoding="utf-8").read()
check("build: no script or stylesheet is left as a reference", 'src="js/' not in html and 'href="css/' not in html)
# A build left from older sources (dist/ is not in git, so nothing else notices) is stale.
ROOT = os.path.join(HERE, "..")
stale = [rel for rel in __import__("re").findall(r'<script src="(js/[a-z/\-]+\.js)"></script>', open(os.path.join(ROOT, "index.html"), encoding="utf-8").read())
         if "<script>/* %s */\n%s\n</script>" % (rel, open(os.path.join(ROOT, rel), encoding="utf-8").read()) not in html]
if open(os.path.join(ROOT, "css", "app.css"), encoding="utf-8").read() not in html: stale.append("css/app.css")
check("build: every inlined file is the one in the working tree now", not stale, stale[:4])

with sync_playwright() as p:
    b = p.chromium.launch(channel=os.environ.get("PW_CHANNEL") or None)
    pg = b.new_page()
    errors, missing = [], []
    pg.on("pageerror", lambda e: errors.append(str(e)))
    pg.on("console", lambda m: m.type == "error" and errors.append(m.text))
    pg.on("requestfailed", lambda r: missing.append(r.url))
    pg.route("**/lichess.org/**", lambda r: r.fulfill(status=200, body="", content_type="application/x-ndjson"))
    pg.goto("file:///" + alone.replace("\\", "/"))
    pg.wait_for_timeout(800)
    check("load: the page runs, with every tab and panel", pg.evaluate("document.querySelectorAll('.tab').length") == 7
          and pg.evaluate("document.querySelectorAll('.panel.active').length") == 1)
    pg.set_input_files("#importFile", PGN); pg.wait_for_timeout(2500)
    n = pg.evaluate("document.querySelectorAll('#revGame option').length")
    check("load: a PGN imports and the games are measured", n == 33 and "games" in pg.inner_text("#rulerCaption"), n)
    pg.click("button.tab[data-tab=sparring]"); pg.select_option("#sparColor", "w"); pg.click("#sparStart")
    try:
        pg.wait_for_function("/depth/.test(document.querySelector('#sfNow').innerText)", timeout=40000); sf = True
    except Exception:
        sf = False
    check("load: the inlined Stockfish starts and reads the position", sf, " ".join(pg.inner_text("#sfNow").split())[:70])
    check("load: no errors, and nothing it asked for was missing", not errors and not missing, (errors + missing)[:3])
    b.close()

print("\n%d passed, %d failed" % (results.count(True), results.count(False)))
sys.exit(0 if all(results) else 1)
