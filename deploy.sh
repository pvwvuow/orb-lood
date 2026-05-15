#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────
# ORBLOOD — safe redeploy from a local source tree (no internet needed)
#
# Usage:
#   1. Download/upload the source ZIP or git checkout to the server.
#      Recommended: extract OUTSIDE /opt/orblood (e.g. into /tmp/).
#         cd /tmp && unzip orb-lood-main.zip
#   2. Run:
#         sudo bash /tmp/orb-lood-main/deploy.sh
#
# Optional env-vars:
#   DOMAIN=orblood.ir           # used in the nginx vhost / .env
#   FORCE_NGINX=1               # overwrite /etc/nginx/sites-available/orblood
#                               #   (off by default — your TLS / CDN config is preserved)
#   FORCE_SYSTEMD=1             # overwrite /etc/systemd/system/orblood.service
#                               #   (off by default if it already exists)
#   SKIP_NPM=1                  # skip npm install (only schema + cache bust)
#   SKIP_DB=1                   # skip the idempotent init-db migration
#
# What it does (idempotent — safe to re-run):
#   - rsyncs new files into /opt/orblood, preserving .env / uploads / node_modules
#   - installs npm dependencies
#   - applies the idempotent DB migration (no data loss)
#   - rewrites the PWA service-worker cache name AND every ?v=… asset stamp
#     in index.html so browsers + CDNs see fresh URLs
#   - fixes permissions so nginx (www-data) can read public/
#   - reloads nginx, restarts the orblood service
#   - actually fetches /, /js/app.js, /api/healthz to prove deploy worked
#
# What it does NOT do:
#   - does NOT touch your database data
#   - does NOT delete uploads
#   - does NOT regenerate JWT / DB / TURN secrets
#   - does NOT overwrite your nginx vhost unless FORCE_NGINX=1
# ─────────────────────────────────────────────────────────────────────

set -euo pipefail

# ── Pretty output ──
say()  { printf '\n\033[1;36m>> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m!! %s\033[0m\n' "$*"; }
fail() { printf '\033[1;31m!! %s\033[0m\n' "$*"; exit 1; }
ok()   { printf '\033[1;32m✓  %s\033[0m\n' "$*"; }

[ "$(id -u)" = "0" ] || fail "Run as root: sudo bash deploy.sh"

# ── Config ──
INSTALL_DIR="${INSTALL_DIR:-/opt/orblood}"
APP_USER="${APP_USER:-orblood}"
DOMAIN="${DOMAIN:-orblood.ir}"
FORCE_NGINX="${FORCE_NGINX:-0}"
FORCE_SYSTEMD="${FORCE_SYSTEMD:-0}"
SKIP_NPM="${SKIP_NPM:-0}"
SKIP_DB="${SKIP_DB:-0}"

# ── Detect source directory (where this script lives) ──
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Sanity checks: make sure we have the expected files
[ -f "$SCRIPT_DIR/server/package.json" ] || fail "Cannot find server/package.json in $SCRIPT_DIR — are you running from the unzipped folder?"
[ -f "$SCRIPT_DIR/public/index.html" ]   || fail "Cannot find public/index.html in $SCRIPT_DIR"
[ -s "$SCRIPT_DIR/public/index.html" ]   || fail "$SCRIPT_DIR/public/index.html is empty — the source extraction is broken!"

# CRITICAL safety check: refuse to run if the source dir is the install
# dir or sits inside it. Otherwise rm/rsync would delete the source mid-deploy.
if [ "$SCRIPT_DIR" = "$INSTALL_DIR" ]; then
  fail "Source dir == install dir ($INSTALL_DIR). Extract the ZIP somewhere else (e.g. /tmp/) and run from there."
