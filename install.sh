#!/usr/bin/env bash
# Orblood — one-shot VPS installer (fresh Ubuntu 22.04 / 24.04, as root).
#
#   1. installs Node 20 (if missing), MariaDB, nginx, coturn, certbot, git
#   2. tunes MariaDB (utf8mb4, bound to 127.0.0.1)
#   3. generates random DB / JWT secrets into /etc/orblood/secrets.env
#   4. clones (or updates) the repo into /opt/orblood
#   5. runs deploy.sh  (server/.env, npm, migrations, systemd, nginx)
#   6. runs scripts/setup-voice.sh  (coturn on :443 with TURN REST secret)
#   7. firewall + daily backup cron
#
# Re-run safe. Usage:
#   sudo DOMAIN=orblood.ir bash install.sh
#   sudo DOMAIN=orblood.ir REPO_BRANCH=main bash install.sh

set -euo pipefail

say()  { printf '\n\033[1;36m== %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m!! %s\033[0m\n' "$*"; }
fail() { printf '\033[1;31m!! %s\033[0m\n' "$*"; exit 1; }

[ "$(id -u)" = "0" ] || fail "Run me as root: sudo bash install.sh"
. /etc/os-release 2>/dev/null || true
case "${ID:-}" in ubuntu|debian) ;; *) warn "Untested on ${ID:-unknown} — proceeding anyway." ;; esac

DOMAIN="${DOMAIN:-}"
REPO_URL="${REPO_URL:-https://github.com/pvwvuow/orb-lood.git}"
REPO_BRANCH="${REPO_BRANCH:-main}"
INSTALL_DIR="${INSTALL_DIR:-/opt/orblood}"
APP_USER="${APP_USER:-orblood}"
SETUP_VOICE="${SETUP_VOICE:-1}"

if [ -z "$DOMAIN" ]; then read -rp "Domain (e.g. orblood.ir): " DOMAIN; fi
[ -n "$DOMAIN" ] || fail "DOMAIN required."

# ------ secrets (cached so re-runs reuse the same values) ------
SECRETS_DIR=/etc/orblood
SECRETS_FILE="$SECRETS_DIR/secrets.env"
mkdir -p "$SECRETS_DIR" && chmod 700 "$SECRETS_DIR"
touch "$SECRETS_FILE" && chmod 600 "$SECRETS_FILE"
get_secret() { grep -E "^$1=" "$SECRETS_FILE" | tail -1 | cut -d= -f2- || true; }
put_secret() { sed -i "/^$1=/d" "$SECRETS_FILE"; echo "$1=$2" >> "$SECRETS_FILE"; }

DB_PASSWORD="$(get_secret DB_PASSWORD)"
[ -n "$DB_PASSWORD" ] || { DB_PASSWORD="$(openssl rand -hex 24)"; put_secret DB_PASSWORD "$DB_PASSWORD"; }
[ -n "$(get_secret JWT_SECRET)" ] || put_secret JWT_SECRET "$(openssl rand -hex 48)"

# ------ 1. apt packages ------
say "Installing apt packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq

# Node 20. Many Iranian datacenters cannot reach deb.nodesource.com; in that
# case install Node manually first and re-run.
if ! command -v node >/dev/null || ! node --version | grep -qE '^v(18|20|22|24)'; then
  apt-get install -y -qq curl ca-certificates gnupg
  if curl -fsSL --max-time 30 https://deb.nodesource.com/setup_20.x -o /tmp/nodesource.sh; then
    bash /tmp/nodesource.sh >/dev/null
    apt-get install -y -qq nodejs
  else
    fail "Could not download the NodeSource script. Install Node 20 manually, then re-run."
  fi
fi

apt-get install -y -qq git rsync curl mariadb-server mariadb-client nginx certbot coturn \
  ufw openssl jq python3 unattended-upgrades apt-listchanges

cat > /etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
EOF
systemctl enable --now unattended-upgrades.service 2>/dev/null || true

# ------ 2. user ------
id "$APP_USER" >/dev/null 2>&1 || useradd --system --create-home --shell /usr/sbin/nologin "$APP_USER"

# ------ 3. MariaDB ------
say "Tuning MariaDB"
cat > /etc/mysql/mariadb.conf.d/60-orblood.cnf <<EOF
[mysqld]
bind-address            = 127.0.0.1
innodb_buffer_pool_size = 512M
max_connections         = 100
character-set-server    = utf8mb4
collation-server        = utf8mb4_unicode_ci
EOF
systemctl enable --now mariadb
systemctl restart mariadb

