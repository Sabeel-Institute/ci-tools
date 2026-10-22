# /// script
# requires-python = ">=3.10"
# dependencies = ["markdown==3.10.3"]
# ///
"""The app's user manual as a PDF: docs/USER-MANUAL.md -> docs/USER-MANUAL.pdf.

    sabeel-ci render-manual      # runs this with `uv run --script`, at the app's root

Every app's manual is rendered the same way, with Chrome headless:

- the cover carries the Sabeel logo (app/assets/logo.png), the app's name
  from app/app.json less "Sabeel Institute" or "Sabeel", which the logo
  already says, "User Manual", and app.json's version with this month;
- the markdown's own title and "*For app version X.Y.Z · <Month YYYY>*" line
  are dropped from the body, since the cover says both, and that line must
  name app.json's version: `sabeel-ci release` moves it, then renders;
- screenshots that differ between a phone and a computer come in pairs, a raw
  HTML block on contiguous lines (python-markdown passes it through), phone
  first:

      <div class="pair">
      <figure class="ph"><img src="manual/img/NAME-phone.png" alt="..."><figcaption>On a phone</figcaption></figure>
      <figure class="wd"><img src="manual/img/NAME-desktop.png" alt="..."><figcaption>On a computer</figcaption></figure>
      </div>

  and image paths are relative to docs/.

`sabeel-ci release` renders the PDF with the version bump and commits it, so
the PDF is the released manual; an edit to the markdown between releases needs
no render.
"""
import datetime
import json
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile
from base64 import b64encode

import markdown

ROOT = pathlib.Path.cwd()
DOCS = ROOT / 'docs'
SOURCE = DOCS / 'USER-MANUAL.md'
OUTPUT = DOCS / 'USER-MANUAL.pdf'
LOGO = ROOT / 'app/assets/logo.png'


def fail(message):
    sys.exit(f'render-manual: {message}')


app = json.loads((ROOT / 'app/app.json').read_text())['expo']
version = app['version']
title = re.sub(r'^Sabeel( Institute)? ', '', app['name'])
dateline = datetime.date.today().strftime('%B %Y')

for path in (SOURCE, LOGO):
    if not path.is_file():
        fail(f'no {path.relative_to(ROOT)}')
source = SOURCE.read_text()
stated = re.search(r'^\*For app version (\S+) · ', source, re.M)
if not stated:
    fail(f'{SOURCE.relative_to(ROOT)} has no "*For app version X.Y.Z · <Month YYYY>*" line under its title')
if stated.group(1) != version:
    fail(f'{SOURCE.relative_to(ROOT)} says version {stated.group(1)}, app/app.json {version}; '
         'update the line under the title (`sabeel-ci release` moves it)')

body = markdown.markdown(source, extensions=['tables', 'smarty', 'md_in_html'])
body = re.sub(r'<h1>.*?</h1>', '', body, count=1)
body = re.sub(r'<p><em>For app version.*?</em></p>', '', body, count=1)
logo = b64encode(LOGO.read_bytes()).decode()

html = f"""<!doctype html><html><head><meta charset="utf-8"><base href="{DOCS.as_uri()}/"><style>
  @page {{ size: A4; margin: 17mm 15mm; }}
  html {{ -webkit-print-color-adjust: exact; }}
  body {{ font-family: Georgia, 'Times New Roman', serif; color: #3A2F28;
         font-size: 13pt; line-height: 1.65; margin: 0; }}

  /* ---- Cover ---- */
  .cover {{ height: 240mm; display: flex; flex-direction: column;
            align-items: center; justify-content: center; text-align: center;
            page-break-after: always; }}
  .cover-logo {{ width: 110mm; border: none; }}
  .cover-title {{ font-size: 34pt; font-weight: bold; color: #83114F; margin-top: 14mm; }}
  .cover-sub {{ font-size: 20pt; color: #795E2A; margin-top: 4mm; }}
  .cover-meta {{ font-size: 12pt; color: #6A5748; margin-top: 18mm; }}

  /* ---- Headings: parts on fresh pages, never stranded above their content ---- */
  h1 {{ color: #83114F; font-size: 23pt; line-height: 1.25;
        border-bottom: 2.5px solid #C6A15B; padding-bottom: 8px;
        page-break-before: always; page-break-after: avoid; margin: 0 0 14px; }}
  h2 {{ color: #83114F; font-size: 16.5pt; margin: 26px 0 8px;
        page-break-after: avoid; }}
  h3 {{ color: #660D3E; font-size: 13.5pt; margin: 20px 0 6px;
        page-break-after: avoid; }}

  p, li {{ orphans: 3; widows: 3; }}
  ul, ol {{ padding-left: 22px; }}
  li {{ margin-bottom: 5px; }}

  /* ---- Screenshots: a lone image centred; a phone/desktop pair kept together,
     the phone first, each with a quiet caption ---- */
  img {{ display: block; width: 74mm; margin: 12px auto;
         border: 1px solid #DFD1C1; border-radius: 8px;
         page-break-inside: avoid; }}
  .pair {{ page-break-inside: avoid; margin: 16px 0 20px; text-align: center; }}
  .pair figure {{ margin: 6px auto 10px; }}
  .pair figcaption {{ font-size: 9.5pt; color: #6A5748; font-style: italic;
                      letter-spacing: 0.03em; margin-top: 4px; }}
  .pair figure.ph img {{ width: 56mm; margin: 0 auto; }}
  .pair figure.wd img {{ width: 165mm; margin: 0 auto; }}

  table {{ border-collapse: collapse; width: 100%; font-size: 11pt;
           page-break-inside: avoid; }}
  th, td {{ border: 1px solid #DFD1C1; padding: 7px 9px; text-align: left;
            vertical-align: top; }}
  th {{ background: #F6EBDD; color: #660D3E; }}

  code {{ font-family: 'DejaVu Sans Mono', monospace; font-size: 11pt;
          background: #F6EBDD; padding: 1px 5px; border-radius: 3px; }}
  strong {{ color: #660D3E; }}
  em {{ color: #6A5748; }}
  hr {{ border: none; border-top: 1px solid #C6A15B; margin: 24px 0; }}
  a {{ color: #83114F; }}
</style></head><body>
<div class="cover">
  <img class="cover-logo" src="data:image/png;base64,{logo}" alt="Sabeel Institute">
  <div class="cover-title">{title}</div>
  <div class="cover-sub">User Manual</div>
  <div class="cover-meta">App version {version} &nbsp;·&nbsp; {dateline}</div>
</div>
{body}</body></html>"""

chrome = shutil.which('google-chrome')
if not chrome:
    fail('google-chrome is not on the PATH; it prints the manual')
with tempfile.TemporaryDirectory(prefix='render-manual-') as scratch:
    page = pathlib.Path(scratch) / 'USER-MANUAL.html'
    page.write_text(html)
    printed = subprocess.run(
        [chrome, '--headless', '--disable-gpu', '--no-sandbox', '--generate-pdf-document-outline',
         '--no-pdf-header-footer', f'--user-data-dir={scratch}/profile', f'--print-to-pdf={OUTPUT}', page.as_uri()],
        capture_output=True, text=True,
    )
    if printed.returncode != 0:
        fail(f'Chrome could not print the manual (exit {printed.returncode}):\n{printed.stderr}')
print(f'{OUTPUT.relative_to(ROOT)}: v{version}, {dateline}, {OUTPUT.stat().st_size} bytes')
