#!/usr/bin/env bash
set -euo pipefail
cd "${WORKSPACE_ROOT:?WORKSPACE_ROOT is required}"
exec "${CODEX_BINARY:?CODEX_BINARY is required}" app-server --listen "unix://${CODEX_SOCKET:?CODEX_SOCKET is required}"
