#!/bin/sh
# Fetch the pinned FastAPI checkout the eval scores against. Prints the path.
# Override with CODEQ_EVAL_REF (tag/branch) and CODEQ_EVAL_ROOT (destination).
set -eu

REF="${CODEQ_EVAL_REF:-0.121.1}"
DEST="${CODEQ_EVAL_ROOT:-${XDG_CACHE_HOME:-$HOME/.cache}/codeq-eval/fastapi}"

if [ -d "$DEST/.git" ]; then
  echo "already fetched: $DEST" >&2
elif [ -e "$DEST" ]; then
  echo "error: $DEST exists but is not a git checkout" >&2
  exit 1
else
  mkdir -p "$(dirname "$DEST")"
  git clone --quiet --depth 1 --branch "$REF" https://github.com/fastapi/fastapi "$DEST"
fi
echo "$DEST"
