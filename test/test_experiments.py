"""Checks for experiments/: the Elo calibration harness and the move predictor.

    python -m unittest discover -s test -p "test_experiments.py"     (from the repository root)

The calibration scripts drive the app in a browser against a native Stockfish. Here the
browser page is a stand-in kept by python-chess (it answers the same scripts the way the app
does: Chess.prototype.gameOver's names, a move list, a FEN), Stockfish is a stand-in told
what to play, and each game is chosen to end a known way, so each script's scoring and its
stops are checked. One check runs calibrate.py's page helpers on the real index.html in
Chromium, so the scripts they send are known to work on the app as it is. The move predictor
trains for real (PyTorch) on the sample games. Nothing reaches the network.
"""
import contextlib, importlib, io, json, math, os, re, runpy, shutil, sys, tempfile, unittest
from unittest import mock

import chess
import chess.engine

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, ".."))
CAL = os.path.join(ROOT, "experiments", "calibration")
sys.path.insert(0, CAL)
import calibrate as c   # noqa: E402  (the scripts import it by this name, so the tests share their module)


def rows_of(path):
    with open(path, encoding="utf-8") as f: return [json.loads(l) for l in f]


def bytes_of(path):
    with open(path, "rb") as f: return f.read()


def game_over(board):
    """What js/core.js's Chess.prototype.gameOver() answers for this position."""
    if not any(board.legal_moves): return "checkmate" if board.is_check() else "stalemate"
    if board.halfmove_clock >= 100: return "fifty"
    if board.is_repetition(3): return "repetition"
    if board.is_insufficient_material(): return "material"
    return None


def quiet(board, ply=None):
    """A legal move after which the game goes on (the first such, so a game is the same every run)."""
    for m in board.legal_moves:
        board.push(m)
        ok = any(board.legal_moves) and not board.is_repetition(3)
        board.pop()
        if ok: return m.uci()
    return None


def script(*ucis):
    """A side that plays these moves in turn, then quiet ones."""
    moves = list(ucis)
    return lambda board, ply=None: moves.pop(0) if moves else quiet(board)


FOOLS = ["f2f3", "e7e5", "g2g4", "d8h4"]   # mate in two for Black
SHUFFLE = ["g1f3", "g8f6", "f3g1", "f6g8"] * 2   # back where it started a third time: a repetition


class Page:
    """index.html as the calibration scripts see it. `mirror(board, ply)` and `engine(board)` give
    a UCI move or None; `over` replaces gameOver; `fen` may lie about the page's position."""
    def __init__(self, mirror=None, engine=None, over=game_over, fen=None, sampling=None, vs_random=None):
        self.mirror, self.engine, self.over, self.fen = mirror or quiet, engine or quiet, over, fen
        self.sampling, self.vs_random = sampling, vs_random
        self.board, self.games, self.calls, self.url = chess.Board(), [], [], None

    def goto(self, url): self.url = url
    def wait_for_selector(self, sel): self.calls.append(("wait", sel))

    def evaluate(self, js, arg=None):
        if "window.__mirror = new Sparring.Mirror" in js:
            self.elo = arg
            if "window.__game = new Chess()" in js:
                self.board = chess.Board(); self.games.append(arg)
            return None
        if "window.__engine = new Engine(); window.__game = new Chess();" in js:
            self.board = chess.Board(); return None
        if "await window.__mirror.chooseMove(g, ply)" in js:
            uci = self.mirror(self.board, arg)
            return None if uci is None else {"uci": uci, "san": "san:" + uci}
        if "window.__engine.rankAsync(window.__game, 3, 900)" in js:
            uci = self.engine(self.board)
            return None if uci is None else {"uci": uci, "san": "san:" + uci, "score": 30, "nodes": 1000}
        if "!!window.__game.move(u)" in js:
            m = chess.Move.from_uci(arg)
            if m not in self.board.legal_moves: return False
            self.board.push(m); return True
        if "window.__game.gameOver()" in js: return self.over(self.board)
        if "window.__game.fen()" in js: return self.fen(self.board) if self.fen else self.board.fen()
        if "window.__mirror.engine.rankAsync(g, 3, 600)" in js: return self.sampling(arg)
        if "Analysis.acplFromElo(elo)" in js: return 20.0
        if "mirrorWhite" in js: return self.vs_random(arg)
        raise AssertionError("a script the stand-in page does not know: " + js[:80])


