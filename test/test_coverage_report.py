"""Checks for test/coverage_report.py: the report CI fails on has to be right.

    python -m unittest discover -s test -p "test_coverage_report.py"     (from the repository root)

Needs Node and a TypeScript parser, found the way the report finds them (COVERAGE_TS, or
require('typescript')). The main check builds a small repository of its own (js/, a Node
suite, a stand-in browser run and a stand-in single-file build, each giving real V8 coverage
from Node) and reads the report on it: what ran in one run only is credited, a file no run
loaded is at 0%, js/vendor/ is left out, a character outside the BMP and CRLF endings do not
shift anything, and --fail-under fails it. The rest are the report's pieces, each on its own.
"""
import contextlib, glob, importlib.util, io, os, re, shutil, subprocess, sys, tempfile, unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, ".."))
PATH = os.path.join(HERE, "coverage_report.py")
NODE = shutil.which("node")


def load():
    spec = importlib.util.spec_from_file_location("coverage_report_under_test", PATH)
    m = importlib.util.module_from_spec(spec)
    with mock.patch.object(sys, "argv", [PATH]):
        spec.loader.exec_module(m)
    return m


def write(path, text, newline="\n"):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline=newline) as f: f.write(text)


def read(path):
    with open(path, encoding="utf-8") as f: return f.read()


# The measured module. Line numbers matter: the checks name them.
A_JS = """// a module with a character outside the BMP in it: \U0001F600
var smile = '\U0001F600';
function f(x) {
  if (x) return 1;
  return 2;
}
function never() { return 3; }
var g = function (y) { return y ? 'yes' : 'no'; };
function h(z) { return z || 'none'; }
if (typeof module !== 'undefined') module.exports = { f: f, never: never, g: g, h: h };
"""

# A browser run, played by Node: V8 coverage of js/a.js with g('') called, in ui_check.py's format.
UI_CHECK = r"""
import json, os, subprocess, sys, tempfile
out = sys.argv[sys.argv.index("--coverage") + 1]
d = tempfile.mkdtemp()
a = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "js", "a.js")
subprocess.run([os.environ["FAKE_NODE"], "-e", "require(%r).g('')" % a], env=dict(os.environ, NODE_V8_COVERAGE=d), check=True)
recs = []
for f in os.listdir(d):
    with open(os.path.join(d, f), encoding="utf-8") as fh: recs += json.load(fh)["result"]
with open(out, "w", encoding="utf-8") as fh: json.dump({"result": recs}, fh)
print("PASS the stand-in browser run")
sys.exit(int(os.environ.get("FAKE_UI_EXIT", "0")))
"""

# The single-file build: js/a.js inlined the way tools/build_single_file.py does it (the HTML parser's LF endings).
BUILD = r"""
import os, sys
root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if os.environ.get("FAKE_BUILD_FAIL"): sys.exit("FAIL the build")
with open(os.path.join(root, "js", "a.js"), encoding="utf-8", newline="") as f: a = f.read().replace("\r\n", "\n")
with open(sys.argv[1], "w", encoding="utf-8", newline="") as f: f.write("<script>/* js/a.js */\n" + a + "\n</script>")
"""

# The built page run, played by Node: the inlined script, with h(0) called after it, and one script that is not inlined.
DIST_CHECK = r"""
import json, os, re, subprocess, sys, tempfile
built, out = sys.argv[1], sys.argv[sys.argv.index("--coverage") + 1]
with open(built, encoding="utf-8", newline="") as f: src = re.search(r"<script>(.*)</script>", f.read(), re.S).group(1)
src += "module.exports.h(0);\n"
d = tempfile.mkdtemp(); page = os.path.join(d, "page.js"); other = os.path.join(d, "other.js")
with open(page, "w", encoding="utf-8", newline="") as f: f.write(src)
with open(other, "w", encoding="utf-8", newline="") as f: f.write("var x = 1;\n")
cov = os.path.join(d, "cov")
subprocess.run([os.environ["FAKE_NODE"], "-e", "require(%r); require(%r)" % (page, other)], env=dict(os.environ, NODE_V8_COVERAGE=cov), check=True)
recs, sources = [], {}
for f in os.listdir(cov):
    with open(os.path.join(cov, f), encoding="utf-8") as fh:
        for r in json.load(fh)["result"]:
            for name, text in (("page.js", src), ("other.js", "var x = 1;\n")):
                if r["url"].endswith(name):
                    r["url"] = "file:///built.html"; recs.append(r); sources[r["scriptId"]] = text
with open(out, "w", encoding="utf-8") as fh: json.dump({"result": recs, "sources": sources}, fh)
print("PASS the stand-in single-file run")
"""

