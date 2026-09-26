"""Record docs/demo.gif by driving the real page: nothing is staged but the games.

    pip install playwright pillow && playwright install chromium
    python tools/record_demo.py

It imports the sample PGN (experiments/move_predictor/ermactually_games.pgn),
moves the analysis window on the Strength tab, then plays a short sparring game
and waits for Stockfish to grade each move. One browser for the whole take, with
real waits: every frame is what the page showed at that moment.
"""
import io, os
from PIL import Image
from playwright.sync_api import sync_playwright

ROOT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
APP = os.path.join(ROOT, "index.html")
PGN = os.path.join(ROOT, "experiments", "move_predictor", "ermactually_games.pgn")
OUT = os.path.join(ROOT, "docs", "demo.gif")
WIDTH = 960   # frames are scaled to this width

frames = []
def show_verdicts(pg):
    # the board is sticky, so scrolling the verdicts into view keeps it on screen, as it would for you
    pg.evaluate("""() => { const r = document.querySelector('#sfLog').getBoundingClientRect();
      window.scrollBy(0, Math.max(0, r.bottom - innerHeight + 24)); }""")
    pg.wait_for_timeout(350)

def grab(pg, ms, clip=None):
    img = Image.open(io.BytesIO(pg.screenshot(clip=clip))).convert("RGB")
    img = img.resize((WIDTH, round(img.height * WIDTH / img.width)), Image.LANCZOS)
    frames.append((img, ms))

def slide(pg, i):
    pg.evaluate("""i => { const r = document.querySelector('#winDays'); r.value = String(i);
      r.dispatchEvent(new Event('input')); r.dispatchEvent(new Event('change')); }""", i)
    pg.wait_for_timeout(700)

def play(pg, a, b):
    n = pg.evaluate("document.querySelectorAll('#sparMoves button').length")
    pg.click('#sparBoard [data-sq="%s"]' % a); pg.wait_for_timeout(250)
    pg.click('#sparBoard [data-sq="%s"]' % b)
    pg.wait_for_function("document.querySelectorAll('#sparMoves button').length >= %d" % (n + 2), timeout=30000)

def graded(pg, n):
    pg.wait_for_function("""n => { const rows = [...document.querySelectorAll('.sf-log tbody tr')];
      return rows.length >= n && rows.slice(0, n).every(r => /good|inaccuracy|mistake|blunder/.test(r.innerText)); }""",
      arg=n, timeout=90000)

with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_page(viewport={"width": 1280, "height": 1060})
    pg.goto("file:///" + APP.replace("\\", "/")); pg.wait_for_timeout(500)
    pg.set_input_files("#importFile", PGN); pg.wait_for_timeout(2500)
    pg.evaluate("document.querySelector('#flash').classList.add('hidden')")

    shot = {"x": 0, "y": 0, "width": 1280, "height": 1060}   # one size for every frame: a GIF keeps the first one's
    grab(pg, 1600, shot)                 # all time
    slide(pg, 6); grab(pg, 1300, shot)   # last year
    slide(pg, 2); grab(pg, 1300, shot)   # last 30 days
    slide(pg, 9)

    pg.click("button.tab[data-tab=sparring]")
    pg.uncheck("#sparCoach")   # a real setting: with live advice off, the Stockfish reader sits beside the board
    pg.select_option("#sparColor", "w"); pg.click("#sparStart")
    pg.wait_for_function("document.querySelector('.sf-eval')", timeout=60000)
    clip = shot
    grab(pg, 1400, clip)
    for i, (a, c) in enumerate([("e2", "e4"), ("g1", "f3"), ("f1", "c4")]):
        pg.wait_for_function("!document.querySelector('#sparStatus').innerText.includes('thinking')", timeout=30000)
        play(pg, a, c)
        grab(pg, 900, clip)
        graded(pg, 2 * (i + 1))
        pg.wait_for_timeout(600)
        show_verdicts(pg)
        grab(pg, 1500 if i < 2 else 3200, clip)
    b.close()

# one shared palette keeps the colours steady from frame to frame
base = frames[0][0].quantize(colors=128, method=Image.Quantize.MEDIANCUT)
pal = [f.quantize(palette=base, dither=Image.Dither.NONE) for f, _ in frames]
os.makedirs(os.path.dirname(OUT), exist_ok=True)
pal[0].save(OUT, save_all=True, append_images=pal[1:], duration=[ms for _, ms in frames], loop=0, optimize=True)
print("wrote %s: %d frames, %d KB" % (os.path.relpath(OUT, ROOT), len(frames), os.path.getsize(OUT) // 1024))