fi
case "$SCRIPT_DIR/" in
  "$INSTALL_DIR"/*) fail "Source dir ($SCRIPT_DIR) is INSIDE install dir ($INSTALL_DIR). Extract somewhere else (e.g. /tmp/) and run from there." ;;
esac

say "Deploying ORBLOOD"
say "  Source : $SCRIPT_DIR"
say "  Target : $INSTALL_DIR"
say "  Domain : $DOMAIN"

# ── Step 0: ensure rsync exists (we use it instead of rm -rf + cp) ──
if ! command -v rsync >/dev/null 2>&1; then
  say "Installing rsync (one-time)..."
  apt-get update -qq && apt-get install -y -qq rsync
fi

# ── Step 1: Stop service ──
say "Stopping orblood service..."
systemctl stop orblood 2>/dev/null || true
# Fallback kill in case systemd doesn't know about the unit yet.
# Use pkill (always installed) instead of lsof.
pkill -f "node[[:space:]].*src/index\.js" 2>/dev/null || true
sleep 1
ok "Service stopped"

# ── Step 2: Ensure user + base dirs exist BEFORE we sync ──
id "$APP_USER" >/dev/null 2>&1 || useradd --system --create-home --shell /bin/bash "$APP_USER"
mkdir -p "$INSTALL_DIR/server/uploads" "$INSTALL_DIR/public"

# ── Step 3: Sync new files (atomic, preserves .env / uploads / node_modules) ──
say "Syncing files into $INSTALL_DIR..."
# --delete on the whole tree so removed files actually disappear,
# but the excludes below protect runtime state.
rsync -a --delete \
  --exclude='/.git/' \
  --exclude='/.github/' \
  --exclude='/node_modules/' \
  --exclude='/server/.env' \
  --exclude='/server/node_modules/' \
  --exclude='/server/uploads/' \
  --exclude='/desktop/node_modules/' \
  --exclude='/desktop/dist*/' \
  --exclude='/dist-electron/' \
  "$SCRIPT_DIR/" "$INSTALL_DIR/"
ok "Files synced"

# ── Step 4: Verify critical files actually landed ──
say "Verifying deploy..."
[ -s "$INSTALL_DIR/public/index.html" ]    || fail "index.html missing or empty after sync!"
[ -s "$INSTALL_DIR/public/js/app.js" ]     || fail "public/js/app.js missing after sync!"
[ -s "$INSTALL_DIR/public/styles/main.css" ]|| fail "public/styles/main.css missing after sync!"
[ -s "$INSTALL_DIR/server/package.json" ]  || fail "server/package.json missing after sync!"
[ -s "$INSTALL_DIR/server/src/index.js" ]  || fail "server/src/index.js missing after sync!"
INDEX_SIZE=$(stat -c%s "$INSTALL_DIR/public/index.html")
APPJS_SIZE=$(stat -c%s "$INSTALL_DIR/public/js/app.js")
ok "index.html: ${INDEX_SIZE} bytes / app.js: ${APPJS_SIZE} bytes"

# ── Step 5: Restore / generate .env if missing ──
if [ ! -f "$INSTALL_DIR/server/.env" ]; then
  if [ -f /etc/orblood/secrets.env ]; then
    say "No .env found — generating from /etc/orblood/secrets.env"
    # shellcheck disable=SC1091
    . /etc/orblood/secrets.env
    cat > "$INSTALL_DIR/server/.env" <<EOF
DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=orblood
DB_PASSWORD=${DB_PASSWORD:-}
DB_NAME=orblood
JWT_SECRET=${JWT_SECRET:-}
JWT_EXPIRES_IN=7d
PORT=4000
PUBLIC_ORIGIN=https://$DOMAIN
UPLOAD_DIR=./uploads
PUBLIC_UPLOADS_BASE=/uploads
TURN_USERNAME=${TURN_USERNAME:-orblood}
TURN_PASSWORD=${TURN_PASSWORD:-}
TURN_URLS=turn:$DOMAIN:443?transport=udp,turn:$DOMAIN:443?transport=tcp,turn:$DOMAIN:3478?transport=udp,turn:$DOMAIN:3478?transport=tcp
EXPRESSTURN_USERNAME=${TURN_USERNAME:-orblood}
EXPRESSTURN_PASSWORD=${TURN_PASSWORD:-}
EXPRESSTURN_URLS=turn:$DOMAIN:443?transport=udp,turn:$DOMAIN:443?transport=tcp,turn:$DOMAIN:3478?transport=udp,turn:$DOMAIN:3478?transport=tcp
EOF
    ok ".env generated from secrets"
  else
    warn "No .env and no /etc/orblood/secrets.env — copying .env.example"
    cp "$INSTALL_DIR/server/.env.example" "$INSTALL_DIR/server/.env"
    warn "EDIT $INSTALL_DIR/server/.env BEFORE RESTART!"
  fi
else
  ok ".env preserved"
fi

# ── Step 6: Cache-bust everything (SW + every ?v=… in index.html) ──
say "Busting client caches..."
STAMP="$(date +%Y%m%d%H%M%S)"
# 6a. Service worker cache name
SW_FILE="$INSTALL_DIR/public/sw.js"
if [ -f "$SW_FILE" ]; then
  sed -i "s/const CACHE_NAME = '[^']*'/const CACHE_NAME = 'orblood-shell-v$STAMP'/" "$SW_FILE"
  ok "  sw.js → orblood-shell-v$STAMP"
