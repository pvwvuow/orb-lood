#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────
# ORBLOOD — deploy from local ZIP (no internet needed)
#
# Usage:
#   1. Download ZIP from GitHub on your PC
#   2. Upload ZIP to server at /tmp/
#   3. Unzip it:  cd /tmp && unzip orb-lood-main.zip
#   4. Run:       sudo bash /tmp/orb-lood-main/deploy.sh
#
# What it does:
#   - Copies new files to /opt/orblood (preserves .env + uploads)
#   - Installs npm dependencies
#   - Updates DB schema WITHOUT deleting data
#   - Busts PWA cache so users see new version
#   - Restarts all services (orblood + nginx)
#
# What it does NOT do:
#   - Does NOT touch your database data
#   - Does NOT delete uploads
#   - Does NOT regenerate secrets/passwords
#   - Does NOT need internet access
# ─────────────────────────────────────────────────────────────────────

set -euo pipefail

# ── Pretty output ──
say()  { printf '\n\033[1;36m>> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m!! %s\033[0m\n' "$*"; }
fail() { printf '\033[1;31m!! %s\033[0m\n' "$*"; exit 1; }
ok()   { printf '\033[1;32m✓  %s\033[0m\n' "$*"; }

[ "$(id -u)" = "0" ] || fail "Run as root: sudo bash deploy.sh"

# ── Config ──
INSTALL_DIR="/opt/orblood"
APP_USER="orblood"
DOMAIN="${DOMAIN:-orblood.ir}"

# ── Detect source directory (where this script lives) ──
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Sanity check: make sure we have the expected files
[ -f "$SCRIPT_DIR/server/package.json" ] || fail "Cannot find server/package.json in $SCRIPT_DIR — are you running from the unzipped folder?"
[ -f "$SCRIPT_DIR/public/index.html" ]   || fail "Cannot find public/index.html in $SCRIPT_DIR"

say "Deploying ORBLOOD from: $SCRIPT_DIR"
say "Install directory: $INSTALL_DIR"

# ── Step 1: Stop service ──
say "Stopping orblood service..."
systemctl stop orblood 2>/dev/null || true
# Kill any leftover process on port 4000
kill $(lsof -t -i:4000) 2>/dev/null || true
sleep 1
ok "Service stopped"

# ── Step 2: Backup .env and uploads ──
say "Preserving .env and uploads..."
ENV_BAK=""
UPLOADS_BAK=""

if [ -f "$INSTALL_DIR/server/.env" ]; then
  ENV_BAK=$(mktemp /tmp/orblood-env-XXXXX)
  cp "$INSTALL_DIR/server/.env" "$ENV_BAK"
  ok ".env backed up"
fi

if [ -d "$INSTALL_DIR/server/uploads" ] && [ "$(ls -A "$INSTALL_DIR/server/uploads" 2>/dev/null)" ]; then
  UPLOADS_BAK=$(mktemp -d /tmp/orblood-uploads-XXXXX)
  cp -a "$INSTALL_DIR/server/uploads/"* "$UPLOADS_BAK/" 2>/dev/null || true
  ok "uploads backed up ($(ls "$UPLOADS_BAK" | wc -l) files)"
fi

# ── Step 3: Clean install directory and copy new files ──
say "Replacing application files..."
rm -rf "$INSTALL_DIR"
mkdir -p "$INSTALL_DIR"
cp -rf "$SCRIPT_DIR/"* "$INSTALL_DIR/"
cp -rf "$SCRIPT_DIR/".* "$INSTALL_DIR/" 2>/dev/null || true
ok "Files copied"

# ── Step 4: Restore .env and uploads ──
say "Restoring .env and uploads..."
mkdir -p "$INSTALL_DIR/server/uploads"

if [ -n "$ENV_BAK" ] && [ -f "$ENV_BAK" ]; then
  cp "$ENV_BAK" "$INSTALL_DIR/server/.env"
  rm -f "$ENV_BAK"
  ok ".env restored"
else
  # No existing .env — create from secrets if available
  if [ -f /etc/orblood/secrets.env ]; then
    say "No existing .env found — generating from /etc/orblood/secrets.env"
    # shellcheck disable=SC1091
    . /etc/orblood/secrets.env
    cat > "$INSTALL_DIR/server/.env" <<EOF
DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=orblood
DB_PASSWORD=$DB_PASSWORD
DB_NAME=orblood
JWT_SECRET=$JWT_SECRET
JWT_EXPIRES_IN=7d
PORT=4000
PUBLIC_ORIGIN=https://$DOMAIN
UPLOAD_DIR=./uploads
PUBLIC_UPLOADS_BASE=/uploads
TURN_USERNAME=${TURN_USERNAME:-orblood}
TURN_PASSWORD=${TURN_PASSWORD:-}
TURN_URLS=turn:$DOMAIN:443?transport=udp,turn:$DOMAIN:443?transport=tcp,turn:$DOMAIN:3478?transport=udp,turn:$DOMAIN:3478?transport=tcp
EOF
    ok ".env generated from secrets"
  else
    warn "No .env found and no /etc/orblood/secrets.env — you must create .env manually!"
    cp "$INSTALL_DIR/server/.env.example" "$INSTALL_DIR/server/.env"
    warn "Copied .env.example → .env — EDIT IT before starting!"
  fi
fi

