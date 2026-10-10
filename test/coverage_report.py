"""Coverage of js/ from every test CI runs, merged: lines, statements, branches, V8 blocks
and functions. No npm packages needed. Exits 1 if any run failed or recorded nothing.

    python test/coverage_report.py [--node path/to/node] [--ts path/to/typescript.js] [--out coverage.html] [--keep]

What is measured: every .js file under js/, at any depth, except js/vendor/ (Stockfish:
third-party, shipped as one generated string). A file no run loaded is listed at 0%.

Where it comes from: the Node suites in test/*.js (all but tactics.js, which CI does not
run: it scores by the clock and asserts nothing), each under NODE_V8_COVERAGE with CI=true,
child processes and worker threads included; test/ui_check.py, which drives index.html in
Chromium, the main page and every fresh page, with a snapshot before each reload; and
test/dist_check.py on a single file built from the tree as it is, whose inlined scripts are
mapped back to the files they came from. Each run gives V8 precise block coverage: nested
ranges with execution counts, the innermost range deciding. A run that exits non-zero, or
that recorded no coverage of js/, fails the report.

A function V8 counts per function only (isBlockCoverage false: code it reused from its
compilation cache, which is why the browser runs pass --js-flags=--no-compilation-cache)
says it was called but not which of its lines ran, so none of them is credited from that
record, and the report says how many there were. Before this, every line of such a
function counted as run, and reloaded pages made 99.03% of lines read as 99.96%.

Merging: each record (one script in one process, or in one page snapshot) is turned into
counts on its own; records are then combined by "ran in any record" for lines,
statements, branches and blocks, and by summing calls for functions. A union cannot count
twice, and Chromium's snapshots are deltas (taking one resets the counters), so summed
calls are not counted twice either.

The figures:
- lines: a line with code (not blank, not only comment) is covered when its first code
  character ran; it is partial when it ran but some code on it did not (`a(); if (x) b();`
  with x never true). Partial lines count as covered and are listed.
- statements: every statement (expression, var, if, loop, return, throw, try...; not a
  block, and not a function declaration, which is a function), covered when its first
  character ran. V8 has no counter between two calls, so a statement after a call that
  threw counts as run; after return, throw, break and continue it does have one.
- branches: both arms of every if (an if with no else has an implicit one: the times the
  if ran but its body did not), both arms of every ?:, every operand of a && || ?? chain,
  every switch case and every default argument: Istanbul's definition.
- blocks: V8's own ranges inside functions (if and else bodies, ?: arms, the right side of
  && || ??, loop bodies, catch, and the code after a return or throw). V8 leaves a block out
  of a record when it ran exactly as often as its parent, so the total is the blocks some
  record listed; but a block that never ran inside code that did is always listed, so the
  list of blocks never run is complete.
- functions: every function in the source, called at least once.

Statements, branches and functions come from the TypeScript parser (any typescript.js:
--ts, COVERAGE_TS, require('typescript'), or the copy inside VS Code, whose Code.exe also
runs as Node). V8 alone does not list a function nested in one that never ran. Without the
parser, statements and branches are skipped and functions are V8's list, and it says so.
Offsets are V8's, UTF-16 units into the file as it is on disk, so a checkout with CRLF
endings measures the same as CI.
"""
import bisect, glob, html, json, os, re, shutil, subprocess, sys, tempfile
from urllib.parse import unquote

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, ".."))
JS = os.path.join(ROOT, "js")
VENDOR = os.path.join(JS, "vendor")
arg = lambda k, d=None: sys.argv[sys.argv.index(k) + 1] if k in sys.argv else d
NODE = arg("--node", shutil.which("node") or "node")
OUT = arg("--out", os.path.join(ROOT, "coverage.html"))
NOT_CI = {"tactics.js"}   # scored by the clock, asserts nothing, not run by CI
SUITES = sorted(s for s in glob.glob(os.path.join(HERE, "*.js")) if os.path.basename(s) not in NOT_CI)

def measured_files():
    out = []
    for p in glob.glob(os.path.join(JS, "**", "*.js"), recursive=True):
        if os.path.commonpath([os.path.abspath(p), VENDOR]) == VENDOR: continue
        out.append(os.path.normpath(p))
    return sorted(out)

