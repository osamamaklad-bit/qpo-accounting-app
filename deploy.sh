#!/usr/bin/env bash
# Push src/ to the Apps Script project and update the live web app (same /exec URL).
# Usage: SCRIPT_ID=xxxx ./deploy.sh        (first time: run `clasp login` once)
set -euo pipefail
cd "$(dirname "$0")"

DEPLOYMENT_ID="${DEPLOYMENT_ID:-AKfycby5qiOh4iZ902dce7d7sPaKOmZy3pH92fCqL6mDwAfnPtIIC3ZjRDUlFCVsMhALMTUv}"

command -v clasp >/dev/null || npm install -g @google/clasp@2.4.2
[ -f "$HOME/.clasprc.json" ] || clasp login

if [ ! -f .clasp.json ]; then
  : "${SCRIPT_ID:?Set SCRIPT_ID (Apps Script > Project Settings > Script ID)}"
  printf '{"scriptId":"%s","rootDir":"src"}\n' "$SCRIPT_ID" > .clasp.json
fi

clasp push -f
clasp deploy -i "$DEPLOYMENT_ID" -d "deploy $(git rev-parse --short HEAD 2>/dev/null || date +%F)"
echo "Done: https://script.google.com/macros/s/$DEPLOYMENT_ID/exec"
