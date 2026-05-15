#!/usr/bin/env bash
# ============================================================
# Orblood — Quick fix for ArvanCloud 504 + Voice not working
# ============================================================
#
# This script fixes TWO issues on an existing Orblood VPS:
#
#   1. SITE 504: ArvanCloud CDN connects to origin on port 80 (HTTP).
#      nginx must listen on port 80 and NOT redirect to 443.
#      certbot/HTTPS on the origin is NOT needed — ArvanCloud handles TLS.
#
#   2. VOICE BROKEN: Iranian ISPs block port 3478 (standard TURN port).
#      We make coturn ALSO listen on port 443 (which ISPs never block).
#      Since nginx only uses port 80, port 443 is free for coturn.
#
# Usage:
#   sudo bash fix-arvan-voice.sh
#
# Prerequisites:
#   - Orblood already installed via install.sh (or manually)
#   - ArvanCloud CDN configured with:
#       • Origin IP: your VPS IP (e.g. 194.60.231.226)
#       • Origin port: 80 (HTTP)   ← IMPORTANT!
#       • CDN/proxy: ON
#       • SSL mode: "Flexible" or "Full" (ArvanCloud terminates HTTPS)
#
# After running this script:
#   - Open ArvanCloud panel → CDN → "تنظیمات سرور مبدأ"
#   - Set port to 80 and protocol to HTTP
#   - Wait 2-3 minutes for CDN cache to clear
#   - Test: curl https://orblood.ir/api/healthz → {"ok":true}
#
set -euo pipefail

say()  { printf '\n\033[1;36m== %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m!! %s\033[0m\n' "$*"; }
fail() { printf '\033[1;31m!! %s\033[0m\n' "$*"; exit 1; }

[ "$(id -u)" = "0" ] || fail "Run as root: sudo bash fix-arvan-voice.sh"

DOMAIN="${DOMAIN:-orblood.ir}"
INSTALL_DIR="${INSTALL_DIR:-/opt/orblood}"

# ─── Step 1: Fix nginx (remove certbot HTTPS, keep port 80 only) ───
say "Step 1: Fixing nginx — port 80 only (ArvanCloud handles HTTPS)"

# Remove any certbot-added SSL config
if grep -q 'listen 443 ssl' /etc/nginx/sites-available/orblood 2>/dev/null; then
  warn "Found HTTPS config in nginx — removing it (ArvanCloud handles TLS)"
fi

cat > /etc/nginx/sites-available/orblood <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN;

    root $INSTALL_DIR/public;
    index index.html;

    client_max_body_size 8m;

    # No-cache for HTML (users always get fresh version)
    location ~* \.html\$ {
        add_header Cache-Control "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0";
        add_header Pragma "no-cache";
        add_header Expires "0";
        try_files \$uri \$uri/ /index.html;
    }

    # Service worker: never cache
    location = /sw.js {
        add_header Cache-Control "no-store, no-cache, must-revalidate";
        add_header Pragma "no-cache";
        add_header Expires "0";
    }

    # Static assets: short cache (CDN will cache)
    location ~* \.(js|css|woff2?|ttf|ico|png|jpg|jpeg|gif|svg|webp)\$ {
        add_header Cache-Control "public, max-age=300, must-revalidate";
        try_files \$uri =404;
    }

    # Frontend SPA fallback
    location / {
        try_files \$uri \$uri/ /index.html;
    }

    # API reverse proxy
    location /api/ {
        proxy_pass         http://127.0.0.1:4000/api/;
        proxy_http_version 1.1;
        proxy_set_header   Host              \$host;
        proxy_set_header   X-Real-IP         \$remote_addr;
        proxy_set_header   X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto \$scheme;
    }

    # WebSocket
    location /ws {
        proxy_pass         http://127.0.0.1:4000/ws;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade           \$http_upgrade;
        proxy_set_header   Connection        "upgrade";
        proxy_set_header   Host              \$host;
        proxy_read_timeout 1d;
    }

    # Uploads
    location /uploads/ {
        proxy_pass http://127.0.0.1:4000/uploads/;
        proxy_set_header Host \$host;
        expires 7d;
    }
}
EOF

ln -sf /etc/nginx/sites-available/orblood /etc/nginx/sites-enabled/orblood
rm -f /etc/nginx/sites-enabled/default

# Remove certbot's auto-redirect config if it exists
rm -f /etc/nginx/sites-enabled/orblood-redirect 2>/dev/null || true

nginx -t || fail "nginx config test failed!"
systemctl reload nginx
say "✓ nginx fixed — listening on port 80 only"

# ─── Step 2: Fix coturn (add port 443) ───
say "Step 2: Fixing coturn — adding port 443 for Iranian ISP bypass"

