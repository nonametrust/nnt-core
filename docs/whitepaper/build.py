#!/usr/bin/env python3
"""Render the whitepaper sources to PDF.

    python3 docs/whitepaper/build.py            # both languages
    python3 docs/whitepaper/build.py en         # one language

Pipeline: Markdown -> HTML (pandoc, template.html + style.css) -> PDF (headless
Chrome). Figures are inlined into the HTML so the bundled fonts reach the SVG
text. Output lands in docs/whitepaper/build/, which is not tracked.

Needs pandoc 3 and Google Chrome (or Chromium) on the machine. Nothing else.
"""
import os, re, shutil, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "build")
LANGS = sys.argv[1:] or ["tr", "en"]

CHROME_CANDIDATES = [
    os.environ.get("CHROME"),
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    shutil.which("google-chrome"), shutil.which("chromium"), shutil.which("chromium-browser"),
]


def chrome():
    for c in CHROME_CANDIDATES:
        if c and os.path.exists(c):
            return c
    sys.exit("no Chrome or Chromium found; set CHROME=/path/to/binary")


def inline_svgs(html):
    def sub(m):
        src = m.group(1)
        path = os.path.join(HERE, src)
        if not path.endswith(".svg") or not os.path.exists(path):
            return m.group(0)
        svg = open(path, encoding="utf-8").read()
        svg = re.sub(r"^<\?xml[^>]*\?>\s*", "", svg)
        return svg
    return re.sub(r'<img src="([^"]+)"[^>]*/?>', sub, html)


def build(lang):
    os.makedirs(OUT, exist_ok=True)
    src = os.path.join(HERE, f"nonametrust-whitepaper.{lang}.md")
    html_path = os.path.join(OUT, f"nonametrust-whitepaper.{lang}.html")
    pdf_path = os.path.join(OUT, f"nonametrust-whitepaper.{lang}.pdf")
    html = subprocess.run(
        ["pandoc", src, "--from", "markdown-smart-tex_math_dollars", "--to", "html5",
         "--standalone", "--template", os.path.join(HERE, "template.html"), "--wrap=none"],
        check=True, capture_output=True, text=True).stdout
    html = inline_svgs(html)
    open(html_path, "w", encoding="utf-8").write(html)
    subprocess.run(
        [chrome(), "--headless=new", "--disable-gpu", "--no-pdf-header-footer",
         "--run-all-compositor-stages-before-draw", "--virtual-time-budget=10000",
         f"--print-to-pdf={pdf_path}", "file://" + html_path],
        check=True, capture_output=True)
    print(pdf_path)


if __name__ == "__main__":
    for lang in LANGS:
        build(lang)