def key_of(path): return os.path.normcase(os.path.normpath(os.path.abspath(path)))

def norm(url):
    """A coverage record's URL as a file key (or None for anything not a file)."""
    if not url.startswith("file:"): return None
    p = unquote(re.sub(r"^file:/+", "", url.split("?")[0].split("#")[0]))
    return key_of(p if re.match(r"^[A-Za-z]:", p) else "/" + p)

# ---------------------------------------------------------------- collecting the runs
def run(cmd, env, timeout):
    try:
        return subprocess.run(cmd, cwd=ROOT, env=env, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout)
    except subprocess.TimeoutExpired as e:   # a hung run is a failed run, reported like any other
        out = lambda b: (b.decode("utf-8", "replace") if isinstance(b, bytes) else b or "")
        return subprocess.CompletedProcess(cmd, 124, out(e.stdout), out(e.stderr) + "\n(stopped after %d s)" % timeout)

def collect(tmp):
    """[(label, exit code, [script coverage records], end of its output)], one per run; raw files go in tmp."""
    runs = []
    env = dict(os.environ, TZ="America/Toronto", PYTHONIOENCODING="utf-8")
    env.setdefault("CI", "true")   # as CI runs them: a check that would SKIP fails instead
    tail = lambda r: (r.stdout[-1500:] + r.stderr[-1500:]).strip()
    for s in SUITES:
        d = os.path.join(tmp, os.path.basename(s))
        r = run([NODE, s], dict(env, NODE_V8_COVERAGE=d), 900)
        scripts = []
        for f in sorted(glob.glob(os.path.join(d, "*.json"))):   # one file per process and worker
            with open(f, encoding="utf-8") as fh: scripts += json.load(fh)["result"]
        runs.append(("node " + os.path.basename(s), r.returncode, scripts, tail(r)))
    out = os.path.join(tmp, "ui.json")
    r = run([sys.executable, os.path.join(HERE, "ui_check.py"), "--coverage", out], env, 1200)
    runs.append(("browser ui_check.py", r.returncode, load(out)["result"], tail(r)))
    built, out = os.path.join(tmp, "Dvoretsky-Lab.html"), os.path.join(tmp, "dist.json")
    b = run([sys.executable, os.path.join(ROOT, "tools", "build_single_file.py"), built], env, 300)
    if b.returncode:
        runs.append(("browser dist_check.py", b.returncode, [], tail(b)))
    else:
        r = run([sys.executable, os.path.join(HERE, "dist_check.py"), built, "--coverage", out], env, 600)
        data = load(out)
        runs.append(("browser dist_check.py", r.returncode, from_single_file(data["result"], data.get("sources", {})), tail(r)))
    return runs

def load(path):
    if not os.path.exists(path): return {"result": []}
    with open(path, encoding="utf-8") as f: return json.load(f)

def from_single_file(recs, sources):
    """The built page inlines each script as "/* js/x.js */\\n" + the file + "\\n", and the HTML parser
    turns CRLF into LF. Map each inlined script's ranges back onto the file as it is on disk."""
    out = []
    for rec in recs:
        src = sources.get(rec["scriptId"], "")
        m = re.match(r"/\* (js/[A-Za-z0-9_/\-]+\.js) \*/\n", src)
        if not m: continue
        path = os.path.join(ROOT, m.group(1))
        disk = read_source(path)
        lf = disk.replace("\r\n", "\n")
        if src[m.end():m.end() + len(lf)] != lf:
            raise SystemExit("dist_check coverage: the inlined %s is not the file in the tree" % m.group(1))
        idx = u16_index(src)
        crlf = [i - k for k, i in enumerate(mm.start() for mm in re.finditer("\r\n", disk))]   # their LF offsets
        def move(o):   # V8 offset in the inline script -> code point in the file on disk
            o = (idx[min(o, len(idx) - 1)] if idx else o) - m.end()
            o = min(max(o, 0), len(lf))
            return o + bisect.bisect_left(crlf, o)
        fns = [dict(fn, ranges=[dict(r, startOffset=move(r["startOffset"]), endOffset=move(r["endOffset"])) for r in fn["ranges"]])
               for fn in rec["functions"]]
        out.append({"scriptId": rec["scriptId"], "url": "file:///" + path.replace("\\", "/"), "functions": fns, "codepoints": True})
    return out