class Browser:
    def __init__(self, page): self.page, self.closed, self.args = page, False, None
    def launch(self, args=None): self.args = args; return self
    def new_page(self): return self.page
    def close(self): self.closed = True


def playwright_with(page):
    browser = Browser(page)
    class P: chromium = browser
    @contextlib.contextmanager
    def sync_playwright():
        yield P()
    return sync_playwright, browser


class Played:
    def __init__(self, move): self.move = move


class Stockfish:
    """A native Stockfish stand-in: `play(board)` gives a UCI move or None, `score` the analysis."""
    def __init__(self, play=None, score=None):
        self.play_fn, self.score = play or quiet, score or chess.engine.Cp(0)
        self.options, self.limits = [], []
    def __enter__(self): return self
    def __exit__(self, *exc): return False
    def configure(self, opts): self.options.append(dict(opts))
    def play(self, board, limit):
        self.limits.append(limit)
        uci = self.play_fn(board)
        return Played(None if uci is None else chess.Move.from_uci(uci))
    def analyse(self, board, limit):
        self.limits.append(limit)
        return {"score": chess.engine.PovScore(self.score, chess.WHITE)}


def mirror_side(moves, mirror_white):
    """Split a game's moves into the mirror's and Stockfish's."""
    mine = moves[0::2] if mirror_white else moves[1::2]
    theirs = moves[1::2] if mirror_white else moves[0::2]
    return script(*mine), script(*theirs)


class Run:
    """Run a calibration script (or call into calibrate) with the stand-ins in place."""
    def __init__(self, test, page, sf):
        self.test, self.page, self.sf = test, page, sf

    def __enter__(self):
        sp, self.browser = playwright_with(self.page)
        self.out = io.StringIO()
        self.st = contextlib.ExitStack()
        self.st.enter_context(mock.patch("playwright.sync_api.sync_playwright", sp))
        self.st.enter_context(mock.patch.object(c, "sync_playwright", sp))
        self.popen = self.st.enter_context(mock.patch("chess.engine.SimpleEngine.popen_uci", return_value=self.sf))
        self.st.enter_context(contextlib.redirect_stdout(self.out))
        return self

    def __exit__(self, *exc):
        self.st.close()
        return False

    def script(self, name):
        runpy.run_path(os.path.join(CAL, name), run_name="__main__")


def saved(test, **values):
    """Set calibrate's globals for one test; put them back after."""
    for k, v in values.items():
        p = mock.patch.object(c, k, v); p.start(); test.addCleanup(p.stop)