if [ -n "$UPLOADS_BAK" ] && [ -d "$UPLOADS_BAK" ]; then
  cp -a "$UPLOADS_BAK/"* "$INSTALL_DIR/server/uploads/" 2>/dev/null || true
  rm -rf "$UPLOADS_BAK"
  ok "uploads restored"
fi

# ── Step 5: Fix permissions ──
say "Setting permissions..."
# Create user if doesn't exist
id "$APP_USER" >/dev/null 2>&1 || useradd --system --create-home --shell /bin/bash "$APP_USER"
chown -R "$APP_USER:$APP_USER" "$INSTALL_DIR"
chmod 600 "$INSTALL_DIR/server/.env"
ok "Permissions set"

# ── Step 6: Install npm dependencies ──
say "Installing npm dependencies..."
cd "$INSTALL_DIR/server"
sudo -u "$APP_USER" npm install --omit=dev --no-audit --no-fund 2>&1 | tail -3
ok "Dependencies installed"

# ── Step 7: Update database schema (SAFE — no data loss) ──
say "Updating database schema (idempotent — data preserved)..."
if sudo -u "$APP_USER" npm run init-db 2>&1; then
  ok "Schema updated"
else
  warn "init-db failed — check DB credentials in .env"
  warn "You can fix .env and re-run: cd $INSTALL_DIR/server && sudo -u $APP_USER npm run init-db"
fi

# ── Step 8: Bust PWA cache ──
say "Busting PWA service worker cache..."
SW_FILE="$INSTALL_DIR/public/sw.js"
if [ -f "$SW_FILE" ]; then
  STAMP="v$(date +%Y%m%d%H%M%S)"
  # Replace the CACHE_NAME with a new timestamped version
  sed -i "s/const CACHE_NAME = '[^']*'/const CACHE_NAME = 'orblood-shell-$STAMP'/" "$SW_FILE"
  chown "$APP_USER:$APP_USER" "$SW_FILE"
  ok "PWA cache busted → orblood-shell-$STAMP"
else
  warn "sw.js not found — skipping cache bust"
fi

# ── Step 9: Ensure systemd unit exists ──
say "Ensuring systemd service is configured..."
cat > /etc/systemd/system/orblood.service <<EOF
[Unit]
Description=Orblood backend
After=network.target mariadb.service
Requires=mariadb.service

[Service]
Type=simple
User=$APP_USER
WorkingDirectory=$INSTALL_DIR/server
EnvironmentFile=$INSTALL_DIR/server/.env
ExecStart=/usr/bin/node src/index.js
Restart=always
RestartSec=3
StandardOutput=journal
StandardError=journal
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$INSTALL_DIR/server/uploads
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable orblood
ok "systemd unit configured"

# ── Step 10: Ensure nginx vhost ──
say "Updating nginx configuration..."
cat > /etc/nginx/sites-available/orblood <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN;

    root $INSTALL_DIR/public;
    index index.html;
    client_max_body_size 8m;

    # No cache for HTML/JS/CSS — users always get latest build
    location ~* \.(html|js|css)$ {
        add_header Cache-Control "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0";
        add_header Pragma "no-cache";
        add_header Expires "0";
        try_files \$uri \$uri/ /index.html;
    }

    location / {
        try_files \$uri \$uri/ /index.html;
    }

    location /api/ {
        proxy_pass         http://127.0.0.1:4000/api/;
        proxy_http_version 1.1;
        proxy_set_header   Host              \$host;
        proxy_set_header   X-Real-IP         \$remote_addr;
        proxy_set_header   X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto \$scheme;
    }

    location /ws {
        proxy_pass         http://127.0.0.1:4000/ws;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade           \$http_upgrade;
        proxy_set_header   Connection        "upgrade";
        proxy_set_header   Host              \$host;
        proxy_read_timeout 1d;
    }

    location /uploads/ {
        proxy_pass http://127.0.0.1:4000/uploads/;
        proxy_set_header Host \$host;
        expires 7d;
    }
}
EOF
ln -sf /etc/nginx/sites-available/orblood /etc/nginx/sites-enabled/orblood
rm -f /etc/nginx/sites-enabled/default
if nginx -t 2>/dev/null; then
  systemctl reload nginx
  ok "nginx configured and reloaded"
else
  warn "nginx config test failed — check manually: nginx -t"
fi

# ── Step 11: Start service ──
say "Starting orblood service..."
systemctl restart orblood
sleep 2

if systemctl is-active --quiet orblood; then
  ok "orblood is running!"
else
  warn "orblood failed to start — check: journalctl -u orblood -n 30"
fi

# ── Step 12: Smoke test ──
say "Running smoke test..."
sleep 1
HEALTH=$(curl -sf http://127.0.0.1:4000/api/healthz 2>/dev/null || echo "FAIL")
if echo "$HEALTH" | grep -q '"ok":true'; then
  ok "API healthy: $HEALTH"
else
  warn "Health check failed: $HEALTH"
  warn "Check logs: journalctl -u orblood -n 30 --no-pager"
fi

# ── Done ──
echo
printf '\033[1;32m═══════════════════════════════════════════════════\033[0m\n'
printf '\033[1;32m  DEPLOY COMPLETE!\033[0m\n'
printf '\033[1;32m═══════════════════════════════════════════════════\033[0m\n'
echo
echo "  Site:    https://$DOMAIN"
echo "  Status:  systemctl status orblood"
echo "  Logs:    journalctl -u orblood -f"
echo
echo "  NOTE: Users may need to hard-refresh (Ctrl+Shift+R) or"
echo "        clear browser cache to see the new version."
echo
