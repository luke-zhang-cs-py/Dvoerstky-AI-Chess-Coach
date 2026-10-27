"""Checks for the Python tools: the single-file build, the Stockfish installer, the vendored
engine's generator and the demo recorder.

    python -m unittest discover -s test -p "test_tools.py"     (from the repository root)

Nothing here reaches the network. Every download is answered from bytes made in the test, and
the demo recorder's browser has every http(s) request stopped and counted (none is expected).
The demo recorder drives the real page in Chromium (Playwright and Pillow needed), the
installer's handshake runs a real process, and the generator rebuilds the committed
js/vendor/stockfish-19-src.js byte for byte from the two files inside it.
"""
import base64, contextlib, hashlib, importlib.util, io, json, os, re, runpy, shutil, ssl, subprocess, sys, tarfile
import tempfile, unittest, zipfile
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, ".."))


def load(rel, name):
    """A file of the repository as a fresh module (its own globals, so a test can patch them)."""
    spec = importlib.util.spec_from_file_location(name, os.path.join(ROOT, rel))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def put(path, data=b""):
    with open(path, "wb") as f: f.write(data)


def got(path, binary=True):
    with REAL_OPEN(path, "rb" if binary else "r", **({} if binary else {"encoding": "utf-8", "newline": ""})) as f: return f.read()


def sha(data):
    return hashlib.sha256(data).hexdigest()


class FakeResponse:
    def __init__(self, body): self.body = body
    def __enter__(self): return self
    def __exit__(self, *exc): return False
    def read(self): return self.body


def tmpdir(test):
    d = tempfile.mkdtemp(prefix="tools-check-")
    test.addCleanup(shutil.rmtree, d, True)
    return d


# ---------------------------------------------------------------- tools/build_single_file.py
BUILD = os.path.join(ROOT, "tools", "build_single_file.py")
REAL_OPEN = io.open


class Build(unittest.TestCase):
    """The build runs as a script. Its reads can be given other content and its write is caught,
    so a test sees the page it would write and the repository is not touched."""

    def build(self, argv=(), files=None):
        files = {os.path.normpath(os.path.join(ROOT, k)): v for k, v in (files or {}).items()}
        writes = {}

        class Caught(io.StringIO):
            def __init__(self, path): super().__init__(); self.path = path
            def close(self): writes[self.path] = self.getvalue(); super().close()

        def fake_open(path, mode="r", *a, **kw):
            path = os.path.normpath(path)
            if "w" in mode: return Caught(path)
            if path in files: return io.StringIO(files[path])
            return REAL_OPEN(path, mode, *a, **kw)

        out = io.StringIO()
        with mock.patch("io.open", fake_open), mock.patch("os.makedirs") as mk, \
                mock.patch.object(sys, "argv", [BUILD] + list(argv)), contextlib.redirect_stdout(out):
            try:
                runpy.run_path(BUILD, run_name="__main__")
                err = None
            except SystemExit as e:
                err = str(e)
        return writes, err, out.getvalue(), mk

    def test_every_script_and_the_stylesheet_inlined(self):
        target = os.path.join(tempfile.gettempdir(), "x", "built.html")
        writes, err, out, mk = self.build([target])
        self.assertIsNone(err)
        page = writes[os.path.normpath(target)]
        index = got(os.path.join(ROOT, "index.html"), False)
        scripts = re.findall(r'<script src="(js/[a-z0-9/\-]+\.js)"></script>', index)
        self.assertGreater(len(scripts), 10)
        for rel in scripts:
            body = got(os.path.join(ROOT, rel), False)
            self.assertIn("<script>/* %s */\n%s\n</script>" % (rel, body), page)
        self.assertIn("<style>\n" + got(os.path.join(ROOT, "css", "app.css"), False) + "\n</style>", page)
        self.assertNotIn('src="js/', page)
        self.assertNotIn('href="css/', page)
        self.assertIn("%d scripts inlined" % len(scripts), out)
        mk.assert_called_once_with(os.path.dirname(os.path.abspath(target)), exist_ok=True)

    def test_default_output_is_dist(self):
        writes, err, out, _ = self.build()
        self.assertIsNone(err)
        self.assertEqual(list(writes), [os.path.join(ROOT, "dist", "Dvoretsky-Lab.html")])

    def test_a_stylesheet_with_url_is_refused(self):
        writes, err, _, _ = self.build(["o.html"], {"css/app.css": "body{background:url(x.png)}"})
        self.assertIn("external url()", err)
        self.assertEqual(writes, {})

    def test_not_exactly_one_stylesheet_link_is_refused(self):
        link = '<link rel="stylesheet" href="css/app.css">'
        for page in ("<html></html>", link + link):
            writes, err, _, _ = self.build(["o.html"], {"index.html": page})
            self.assertIn("exactly one stylesheet link", err)
            self.assertEqual(writes, {})

    def test_a_script_holding_a_closing_tag_is_refused(self):
        page = '<link rel="stylesheet" href="css/app.css"><script src="js/board.js"></script>'
        writes, err, _, _ = self.build(["o.html"], {"index.html": page, "js/board.js": "var s = '</SCRIPT>';"})
        self.assertEqual(err, "js/board.js contains </script, which would end the inlined tag early")
        self.assertEqual(writes, {})

    def test_a_reference_left_behind_is_refused(self):
        # an upper-case name is not one the build inlines, so it would be left pointing at js/
        page = '<link rel="stylesheet" href="css/app.css"><script src="js/Board.js"></script>'
        writes, err, _, _ = self.build(["o.html"], {"index.html": page})
        self.assertEqual(err, "a script or stylesheet reference was left un-inlined")
        self.assertEqual(writes, {})


