#!/usr/bin/env bash
# ============================================================
# Orblood — CDN-bypass WebSocket endpoint (wss://ws.<domain>:8443/ws)
# ============================================================
#
# Why: ArvanCloud does not reliably proxy WebSockets (buffered upgrade
# frames, idle drops, failed handshakes on filtered ISPs). Voice
# signalling (offer / answer / ICE) rides on that socket, so calls stall
# at CHECKING. This puts /ws on its own DNS-only subdomain.
#
# Port 8443 because coturn owns :443 (TURN over TLS for Iranian ISPs).
#
#   sudo WS_HOST=ws.orblood.ir WS_PORT=8443 bash fix-arvan-ws.sh
#   sudo bash fix-arvan-ws.sh disable      # roll back to same-origin /ws
#
# Prerequisites:
#   * backend on 127.0.0.1:4000, nginx vhost written by deploy.sh
#   * DNS A record $WS_HOST → this VPS with the ArvanCloud cloud OFF
#
# When the endpoint answers, the script also tells the SPA to use it: it
# writes /etc/nginx/snippets/orblood-realtime.conf, which injects
#   <meta name="orblood-realtime" content="wss://$WS_HOST:$WS_PORT/ws">
# into index.html at serve time (deploy.sh's vhost includes it). No
# rebuild of the frontend needed; users pick it up on their next load.
set -euo pipefail

say()  { printf '\n\033[1;36m== %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m!! %s\033[0m\n' "$*"; }
fail() { printf '\033[1;31m!! %s\033[0m\n' "$*"; exit 1; }

[ "$(id -u)" = "0" ] || fail "Run as root: sudo bash fix-arvan-ws.sh"

WS_HOST="${WS_HOST:-ws.orblood.ir}"
WS_PORT="${WS_PORT:-8443}"
BACKEND_HOST="${BACKEND_HOST:-127.0.0.1}"
BACKEND_PORT="${BACKEND_PORT:-4000}"
LE_EMAIL="${LE_EMAIL:-}"
SNIPPET=/etc/nginx/snippets/orblood-realtime.conf

if [ "${1:-}" = "disable" ]; then
  rm -f "$SNIPPET"
  nginx -t && systemctl reload nginx
  say "SPA is back on same-origin /ws (the wss vhost is left in place)."
  exit 0
fi

say "Configuration"
echo "  WS_HOST = $WS_HOST"
echo "  WS_PORT = $WS_PORT"
echo "  BACKEND = $BACKEND_HOST:$BACKEND_PORT"

# ── Step 1: DNS sanity check ──
say "Step 1: DNS check for $WS_HOST"
RESOLVED_IP="$(getent ahostsv4 "$WS_HOST" 2>/dev/null | awk 'NR==1{print $1}')"
LOCAL_IP="$(curl -fsSL --max-time 5 https://api.ipify.org 2>/dev/null \
  || curl -fsSL --max-time 5 https://ifconfig.me 2>/dev/null \
  || hostname -I | awk '{print $1}')"
if [ -z "$RESOLVED_IP" ]; then
  warn "DNS for $WS_HOST does not resolve yet. Add: $WS_HOST → $LOCAL_IP (cloud OFF)"
elif [ "$RESOLVED_IP" != "$LOCAL_IP" ]; then
  warn "$WS_HOST resolves to $RESOLVED_IP but this VPS is $LOCAL_IP — is the CDN still ON for it?"
else
  echo "  DNS OK: $WS_HOST → $LOCAL_IP"
fi

# ── Step 2: packages + firewall ──
say "Step 2: nginx + certbot + firewall"
command -v nginx   >/dev/null || { apt-get update -qq && apt-get install -y -qq nginx; }
command -v certbot >/dev/null || apt-get install -y -qq certbot
if command -v ufw >/dev/null; then
  ufw allow 80/tcp >/dev/null 2>&1 || true
  ufw allow "${WS_PORT}/tcp" >/dev/null 2>&1 || true
fi

# Log format without query strings (the JWT rides in ?token=).
if [ ! -f /etc/nginx/conf.d/orblood-logformat.conf ]; then
  cat > /etc/nginx/conf.d/orblood-logformat.conf <<'EOF'
# orblood-managed: deploy.sh
log_format orblood_noargs '$remote_addr - [$time_local] "$request_method $uri $server_protocol" '
                          '$status $body_bytes_sent "$http_user_agent" $request_time';
EOF
fi

