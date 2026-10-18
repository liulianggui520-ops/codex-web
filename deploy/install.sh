#!/usr/bin/env bash
set -euo pipefail
BASE=/opt/codex-workbench
STATE=/var/lib/codex-workbench
SOURCE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
DOMAIN=''
WORKSPACE=/srv/codex-workspaces
UPGRADE=0
while (($#)); do
  case "$1" in
    --domain) DOMAIN=${2:?domain required}; shift 2;;
    --workspace) WORKSPACE=${2:?workspace required}; shift 2;;
    --upgrade) UPGRADE=1; shift;;
    *) printf 'Unknown option: %s\n' "$1" >&2; exit 2;;
  esac
done
[[ $EUID -eq 0 ]] || { printf 'Run with sudo bash deploy/install.sh --domain codex.example.com\n' >&2; exit 1; }
[[ -f /etc/os-release ]] || exit 1
. /etc/os-release
[[ "${ID:-}" == ubuntu || "${ID:-}" == debian ]] || { printf 'Only Ubuntu/Debian are supported\n' >&2; exit 1; }
[[ "$DOMAIN" =~ ^[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?$ && "$DOMAIN" == *.* && "$DOMAIN" != *..* ]] || { printf 'Supply a DNS hostname with --domain\n' >&2; exit 1; }
[[ "$WORKSPACE" =~ ^/[a-zA-Z0-9_./-]+$ && "$WORKSPACE" != / ]] || { printf 'Use an absolute workspace path containing letters, digits, dots, underscores, slashes or hyphens\n' >&2; exit 1; }
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y ca-certificates curl git xz-utils ripgrep logrotate caddy bubblewrap
if [[ "$ID" == ubuntu && "${VERSION_ID:-}" == 24.04 ]] && [[ -e /sys/module/apparmor/parameters/enabled ]] && grep -q Y /sys/module/apparmor/parameters/enabled; then
  apt-get install -y apparmor-profiles apparmor-utils
  if [[ -f /usr/share/apparmor/extra-profiles/bwrap-userns-restrict && ! -f /etc/apparmor.d/bwrap-userns-restrict ]]; then
    install -m 0644 /usr/share/apparmor/extra-profiles/bwrap-userns-restrict /etc/apparmor.d/bwrap-userns-restrict
    apparmor_parser -r /etc/apparmor.d/bwrap-userns-restrict
  fi
fi
install -d -m 0755 "$BASE" "$BASE/releases" "$BASE/bin" "$BASE/.downloads"
if [[ ! -x "$BASE/runtime/bin/node" ]]; then
  case "$(uname -m)" in x86_64) ARCH=x64;; aarch64|arm64) ARCH=arm64;; *) printf 'Unsupported architecture\n' >&2; exit 1;; esac
  NODE_VERSION=v24.19.0
  NODE_ARCHIVE="node-$NODE_VERSION-linux-$ARCH.tar.xz"
  curl -fSL --retry 3 "https://nodejs.org/dist/$NODE_VERSION/$NODE_ARCHIVE" -o "$BASE/.downloads/$NODE_ARCHIVE"
  curl -fSL --retry 3 "https://nodejs.org/dist/$NODE_VERSION/SHASUMS256.txt" -o "$BASE/.downloads/SHASUMS256.txt"
  EXPECTED=$(awk -v name="$NODE_ARCHIVE" '$2==name { print $1 }' "$BASE/.downloads/SHASUMS256.txt")
  [[ "$EXPECTED" =~ ^[a-f0-9]{64}$ ]] || { printf 'Missing Node checksum\n' >&2; exit 1; }
  printf '%s  %s\n' "$EXPECTED" "$BASE/.downloads/$NODE_ARCHIVE" | sha256sum --check
  install -d -m 0755 "$BASE/runtime"
  tar -xJf "$BASE/.downloads/$NODE_ARCHIVE" -C "$BASE/runtime" --strip-components=1