# ---------------------------------------------------------------- tools/install_stockfish.py
class Installer(unittest.TestCase):
    def setUp(self):
        self.m = load("tools/install_stockfish.py", "install_stockfish_under_test")
        self.home = os.path.join(tmpdir(self), "stockfish-19")
        self.syz = os.path.join(tmpdir(self), "syzygy-34")
        for k, v in (("HOME", self.home), ("SYZYGY_HOME", self.syz)):
            p = mock.patch.object(self.m, k, v); p.start(); self.addCleanup(p.stop)

    def test_fetch_keeps_verifying_but_drops_only_the_strict_profile(self):
        seen = {}
        def urlopen(url, timeout, context):
            seen.update(url=url, timeout=timeout, ctx=context)
            return FakeResponse(b"bytes")
        with mock.patch("urllib.request.urlopen", urlopen):
            self.assertEqual(self.m.fetch("https://example.invalid/a"), b"bytes")
        self.assertEqual((seen["url"], seen["timeout"]), ("https://example.invalid/a", 300))
        self.assertEqual(seen["ctx"].verify_flags & ssl.VERIFY_X509_STRICT, 0)
        self.assertEqual(seen["ctx"].verify_mode, ssl.CERT_REQUIRED)
        self.assertTrue(seen["ctx"].check_hostname)

    def test_asset_by_system_and_processor(self):
        for system, machine, want in (("Windows", "AMD64", "stockfish-windows-x86-64-universal.zip"),
                                      ("Linux", "aarch64", "stockfish-linux-arm64-universal.tar.gz"),
                                      ("Darwin", "arm64", "stockfish-macos-universal.tar.gz"),
                                      ("Linux", "riscv64", "stockfish-linux-riscv64-universal.tar.gz")):
            with mock.patch("platform.system", return_value=system), mock.patch("platform.machine", return_value=machine):
                name, digest = self.m.asset()
            self.assertEqual(name, want)
            self.assertRegex(digest, "^[0-9a-f]{64}$")
        with mock.patch("platform.system", return_value="Plan9"), mock.patch("platform.machine", return_value="MIPS"):
            with self.assertRaises(SystemExit) as e: self.m.asset()
        self.assertIn("plan9/mips", str(e.exception))

    def test_handshake(self):
        # a real process that is not Stockfish: Python reading "uci" as a program prints nothing to stdout
        self.assertFalse(self.m.answers_as_19(sys.executable))
        self.assertFalse(self.m.answers_as_19(os.path.join(self.home, "no-such-binary")))   # OSError
        done = lambda out: mock.patch("subprocess.run", return_value=subprocess.CompletedProcess([], 0, out, ""))
        with done("Stockfish 19 by the Stockfish developers\nid name Stockfish 19\nuciok\n"):
            self.assertTrue(self.m.answers_as_19("sf"))
        with done("id name Stockfish 18\nuciok\n"):
            self.assertFalse(self.m.answers_as_19("sf"))
        with mock.patch("subprocess.run", side_effect=subprocess.TimeoutExpired("sf", 30)):
            self.assertFalse(self.m.answers_as_19("sf"))
        with mock.patch("subprocess.run", return_value=subprocess.CompletedProcess([], 0, "", "")) as run:
            self.m.answers_as_19("sf")
        self.assertEqual(run.call_args.kwargs["input"], "uci\nquit\n")

    def test_installed_is_only_a_binary_that_answers(self):
        self.assertIsNone(self.m.installed())   # no folder yet
        os.makedirs(os.path.join(self.home, "stockfish-folder"))
        for name in ("stockfish-a", "stockfish-b", "stockfish-c.zip", "stockfish-d.tar.gz", "notes.txt"):
            put(os.path.join(self.home, name))
        asked = []
        def answers(path):
            asked.append(os.path.basename(path)); return path.endswith("stockfish-b")
        with mock.patch.object(self.m, "answers_as_19", answers):
            self.assertEqual(self.m.installed(), os.path.join(self.home, "stockfish-b"))
        self.assertEqual(asked, ["stockfish-a", "stockfish-b"])   # archives, folders and other files are not run
        with mock.patch.object(self.m, "answers_as_19", return_value=False):
            self.assertIsNone(self.m.installed())

    def archive(self, kind, names):
        buf = io.BytesIO()
        if kind == "zip":
            with zipfile.ZipFile(buf, "w") as z:
                z.writestr("stockfish/", "")
                for n in names: z.writestr(n, "body of " + n)
        else:
            with tarfile.open(fileobj=buf, mode="w:gz") as t:
                d = tarfile.TarInfo("stockfish"); d.type = tarfile.DIRTYPE; t.addfile(d)
                for n in names:
                    data = ("body of " + n).encode(); info = tarfile.TarInfo(n); info.size = len(data)
                    t.addfile(info, io.BytesIO(data))
        return buf.getvalue()

    RELEASE = ["stockfish/stockfish-x86-64.exe", "stockfish/src/stockfish.cpp", "stockfish/README.md",
               "stockfish/stockfish-notes.txt", "stockfish/stockfish.nnue", "stockfish/wiki/Home.md", "stockfish/AUTHORS"]

    def test_unpack_takes_the_binary_alone(self):
        for kind, name in (("zip", "a.zip"), ("tar", "a.tar.gz")):
            out = self.m.unpack(name, self.archive(kind, self.RELEASE))
            self.assertEqual(out, os.path.join(self.home, "stockfish-x86-64.exe"))
            self.assertEqual(got(out, False), "body of stockfish/stockfish-x86-64.exe")
            self.assertEqual(os.listdir(self.home), ["stockfish-x86-64.exe"])
            if os.name != "nt": self.assertTrue(os.stat(out).st_mode & 0o111)
            shutil.rmtree(self.home)

    def test_unpack_wants_exactly_one_binary(self):
        with self.assertRaises(SystemExit) as e: self.m.unpack("a.zip", self.archive("zip", ["stockfish/README.md"]))
        self.assertIn("found: none", str(e.exception))
        two = ["stockfish/stockfish-a", "stockfish/stockfish-b"]
        with self.assertRaises(SystemExit) as e: self.m.unpack("a.tar.gz", self.archive("tar", two))
        self.assertIn(str(two), str(e.exception))
        self.assertFalse(os.path.exists(self.home))

    def test_install_does_nothing_once_installed(self):
        out = io.StringIO()
        with mock.patch.object(self.m, "installed", return_value="/sf/stockfish"), \
                mock.patch.object(self.m, "fetch") as fetch, contextlib.redirect_stdout(out):
            self.assertEqual(self.m.install(), "/sf/stockfish")
        fetch.assert_not_called()
        self.assertEqual(out.getvalue(), "/sf/stockfish\n")

    def install(self, answers, digest=None, stale=True):
        data = self.archive("tar", self.RELEASE)
        if stale: os.makedirs(self.home); put(os.path.join(self.home, "stockfish-stale"))
        out, err = io.StringIO(), io.StringIO()
        with mock.patch.object(self.m, "installed", return_value=None), \
                mock.patch.object(self.m, "asset", return_value=("sf.tar.gz", digest or sha(data))), \
                mock.patch.object(self.m, "fetch", return_value=data) as fetch, \
                mock.patch.object(self.m, "answers_as_19", return_value=answers), \
                contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            try: return self.m.install(), out.getvalue(), err.getvalue(), fetch
            except SystemExit as e: return e, out.getvalue(), err.getvalue(), fetch

    def test_install_downloads_checks_and_replaces_a_stale_folder(self):
        path, out, err, fetch = self.install(True)
        fetch.assert_called_once_with(self.m.RELEASE + "sf.tar.gz")
        self.assertEqual(path, os.path.join(self.home, "stockfish-x86-64.exe"))
        self.assertEqual(os.listdir(self.home), ["stockfish-x86-64.exe"])   # the stale binary is gone
        self.assertEqual(out, path + "\n")
        self.assertIn("Downloading sf.tar.gz", err)

    def test_install_into_no_folder_yet(self):
        path, out, _, _ = self.install(True, stale=False)
        self.assertEqual(path, os.path.join(self.home, "stockfish-x86-64.exe"))
        self.assertEqual(os.listdir(self.home), ["stockfish-x86-64.exe"])

    def test_install_refuses_a_wrong_hash_before_unpacking(self):
        e, _, _, _ = self.install(True, digest="0" * 64)
        self.assertIn("does not match the release's SHA-256", str(e))
        self.assertEqual(os.listdir(self.home), ["stockfish-stale"])   # nothing was touched

    def test_install_removes_a_binary_that_fails_the_handshake(self):
        e, _, _, _ = self.install(False)
        self.assertIn("did not answer the UCI handshake as Stockfish 19", str(e))
        self.assertFalse(os.path.exists(self.home))

    TABLES = {"KvK.rtbw": b"wdl table", "KvK.rtbz": b"dtz table"}

    def tables(self):
        return mock.patch.object(self.m, "SYZYGY", {n: sha(b) for n, b in self.TABLES.items()})

    def test_syzygy_only_when_every_file_matches(self):
        with self.tables():
            self.assertIsNone(self.m.syzygy())
            os.makedirs(self.syz)
            for n, b in self.TABLES.items(): put(os.path.join(self.syz, n), b)
            self.assertEqual(self.m.syzygy(), self.syz)
            put(os.path.join(self.syz, "KvK.rtbz"), b"damaged")
            self.assertIsNone(self.m.syzygy())
        self.assertEqual(self.m.sha256_of(os.path.join(self.syz, "KvK.rtbw")), sha(b"wdl table"))

    def test_install_syzygy_fetches_only_what_is_missing(self):
        os.makedirs(self.syz); put(os.path.join(self.syz, "KvK.rtbw"), self.TABLES["KvK.rtbw"])
        urls = []
        def fetch(url):
            urls.append(url); return self.TABLES[url.rsplit("/", 1)[1]]
        with self.tables(), mock.patch.object(self.m, "fetch", fetch), contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(self.m.install_syzygy(), self.syz)
            self.assertEqual(urls, [self.m.SYZYGY_URL % "dtz" + "KvK.rtbz"])
            self.assertEqual(self.m.syzygy(), self.syz)
            self.assertEqual(self.m.install_syzygy(), self.syz)   # all there: nothing fetched
        self.assertEqual(len(urls), 1)

    def test_install_syzygy_keeps_no_file_that_fails_its_hash(self):
        urls = []
        def fetch(url):
            urls.append(url); return b"not the table"
        with self.tables(), mock.patch.object(self.m, "fetch", fetch), contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit) as e: self.m.install_syzygy()
        self.assertEqual(str(e.exception), "KvK.rtbw does not match its pinned SHA-256; it was not kept.")
        self.assertEqual(urls, [self.m.SYZYGY_URL % "wdl" + "KvK.rtbw"])
        self.assertEqual(os.listdir(self.syz), [])

    def test_command_line(self):
        def run(argv, **patches):
            out = io.StringIO()
            with contextlib.ExitStack() as st:
                mocks = {k: st.enter_context(mock.patch.object(self.m, k, **v)) for k, v in patches.items()}
                st.enter_context(contextlib.redirect_stdout(out))
                try: self.m.main(argv); err = None
                except SystemExit as e: err = str(e)
            return out.getvalue(), err, mocks
        self.assertEqual(run(["--path"], installed={"return_value": "/sf"})[:2], ("/sf\n", None))
        self.assertIn("Stockfish 19 is not installed", run(["--path"], installed={"return_value": None})[1])
        self.assertEqual(run(["--syzygy"], syzygy={"return_value": "/tb"})[:2], ("/tb\n", None))
        self.assertIn("Syzygy tables are not installed", run(["--syzygy"], syzygy={"return_value": None})[1])
        _, err, mocks = run([], install={}, install_syzygy={})
        self.assertIsNone(err)
        mocks["install"].assert_called_once_with(); mocks["install_syzygy"].assert_called_once_with()


