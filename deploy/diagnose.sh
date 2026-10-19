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
printf '\n=== Updater logs ===\n'
journalctl --namespace=codex-workbench -u codex-updater.service --no-pager -n 40
printf '\n=== Web logs ===\n'
journalctl --namespace=codex-workbench -u codex-web.service --no-pager -n 30
printf '\n=== Engine logs ===\n'
journalctl --namespace=codex-workbench -u codex-engine.service --no-pager -n 20
printf '\n=== Updater recovery ===\n'
if [[ -f /var/lib/codex-workbench-updater/transaction.json ]]; then
  printf 'Pending transaction exists; preserve it for updater recovery.\n'
else
  printf 'No pending transaction.\n'
fi
if [[ -f /opt/codex-workbench/updater/server/update-health.mjs && -n "${PUBLIC_ORIGIN:-}" ]]; then
  /opt/codex-workbench/runtime/bin/node --input-type=module - "$PUBLIC_ORIGIN" <<'NODE'
import {probeWebHealth} from '/opt/codex-workbench/updater/server/update-health.mjs';
console.log(await probeWebHealth({origin:process.argv[2]}));
NODE
else
  printf 'Installed updater has no repaired native HTTP health probe; see README 2.1.5 recovery instructions.\n'
fi
