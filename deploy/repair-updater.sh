#!/usr/bin/env bash
set -euo pipefail
[[ $EUID -eq 0 ]] || { printf 'Run with sudo bash deploy/repair-updater.sh\n' >&2; exit 1; }
BASE=/opt/codex-workbench
STATE=/var/lib/codex-workbench-updater
SOURCE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
NODE="$BASE/runtime/bin/node"
[[ -x "$NODE" && -d "$BASE/updater/server" && -f /etc/codex-workbench.env ]] || { printf 'Existing updater installation required\n' >&2; exit 1; }
"$NODE" "$SOURCE/scripts/verify.mjs" "$SOURCE"
# Only install verified updater modules; preserve engine, web data and transaction journal.
for module in update-daemon update-core update-health release; do
  [[ -f "$SOURCE/server/$module.mjs" ]] || { printf 'Missing updater module: %s\n' "$module" >&2; exit 1; }
done
install -d -m 0700 "$STATE"
BACKUP=$(mktemp -d "$STATE/repair-backup-XXXXXX")
printf 'Updater backup: %s\nStopping updater before replacing verified modules...\n' "$BACKUP"
systemctl stop codex-updater.service
cp -a "$BASE/updater/server" "$BACKUP/server"
for module in update-daemon update-core update-health release; do
  install -o root -g root -m 0644 "$SOURCE/server/$module.mjs" "$BASE/updater/server/$module.mjs"
done
# Recovery checks the journaled previous release using the repaired health probe.
systemctl start codex-updater.service
. /etc/codex-workbench.env
"$NODE" --input-type=module - "$BASE/updater/server/update-health.mjs" "$PUBLIC_ORIGIN" "$SOURCE/server/update-client.mjs" "$UPDATE_SOCKET" <<'NODE'
import {pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
const {waitWebHealth}=await import(pathToFileURL(process.argv[2]).href);
const {UpdateClient}=await import(pathToFileURL(process.argv[4]).href);
const client=new UpdateClient(process.argv[5]),deadline=Date.now()+90000;
let status;
while(Date.now()<deadline){try{status=await client.request();break;}catch{await delay(500);}}
if(!status?.enabled||status.busy||!status.current?.releaseId)throw Error('Updater recovery did not finish; run deploy/diagnose.sh and inspect codex-updater logs');
const ok=await waitWebHealth({origin:process.argv[3],manifest:status.current,onFailure:message=>console.error(message)});
if(!ok)process.exit(1);
NODE
printf '\nUpdater repaired. Backup: %s\nRecovery may briefly restart the web service; the Codex engine was not restarted.\nNow run sudo bash deploy/upgrade.sh from this SAME verified release directory to upgrade the web service.\nOlder web clients may be unable to install updates through the page.\n' "$BACKUP"