class Calibrate(unittest.TestCase):
    def setUp(self):
        d = tempfile.mkdtemp(prefix="calibration-check-")
        self.addCleanup(shutil.rmtree, d, True)
        saved(self, RESULTS_PATH=c.Path(d) / "results.jsonl")

    def game(self, moves, mirror_white, sf_score=None, over=game_over):
        mirror, theirs = mirror_side(moves, mirror_white)
        page, sf = Page(mirror=mirror, over=over), Stockfish(play=theirs, score=sf_score)
        with Run(self, page, sf):
            r = c.play_one_game(page, sf, 1800, mirror_white)
        return r, page, sf

    def test_a_mate_counts_for_the_side_that_gave_it(self):
        r, page, sf = self.game(FOOLS, mirror_white=False)
        self.assertEqual(r, {"plies": 4, "termination": "checkmate", "mirror_score": 1.0})
        self.assertEqual(sf.options, [{"UCI_LimitStrength": True, "UCI_Elo": 1800}])
        self.assertEqual(page.games, [1800])
        r, _, _ = self.game(FOOLS, mirror_white=True)
        self.assertEqual(r["mirror_score"], 0.0)

    def test_every_draw_the_app_names_is_half_a_point(self):
        # a repetition was scored by Stockfish's opinion of the position before: it is a draw
        r, _, sf = self.game(SHUFFLE, mirror_white=True, sf_score=chess.engine.Cp(900))
        self.assertEqual((r["termination"], r["mirror_score"], r["plies"]), ("repetition", 0.5, 8))
        self.assertEqual(len(sf.options), 1)   # never asked to adjudicate
        for name in ("stalemate", "fifty", "material"):
            r, _, _ = self.game([], True, over=lambda b, n=name: n if b.move_stack else None)
            self.assertEqual((r["termination"], r["mirror_score"], r["plies"]), (name, 0.5, 1))
        self.assertEqual(set(c.DRAWS), {"stalemate", "fifty", "repetition", "material"})

    def test_a_game_cut_at_the_cap_is_scored_by_the_position(self):
        saved(self, MAX_PLIES=6)
        r, _, sf = self.game([], True, sf_score=chess.engine.Cp(400))
        self.assertEqual((r["termination"], r["plies"]), ("adjudicated", 6))
        self.assertEqual(r["mirror_score"], round(1 / (1 + 10 ** -1), 3))
        self.assertEqual(sf.options[-1], {"UCI_LimitStrength": False})   # judged at full strength
        self.assertEqual(sf.limits[-1].time, 0.5)
        r, _, _ = self.game([], False, sf_score=chess.engine.Cp(400))
        self.assertEqual(r["mirror_score"], round(1 - 1 / (1 + 10 ** -1), 3))

    def test_a_game_that_stops_early_is_scored_by_the_position(self):
        page, sf = Page(mirror=lambda b, ply: None), Stockfish(score=chess.engine.Cp(0))
        with Run(self, page, sf):
            r = c.play_one_game(page, sf, 1600, True)
        self.assertEqual(r, {"plies": 1, "termination": "unknown", "mirror_score": 0.5})
        page, sf = Page(), Stockfish(play=lambda b: None, score=chess.engine.Cp(0))
        with Run(self, page, sf):
            r = c.play_one_game(page, sf, 1600, True)
        self.assertEqual((r["plies"], r["termination"]), (2, "unknown"))

    def test_mates_in_the_adjudication(self):
        board = chess.Board()
        win = c.adjudicate_score(Stockfish(score=chess.engine.Mate(3)), board, True)
        loss = c.adjudicate_score(Stockfish(score=chess.engine.Mate(-3)), board, True)
        self.assertGreater(win, 0.9999); self.assertLess(loss, 0.0001)
        self.assertAlmostEqual(c.adjudicate_score(Stockfish(score=chess.engine.Mate(3)), board, False), 1 - win)
        self.assertEqual(c.adjudicate_score(Stockfish(), board, True), 0.5)

    def test_a_desynced_board_is_an_error(self):
        page = Page()
        with self.assertRaises(RuntimeError) as e: c.apply_uci_in_page(page, "e2e5")
        self.assertIn("page rejected move 'e2e5'", str(e.exception))

    def test_the_study_writes_one_line_a_game(self):
        saved(self, ELO_CHECKPOINTS=[1600, 2000], GAMES_PER_CHECKPOINT=2, MAX_PLIES=6)
        def move(board, ply=None):   # the second game at each Elo is fool's mate; the first runs to the cap
            n = len(board.move_stack)
            return FOOLS[n] if len(page.games) % 2 == 0 and n < 4 else quiet(board)
        def mirror(board, ply):
            if page.elo == 2000: raise RuntimeError("page crashed")
            return move(board)
        page, sf = Page(mirror=mirror), Stockfish(play=move)
        with Run(self, page, sf) as run:
            c.main()
        rows = rows_of(c.RESULTS_PATH)
        self.assertEqual([(r["elo"], r["game"], r["mirror_is_white"]) for r in rows],
                         [(1600, 0, True), (1600, 1, False), (2000, 0, True), (2000, 1, False)])
        self.assertEqual(rows[1]["termination"], "checkmate")   # as Black, fool's mate
        self.assertEqual(rows[1]["mirror_score"], 1.0)
        for r in rows[2:]:
            self.assertEqual((r["plies"], r["termination"], r["mirror_score"]), (None, "error: page crashed", None))
        out = run.out.getvalue()
        self.assertIn(">>> elo=1600: mirror scored", out)
        self.assertNotIn(">>> elo=2000", out)   # no game finished there: no score is made up
        self.assertEqual(run.popen.call_args.args, (str(c.STOCKFISH_PATH),))
        self.assertEqual((page.url, run.browser.args, run.browser.closed), (c.APP_URL, ["--no-sandbox"], True))

    def test_the_smoke_run_leaves_the_study_results_alone(self):
        study = os.path.join(CAL, "results.jsonl")
        before = bytes_of(study)
        keep = {k: getattr(c, k) for k in ("ELO_CHECKPOINTS", "GAMES_PER_CHECKPOINT", "MAX_PLIES", "RESULTS_PATH")}
        self.addCleanup(lambda: [setattr(c, k, v) for k, v in keep.items()])
        page, sf = Page(), Stockfish()
        with Run(self, page, sf) as run:
            run.script("smoke_test.py")
        self.assertEqual(bytes_of(study), before)
        self.assertEqual((c.ELO_CHECKPOINTS, c.GAMES_PER_CHECKPOINT, c.MAX_PLIES), ([1600], 2, 60))
        rows = rows_of(c.RESULTS_PATH)
        self.assertEqual(len(rows), 2)
        self.assertTrue(all(r["plies"] == 60 and r["termination"] == "adjudicated" for r in rows))
        os.remove(c.RESULTS_PATH)


