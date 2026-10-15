#!/usr/bin/env bash
# =============================================================================
# Orblood — rotate every server secret that was ever published in git.
#
#   sudo bash scripts/rotate-secrets.sh            # JWT + TURN
#   ROTATE_DB=1 sudo bash scripts/rotate-secrets.sh  # + MySQL/MariaDB password
#
# - JWT_SECRET: new random value. Every user has to log in once more
#   (old tokens, including any forged with the leaked secret, die).
# - TURN: switches coturn to `use-auth-secret` with a fresh TURN_SECRET;
#   the old static password stops working. (Runs setup-voice.sh.)
# - DB (optional): new password for the `orblood` DB user.
#
# New values live in /etc/orblood/secrets.env (root only) and
# /opt/orblood/server/.env (orblood user only). Never commit them.
# =============================================================================
set -euo pipefail

say()  { printf '\n\033[1;36m== %s\033[0m\n' "$*"; }
ok()   { printf '\033[1;32m  ✓ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m  ! %s\033[0m\n' "$*"; }
fail() { printf '\033[1;31m  ✗ %s\033[0m\n' "$*"; exit 1; }

[ "$(id -u)" = "0" ] || fail "Run as root: sudo bash scripts/rotate-secrets.sh"
command -v openssl >/dev/null || fail "openssl is required"

INSTALL_DIR="${INSTALL_DIR:-/opt/orblood}"
ENV_FILE="$INSTALL_DIR/server/.env"
SECRETS_FILE=/etc/orblood/secrets.env
HERE="$(cd "$(dirname "$0")" && pwd)"

[ -f "$ENV_FILE" ] || fail "$ENV_FILE not found — deploy first (sudo bash deploy.sh)"

set_kv() {
  local file="$1" key="$2" val="$3"
  touch "$file"
  python3 - "$file" "$key" "$val" <<'PY'
import sys, pathlib
path, key, val = sys.argv[1], sys.argv[2], sys.argv[3]
p = pathlib.Path(path)
out, done = [], False
for line in p.read_text().splitlines():
    if line.startswith(key + '='):
        if not done: out.append(f"{key}={val}")
        done = True
    else:
        out.append(line)
if not done: out.append(f"{key}={val}")
p.write_text('\n'.join(out) + '\n')
PY
}

mkdir -p /etc/orblood && chmod 700 /etc/orblood
touch "$SECRETS_FILE" && chmod 600 "$SECRETS_FILE"

say "Rotating JWT_SECRET"
JWT="$(openssl rand -hex 48)"
set_kv "$SECRETS_FILE" JWT_SECRET "$JWT"
set_kv "$ENV_FILE" JWT_SECRET "$JWT"
ok "new JWT_SECRET written (all users will need to log in again)"

if [ "${ROTATE_DB:-0}" = "1" ]; then
  say "Rotating the database password"
  DB_USER="$(grep -E '^DB_USER=' "$ENV_FILE" | tail -1 | cut -d= -f2-)"; DB_USER="${DB_USER:-orblood}"
  DB_PASS="$(openssl rand -hex 24)"
  if mysql -u root -e "ALTER USER '${DB_USER}'@'localhost' IDENTIFIED BY '${DB_PASS}'; FLUSH PRIVILEGES;" 2>/dev/null \
     || mysql -u root -e "SET PASSWORD FOR '${DB_USER}'@'localhost' = PASSWORD('${DB_PASS}'); FLUSH PRIVILEGES;" 2>/dev/null; then
    mysql -u root -e "ALTER USER '${DB_USER}'@'127.0.0.1' IDENTIFIED BY '${DB_PASS}';" 2>/dev/null || true
    set_kv "$SECRETS_FILE" DB_PASSWORD "$DB_PASS"
    set_kv "$ENV_FILE" DB_PASSWORD "$DB_PASS"
    ok "DB password rotated for ${DB_USER}"
  else
    warn "could not ALTER USER as root (no socket auth?). DB password unchanged."
  fi
fi

chown orblood:orblood "$ENV_FILE" 2>/dev/null || true
chmod 600 "$ENV_FILE"

say "Rotating TURN credentials (coturn → use-auth-secret)"
if [ -f "$HERE/setup-voice.sh" ]; then
  NEW_TURN_SECRET=1 ISSUE_CERT="${ISSUE_CERT:-0}" INSTALL_DIR="$INSTALL_DIR" bash "$HERE/setup-voice.sh" install
else
  warn "setup-voice.sh not found next to this script; TURN not rotated"
fi

say "Restarting backend"
systemctl restart orblood
sleep 2
if systemctl is-active --quiet orblood; then ok "orblood is running"; else warn "orblood failed: journalctl -u orblood -n 30"; fi

cat <<'EOM'

Done. Still to do by hand (cannot be scripted from here):
  * The old values are still visible in the public git history. They are
    now useless, but if you want them gone, rewrite history with
    git-filter-repo / BFG and force-push, or make the repo private.
  * If you ever reused the leaked DB password anywhere else, change it there.
EOM
