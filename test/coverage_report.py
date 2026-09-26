"""Line and function coverage of js/, from every test that runs: the Node suites
and the browser drive of index.html, merged. No npm packages needed.

    python test/coverage_report.py [--node path/to/node] [--out coverage.html]

Both Node (NODE_V8_COVERAGE) and Chromium (Profiler.takePreciseCoverage) report
V8 block coverage: nested byte ranges with execution counts, where the innermost
range decides. A line counts as covered when the first code character on it ran;
a line is "partial" when it ran but some code on it did not (an `if` whose body
was skipped). Blank lines and comment-only lines are not counted.
"""
import glob, html, json, os, re, shutil, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, ".."))
arg = lambda k, d=None: sys.argv[sys.argv.index(k) + 1] if k in sys.argv else d
NODE = arg("--node", shutil.which("node") or "node")
OUT = arg("--out", os.path.join(ROOT, "coverage.html"))
SUITES = sorted(glob.glob(os.path.join(HERE, "*.js")))

def norm(url):
    if not url.startswith("file:"): return None
    p = re.sub(r"^file:/+", "", url).replace("%20", " ")
    p = os.path.normcase(os.path.normpath(p if re.match(r"^[A-Za-z]:", p) else "/" + p))
    return p if os.path.dirname(p) == os.path.normcase(os.path.join(ROOT, "js")) else None

def collect():
    runs = []   # (label, [script coverage])
    tmp = tempfile.mkdtemp()
    env = dict(os.environ, TZ="America/Toronto")
    for s in SUITES:
        d = os.path.join(tmp, os.path.basename(s))
        r = subprocess.run([NODE, s], cwd=ROOT, env=dict(env, NODE_V8_COVERAGE=d),
                           capture_output=True, text=True, timeout=900)
        scripts = []
        for f in glob.glob(os.path.join(d, "*.json")):
            scripts += json.load(open(f, encoding="utf-8"))["result"]
        runs.append(("node " + os.path.basename(s), r.returncode, scripts))
    ui = os.path.join(tmp, "ui.json")
    r = subprocess.run([sys.executable, os.path.join(HERE, "ui_check.py"), "--coverage", ui],
                       cwd=ROOT, env=dict(env, PYTHONIOENCODING="utf-8"), capture_output=True, text=True, timeout=900)
    runs.append(("browser ui_check.py", r.returncode, json.load(open(ui))["result"] if os.path.exists(ui) else []))
    return runs

def code_lines(src):
    """Offsets of the first code character on each line that has code."""
    out, i, n, line_start, state = {}, 0, len(src), 0, None
    line_no, seen = 1, False
    while i < n:
        c = src[i]
        if c == "\n":
            line_no += 1; seen = False
            if state == "line": state = None
            i += 1; continue
        if state == "block":
            if src.startswith("*/", i): state = None; i += 2
            else: i += 1
            continue
        if state == "line": i += 1; continue
        if src.startswith("//", i): state = "line"; i += 2; continue
        if src.startswith("/*", i): state = "block"; i += 2; continue
        if not c.isspace() and not seen:
            out[line_no] = i; seen = True
        i += 1
    return out

def line_ends(src):
    ends, pos = {}, 0
    for no, text in enumerate(src.split("\n"), 1):
        ends[no] = (pos, pos + len(text)); pos += len(text) + 1
    return ends

def main():
    runs = collect()
    files = sorted(glob.glob(os.path.join(ROOT, "js", "*.js")))
    report = []
    for path in files:
        src = open(path, encoding="utf-8").read()
        key = os.path.normcase(os.path.normpath(path))
        n = len(src)
        covered_any = bytearray(n)      # 1 where some run executed this character
        executed_by = {}
        funcs = {}                      # (start, end) -> [name, calls]
        for label, _, scripts in runs:
            for sc in scripts:
                if norm(sc.get("url", "")) != key: continue
                counts = [None] * n
                ranges = [(r["startOffset"], r["endOffset"], r["count"]) for fn in sc["functions"] for r in fn["ranges"]]
                for s, e, c in sorted(ranges, key=lambda x: (x[0], -x[1])):   # outer first; inner overwrite
                    for k in range(max(0, s), min(n, e)): counts[k] = c
                for k in range(n):
                    if counts[k]: covered_any[k] = 1
                executed_by[label] = True
                for fn in sc["functions"]:
                    r0 = fn["ranges"][0]
                    if r0["startOffset"] == 0 and r0["endOffset"] >= n - 2: continue   # the module wrapper
                    k = (r0["startOffset"], r0["endOffset"])
                    funcs.setdefault(k, [fn["functionName"] or "(anonymous)", 0])[1] += r0["count"]
        lines, ends = code_lines(src), line_ends(src)
        cov, part, miss = [], [], []
        for no, first in lines.items():
            a, b = ends[no]
            if not covered_any[first]: miss.append(no); continue
            code_chars = [k for k in range(first, b) if not src[k].isspace()]
            (part if any(not covered_any[k] for k in code_chars) else cov).append(no)
        f_total = len(funcs); f_hit = sum(1 for v in funcs.values() if v[1] > 0)
        report.append(dict(file=os.path.relpath(path, ROOT).replace("\\", "/"), src=src, lines=len(lines),
                           covered=len(cov) + len(part), partial=part, missed=miss,
                           funcs=f_total, funcs_hit=f_hit,
                           unrun=sorted([v[0] for v in funcs.values() if v[1] == 0]),
                           by=sorted(executed_by)))
    write_html(report, runs)
    print("%-18s %7s %7s %7s %9s" % ("file", "lines", "covered", "partial", "functions"))
    T = [0, 0, 0, 0, 0]
    for r in report:
        print("%-18s %7d %6.1f%% %7d %4d/%-4d" % (r["file"], r["lines"], 100.0 * r["covered"] / max(1, r["lines"]),
                                              len(r["partial"]), r["funcs_hit"], r["funcs"]))
        for i, v in enumerate([r["lines"], r["covered"], len(r["partial"]), r["funcs_hit"], r["funcs"]]): T[i] += v
    print("%-18s %7d %6.1f%% %7d %4d/%-4d" % ("TOTAL", T[0], 100.0 * T[1] / T[0], T[2], T[3], T[4]))
    print("\nruns:", ", ".join("%s (exit %d)" % (l, c) for l, c, _ in runs))
    print("report:", OUT)