class Debug(unittest.TestCase):
    def run_script(self, name, page, sf=None):
        with Run(self, page, sf or Stockfish()) as run:
            run.script(name)
        return run

    def test_one_game_traced(self):
        mirror, theirs = mirror_side(FOOLS, True)   # the script's mirror plays White
        run = self.run_script("debug_one_game.py", Page(mirror=mirror), Stockfish(play=theirs))
        out = run.out.getvalue()
        self.assertIn("ply 1 MIRROR (w): san=san:f2f3 uci=f2f3", out)
        self.assertIn("ply 2 STOCKFISH (b): uci=e7e5", out)
        self.assertIn("GAME OVER: checkmate", out)
        self.assertEqual(out.count("final python fen: rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3"), 1)

    def test_one_game_stops_on_each_fault(self):
        lies = Page(fen=lambda b: "8/8/8/8/8/8/8/8 w - - 0 1" if b.move_stack else b.fen())
        out = self.run_script("debug_one_game.py", lies).out.getvalue()
        self.assertIn("!!! DESYNC before ply 2", out)
        out = self.run_script("debug_one_game.py", Page(mirror=lambda b, ply: None)).out.getvalue()
        self.assertIn("mirror: no move returned", out)
        out = self.run_script("debug_one_game.py", Page(mirror=lambda b, ply: "e2e5")).out.getvalue()
        self.assertIn("!!! python-chess rejected mirror move e2e5", out)
        out = self.run_script("debug_one_game.py", Page(over=lambda b: None)).out.getvalue()
        self.assertIn("ply 30 STOCKFISH (b)", out)   # thirty plies, then the trace ends by itself
        self.assertNotIn("ply 31", out)

    def test_raw_engine(self):
        # the engine plays White here: fool's mate needs it to lose, so Stockfish gives the mate
        page = Page(engine=script("f2f3", "g2g4"))
        out = self.run_script("debug_raw_engine.py", page, Stockfish(play=script("e7e5", "d8h4"))).out.getvalue()
        self.assertIn("ply 1 ENGINE: san=san:f2f3 score=30 nodes=1000", out)
        self.assertIn("ply 4 STOCKFISH@1320: uci=d8h4", out)
        self.assertIn("GAME OVER: checkmate", out)
        out = self.run_script("debug_raw_engine.py", Page(engine=lambda b: None)).out.getvalue()
        self.assertIn("engine: no move", out)
        out = self.run_script("debug_raw_engine.py", Page(over=lambda b: None)).out.getvalue()
        self.assertIn("ply 80 STOCKFISH@1320", out)
        self.assertNotIn("ply 81", out)

    def test_mirror_sampling(self):
        rows = [{"san": "Nc3", "best": 40, "pickedScore": 14}, {"san": "a3", "best": 40, "pickedScore": None},
                {"san": "h3", "best": None, "pickedScore": 3}]
        page = Page(sampling=lambda fen: [dict(r) for r in rows])
        out = self.run_script("debug_mirror_sampling.py", page).out.getvalue()
        self.assertIn("targetElo=2400 -> Analysis.acplFromElo = 20.0 cp", out)
        losses = re.findall(r"real_loss\(best-picked\)= (\S+)", out)
        self.assertEqual(losses, ["26", "None", "None"])
        self.assertEqual(page.elo, 2400)

    def test_mirror_against_a_random_mover(self):
        seen = []
        page = Page(vs_random=lambda white: seen.append(white) or {"over": "checkmate", "ply": 31})
        out = self.run_script("debug_vs_random.py", page).out.getvalue()
        self.assertEqual(seen, [True, False, True, False])
        self.assertEqual(out.count("{'over': 'checkmate', 'ply': 31}"), 4)
        self.assertEqual(page.url, "http://localhost:8000/index.html")

    def test_sanity_check_scores_each_ending(self):
        # game 0 the mirror (White) is mated; 1 the mirror (Black) mates; 2 a repetition; 3 the cap
        def play(side):
            def move(board, ply=None):
                g = len(page.games) - 1
                if g in (0, 1):
                    seq = FOOLS
                elif g == 2:
                    seq = SHUFFLE
                else:
                    return quiet(board)
                n = len(board.move_stack)
                return seq[n] if n < len(seq) else quiet(board)
            return move
        page = Page(mirror=play("mirror"))
        sf = Stockfish(play=play("sf"), score=chess.engine.Cp(-400))
        saved(self, MAX_PLIES=10)
        out = self.run_script("sanity_check.py", page, sf).out.getvalue()
        lines = [l for l in out.splitlines() if l.startswith("game ")]
        self.assertEqual(lines[0], "game 0 mirror_white=True plies=4 term=checkmate mirror_score=0.0")
        self.assertEqual(lines[1], "game 1 mirror_white=False plies=4 term=checkmate mirror_score=1.0")
        self.assertEqual(lines[2], "game 2 mirror_white=True plies=8 term=repetition mirror_score=0.5")
        self.assertEqual(lines[3], "game 3 mirror_white=False plies=10 term=adjudicated mirror_score=%s"
                         % round(1 - 1 / (1 + 10 ** 1), 3))
        self.assertIn("Mirror@2400 vs Stockfish@1320(floor): %s/4" % (0.0 + 1.0 + 0.5 + round(1 - 1 / (1 + 10 ** 1), 3)), out)
        self.assertEqual(sf.options[0], {"UCI_LimitStrength": True, "UCI_Elo": 1320})

    def test_sanity_check_stops_when_a_side_has_no_move(self):
        page = Page(mirror=lambda b, ply: None if len(page.games) % 2 else quiet(b))
        sf = Stockfish(play=lambda b: None)
        out = self.run_script("sanity_check.py", page, sf).out.getvalue()
        lines = [l for l in out.splitlines() if l.startswith("game ")]
        self.assertEqual([l.split(" term=")[0] for l in lines],
                         ["game 0 mirror_white=True plies=1", "game 1 mirror_white=False plies=1",
                          "game 2 mirror_white=True plies=1", "game 3 mirror_white=False plies=1"])
        self.assertTrue(all("term=adjudicated mirror_score=0.5" in l for l in lines))


