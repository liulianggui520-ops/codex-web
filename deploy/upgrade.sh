#!/usr/bin/env bash
set -euo pipefail
[[ $EUID -eq 0 ]] || { printf 'Run with sudo\n' >&2; exit 1; }
[[ -f /etc/codex-workbench.env ]] || { printf 'Install first\n' >&2; exit 1; }
# The installer generates shell-compatible values and never stores model credentials here.
. /etc/codex-workbench.env
DOMAIN=${PUBLIC_ORIGIN#https://}
SOURCE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
exec bash "$SOURCE/install.sh" --upgrade --domain "$DOMAIN" --workspace "$WORKSPACE_ROOT"
