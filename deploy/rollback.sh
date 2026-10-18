#!/usr/bin/env bash
set -euo pipefail
[[ $EUID -eq 0 ]] || { printf 'Run with sudo\n' >&2; exit 1; }
BASE=/opt/codex-workbench
PREVIOUS=$(readlink -f "$BASE/previous")
CURRENT=$(readlink -f "$BASE/current")
[[ "$PREVIOUS" == "$BASE/releases/"* && -f "$PREVIOUS/release.json" ]] || { printf 'No valid previous release\n' >&2; exit 1; }
"$BASE/runtime/bin/node" "$PREVIOUS/scripts/verify.mjs" "$PREVIOUS"
systemctl stop codex-web.service
ln -sfn "$PREVIOUS" "$BASE/current.next"
mv -Tf "$BASE/current.next" "$BASE/current"
ln -sfn "$CURRENT" "$BASE/previous"
systemctl start codex-web.service
printf 'Rolled back web code to %s. Native Codex data and web state were preserved.\n' "$PREVIOUS"