class CalibrateOnTheRealPage(unittest.TestCase):
    """calibrate.py's helpers send scripts to the app: run them on index.html as it is."""
    def test_helpers_on_index_html(self):
        from playwright.sync_api import sync_playwright
        with sync_playwright() as p:
            b = p.chromium.launch()
            try:
                pg = b.new_page()
                blocked = []
                pg.route(re.compile(r"^https?://"), lambda r: (blocked.append(r.request.url), r.abort()))
                pg.goto("file:///" + os.path.join(ROOT, "index.html").replace("\\", "/"))
                pg.wait_for_selector("text=Dvoretsky Lab")
                c.new_position(pg, 1600)
                board = chess.Board()
                res = c.mirror_move_uci(pg, 1)
                self.assertIn(chess.Move.from_uci(res["uci"]), board.legal_moves)
                self.assertEqual(res["san"], board.san(chess.Move.from_uci(res["uci"])))
                c.new_position(pg, 1600)
                for u in FOOLS:
                    self.assertIsNone(c.page_game_over(pg))
                    c.apply_uci_in_page(pg, u)
                self.assertEqual(c.page_game_over(pg), "checkmate")
                with self.assertRaises(RuntimeError): c.apply_uci_in_page(pg, "e2e4")
                # a promotion's piece reaches the page the way the mirror's move is spelt
                pg.evaluate("() => { window.__game = new Chess('7k/P7/8/8/8/8/8/K7 w - - 0 1'); }")
                c.apply_uci_in_page(pg, "a7a8n")
                self.assertEqual(pg.evaluate("() => window.__game.fen()").split()[0], "N6k/8/8/8/8/8/8/K7")
                self.assertEqual(blocked, [])
            finally:
                b.close()