# ---------------------------------------------------------------- js/vendor/make_stockfish_src.py
VENDORED = os.path.join(ROOT, "js", "vendor", "stockfish-19-src.js")


def vendored_files():
    """The glue and the .wasm, read back out of the committed stockfish-19-src.js."""
    src = got(VENDORED, False)
    glue = json.loads(re.search(r'^  root\.STOCKFISH_SOURCE = (".*");$', src, re.M).group(1))
    wasm = base64.b64decode(re.search(r'^  root\.STOCKFISH_WASM = "([A-Za-z0-9+/=]*)";$', src, re.M).group(1))
    return src, glue.encode("utf-8"), wasm


def tarball(members):
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as t:
        for name, data in members.items():
            info = tarfile.TarInfo(name); info.size = len(data); t.addfile(info, io.BytesIO(data))
    raw = buf.getvalue()
    return raw, "sha512-" + base64.b64encode(hashlib.sha512(raw).digest()).decode()


class Generator(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.src, cls.glue, cls.wasm = vendored_files()

    def setUp(self):
        self.m = load("js/vendor/make_stockfish_src.py", "make_stockfish_src_under_test")
        self.dir = tmpdir(self)
        p = mock.patch.object(self.m, "OUT", os.path.join(self.dir, "stockfish-19-src.js")); p.start(); self.addCleanup(p.stop)

    def run_main(self, raw, integrity, argv=True):
        path = os.path.join(self.dir, "stockfish.tgz")
        put(path, raw)
        out = io.StringIO()
        with mock.patch.object(self.m, "INTEGRITY", integrity), \
                mock.patch.object(sys, "argv", ["make", path] if argv else ["make"]), contextlib.redirect_stdout(out):
            try: self.m.main(); return None, out.getvalue()
            except SystemExit as e: return str(e), out.getvalue()

    def test_the_committed_files_are_the_pinned_ones(self):
        self.assertEqual(sha(self.glue), self.m.FILES[self.m.GLUE])
        self.assertEqual(sha(self.wasm), self.m.FILES[self.m.WASM])
        self.assertEqual(len(self.glue), 28230)
        self.assertEqual(len(self.wasm), 1845971)

    def test_rebuilds_the_committed_script_byte_for_byte(self):
        raw, integrity = tarball({self.m.GLUE: self.glue, self.m.WASM: self.wasm, "package/README.md": b"other"})
        err, out = self.run_main(raw, integrity)
        self.assertIsNone(err)
        self.assertEqual(got(self.m.OUT), self.src.encode("utf-8"))
        self.assertIn("wrote stockfish-19-src.js: %d bytes" % len(self.src.encode()), out)
        self.assertIn("sha256 " + sha(self.src.encode()), out)

    def test_downloads_when_no_tarball_is_given(self):
        raw, integrity = tarball({self.m.GLUE: self.glue, self.m.WASM: self.wasm})
        seen = {}
        def urlopen(url, context, timeout):
            seen.update(url=url, timeout=timeout, strict=context.verify_flags & ssl.VERIFY_X509_STRICT)
            return FakeResponse(raw)
        with mock.patch("urllib.request.urlopen", urlopen):
            err, _ = self.run_main(b"", integrity, argv=False)
        self.assertIsNone(err)
        self.assertEqual(seen, {"url": self.m.TARBALL, "timeout": 120, "strict": 0})
        self.assertEqual(got(self.m.OUT), self.src.encode("utf-8"))

    def test_a_tarball_that_is_not_the_published_one_is_refused(self):
        raw, _ = tarball({self.m.GLUE: self.glue, self.m.WASM: self.wasm})
        err, _ = self.run_main(raw, self.m.INTEGRITY)   # the real pin: these bytes are not npm's tarball
        self.assertIn("is not stockfish@19.0.1 as published", err)
        self.assertFalse(os.path.exists(self.m.OUT))

    def test_a_changed_file_is_refused(self):
        raw, integrity = tarball({self.m.GLUE: self.glue, self.m.WASM: self.wasm + b"\0"})
        err, _ = self.run_main(raw, integrity)
        self.assertEqual(err, "%s: sha256 %s, expected %s" % (self.m.WASM, sha(self.wasm + b"\0"), self.m.FILES[self.m.WASM]))
        self.assertFalse(os.path.exists(self.m.OUT))

    def test_a_glue_that_would_close_the_script_tag_is_refused(self):
        glue = b"var a = '</Script>';"
        raw, integrity = tarball({self.m.GLUE: glue, self.m.WASM: self.wasm})
        with mock.patch.dict(self.m.FILES, {self.m.GLUE: sha(glue)}):
            err, _ = self.run_main(raw, integrity)
        self.assertIn("the glue contains </script", err)
        self.assertFalse(os.path.exists(self.m.OUT))

    def test_closing_tags_in_the_string_are_escaped(self):
        glue = b"var a = '</div>';"
        raw, integrity = tarball({self.m.GLUE: glue, self.m.WASM: b"\0asm"})
        with mock.patch.dict(self.m.FILES, {self.m.GLUE: sha(glue), self.m.WASM: sha(b"\0asm")}):
            err, _ = self.run_main(raw, integrity)
        self.assertIsNone(err)
        out = got(self.m.OUT, False)
        self.assertIn('root.STOCKFISH_SOURCE = "var a = \'<\\/div>\';";', out)
        self.assertIn('root.STOCKFISH_WASM = "%s";' % base64.b64encode(b"\0asm").decode(), out)


# ---------------------------------------------------------------- tools/record_demo.py
class NoNetwork:
    """sync_playwright, with every page made by the script stopping (and counting) any http(s) request."""
    def __init__(self, real, blocked): self.real, self.blocked, self.events = real, blocked, []

    def __call__(self):
        outer = self
        class Browser:
            def __init__(self, b): self.b = b
            def new_page(self, **kw):
                pg = self.b.new_page(**kw)
                pg.route(re.compile(r"^https?://"), lambda r: (outer.blocked.append(r.request.url), r.abort()))
                pg.on("crash", lambda _: outer.events.append("the page crashed"))
                pg.on("close", lambda _: outer.events.append("the page closed"))
                pg.on("pageerror", lambda e: outer.events.append("page error: %s" % e))
                return pg
            def close(self): self.b.close()
        class Chromium:
            def __init__(self, c): self.c = c
            def launch(self, **kw): return Browser(self.c.launch(**kw))
        class P:
            def __init__(self, p): self.chromium = Chromium(p.chromium)
        class Ctx:
            def __enter__(self):
                self.cm = outer.real(); return P(self.cm.__enter__())
            def __exit__(self, *exc): return self.cm.__exit__(*exc)
        return Ctx()


class Demo(unittest.TestCase):
    def test_records_the_demo_from_the_real_page(self):
        import playwright.sync_api
        from PIL import Image
        script = os.path.join(ROOT, "tools", "record_demo.py")
        out_gif = os.path.join(tmpdir(self), "sub", "demo.gif")
        blocked, out = [], io.StringIO()
        guard = NoNetwork(playwright.sync_api.sync_playwright, blocked)
        with mock.patch.object(playwright.sync_api, "sync_playwright", guard), \
                mock.patch.object(sys, "argv", [script, out_gif]), contextlib.redirect_stdout(out):
            try:
                g = runpy.run_path(script, run_name="__main__")
            except Exception as e:   # say what the page did before it went
                raise AssertionError("the recorder stopped: %s; page events: %s" % (e, guard.events)) from e
        self.assertEqual([e for e in guard.events if e != "the page closed"], [])
        self.assertEqual(blocked, [])
        self.assertEqual(g["OUT"], out_gif)
        # three windows on the Strength tab, the sparring board, then each of three moves before and after grading
        self.assertEqual(len(g["frames"]), 10)
        with Image.open(out_gif) as im:
            self.assertEqual(im.n_frames, 10)
            self.assertEqual(im.width, 960)
            self.assertEqual(im.height, round(1060 * 960 / 1280))
            durations = []
            for i in range(im.n_frames):
                im.seek(i); durations.append(im.info["duration"])
        self.assertEqual(durations, [1600, 1300, 1300, 1400, 900, 1500, 900, 1500, 900, 3200])
        self.assertEqual(out.getvalue().strip(), "wrote %s: 10 frames, %d KB" % (out_gif, os.path.getsize(out_gif) // 1024))
        # The script waits for Stockfish to grade each move (a timeout would have failed it), and
        # the sample games were imported: the first frame was taken on the Strength tab with them.


if __name__ == "__main__":
    unittest.main()