fi
# 6b. Every ?v=YYYYMMDD or ?v=N in HTML, so the browser AND any CDN
#     see brand-new URLs and re-fetch CSS/JS even if they had aggressive
#     long-term caching enabled (ArvanCloud, Cloudflare, etc.).
INDEX_FILE="$INSTALL_DIR/public/index.html"
if [ -f "$INDEX_FILE" ]; then
  sed -i -E "s/\?v=[0-9A-Za-z._-]+/?v=$STAMP/g" "$INDEX_FILE"
  ok "  index.html ?v= stamps → $STAMP"
fi
# 6c. Same treatment for any other html in public/
find "$INSTALL_DIR/public" -maxdepth 2 -name '*.html' ! -path "*/vendor/*" -print0 \
  | xargs -0 -r sed -i -E "s/\?v=[0-9A-Za-z._-]+/?v=$STAMP/g" 2>/dev/null || true

# ── Step 7: Fix permissions ──
say "Setting permissions..."
chown -R "$APP_USER:$APP_USER" "$INSTALL_DIR"
chmod 600 "$INSTALL_DIR/server/.env" 2>/dev/null || true
# Make sure nginx (www-data) can traverse + read everything in public/
# This is what was broken before — without explicit chmod, a strict
# umask leaves dirs as 700 and nginx returns empty / 403.
chmod 755 "$INSTALL_DIR"
find "$INSTALL_DIR" -type d -exec chmod 755 {} +
find "$INSTALL_DIR/public" -type f -exec chmod 644 {} +
ok "Permissions fixed (public/ readable by nginx)"

# ── Step 8: Install npm dependencies ──
if [ "$SKIP_NPM" != "1" ]; then
  say "Installing npm dependencies..."
  cd "$INSTALL_DIR/server"
  if sudo -u "$APP_USER" npm install --omit=dev --no-audit --no-fund > /tmp/orblood-npm.log 2>&1; then
    ok "Dependencies installed"
    tail -3 /tmp/orblood-npm.log || true
  else
    warn "npm install FAILED — last 20 lines of /tmp/orblood-npm.log:"
    tail -20 /tmp/orblood-npm.log || true
    fail "npm install failed — fix .npmrc / network and re-run."
  fi
else
  ok "Skipped npm (SKIP_NPM=1)"
fi

# ── Step 9: Update database schema (SAFE — no data loss) ──
if [ "$SKIP_DB" != "1" ]; then
  say "Updating database schema (idempotent)..."
  cd "$INSTALL_DIR/server"
  if sudo -u "$APP_USER" npm run init-db > /tmp/orblood-db.log 2>&1; then
    ok "Schema updated"
  else
    warn "init-db failed — check DB credentials in .env"
    tail -10 /tmp/orblood-db.log || true
    warn "You can fix .env and re-run: cd $INSTALL_DIR/server && sudo -u $APP_USER npm run init-db"
  fi
else
  ok "Skipped DB migration (SKIP_DB=1)"
fi

# ── Step 10: systemd unit (only write if missing OR forced) ──
say "Configuring systemd..."
SYSTEMD_UNIT=/etc/systemd/system/orblood.service
if [ ! -f "$SYSTEMD_UNIT" ] || [ "$FORCE_SYSTEMD" = "1" ]; then
  cat > "$SYSTEMD_UNIT" <<EOF
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
  ok "systemd unit (re)written"
else
  ok "systemd unit preserved (use FORCE_SYSTEMD=1 to overwrite)"
fi
systemctl enable orblood >/dev/null 2>&1 || true

# ── Step 11: nginx vhost (only write if missing OR forced) ──
say "Configuring nginx..."
NGX_CONF=/etc/nginx/sites-available/orblood
if [ ! -f "$NGX_CONF" ] || [ "$FORCE_NGINX" = "1" ]; then
  cat > "$NGX_CONF" <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN;

    root $INSTALL_DIR/public;
    index index.html;
    client_max_body_size 8m;

    # ─── Service worker — must NEVER be cached, anywhere ─────────────
    location = /sw.js {
        add_header Cache-Control "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0" always;
        add_header Pragma "no-cache" always;
        add_header Expires "0" always;
        try_files \$uri =404;
    }

    # ─── HTML — never cached, falls back to index.html for SPA routing
    location ~* \.html\$ {
        add_header Cache-Control "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0" always;
        add_header Pragma "no-cache" always;
        add_header Expires "0" always;
        try_files \$uri \$uri/ /index.html;
    }

    # ─── Static assets — short cache, MUST 404 if missing (NOT fall through to HTML!)
    # The OLD config served index.html for missing JS/CSS, which broke
    # MIME types and made the page render as a blank white screen.
    location ~* \.(js|css|woff2?|ttf|otf|eot|ico|png|jpg|jpeg|gif|svg|webp|mp3|wav|ogg|webm|mp4)\$ {
        add_header Cache-Control "public, max-age=300, must-revalidate" always;
        try_files \$uri =404;
    }

    # SPA fallback for clean URLs (/server/abc, /dm/xyz, etc.)
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
  ok "nginx vhost (re)written"