def write_html(report, runs):
    T = sum(r["lines"] for r in report); C = sum(r["covered"] for r in report)
    rows, bodies = [], []
    for r in report:
        pct = 100.0 * r["covered"] / max(1, r["lines"])
        fid = r["file"].replace("/", "-").replace(".", "-")
        rows.append('<tr><td><a href="#%s">%s</a></td><td class=n>%d</td><td class=n>%d</td><td class=n>%.1f%%</td>'
                    '<td><div class=bar><i style="width:%.1f%%"></i></div></td><td class=n>%d</td><td class=n>%d / %d</td></tr>'
                    % (fid, r["file"], r["lines"], r["covered"], pct, pct, len(r["partial"]), r["funcs_hit"], r["funcs"]))
        miss, part = set(r["missed"]), set(r["partial"])
        code = []
        for no, text in enumerate(r["src"].split("\n"), 1):
            cls = "m" if no in miss else "p" if no in part else ""
            code.append('<tr class="%s"><td class=ln>%d</td><td><pre>%s</pre></td></tr>' % (cls, no, html.escape(text)))
        bodies.append('<section id="%s"><h2>%s <span>%.1f%% of %d lines &middot; %d/%d functions</span></h2>'
                      '<p class=un>Functions never called: %s</p><table class=src>%s</table></section>'
                      % (fid, r["file"], pct, r["lines"], r["funcs_hit"], r["funcs"],
                         html.escape(", ".join(r["unrun"]) or "none"), "".join(code)))
    page = """<!doctype html><meta charset=utf-8><title>Dvoretsky Lab coverage</title>
<style>body{margin:0;background:#0b0f16;color:#dfe7ef;font:14px system-ui,Segoe UI,sans-serif}main{max-width:1100px;margin:auto;padding:28px}
h1{font:600 24px Consolas,monospace}h2{font:600 15px Consolas,monospace;position:sticky;top:0;background:#131b27;padding:9px 12px;margin:28px 0 0;border:1px solid #1f2a38}
h2 span{color:#8fa1b3;font-weight:400}a{color:#3fd3f2}table{border-collapse:collapse;width:100%%}
.sum td,.sum th{padding:7px 10px;border-bottom:1px solid #1f2a38;text-align:left}.n{text-align:right;font-family:Consolas,monospace}
.bar{background:#1f2a38;height:9px;width:160px}.bar i{display:block;height:9px;background:#5fe0a0}
.src{font:12.5px/1.45 Consolas,monospace;border:1px solid #1f2a38;border-top:0}.src pre{margin:0;white-space:pre-wrap}
.src td{padding:0 8px;vertical-align:top}.ln{color:#4d5b6a;text-align:right;user-select:none;width:44px}
tr.m{background:rgba(255,107,107,.16)}tr.p{background:rgba(242,193,78,.13)}.un{color:#8fa1b3;margin:8px 0}
.key span{display:inline-block;padding:1px 8px;margin-right:8px}</style><main>
<h1>&gt; Dvoretsky Lab &middot; coverage %.1f%%</h1>
<p>%d of %d code lines executed across %d runs: %s.</p>
<p class=key><span style="background:rgba(255,107,107,.3)">never ran</span><span style="background:rgba(242,193,78,.25)">ran, but part of the line did not</span></p>
<table class=sum><tr><th>file</th><th class=n>lines</th><th class=n>covered</th><th class=n>%%</th><th></th><th class=n>partial</th><th class=n>functions</th></tr>%s</table>
%s</main>""" % (100.0 * C / T, C, T, len(runs), html.escape(", ".join(l for l, _, _ in runs)), "".join(rows), "".join(bodies))
    open(OUT, "w", encoding="utf-8").write(page)

if __name__ == "__main__":
    main()