fi
export PATH="$BASE/runtime/bin:/usr/local/bin:/usr/bin:/bin"
[[ "$(node -p 'process.versions.node.split(".")[0]')" == 24 ]] || { printf 'Node 24 required\n' >&2; exit 1; }
node "$SOURCE/scripts/verify.mjs" "$SOURCE"
RELEASE=$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).releaseId' "$SOURCE/release.json")
ENGINE_VERSION=$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).codexVersion' "$SOURCE/release.json")
if ! id codexweb >/dev/null 2>&1; then useradd --system --user-group --home-dir "$STATE" --shell /bin/bash codexweb; fi
install -d -o codexweb -g codexweb -m 0700 "$STATE" "$STATE/web" "$STATE/codex" "$STATE/backups"
if [[ ! -d "$WORKSPACE" ]]; then install -d -o codexweb -g codexweb -m 0750 "$WORKSPACE"; fi
runuser -u codexweb -- test -r "$WORKSPACE" || { printf 'codexweb must be able to read the workspace directory\n' >&2; exit 1; }
runuser -u codexweb -- test -w "$WORKSPACE" || { printf 'codexweb must be able to write the workspace directory; ownership was not changed automatically\n' >&2; exit 1; }
OLD_ENGINE=$(sed -n 's/^CODEX_BINARY=//p' /etc/codex-workbench.env 2>/dev/null || true)
ENGINE_DIR="$BASE/engines/$ENGINE_VERSION"
if [[ -x "$BASE/engine/node_modules/.bin/codex" ]] && "$BASE/engine/node_modules/.bin/codex" --version | grep -Fx "codex-cli $ENGINE_VERSION" >/dev/null; then ENGINE_DIR="$BASE/engine"; fi
if [[ ! -x "$ENGINE_DIR/node_modules/.bin/codex" ]]; then
  npm install --prefix "$ENGINE_DIR" --omit=dev --no-audit --no-fund "@openai/codex@$ENGINE_VERSION"
fi
"$ENGINE_DIR/node_modules/.bin/codex" --version | grep -F "codex-cli $ENGINE_VERSION" >/dev/null || { printf 'Installed engine does not match the locked protocol\n' >&2; exit 1; }
if [[ -d "$BASE/releases/$RELEASE" ]]; then node "$BASE/releases/$RELEASE/scripts/verify.mjs" "$BASE/releases/$RELEASE"; else
  install -d -m 0755 "$BASE/releases/$RELEASE"
  cp -a "$SOURCE/." "$BASE/releases/$RELEASE/"
  chown -R root:root "$BASE/releases/$RELEASE"
  chmod -R a+rX,go-w "$BASE/releases/$RELEASE"
fi
if [[ -L "$BASE/current" ]]; then
  PREVIOUS=$(readlink -f "$BASE/current")
  [[ "$PREVIOUS" == "$BASE/releases/"* ]] || { printf 'Current release path is outside releases\n' >&2; exit 1; }
  if [[ "$PREVIOUS" != "$BASE/releases/$RELEASE" ]]; then ln -sfn "$PREVIOUS" "$BASE/previous"; fi
fi
if [[ "$UPGRADE" == 1 ]]; then
  systemctl stop codex-web.service || true
  if [[ -f "$STATE/web/web.sqlite" ]]; then
    node "$SOURCE/scripts/state-backup.mjs" "$STATE/web/web.sqlite" "$STATE/backups/web-$(date -u +%Y%m%dT%H%M%SZ).sqlite"
    chown codexweb:codexweb "$STATE/backups/"*.sqlite
  fi