# ---------------------------------------------------------------- source and offsets
def read_source(path):
    # newline="": V8 counts in the file as it is; utf-8-sig: Node and browsers both drop a BOM.
    with open(path, encoding="utf-8-sig", newline="") as f: return f.read()

def u16_index(src):
    """V8 offsets are UTF-16 units, Python's are code points: a map from one to the other,
    or None when they agree (no character outside the BMP)."""
    if all(ord(c) <= 0xFFFF for c in src): return None
    idx = []
    for i, c in enumerate(src):
        idx.append(i)
        if ord(c) > 0xFFFF: idx.append(i)
    idx.append(len(src))
    return idx

REGEX_AFTER = set("(,=:[!&|?{};+-*%<>~^")
REGEX_WORDS = {"return", "typeof", "case", "do", "else", "in", "of", "new", "delete", "void", "throw", "instanceof", "yield", "await"}

def code_mask(src):
    """1 for each character that is code: not whitespace, not in a comment. Strings,
    template literals and regex literals are passed over whole, so a // or /* in one is not
    a comment. A / starts a regex where an expression can start (after an operator, an
    opening bracket, a keyword such as return, or at the start). When the TypeScript scanner
    is found the two are compared, and a disagreement is reported."""
    n, mask, i, quote, prev = len(src), bytearray(len(src)), 0, None, -1   # prev: the last code character
    while i < n:
        c = src[i]
        if quote:
            if not c.isspace(): mask[i] = 1
            if c == "\\":
                if i + 1 < n and not src[i + 1].isspace(): mask[i + 1] = 1
                i += 2; continue
            if c == quote or (c == "\n" and quote != "`"): quote = None
            prev = i; i += 1; continue
        if src.startswith("//", i):
            j = src.find("\n", i); i = n if j < 0 else j; continue
        if src.startswith("/*", i):
            j = src.find("*/", i + 2); i = n if j < 0 else j + 2; continue
        if c == "/":
            word = re.search(r"([A-Za-z_$][\w$]*)$", src[max(0, prev - 11):prev + 1]) if prev >= 0 else None
            if prev < 0 or src[prev] in REGEX_AFTER or (word and word.group(1) in REGEX_WORDS):
                j, cls = i + 1, False   # to the closing / outside a [...] class
                while j < n and src[j] != "\n" and (cls or src[j] != "/"):
                    if src[j] == "\\": j += 1
                    elif src[j] == "[": cls = True
                    elif src[j] == "]": cls = False
                    j += 1
                for k in range(i, min(j + 1, n)):
                    if not src[k].isspace(): mask[k] = 1
                prev = j; i = j + 1; continue
        if c in "'\"`": quote = c
        if not c.isspace(): mask[i] = 1; prev = i
        i += 1
    return mask

def line_spans(src):
    spans, pos = [], 0
    for text in src.split("\n"):
        spans.append((pos, pos + len(text))); pos += len(text) + 1
    return spans

# ---------------------------------------------------------------- one record's counts
def segments(ranges, n):
    """V8's ranges nest and the innermost decides: sorted, disjoint (start, end, count) pieces."""
    segs, stack, pos = [], [], 0
    def emit(upto):
        nonlocal pos
        if upto > pos and stack: segs.append((pos, upto, stack[-1][1]))
        pos = max(pos, upto)
    for s, e, c in sorted(ranges, key=lambda r: (r[0], -r[1])):
        s, e = max(0, min(s, n)), max(0, min(e, n))
        while stack and stack[-1][0] <= s:
            emit(stack[-1][0]); stack.pop()
        emit(s)
        if stack: e = min(e, stack[-1][0])
        stack.append((e, c))
    while stack:
        emit(stack[-1][0]); stack.pop()
    return segs

