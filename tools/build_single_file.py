"""Build one self-contained HTML file: index.html with the stylesheet and every script inlined.

    python tools/build_single_file.py [out.html]      # default: dist/Dvoretsky-Lab.html

The result opens by double-click and needs nothing beside it -- no css/, no js/,
no server. That includes Stockfish, which already ships as a string for exactly
this reason (js/vendor/README.md).
"""
import io, os, re, sys

ROOT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, "dist", "Dvoretsky-Lab.html")
read = lambda rel: io.open(os.path.join(ROOT, rel), encoding="utf-8").read()

page = read("index.html")
css = read("css/app.css")
if "url(" in css:
    raise SystemExit("css/app.css references an external url(); inlining would break it")
link = '<link rel="stylesheet" href="css/app.css">'
if page.count(link) != 1:
    raise SystemExit("expected exactly one stylesheet link in index.html")
page = page.replace(link, "<style>\n" + css + "\n</style>")

scripts = re.findall(r'<script src="(js/[a-z/\-]+\.js)"></script>', page)
for rel in scripts:
    js = read(rel)
    if "</script" in js.lower():
        raise SystemExit(rel + " contains </script, which would end the inlined tag early")
    page = page.replace('<script src="%s"></script>' % rel, "<script>/* %s */\n%s\n</script>" % (rel, js), 1)
if 'src="js/' in page or 'href="css/' in page:
    raise SystemExit("a script or stylesheet reference was left un-inlined")

os.makedirs(os.path.dirname(os.path.abspath(OUT)), exist_ok=True)
io.open(OUT, "w", encoding="utf-8").write(page)
print("wrote %s: %d KB, %d scripts inlined" % (OUT, len(page.encode()) // 1024, len(scripts)))
