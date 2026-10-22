"""docs/render-manual.py as the apps have it: refuses a manual whose version
line disagrees with app.json, and renders the PDF with app.json's version."""
import json
import pathlib
import re

HERE = pathlib.Path(__file__).parent
VERSION = json.loads((HERE.parent / 'app/app.json').read_text())['expo']['version']
stated = re.search(r'\*For app version (\S+) ·', (HERE / 'USER-MANUAL.md').read_text())
if not stated or stated.group(1) != VERSION:
    raise SystemExit(f'USER-MANUAL.md says {stated and stated.group(1)}, app.json {VERSION}')
(HERE / 'USER-MANUAL.pdf').write_text(f'PDF {VERSION}\n')