class Record:
    def __init__(self, label, rec, n, idx):
        fix = (lambda o: idx[min(o, len(idx) - 1)]) if idx and not rec.get("codepoints") else (lambda o: o)
        self.label, self.funcs, self.blocks, ranges, self.unknown = label, [], {}, [], 0
        for fn in rec["functions"]:
            rs = [(fix(r["startOffset"]), fix(r["endOffset"]), r["count"]) for r in fn["ranges"]]
            self.funcs.append((rs[0][0], rs[0][1], fn["functionName"], rs[0][2]))
            if not fn.get("isBlockCoverage", True) and rs[0][2] > 0:
                # Called, but counted per function only (V8 does this for code it reuses from its
                # compilation cache): which of its lines ran is unknown, so none of them is credited.
                ranges.append((rs[0][0], rs[0][1], None)); self.unknown += 1
                continue
            ranges += rs
            for s, e, c in rs[1:]: self.blocks[(s, e)] = c
        self.segs = segments(ranges, n)
        self.starts = [s for s, _, _ in self.segs]
    def count(self, p):   # an unknown count (None) is not a run
        i = bisect.bisect_right(self.starts, p) - 1
        return (self.segs[i][2] or 0) if i >= 0 and p < self.segs[i][1] else 0

# ---------------------------------------------------------------- the parser's inventory
AST_JS = r"""
const ts = require(process.argv[2]), fs = require('fs'), out = {};
for (const file of process.argv.slice(3)) {
  let text = fs.readFileSync(file, 'utf8');
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const K = ts.SyntaxKind, F = { functions: [], statements: [], branches: [], code: [], errors: sf.parseDiagnostics.length };
  const at = n => n.getStart(sf), ln = p => sf.getLineAndCharacterOfPosition(p).line + 1;
  const unparen = n => { while (n.kind === K.ParenthesizedExpression) n = n.expression; return n; };
  const isLogical = n => n.kind === K.BinaryExpression &&
    [K.AmpersandAmpersandToken, K.BarBarToken, K.QuestionQuestionToken].includes(n.operatorToken.kind);
  const leaves = (n, acc) => { n = unparen(n); if (isLogical(n)) { leaves(n.left, acc); leaves(n.right, acc); } else acc.push(at(n)); return acc; };
  const STMT = new Set([K.VariableStatement, K.ExpressionStatement, K.IfStatement, K.ForStatement, K.ForInStatement, K.ForOfStatement,
    K.WhileStatement, K.DoStatement, K.ReturnStatement, K.BreakStatement, K.ContinueStatement, K.ThrowStatement, K.TryStatement,
    K.SwitchStatement, K.LabeledStatement, K.DebuggerStatement, K.WithStatement]);
  const FUNC = new Set([K.FunctionDeclaration, K.FunctionExpression, K.ArrowFunction, K.MethodDeclaration, K.GetAccessor,
    K.SetAccessor, K.Constructor]);
  (function walk(n, inLogical) {
    const p = n.kind === K.SourceFile ? 0 : at(n);
    if (FUNC.has(n.kind)) F.functions.push({ name: n.name ? n.name.getText(sf) : '', start: p, end: n.end, line: ln(p) });
    if (STMT.has(n.kind)) F.statements.push({ at: p, line: ln(p) });
    let arms = null, type = null;
    if (n.kind === K.IfStatement) { type = 'if'; arms = [at(n.thenStatement), n.elseStatement ? at(n.elseStatement) : null]; }
    else if (n.kind === K.ConditionalExpression) { type = '?:'; arms = [at(n.whenTrue), at(n.whenFalse)]; }
    else if (n.kind === K.SwitchStatement) { type = 'switch'; arms = n.caseBlock.clauses.map(c => c.statements.length ? at(c.statements[0]) : at(c)); }
    else if (isLogical(n) && !inLogical) { type = 'logical'; arms = leaves(n, []); }
    else if (n.kind === K.Parameter && n.initializer) { type = 'default'; arms = [at(n.initializer)]; }
    if (type) F.branches.push({ type, at: p, line: ln(p), arms });
    const logical = isLogical(n) || (inLogical && n.kind === K.ParenthesizedExpression);
    ts.forEachChild(n, c => walk(c, logical));
  })(sf, false);
  // Code characters by the real scanner: each token, no trivia (regexes and templates rescanned).
  const sc = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, text);
  const ENDS = [K.Identifier, K.NumericLiteral, K.StringLiteral, K.BigIntLiteral, K.RegularExpressionLiteral, K.CloseParenToken,
    K.CloseBracketToken, K.CloseBraceToken, K.ThisKeyword, K.SuperKeyword, K.TrueKeyword, K.FalseKeyword, K.NullKeyword,
    K.PlusPlusToken, K.MinusMinusToken, K.NoSubstitutionTemplateLiteral, K.TemplateTail];
  const tmpl = []; let prev = null;
  for (let t = sc.scan(); t !== K.EndOfFileToken; t = sc.scan()) {
    if ((t === K.SlashToken || t === K.SlashEqualsToken) && (prev === null || !ENDS.includes(prev))) t = sc.reScanSlashToken();
    if (t === K.TemplateHead) tmpl.push(0);
    else if (t === K.OpenBraceToken && tmpl.length) tmpl[tmpl.length - 1]++;
    else if (t === K.CloseBraceToken && tmpl.length) {
      if (tmpl[tmpl.length - 1] === 0) { t = sc.reScanTemplateToken(false); if (t === K.TemplateTail) tmpl.pop(); }
      else tmpl[tmpl.length - 1]--;
    }
    F.code.push([sc.getTokenStart ? sc.getTokenStart() : sc.getTokenPos(), sc.getTextPos()]);
    prev = t;
  }
  out[file] = F;
}
process.stdout.write(JSON.stringify(out));
"""