else
  ok "nginx vhost preserved (use FORCE_NGINX=1 to overwrite — useful if you customised TLS)"
fi
ln -sf "$NGX_CONF" /etc/nginx/sites-enabled/orblood
rm -f /etc/nginx/sites-enabled/default

if nginx -t > /tmp/orblood-nginx.log 2>&1; then
  systemctl reload nginx
  ok "nginx reloaded"
else
  warn "nginx config test FAILED:"
  cat /tmp/orblood-nginx.log
fi

# ── Step 12: Start service ──
say "Starting orblood service..."
systemctl restart orblood
sleep 2

if systemctl is-active --quiet orblood; then
  ok "orblood is running"
else
  warn "orblood failed to start — last 30 log lines:"
  journalctl -u orblood -n 30 --no-pager || true
fi

# ── Step 13: REAL smoke test (not just /api/healthz) ──
say "Running smoke tests..."
sleep 1

# 13a. Backend health on localhost
HEALTH=$(curl -sf --max-time 5 http://127.0.0.1:4000/api/healthz 2>/dev/null || echo "FAIL")
if echo "$HEALTH" | grep -q '"ok":true'; then
  ok "backend /api/healthz : OK"
else
  warn "backend /api/healthz FAILED: $HEALTH"
fi

# 13b. nginx serves the homepage (proves files are readable + reachable)
INDEX_INFO=$(curl -s -o /tmp/orblood-index.html -w "code=%{http_code} bytes=%{size_download}" http://127.0.0.1/ 2>/dev/null || echo "FAIL")
INDEX_BODY_BYTES=$(stat -c%s /tmp/orblood-index.html 2>/dev/null || echo 0)
if echo "$INDEX_INFO" | grep -q "code=200" && [ "$INDEX_BODY_BYTES" -gt 1000 ]; then
  ok "nginx /         : $INDEX_INFO (looks healthy)"
elif echo "$INDEX_INFO" | grep -q "code=200"; then
  warn "nginx /         : $INDEX_INFO  ← suspiciously small, frontend may be broken"
  echo "First 5 lines of served index:"
  head -5 /tmp/orblood-index.html || true
else
  warn "nginx /         : $INDEX_INFO  ← FAILED"
fi

# 13c. nginx serves app.js (proves the regex location works correctly)
APPJS_INFO=$(curl -s -o /dev/null -w "code=%{http_code} bytes=%{size_download} type=%{content_type}" http://127.0.0.1/js/app.js 2>/dev/null || echo "FAIL")
if echo "$APPJS_INFO" | grep -q "code=200" && echo "$APPJS_INFO" | grep -qiE "javascript|js"; then
  ok "nginx /js/app.js : $APPJS_INFO"
else
  warn "nginx /js/app.js: $APPJS_INFO  ← if content-type is text/html, the nginx location regex is wrong"
fi

# 13d. Verify the cache-bust stamp made it into served HTML
if grep -q "?v=$STAMP" /tmp/orblood-index.html 2>/dev/null; then
  ok "cache-bust stamp $STAMP is live in served HTML"
else
  warn "cache-bust stamp NOT found in served HTML — CDN may be returning cached page"
fi

rm -f /tmp/orblood-index.html /tmp/orblood-npm.log /tmp/orblood-db.log /tmp/orblood-nginx.log

# ── Done ──
echo
printf '\033[1;32m═══════════════════════════════════════════════════\033[0m\n'
printf '\033[1;32m  DEPLOY COMPLETE — stamp %s\033[0m\n' "$STAMP"
printf '\033[1;32m═══════════════════════════════════════════════════\033[0m\n'
echo
echo "  Site:      https://$DOMAIN"
echo "  Status:    systemctl status orblood"
echo "  Logs:      journalctl -u orblood -f"
echo
echo "  Cache notes:"
echo "  - Browsers will pick up the new ?v=$STAMP automatically on next visit."
echo "  - Service worker rolls over to orblood-shell-v$STAMP after one reload."
echo "  - If you sit BEHIND a CDN (ArvanCloud / Cloudflare / etc.):"
echo "      → purge cache for / and /sw.js from the CDN dashboard,"
echo "        otherwise the CDN keeps serving the old empty index."
echo