fi
install -m 0755 "$SOURCE/deploy/start-engine.sh" "$BASE/bin/start-engine.sh"
cat > /etc/codex-workbench.env <<EOF
PUBLIC_ORIGIN=https://$DOMAIN
PORT=47832
DATA_DIR=$STATE/web
CODEX_HOME=$STATE/codex
CODEX_SOCKET=/run/codex-workbench/engine.sock
UPDATE_SOCKET=/run/codex-workbench-updater/control.sock
CODEX_BINARY=$ENGINE_DIR/node_modules/.bin/codex
WORKSPACE_ROOT="$WORKSPACE"
PATH=$BASE/runtime/bin:/usr/local/bin:/usr/bin:/bin
EOF
chown root:codexweb /etc/codex-workbench.env
chmod 0640 /etc/codex-workbench.env
install -m 0644 "$SOURCE/deploy/codex-workbench.slice" /etc/systemd/system/codex-workbench.slice
install -m 0644 "$SOURCE/deploy/codex-engine.service" /etc/systemd/system/codex-engine.service
install -m 0644 "$SOURCE/deploy/codex-web.service" /etc/systemd/system/codex-web.service
# Root updater is fixed at installation time; downloaded releases never replace its code.
install -d -m 0755 "$BASE/updater/server"
cp "$SOURCE/server/"{update-daemon,update-core,release}.mjs "$BASE/updater/server/"
cp "$SOURCE/package.json" "$BASE/updater/package.json"
cp -a "$SOURCE/node_modules" "$BASE/updater/"
chown -R root:root "$BASE/updater"
chmod -R a+rX,go-w "$BASE/updater"
install -m 0644 "$SOURCE/deploy/codex-updater.service" /etc/systemd/system/codex-updater.service
cat > /etc/systemd/journald@codex-workbench.conf <<'EOF'
[Journal]
Storage=persistent
SystemMaxUse=100M
MaxRetentionSec=7day
EOF
cat > /etc/logrotate.d/codex-workbench <<'EOF'
/var/lib/codex-workbench/codex/log/*.log {
    daily
    maxsize 20M
    rotate 7
    compress
    missingok
    notifempty
    copytruncate
    su codexweb codexweb
}
EOF
install -d -m 0755 /etc/caddy
if [[ -f /etc/caddy/Caddyfile ]]; then cp -p /etc/caddy/Caddyfile "/etc/caddy/Caddyfile.before-codex-$(date -u +%Y%m%dT%H%M%SZ)"; else touch /etc/caddy/Caddyfile; fi
sed "s/DOMAIN_PLACEHOLDER/$DOMAIN/g" "$SOURCE/deploy/Caddyfile.template" > /etc/caddy/codex-workbench.caddy
grep -qxF 'import /etc/caddy/codex-workbench.caddy' /etc/caddy/Caddyfile || printf '\nimport /etc/caddy/codex-workbench.caddy\n' >> /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
ln -sfn "$BASE/releases/$RELEASE" "$BASE/current.next"
mv -Tf "$BASE/current.next" "$BASE/current"
systemctl daemon-reload
systemctl enable --now codex-engine.service codex-updater.service codex-web.service caddy.service
if [[ -n "$OLD_ENGINE" && "$OLD_ENGINE" != "$ENGINE_DIR/node_modules/.bin/codex" ]]; then systemctl restart codex-engine.service; fi
systemctl restart codex-updater.service
systemctl restart codex-web.service
systemctl reload caddy.service
printf '\nInstalled %s\nOpen https://%s after DNS and ports 80/443 are ready.\n' "$RELEASE" "$DOMAIN"
printf '\nSet the persistent web password:\n'
printf 'sudo -u codexweb env DATA_DIR=%s/web %s/runtime/bin/node %s/current/scripts/password.mjs\n' "$STATE" "$BASE" "$BASE"
printf '\nSign in to Codex (under the SAME service user and CODEX_HOME):\n'
printf 'sudo -u codexweb env CODEX_HOME=%s/codex PATH=%s/runtime/bin:/usr/bin:/bin %s/node_modules/.bin/codex login --device-auth\n' "$STATE" "$BASE" "$ENGINE_DIR"
