#!/usr/bin/env bash
set -euo pipefail
# The app's user manual as a PDF, the same way in every app:
#
#   sabeel-ci render-manual    # docs/USER-MANUAL.md -> docs/USER-MANUAL.pdf
#
# `sabeel-ci release` runs it with the version bump and commits the PDF. The
# renderer is scripts/lib/render-manual.py, Python with its dependencies
# declared inline (PEP 723), so uv runs it in an environment of its own and
# nothing is installed into the app or the machine's Python. It needs uv and
# google-chrome; nothing before `npm ci` runs it.

: "${CI_TOOLS:?render-manual runs through sabeel-ci: npx sabeel-ci render-manual}"
if [ "$#" -ne 0 ]; then
  echo "usage: sabeel-ci render-manual" >&2
  exit 2
fi
command -v uv >/dev/null || {
  echo "render-manual: uv is not on the PATH (https://docs.astral.sh/uv/); it runs the renderer" >&2
  exit 1
}
exec uv run --quiet --script "$CI_TOOLS/scripts/lib/render-manual.py"