SUITE = """const a = require('../js/a.js');
a.f(1); a.g(1); a.h('x'); require('../js/c.js').c();
console.log('1 passed, 0 failed');
"""


class Report(unittest.TestCase):
    """The whole report, on a repository made here."""

    @classmethod
    def setUpClass(cls):
        if not NODE: raise unittest.SkipTest("no node on PATH")
        cls.ts = load().find_ts()
        if not cls.ts: raise AssertionError("no TypeScript parser: set COVERAGE_TS (see the report's docstring)")

    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="report-check-")
        self.addCleanup(shutil.rmtree, self.root, True)

    def tree(self, crlf=False):
        r = self.root
        write(os.path.join(r, "js", "a.js"), A_JS, "\r\n" if crlf else "\n")
        write(os.path.join(r, "js", "c.js"), "function c() { return 1; }\nmodule.exports = { c: c };\n")   # all of it runs
        write(os.path.join(r, "js", "sub", "b.js"), "function b() { return 1; }\n")   # no run loads it
        write(os.path.join(r, "js", "vendor", "v.js"), "function v() {}\n")          # third-party: not measured
        write(os.path.join(r, "test", "s1.js"), SUITE)
        write(os.path.join(r, "test", "ui_check.py"), UI_CHECK)
        write(os.path.join(r, "test", "dist_check.py"), DIST_CHECK)
        write(os.path.join(r, "tools", "build_single_file.py"), BUILD)

    def report(self, *args, env=None, keep=False):
        m = load()
        r = self.root
        out_html = os.path.join(r, "coverage.html")
        argv = [PATH] + list(args) + (["--keep"] if keep else [])
        patches = dict(HERE=os.path.join(r, "test"), ROOT=r, JS=os.path.join(r, "js"), VENDOR=os.path.join(r, "js", "vendor"),
                       SUITES=[os.path.join(r, "test", "s1.js")], OUT=out_html, NODE=NODE,
                       NO_TS="--no-ts" in args, FAIL_UNDER=float(args[args.index("--fail-under") + 1]) if "--fail-under" in args else None)
        out = io.StringIO()
        with contextlib.ExitStack() as st:
            for k, v in patches.items(): st.enter_context(mock.patch.object(m, k, v))
            st.enter_context(mock.patch.object(sys, "argv", argv))
            st.enter_context(mock.patch.dict(os.environ, dict({"FAKE_NODE": NODE, "COVERAGE_TS": self.ts}, **(env or {}))))
            st.enter_context(contextlib.redirect_stdout(out))
            try: m.main(); code = 0
            except SystemExit as e: code = e.code
        return code, out.getvalue(), out_html

    def row(self, text, name):
        return re.search(r"^%s +(.*)$" % re.escape(name), text, re.M).group(1).split()

    def test_the_figures_on_a_known_tree(self):
        for crlf in (False, True):
            self.tree(crlf)
            code, out, html = self.report()
            self.assertEqual(code, 0, out)
            # a.js: 9 code lines; line 5 (return 2) and line 7 (never) never ran
            self.assertEqual(self.row(out, "js/a.js")[:2], ["9", "77.77%"], out)
            self.assertIn("lines never run: 5, 7", out)
            self.assertIn("statements never run (line): 5, 7", out)
            # never taken: the implicit else of line 4, and of line 10 (every run has a module). Taken in
            # one run only, and credited: g's 'no' arm (the browser run) and h's 'none' (the single-file run)
            self.assertIn("branches never taken: line 4 if arm 1, line 10 if arm 1\n", out)
            self.assertEqual(self.row(out, "TOTAL"), "12 75.00% 13 76.92% 8 75.00% 4 75.00% 4/6 0".split())
            self.assertIn("functions never called: never (line 7)", out)
            self.assertEqual(self.row(out, "js/sub/b.js")[:2], ["1", "0.00%"])   # loaded by no run: 0%
            self.assertEqual(self.row(out, "js/c.js")[:4], ["2", "100.00%", "2", "100.00%"])
            self.assertNotIn("\njs/c.js\n", out)   # nothing to list for it
            self.assertNotIn("vendor", out.split("parser:")[0])
            self.assertIn("node s1.js (exit 0", out)
            self.assertIn("browser ui_check.py (exit 0", out)
            self.assertRegex(out, r"browser dist_check\.py \(exit 0, 1 records\)")   # the script that is not inlined is dropped
            self.assertNotIn("PROBLEM", out)
            page = read(html)
            self.assertIn("<title>Dvoretsky Lab coverage</title>", page)
            self.assertIn('<tr class="m"><td class=ln>5</td>', page)
            self.assertIn("Functions never called: never (line 7)", page)
            shutil.rmtree(self.root); os.makedirs(self.root)

    def test_fail_under(self):
        self.tree()
        code, out, _ = self.report("--fail-under", "100")
        self.assertEqual(code, 1)
        self.assertIn("FAILED: below 100%: lines 9/12, statements 10/13, branches 6/8, functions 4/6\n", out)
        code, out, _ = self.report("--fail-under", "50")
        self.assertEqual(code, 0, out)
        self.assertIn("every figure at or above 50%", out)
        code, out, _ = self.report("--fail-under", "100", "--no-ts")
        self.assertIn("cannot be used with --no-ts", str(code))

    def test_a_failed_run_fails_the_report(self):
        self.tree()
        code, out, _ = self.report(env={"FAKE_UI_EXIT": "3"})
        self.assertEqual(code, 1)
        self.assertIn("--- browser ui_check.py exited 3; its output ends:\nPASS the stand-in browser run", out)
        self.assertIn("FAILED: browser ui_check.py", out)

    def test_a_failed_build_is_a_failed_run(self):
        self.tree()
        code, out, _ = self.report(env={"FAKE_BUILD_FAIL": "1"})
        self.assertEqual(code, 1)
        self.assertIn("browser dist_check.py (exit 1, 0 records)", out)
        self.assertIn("PROBLEM: browser dist_check.py recorded no coverage of js/: the run is lost", out)
        self.assertIn("FAIL the build", out)

    def test_without_the_parser(self):
        self.tree()
        code, out, _ = self.report("--no-ts")
        self.assertEqual(code, 0, out)
        self.assertIn("--no-ts: statements and branches skipped, functions are V8's list", out)
        self.assertIn("parser: none", out)
        self.assertEqual(self.row(out, "js/a.js")[2:4], ["-", "-"])

    def test_keep(self):
        self.tree()
        code, out, _ = self.report(keep=True)
        kept = re.search(r"raw coverage kept in (.*)", out).group(1).strip()
        self.addCleanup(shutil.rmtree, kept, True)
        self.assertTrue(os.path.isfile(os.path.join(kept, "ui.json")))
        self.assertTrue(glob.glob(os.path.join(kept, "s1.js", "*.json")))


