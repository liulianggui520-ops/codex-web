#!/usr/bin/env bash
set -uo pipefail
printf '\n=== Service status ===\n'
systemctl --no-pager --full status codex-engine.service codex-web.service codex-updater.service caddy.service
printf '\n=== Resource budget ===\n'
systemctl show codex-workbench.slice -p MemoryCurrent -p MemoryHigh -p MemoryMax -p CPUQuotaPerSecUSec
printf '\n=== Versions ===\n'
/opt/codex-workbench/runtime/bin/node --version
if [[ -r /etc/codex-workbench.env ]]; then . /etc/codex-workbench.env; PATH=/opt/codex-workbench/runtime/bin:/usr/bin:/bin "$CODEX_BINARY" --version; fi
printf '\n=== Local health ===\n'
if [[ -r /etc/codex-workbench.env ]]; then
  . /etc/codex-workbench.env
  curl --fail --max-time 5 --header "Host: ${PUBLIC_ORIGIN#https://}" http://127.0.0.1:47832/healthz
fi
printf '\n=== Recent service logs (contains no auth cache dumps) ===\n'
journalctl --namespace=codex-workbench -u codex-web.service -u codex-engine.service -u codex-updater.service --no-pager -n 50