def find_ts():
    p = arg("--ts", os.environ.get("COVERAGE_TS"))
    if p: return p if os.path.exists(p) else None
    try:
        r = subprocess.run([NODE, "-e", "process.stdout.write(require.resolve('typescript'))"], cwd=ROOT,
                           capture_output=True, text=True, timeout=60)
        if r.returncode == 0 and os.path.exists(r.stdout.strip()): return r.stdout.strip()
    except Exception: pass
    d = os.path.dirname(os.path.abspath(NODE))
    for pat in ("resources/app/extensions/node_modules/typescript/lib/typescript.js",
                "*/resources/app/extensions/node_modules/typescript/lib/typescript.js"):
        hits = sorted(glob.glob(os.path.join(d, pat)), key=os.path.getmtime)
        if hits: return hits[-1]
    return None

def inventory(files, tmp):
    ts = find_ts()
    if not ts: return None, None
    tmp = os.path.join(tmp, "ast.js")
    with open(tmp, "w", encoding="utf-8") as f: f.write(AST_JS)
    r = run([NODE, tmp, ts] + files, dict(os.environ), 300)
    if r.returncode: raise SystemExit("the TypeScript parser failed:\n" + r.stderr[-2000:])
    return {key_of(k): v for k, v in json.loads(r.stdout).items()}, ts