say "Creating database + user"
mysql --protocol=socket -uroot <<SQL
CREATE DATABASE IF NOT EXISTS orblood CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS 'orblood'@'localhost' IDENTIFIED BY '$DB_PASSWORD';
CREATE USER IF NOT EXISTS 'orblood'@'127.0.0.1' IDENTIFIED BY '$DB_PASSWORD';
ALTER USER 'orblood'@'localhost' IDENTIFIED BY '$DB_PASSWORD';
ALTER USER 'orblood'@'127.0.0.1' IDENTIFIED BY '$DB_PASSWORD';
GRANT ALL ON orblood.* TO 'orblood'@'localhost';
GRANT ALL ON orblood.* TO 'orblood'@'127.0.0.1';
FLUSH PRIVILEGES;
SQL

# ------ 4. source ------
say "Fetching application source ($REPO_URL @ $REPO_BRANCH)"
if [ ! -d "$INSTALL_DIR/.git" ]; then
  if [ -d "$INSTALL_DIR" ] && [ -n "$(ls -A "$INSTALL_DIR" 2>/dev/null)" ]; then
    warn "$INSTALL_DIR exists but is not a git checkout — leaving it, deploying from a fresh clone"
    TMP_SRC="$(mktemp -d /tmp/orblood-src-XXXX)"
    git clone --depth 1 --branch "$REPO_BRANCH" "$REPO_URL" "$TMP_SRC"
    SRC="$TMP_SRC"
  else
    git clone --branch "$REPO_BRANCH" "$REPO_URL" "$INSTALL_DIR"
    SRC="$INSTALL_DIR"
  fi
else
  # Keeps server/.env, uploads and node_modules (untracked / ignored).
  git -C "$INSTALL_DIR" fetch origin "$REPO_BRANCH"
  git -C "$INSTALL_DIR" checkout "$REPO_BRANCH"
  git -C "$INSTALL_DIR" merge --ff-only "origin/$REPO_BRANCH" || fail "local changes in $INSTALL_DIR — commit/stash them first"
  SRC="$INSTALL_DIR"
fi

# ------ 5. app: .env, npm, migrations, systemd, nginx ------
say "Deploying the app"
DOMAIN="$DOMAIN" INSTALL_DIR="$INSTALL_DIR" bash "$SRC/deploy.sh"

# ------ 6. voice / TURN ------
if [ "$SETUP_VOICE" = "1" ]; then
  say "Setting up coturn (voice)"
  DOMAIN="$DOMAIN" INSTALL_DIR="$INSTALL_DIR" bash "$INSTALL_DIR/scripts/setup-voice.sh" install \
    || warn "voice setup had problems — re-run: sudo bash $INSTALL_DIR/scripts/setup-voice.sh"
fi

# ------ 7. firewall ------
say "Configuring UFW"
CURRENT_SSH_PORT="$(awk '/^Port / {print $2; exit}' /etc/ssh/sshd_config 2>/dev/null || true)"
[ -n "$CURRENT_SSH_PORT" ] || CURRENT_SSH_PORT=22
ufw allow "$CURRENT_SSH_PORT/tcp" >/dev/null
ufw allow 22/tcp >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw allow 443/udp >/dev/null
ufw allow 49152:65535/udp >/dev/null
yes | ufw enable >/dev/null 2>&1 || true

# ------ 8. backup cron (password in a root-only option file, not the script) ------
say "Installing daily backup cron"
cat > "$SECRETS_DIR/backup.cnf" <<EOF
[client]
user=orblood
password=$DB_PASSWORD
EOF
chmod 600 "$SECRETS_DIR/backup.cnf"
cat > /etc/cron.daily/orblood-backup <<EOF
#!/bin/bash
set -e
DEST=/var/backups/orblood
DATE=\$(date +%F)
mkdir -p "\$DEST" && chmod 700 "\$DEST"
mysqldump --defaults-extra-file=$SECRETS_DIR/backup.cnf --single-transaction orblood | gzip > "\$DEST/orblood-\$DATE.sql.gz"
tar -czf "\$DEST/uploads-\$DATE.tar.gz" -C $INSTALL_DIR/server uploads
find "\$DEST" -name '*.gz' -mtime +14 -delete
EOF
chmod 700 /etc/cron.daily/orblood-backup

say "All done."
echo
echo "  Site:     https://$DOMAIN   (ArvanCloud terminates HTTPS, origin is :80)"
echo "  Status:   systemctl status orblood"
echo "  Logs:     journalctl -u orblood -f"
echo "  Secrets:  $SECRETS_FILE (root only)"
echo "  Smoke:    curl -s http://127.0.0.1:4000/api/healthz"