# ---------------------------------------------------------------- experiments/move_predictor/train.py
def load_train():
    spec = importlib.util.spec_from_file_location("train_under_test", os.path.join(ROOT, "experiments", "move_predictor", "train.py"))
    m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
    return m


PGN = """[Event "a"]
[White "ermactually"]
[Black "someone"]

1. e4 e5 2. Nf3 Nc6 *

[Event "b"]
[White "a"]
[Black "b"]

1. d4 d5 *

[Event "c"]
[White "x"]
[Black "ErmActually"]
[Variant "Chess960"]
[FEN "bqnb1rkr/pp3ppp/3ppn2/2p5/5P2/P2P4/NPP1P1PP/BQ1BNRKR w HFhf - 2 9"]
[SetUp "1"]

9. g3 *

[Event "d"]
[White "x"]
[Black "ErmActually"]

1. c4 e5 2. Nc3 *
"""


class Train(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.t = load_train()
        cls.dir = tempfile.mkdtemp(prefix="train-check-")
        cls.pgn = os.path.join(cls.dir, "few.pgn")
        with open(cls.pgn, "w", encoding="utf-8") as f: f.write(PGN)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.dir, True)

    def test_the_pgn_is_found_from_any_folder(self):
        self.assertTrue(os.path.isfile(self.t.PGN_PATH))
        self.assertTrue(os.path.isabs(self.t.PGN_PATH))

    def test_only_the_players_own_standard_moves(self):
        plies = [(b.fen(), m.uci(), w, cont) for b, m, w, cont in self.t.iter_username_plies(self.pgn, "ermactually")]
        self.assertEqual([p[1:] for p in plies], [("e2e4", True, False), ("g1f3", True, True),
                                                  ("e7e5", False, False)])   # case ignored; Chess960 and others' games left out
        self.assertEqual(plies[2][0], "rnbqkbnr/pppppppp/8/8/2P5/8/PP1PPPPP/RNBQKBNR b KQkq - 0 1")
        examples, spans = self.t.load_examples(self.pgn, "ermactually")
        self.assertEqual(spans, [(0, 2), (2, 3)])
        self.assertEqual([a for _, a in examples], [12 * 64 + 28, 6 * 64 + 21, 12 * 64 + 28])   # e7e5 seen from Black is e2e4
        self.assertEqual(self.t.load_examples(self.pgn, "nobody"), ([], []))

    def test_encoding_is_from_the_movers_side(self):
        t = self.t.encode_board(chess.Board())
        self.assertEqual(tuple(t.shape), (12, 8, 8))
        self.assertEqual(int(t.sum()), 32)
        self.assertEqual(t[0, 1].tolist(), [1.0] * 8)    # white pawns on the second rank
        self.assertEqual(t[6 + 5, 7, 4].item(), 1.0)      # the black king on e8
        b = chess.Board(); b.push_uci("e2e4")
        self.assertTrue(self.t.encode_board(b.mirror()).equal(self.t.encode_board(chess.Board("rnbqkbnr/pppp1ppp/8/4p3/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"))))

    def test_legal_top_k(self):
        import torch
        b = chess.Board()
        logits = torch.zeros(4096)
        e4, d4, nf3 = 12 * 64 + 28, 11 * 64 + 27, 6 * 64 + 21
        logits[e4], logits[d4], logits[nf3] = 3.0, 2.0, 1.0
        logits[0] = 99.0   # a1a1: not a legal move, so it never counts
        self.assertTrue(self.t.legal_topk_hit(logits, b, e4, 1))
        self.assertFalse(self.t.legal_topk_hit(logits, b, d4, 1))
        self.assertTrue(self.t.legal_topk_hit(logits, b, nf3, 3))
        b.push_uci("e2e4")   # Black to move: e7e5 is scored as e2e4 from Black's side
        self.assertTrue(self.t.legal_topk_hit(logits, b, e4, 1))

    def test_too_few_examples_stops_before_training(self):
        out = io.StringIO()
        with mock.patch.object(self.t, "PGN_PATH", self.pgn), contextlib.redirect_stdout(out):
            self.t.main()
        self.assertEqual(out.getvalue().splitlines(), ["games contributing examples: 2", "total (ermactually-only) positions: 3",
                                                       "Too few examples to train anything meaningful -- stopping."])

    def test_trains_on_the_sample_games(self):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            runpy.run_path(os.path.join(ROOT, "experiments", "move_predictor", "train.py"), run_name="__main__")
        text = out.getvalue()
        self.assertIn("games contributing examples: 33", text)
        n = int(re.search(r"total \(ermactually-only\) positions: (\d+)", text).group(1))
        tr, va, held = map(int, re.search(r"train positions: (\d+) \| val positions: (\d+) \((\d+)/33 games held out\)", text).groups())
        self.assertEqual((tr + va, held), (n, 6))
        self.assertEqual(re.findall(r"epoch +(\d+)", text), ["10", "20", "30", "40"])
        losses = [float(x) for x in re.findall(r"train_loss=([\d.]+)", text)]
        self.assertLess(losses[-1], losses[0])   # it learns the training games
        self.assertLess(losses[0], math.log(4096))
        self.assertIn("legal-move-restricted val accuracy over %d positions:" % va, text)
        top1, top3 = map(float, re.search(r"top-1: ([\d.]+)%   top-3: ([\d.]+)%", text).groups())
        self.assertLessEqual(top1, top3)
        self.assertGreater(top3, 0)


if __name__ == "__main__":
    unittest.main()