# ---------------------------------------------------------------- one file
def measure(path, recs, inv, problems):
    src = read_source(path)
    n, idx = len(src), u16_index(src)
    fix = (lambda o: idx[min(o, len(idx) - 1)]) if idx else (lambda o: o)
    mine = [Record(label, rec, n, idx) for label, rec in recs]
    ran = bytearray(n)
    for r in mine:
        for s, e, c in r.segs:
            if c: ran[s:e] = b"\x01" * (e - s)   # None, unknown, is not a run
    hit = lambda p: any(r.count(p) > 0 for r in mine)
    rel = os.path.relpath(path, ROOT).replace("\\", "/")
    lineno = lambda p: src.count("\n", 0, p) + 1
    unknown = sum(r.unknown for r in mine)
    if unknown:
        problems.append("%s: %d function calls came without block counts; none of their lines is credited" % (rel, unknown))

    mask = code_mask(src)
    if inv:
        if inv["errors"]: problems.append("%s: the parser found %d syntax errors" % (rel, inv["errors"]))
        tsmask = bytearray(n)
        for s, e in inv["code"]:
            for k in range(fix(s), fix(e)):
                if not src[k].isspace(): tsmask[k] = 1
        if tsmask != mask:
            bad = sorted({lineno(k) for k in range(n) if tsmask[k] != mask[k]})
            problems.append("%s: the comment scanner and TypeScript's disagree on lines %s (TypeScript's used)" % (rel, bad[:10]))
            mask = tsmask
    # lines
    cov, part, miss = [], [], []
    for no, (a, b) in enumerate(line_spans(src), 1):
        code = [k for k in range(a, b) if mask[k]]
        if not code: continue
        if not ran[code[0]]: miss.append(no)
        elif all(ran[k] for k in code): cov.append(no)
        else: part.append(no)
    # blocks: every range some record listed; run if, in a record, its own count (or, where V8 left it
    # out as equal to its parent, the count there) was above zero
    blocks = {}
    for r in mine:
        for k in r.blocks: blocks[k] = False
    for k in blocks:
        blocks[k] = any((r.blocks[k] if k in r.blocks else r.count(k[0])) > 0 for r in mine)
    blk_miss = sorted(lineno(s) for (s, e), v in blocks.items() if not v)
    # functions
    v8f = {}
    for r in mine:
        for s, e, name, calls in r.funcs:
            if s == 0 and e >= n - 2 and not name: continue   # the script itself
            v8f.setdefault((s, e), [name or "(anonymous)", 0])[1] += calls
    stmts = branches = None
    if inv:
        by_end = {}
        for (s, e), v in v8f.items(): by_end.setdefault(e, []).append((s, v))
        funcs, matched = [], set()
        for f in inv["functions"]:
            s, e = fix(f["start"]), fix(f["end"])
            cand = sorted(by_end.get(e, []), key=lambda c: abs(c[0] - s))
            if cand: matched.add((cand[0][0], e))
            funcs.append((f["name"] or "(anonymous)", f["line"], cand[0][1][1] if cand else 0))
        extra = [(lineno(s), v[0]) for (s, e), v in v8f.items() if (s, e) not in matched]
        if extra: problems.append("%s: V8 reports functions the parser does not: %s" % (rel, extra[:5]))
        stmts = [(f["line"], hit(fix(f["at"]))) for f in inv["statements"]]
        branches = []
        for b in inv["branches"]:
            at = fix(b["at"])
            for i, a in enumerate(b["arms"]):
                if a is None:   # the else an if leaves unwritten: taken when the if ran more often than its body
                    then = fix(b["arms"][0])
                    ok = any(r.count(at) > r.count(then) for r in mine)
                else:
                    ok = hit(fix(a))
                branches.append((b["line"], b["type"], i, ok))
    else:
        funcs = [(v[0], lineno(s), v[1]) for (s, e), v in v8f.items()]
    def miss_of(items, fmt):
        return None if items is None else sorted(fmt(x) for x in items if not x[-1])
    return dict(file=rel, src=src, lines=len(cov) + len(part) + len(miss), covered=len(cov) + len(part), partial=part, missed=miss,
                blocks=len(blocks), blocks_hit=sum(blocks.values()), blocks_missed=blk_miss,
                funcs=len(funcs), funcs_hit=sum(1 for f in funcs if f[2] > 0),
                unrun=sorted("%s (line %d)" % (f[0], f[1]) for f in funcs if f[2] == 0),
                stmts=None if stmts is None else len(stmts), stmts_hit=None if stmts is None else sum(1 for s in stmts if s[1]),
                stmts_missed=miss_of(stmts, lambda s: s[0]),
                br=None if branches is None else len(branches), br_hit=None if branches is None else sum(1 for b in branches if b[3]),
                br_missed=None if branches is None else ["line %d %s arm %d" % b[:3] for b in sorted(branches) if not b[3]],
                by=sorted({label for label, _ in recs}))

def main():
    tmp = tempfile.mkdtemp(prefix="coverage-")
    try:
        report(tmp)
    finally:
        if "--keep" in sys.argv: print("raw coverage kept in", tmp)
        else: shutil.rmtree(tmp, ignore_errors=True)