# Check if coturn config exists
[ -f /etc/turnserver.conf ] || fail "/etc/turnserver.conf not found. Run install.sh first."

# Add alt-listening-port=443 if not already there
if grep -q '^alt-listening-port=443' /etc/turnserver.conf; then
  say "coturn already has alt-listening-port=443"
else
  # Remove any existing alt-listening-port line
  sed -i '/^alt-listening-port=/d' /etc/turnserver.conf
  sed -i '/^alt-tls-listening-port=/d' /etc/turnserver.conf

  # Add after listening-port line
  sed -i '/^listening-port=/a alt-listening-port=443\nalt-tls-listening-port=0' /etc/turnserver.conf
  say "Added alt-listening-port=443 to coturn config"
fi

# Make sure port 443 isn't being used by something else
if ss -tlnp 'sport = :443' | grep -v coturn | grep -q LISTEN; then
  BLOCKER=$(ss -tlnp 'sport = :443' | grep LISTEN | head -1)
  warn "Something else is using port 443: $BLOCKER"
  warn "If it's nginx (from certbot), this script already removed it."
  warn "Restarting nginx first to free port 443..."
  systemctl restart nginx
  sleep 1
fi

systemctl restart coturn || warn "coturn restart failed — check: journalctl -u coturn -n 20"

# Verify coturn is listening on 443
sleep 2
if ss -ulnp 'sport = :443' | grep -q turnserver; then
  say "✓ coturn listening on port 443 UDP"
else
  warn "coturn might not be on 443 yet — check: ss -ulnp 'sport = :443'"
fi

# ─── Step 3: Update TURN URLs in .env ───
say "Step 3: Updating TURN URLs in .env to use port 443"

ENV_FILE="$INSTALL_DIR/server/.env"
if [ -f "$ENV_FILE" ]; then
  # Update EXPRESSTURN_URLS / TURN_URLS to prefer port 443
  if grep -q 'EXPRESSTURN_URLS=' "$ENV_FILE"; then
    sed -i "s|^EXPRESSTURN_URLS=.*|EXPRESSTURN_URLS=turn:$DOMAIN:443?transport=udp,turn:$DOMAIN:443?transport=tcp,turn:$DOMAIN:3478?transport=udp,turn:$DOMAIN:3478?transport=tcp|" "$ENV_FILE"
  fi
  if grep -q 'TURN_URLS=' "$ENV_FILE"; then
    sed -i "s|^TURN_URLS=.*|TURN_URLS=turn:$DOMAIN:443?transport=udp,turn:$DOMAIN:443?transport=tcp,turn:$DOMAIN:3478?transport=udp,turn:$DOMAIN:3478?transport=tcp|" "$ENV_FILE"
  fi
  say "✓ .env updated with port 443 TURN URLs"
else
  warn "$ENV_FILE not found — update TURN URLs manually"
fi

# ─── Step 4: Restart backend ───
say "Step 4: Restarting Orblood backend"
systemctl restart orblood || warn "Could not restart orblood service"

# ─── Step 5: Open firewall for 443/udp ───
say "Step 5: Ensuring firewall allows 443/udp for TURN"
if command -v ufw >/dev/null; then
  ufw allow 443/udp >/dev/null 2>&1
  ufw allow 443/tcp >/dev/null 2>&1
  say "✓ UFW: 443/udp and 443/tcp allowed"
fi

# ─── Done ───
echo
say "All done! Summary of changes:"
echo
echo "  ✓ nginx: port 80 only (ArvanCloud terminates HTTPS)"
echo "  ✓ coturn: now also listens on port 443 (bypasses ISP blocks)"
echo "  ✓ TURN URLs: updated to use port 443"
echo "  ✓ Backend: restarted with new config"
echo
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  IMPORTANT: Configure ArvanCloud CDN origin settings:       ║"
echo "║                                                             ║"
echo "║  1. Go to ArvanCloud panel → CDN → Origin Server Settings   ║"
echo "║  2. Set protocol: HTTP                                      ║"
echo "║  3. Set port: 80                                            ║"
echo "║  4. Make sure 'CDN' toggle is ON for orblood.ir             ║"
echo "║  5. Wait 2-3 minutes                                        ║"
echo "║                                                             ║"
echo "║  Test: curl https://orblood.ir/api/healthz                  ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo
echo "Voice test:"
echo "  Open https://orblood.ir → join a voice channel from 2 devices"
echo
echo "Debug commands:"
echo "  ss -ulnp 'sport = :443'          # coturn on 443?"
echo "  journalctl -u coturn -n 20       # coturn logs"
echo "  journalctl -u orblood -n 20      # backend logs"
echo "  curl http://localhost/api/healthz # nginx→backend ok?"
echo