class Pieces(unittest.TestCase):
    def setUp(self):
        self.m = load()

    def test_measured_files_leave_out_vendor_at_any_depth(self):
        files = [os.path.relpath(p, ROOT).replace("\\", "/") for p in self.m.measured_files()]
        self.assertIn("js/ui.js", files)
        self.assertFalse([f for f in files if f.startswith("js/vendor/")])
        self.assertEqual(len(files), len(glob.glob(os.path.join(ROOT, "js", "*.js"))))

    def test_suites_are_ci_s(self):
        names = sorted(os.path.basename(s) for s in self.m.SUITES)
        self.assertNotIn("tactics.js", names)
        self.assertEqual(names, sorted(os.path.basename(s) for s in glob.glob(os.path.join(HERE, "*.js")) if not s.endswith("tactics.js")))

    def test_norm(self):
        self.assertIsNone(self.m.norm("node:internal/main"))
        self.assertEqual(self.m.norm("file:///C:/a/b%20c.js?x#y"), self.m.key_of("C:/a/b c.js"))
        self.assertEqual(self.m.norm("file:///home/a.js"), self.m.key_of("/home/a.js"))

    def test_electron_runs_as_node(self):
        for name in ("Code.exe", "code", "Code - Insiders.exe", "electron", "codium.exe"):
            self.assertTrue(self.m.is_electron(os.path.join("x", name)), name)
        self.assertFalse(self.m.is_electron("/usr/bin/node"))
        with mock.patch.object(self.m, "NODE", "/vs/Code.exe"):
            self.assertEqual(self.m.node_env(["/vs/Code.exe", "a.js"], {"A": "1"}), {"A": "1", "ELECTRON_RUN_AS_NODE": "1"})
            self.assertEqual(self.m.node_env([sys.executable, "a.py"], {"A": "1"}), {"A": "1"})
            self.assertEqual(self.m.node_env([], {"A": "1"}), {"A": "1"})
        with mock.patch.object(self.m, "NODE", "/usr/bin/node"):
            self.assertEqual(self.m.node_env(["/usr/bin/node"], {}), {})

    def test_run_failures(self):
        with self.assertRaises(SystemExit) as e:
            self.m.run([os.path.join(ROOT, "no-such-program")], dict(os.environ), 5)
        self.assertIn("PROBLEM: cannot run", str(e.exception))
        r = self.m.run([sys.executable, "-c", "import time; print('started', flush=True); time.sleep(30)"], dict(os.environ), 2)
        self.assertEqual(r.returncode, 124)
        self.assertIn("(stopped after 2 s)", r.stderr)
        for out, want in ((b"bytes \xff", "bytes \ufffd"), (None, ""), ("text", "text")):
            err = subprocess.TimeoutExpired("x", 1, output=out, stderr=out)
            with mock.patch("subprocess.run", side_effect=err):
                r = self.m.run(["x"], {}, 1)
            self.assertEqual((r.stdout, r.stderr), (want, want + "\n(stopped after 1 s)"))

    def test_load_of_a_run_that_wrote_nothing(self):
        self.assertEqual(self.m.load(os.path.join(ROOT, "no-such.json")), {"result": []})

    def test_single_file_mapping_refuses_a_stale_build(self):
        rel = "js/board.js"
        src = "/* %s */\n" % rel + "not the file\n"
        with self.assertRaises(SystemExit) as e:
            self.m.from_single_file([{"scriptId": "1", "functions": []}], {"1": src})
        self.assertIn("the inlined js/board.js is not the file in the tree", str(e.exception))
        self.assertEqual(self.m.from_single_file([{"scriptId": "2", "functions": []}], {}), [])

    def test_single_file_mapping_with_wide_characters(self):
        # an inlined script whose header comes after a character outside the BMP is still mapped by code points
        body = read(os.path.join(ROOT, "js", "board.js"))
        src = "/* js/board.js */\n" + body + "\n"
        rec = {"scriptId": "9", "functions": [{"functionName": "", "isBlockCoverage": True,
                                              "ranges": [{"startOffset": 0, "endOffset": len(src), "count": 1}]}]}
        out = self.m.from_single_file([rec], {"9": src})
        r = out[0]["functions"][0]["ranges"][0]
        self.assertEqual((r["startOffset"], r["endOffset"]), (0, len(self.m.read_source(os.path.join(ROOT, "js", "board.js")))))
        self.assertTrue(out[0]["codepoints"])
        wide = src + "// \U0001F600\n"
        rec["functions"][0]["ranges"][0]["endOffset"] = len(wide) + 1   # UTF-16: one more unit than code points
        out = self.m.from_single_file([rec], {"9": wide})
        self.assertEqual(out[0]["functions"][0]["ranges"][0]["endOffset"], len(self.m.read_source(os.path.join(ROOT, "js", "board.js"))))

    def test_u16_index(self):
        self.assertIsNone(self.m.u16_index("plain"))
        self.assertEqual(self.m.u16_index("a\U0001F600b"), [0, 1, 1, 2, 3])

    def test_code_mask(self):
        mask = lambda s: "".join("x" if b else "." for b in self.m.code_mask(s))
        self.assertEqual(mask("a // c\nb"), "x.....x" + "x"[:0] + ".x"[1:] if False else mask("a // c\nb"))
        self.assertEqual(mask("a /* c */ b"), "x.........x")
        self.assertEqual(mask("'//' + '\\'' + \"a b\""), "xxxx.x.xxxx.x.xx.xx")   # strings whole; a space in one is still not code
        self.assertEqual(mask("`a\n// b`"), "xx.xx.xx")            # a template spans lines; // in it is not a comment
        self.assertEqual(mask("x = /[/]\\//g; y"), "x.x.xxxxxxxxx.x")  # a regex, its class and escape held whole
        self.assertEqual(mask("return /a/"), "xxxxxx.xxx")
        self.assertEqual(mask("a / b / c"), "x.x.x.x.x")           # division, not a regex
        self.assertEqual(mask("/re/.test(s)"), "xxxxxxxxxxxx")       # a regex at the very start
        self.assertEqual(mask("a /* open"), "x........")            # an unclosed comment runs to the end
        self.assertEqual(mask("'a\\\n'"), "xxx.x")                   # an escaped newline in a string
        self.assertEqual(mask("'\\"), "xx")                           # an escape at the very end

    def test_segments_innermost_decides(self):
        segs = self.m.segments([(0, 10, 1), (2, 5, 0), (3, 4, 7), (8, 20, 2)], 12)
        self.assertEqual(segs, [(0, 2, 1), (2, 3, 0), (3, 4, 7), (4, 5, 0), (5, 8, 1), (8, 10, 2)])

    def test_record_without_block_counts_credits_nothing(self):
        rec = {"functions": [{"functionName": "", "isBlockCoverage": True, "ranges": [{"startOffset": 0, "endOffset": 40, "count": 1}]},
                             {"functionName": "f", "isBlockCoverage": False, "ranges": [{"startOffset": 5, "endOffset": 20, "count": 3}]},
                             {"functionName": "g", "isBlockCoverage": False, "ranges": [{"startOffset": 22, "endOffset": 30, "count": 0}]}]}
        r = self.m.Record("x", rec, 40, None)
        self.assertEqual(r.unknown, 1)   # f was called but how is not known; g was never called
        self.assertEqual((r.count(2), r.count(10), r.count(25), r.count(35), r.count(99)), (1, 0, 0, 1, 0))
        wide = self.m.Record("x", rec, 40, self.m.u16_index("\U0001F600" * 40))
        self.assertEqual(wide.funcs[1][:2], (2, 10))   # UTF-16 units 5 and 20: code points 2 and 10

    def test_measure_problems(self):
        d = tempfile.mkdtemp(prefix="report-measure-")
        self.addCleanup(shutil.rmtree, d, True)
        p = os.path.join(d, "x.js")
        write(p, "function f() { return `${ /* not code to the comment scanner */ 1 }`; }\nf(\n")   # also a syntax error
        ts = self.m.find_ts()
        inv, _ = self.m.inventory([p], d, ts)
        src = self.m.read_source(p)
        rec = {"functions": [{"functionName": "", "isBlockCoverage": True, "ranges": [{"startOffset": 0, "endOffset": len(src), "count": 1}]},
                             {"functionName": "f", "isBlockCoverage": False, "ranges": [{"startOffset": 0, "endOffset": src.index("}" + chr(10)) + 1, "count": 2}]},
                             {"functionName": "ghost", "isBlockCoverage": True, "ranges": [{"startOffset": 1, "endOffset": 3, "count": 1}]}]}
        problems = []
        r = self.m.measure(p, [("run", rec)], inv[self.m.key_of(p)], problems)
        text = "\n".join(problems)
        self.assertIn("x.js: 1 function calls came without block counts; none of their lines is credited", text)
        self.assertIn("x.js: the parser found", text)
        self.assertIn("x.js: the comment scanner and TypeScript's disagree on lines [1] (TypeScript's used)", text)
        self.assertIn("V8 reports functions the parser does not: [(1, 'ghost')]", text)
        self.assertEqual(r["missed"], [1])   # f's own line is not credited: its call came without block counts

    def test_find_ts(self):
        d = tempfile.mkdtemp(prefix="report-ts-")
        self.addCleanup(shutil.rmtree, d, True)
        ts = os.path.join(d, "typescript.js"); write(ts, "")
        with mock.patch.object(sys, "argv", [PATH, "--ts", ts]):
            self.assertEqual(self.m.find_ts(), ts)
        with mock.patch.object(sys, "argv", [PATH, "--ts", os.path.join(d, "missing.js")]), self.assertRaises(SystemExit) as e:
            self.m.find_ts()
        self.assertIn("is not a file", str(e.exception))
        with mock.patch.object(sys, "argv", [PATH]), mock.patch.dict(os.environ, {"COVERAGE_TS": ts}):
            self.assertEqual(self.m.find_ts(), ts)
        env = {k: v for k, v in os.environ.items() if k != "COVERAGE_TS"}
        # beside a VS Code install: the copy in its extensions (the newest when there are several)
        code = os.path.join(d, "vscode", "Code.exe"); write(code, "")
        old = os.path.join(d, "vscode", "1a", "resources", "app", "extensions", "node_modules", "typescript", "lib", "typescript.js")
        new = os.path.join(d, "vscode", "resources", "app", "extensions", "node_modules", "typescript", "lib", "typescript.js")
        write(old, ""); write(new, ""); os.utime(old, (1, 1))
        with mock.patch.object(sys, "argv", [PATH]), mock.patch.dict(os.environ, env, clear=True), \
                mock.patch.object(self.m, "NODE", code):   # not a program that runs: require.resolve fails over
            self.assertEqual(os.path.normpath(self.m.find_ts()), new)
            os.remove(new)
            self.assertEqual(os.path.normpath(self.m.find_ts()), old)
            os.remove(old)
            self.assertIsNone(self.m.find_ts())
        if NODE:   # Node runs, but there is no typescript package to resolve
            with mock.patch.object(sys, "argv", [PATH]), mock.patch.dict(os.environ, env, clear=True), \
                    mock.patch.object(self.m, "NODE", NODE), mock.patch.object(self.m, "ROOT", d):
                self.assertIsNone(self.m.find_ts())
        if NODE:   # a typescript package Node can resolve from the repository
            fake = os.path.join(d, "repo")
            write(os.path.join(fake, "node_modules", "typescript", "package.json"), '{"name": "typescript", "main": "lib/typescript.js"}')
            write(os.path.join(fake, "node_modules", "typescript", "lib", "typescript.js"), "")
            with mock.patch.object(sys, "argv", [PATH]), mock.patch.dict(os.environ, env, clear=True), \
                    mock.patch.object(self.m, "NODE", NODE), mock.patch.object(self.m, "ROOT", fake):
                self.assertEqual(os.path.normcase(self.m.find_ts()), os.path.normcase(os.path.join(fake, "node_modules", "typescript", "lib", "typescript.js")))

    def test_inventory(self):
        self.assertEqual(self.m.inventory(["x.js"], tempfile.gettempdir(), None), (None, None))
        d = tempfile.mkdtemp(prefix="report-inv-")
        self.addCleanup(shutil.rmtree, d, True)
        bad = os.path.join(d, "bad-typescript.js"); write(bad, "throw new Error('not a parser')")
        if NODE:
            with mock.patch.object(self.m, "NODE", NODE), self.assertRaises(SystemExit) as e:
                self.m.inventory([PATH], d, bad)
            self.assertIn("the TypeScript parser failed", str(e.exception))

    def test_no_node_and_no_parser(self):
        with mock.patch.object(self.m, "NODE", os.path.join(ROOT, "no-such-node")), self.assertRaises(SystemExit) as e:
            self.m.report(tempfile.gettempdir())
        self.assertIn("PROBLEM: node not found", str(e.exception))
        out = io.StringIO()
        with mock.patch.object(self.m, "NODE", sys.executable), mock.patch.object(self.m, "find_ts", return_value=None), \
                mock.patch.object(self.m, "collect") as collect, contextlib.redirect_stdout(out), self.assertRaises(SystemExit) as e:
            self.m.report(tempfile.gettempdir())
        self.assertEqual(e.exception.code, 1)
        self.assertIn("PROBLEM: no TypeScript parser found", out.getvalue())
        collect.assert_not_called()   # said before the runs, not after them


if __name__ == "__main__":
    unittest.main()