def report(tmp):
    runs = collect(tmp)
    files = measured_files()
    inv, ts = inventory(files, tmp)
    keys = {key_of(p): p for p in files}
    per_file, problems = {k: [] for k in keys}, []
    for label, code, scripts, _ in runs:
        mine = 0
        for sc in scripts:
            k = norm(sc.get("url", ""))
            if k in per_file: per_file[k].append((label, sc)); mine += 1
        if mine == 0: problems.append("%s recorded no coverage of js/: the run is lost" % label)
    report = [measure(keys[k], per_file[k], inv.get(k) if inv else None, problems) for k in sorted(keys)]
    write_html(report, runs, ts)
    # Floors, not rounding: 99.96% must never print as 100.0%.
    pct = lambda a, b: ("%6.2f%%" % (int(10000.0 * a / b) / 100.0)) if b else "    - "
    num = lambda v: "-" if v is None else str(v)
    print("%-22s %15s %15s %15s %15s %13s %7s" % ("file", "lines", "statements", "branches", "V8 blocks", "functions", "partial"))
    K = ("lines", "covered", "stmts", "stmts_hit", "br", "br_hit", "blocks", "blocks_hit", "funcs", "funcs_hit")
    T = dict.fromkeys(K, 0); T["partial"] = 0
    row = lambda name, r, p: "%-22s %5s %s %6s %s %6s %s %6s %s %5d/%-5d %7d" % (
        name, r["lines"], pct(r["covered"], r["lines"]), num(r["stmts"]), pct(r["stmts_hit"], r["stmts"]), num(r["br"]),
        pct(r["br_hit"], r["br"]), r["blocks"], pct(r["blocks_hit"], r["blocks"]), r["funcs_hit"], r["funcs"], p)
    for r in report:
        print(row(r["file"], r, len(r["partial"])))
        for k in K: T[k] += r[k] or 0
        T["partial"] += len(r["partial"])
    print(row("TOTAL", T, T["partial"]))
    print("\ntotals: lines %d/%d, statements %d/%d, branches %d/%d, V8 blocks %d/%d, functions %d/%d, partial lines %d" % (
        T["covered"], T["lines"], T["stmts_hit"], T["stmts"], T["br_hit"], T["br"], T["blocks_hit"], T["blocks"],
        T["funcs_hit"], T["funcs"], T["partial"]))
    for r in report:
        gaps = [(t, v) for t, v in (("lines never run", r["missed"]), ("partial lines", r["partial"]),
                                    ("statements never run (line)", r["stmts_missed"]), ("branches never taken", r["br_missed"]),
                                    ("V8 blocks never run (line)", r["blocks_missed"]), ("functions never called", r["unrun"])) if v]
        if gaps:
            print("\n" + r["file"])
            for t, v in gaps: print("  %s: %s" % (t, ", ".join(map(str, v))))
    if not ts: print("\nno TypeScript parser found (--ts): statements and branches skipped, functions are V8's list")
    print("\nparser:", ts or "none")
    print("runs:", ", ".join("%s (exit %d, %d records)" % (l, c, len(s)) for l, c, s, _ in runs))
    print("report:", OUT)
    for p in problems: print("PROBLEM: " + p)
    for l, c, _, t in runs:
        if c != 0: print("\n--- %s exited %d; its output ends:\n%s" % (l, c, t))
    bad = [l for l, c, _, _ in runs if c != 0] + [p for p in problems if "is lost" in p]
    if bad:   # coverage from a failing or silent run is not a result: say so, and fail
        print("FAILED: " + "; ".join(bad))
        sys.exit(1)