# ── Step 3: permanent :80 block for ACME (issuance AND renewals) ──
say "Step 3: HTTP block for Let's Encrypt on $WS_HOST"
ACME_BLOCK=/etc/nginx/sites-available/orblood-ws-acme
cat > "$ACME_BLOCK" <<EOF
# Kept permanently: certbot renewals for $WS_HOST use HTTP-01 here.
server {
    listen 80;
    server_name $WS_HOST;
    access_log off;
    location /.well-known/acme-challenge/ { root /var/www/html; }
    location / { return 404; }
}
EOF
ln -sf "$ACME_BLOCK" /etc/nginx/sites-enabled/orblood-ws-acme
mkdir -p /var/www/html
nginx -t && systemctl reload nginx

# ── Step 4: certificate ──
say "Step 4: certificate for $WS_HOST"
if [ ! -f "/etc/letsencrypt/live/$WS_HOST/fullchain.pem" ]; then
  certbot certonly --webroot -w /var/www/html -d "$WS_HOST" \
    --non-interactive --agree-tos \
    $( [ -n "$LE_EMAIL" ] && echo "-m $LE_EMAIL" || echo "--register-unsafely-without-email" ) \
    || fail "certbot failed. Check DNS first (see step 1)."
else
  echo "  cert already present"
fi
mkdir -p /etc/letsencrypt/renewal-hooks/deploy
printf '#!/bin/sh\nsystemctl reload nginx 2>/dev/null || true\n' > /etc/letsencrypt/renewal-hooks/deploy/orblood-reload-nginx.sh
chmod +x /etc/letsencrypt/renewal-hooks/deploy/orblood-reload-nginx.sh

# ── Step 5: the wss reverse proxy ──
say "Step 5: nginx block for wss://$WS_HOST:$WS_PORT/ws"
WS_BLOCK=/etc/nginx/sites-available/orblood-ws
cat > "$WS_BLOCK" <<EOF
# Orblood WebSocket bypass — fix-arvan-ws.sh. Only /ws (and /healthz).
server {
    listen $WS_PORT ssl;
    listen [::]:$WS_PORT ssl;
    server_name $WS_HOST;
    server_tokens off;
    access_log /var/log/nginx/orblood-ws.access.log orblood_noargs;

    ssl_certificate     /etc/letsencrypt/live/$WS_HOST/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/$WS_HOST/privkey.pem;
    ssl_protocols       TLSv1.2 TLSv1.3;

    location = /healthz {
        default_type text/plain;
        return 200 "ok\n";
    }

    location /ws {
        proxy_pass         http://$BACKEND_HOST:$BACKEND_PORT/ws;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade           \$http_upgrade;
        proxy_set_header   Connection        "upgrade";
        proxy_set_header   Host              \$host;
        # Direct connection (no CDN): \$remote_addr is the visitor.
        proxy_set_header   X-Real-IP         \$remote_addr;
        proxy_set_header   X-Forwarded-For   \$remote_addr;
        proxy_set_header   X-Forwarded-Proto https;
        proxy_buffering    off;
        proxy_read_timeout 1d;
        proxy_send_timeout 1d;
    }

    location / { return 404; }
}
EOF
ln -sf "$WS_BLOCK" /etc/nginx/sites-enabled/orblood-ws
nginx -t || fail "nginx config test failed; see above"
systemctl reload nginx

# ── Step 6: smoke test, then switch the SPA over ──
say "Step 6: smoke test"
RESP="$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 \
  --resolve "${WS_HOST}:${WS_PORT}:127.0.0.1" "https://${WS_HOST}:${WS_PORT}/healthz" || true)"
if [ "$RESP" = "200" ]; then
  echo "  https://${WS_HOST}:${WS_PORT}/healthz → 200 (valid TLS)"
  cat > "$SNIPPET" <<EOF
# orblood-managed: fix-arvan-ws.sh — tells the SPA to open its WebSocket
# on the CDN-bypass host. Remove with: sudo bash fix-arvan-ws.sh disable
sub_filter_once on;
sub_filter_types text/html;
sub_filter '</head>' '<meta name="orblood-realtime" content="wss://${WS_HOST}:${WS_PORT}/ws"></head>';
EOF
  if grep -q 'orblood-realtime\*\.conf' /etc/nginx/sites-available/orblood 2>/dev/null; then
    nginx -t && systemctl reload nginx
    say "SPA now uses wss://${WS_HOST}:${WS_PORT}/ws (users get it on next page load)"
  else
    warn "The main vhost does not include snippets/orblood-realtime*.conf yet."
    warn "Run deploy.sh (FORCE_NGINX=1 if you hand-edited the vhost), then reload nginx."
  fi
else
  warn "healthz returned HTTP $RESP — NOT switching the SPA over. Fix TLS/DNS and re-run."
fi

cat <<DONE

Check from a phone on mobile data:
  https://orblood.ir/voice-debug.html  → WebSocket: open, RTT < 200 ms

Roll back:  sudo bash $0 disable
DONE