def write_html(report, runs, ts):
    T = lambda k: sum(r[k] or 0 for r in report)
    pc = lambda a, b: int(10000.0 * a / b) / 100.0 if b else 0.0
    cell = lambda a, b: '<td class=n>%s</td>' % ("%d / %d" % (a, b) if b is not None else "-")
    rows, bodies = [], []
    for r in report:
        pct = pc(r["covered"], r["lines"])
        fid = r["file"].replace("/", "-").replace(".", "-")
        rows.append('<tr><td><a href="#%s">%s</a></td><td class=n>%.2f%%</td><td><div class=bar><i style="width:%.1f%%"></i></div></td>'
                    '%s%s%s%s%s<td class=n>%d</td></tr>'
                    % (fid, r["file"], pct, pct, cell(r["covered"], r["lines"]), cell(r["stmts_hit"], r["stmts"]),
                       cell(r["br_hit"], r["br"]), cell(r["blocks_hit"], r["blocks"]), cell(r["funcs_hit"], r["funcs"]), len(r["partial"])))
        miss, part = set(r["missed"]), set(r["partial"])
        code = []
        for no, text in enumerate(r["src"].split("\n"), 1):
            cls = "m" if no in miss else "p" if no in part else ""
            code.append('<tr class="%s"><td class=ln>%d</td><td><pre>%s</pre></td></tr>' % (cls, no, html.escape(text.rstrip("\r"))))
        notes = "".join("<p class=un>%s: %s</p>" % (t, html.escape(", ".join(map(str, v or [])) or "none")) for t, v in (
            ("Functions never called", r["unrun"]), ("Statements never run (line)", r["stmts_missed"]),
            ("Branches never taken", r["br_missed"]), ("V8 blocks never run (line)", r["blocks_missed"])))
        bodies.append('<section id="%s"><h2>%s <span>%.2f%% of %d lines &middot; %d/%d functions</span></h2>%s<table class=src>%s</table></section>'
                      % (fid, r["file"], pct, r["lines"], r["funcs_hit"], r["funcs"], notes, "".join(code)))
    page = """<!doctype html><meta charset=utf-8><title>Dvoretsky Lab coverage</title>
<style>body{margin:0;background:#0b0f16;color:#dfe7ef;font:14px system-ui,Segoe UI,sans-serif}main{max-width:1100px;margin:auto;padding:28px}
h1{font:600 24px Consolas,monospace}h2{font:600 15px Consolas,monospace;position:sticky;top:0;background:#131b27;padding:9px 12px;margin:28px 0 0;border:1px solid #1f2a38}
h2 span{color:#8fa1b3;font-weight:400}a{color:#3fd3f2}table{border-collapse:collapse;width:100%%}
.sum td,.sum th{padding:7px 10px;border-bottom:1px solid #1f2a38;text-align:left}.n{text-align:right;font-family:Consolas,monospace}
.bar{background:#1f2a38;height:9px;width:120px}.bar i{display:block;height:9px;background:#5fe0a0}
.src{font:12.5px/1.45 Consolas,monospace;border:1px solid #1f2a38;border-top:0}.src pre{margin:0;white-space:pre-wrap}
.src td{padding:0 8px;vertical-align:top}.ln{color:#4d5b6a;text-align:right;user-select:none;width:44px}
tr.m{background:rgba(255,107,107,.16)}tr.p{background:rgba(242,193,78,.13)}.un{color:#8fa1b3;margin:8px 0}
.key span{display:inline-block;padding:1px 8px;margin-right:8px}</style><main>
<h1>&gt; Dvoretsky Lab &middot; coverage %.2f%% of lines</h1>
<p>Lines %d/%d, statements %d/%d, branches %d/%d, V8 blocks %d/%d, functions %d/%d, across %d runs: %s. Parser: %s.</p>
<p class=key><span style="background:rgba(255,107,107,.3)">never ran</span><span style="background:rgba(242,193,78,.25)">ran, but part of the line did not</span></p>
<table class=sum><tr><th>file</th><th class=n>lines</th><th></th><th class=n>lines</th><th class=n>statements</th><th class=n>branches</th><th class=n>V8 blocks</th><th class=n>functions</th><th class=n>partial</th></tr>%s</table>
%s</main>""" % (pc(T("covered"), T("lines")), T("covered"), T("lines"), T("stmts_hit"), T("stmts"), T("br_hit"), T("br"),
                T("blocks_hit"), T("blocks"), T("funcs_hit"), T("funcs"), len(runs), html.escape(", ".join(l for l, _, _, _ in runs)),
                html.escape(ts or "none"), "".join(rows), "".join(bodies))
    with open(OUT, "w", encoding="utf-8") as f: f.write(page)

if __name__ == "__main__":
    main()
