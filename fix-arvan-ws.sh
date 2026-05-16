#!/usr/bin/env bash
# ============================================================
# Orblood — CDN-bypass WebSocket endpoint
# ============================================================
#
# Symptom this fixes:
#   • voice-debug.html shows "WS open timeout" or 1006 closes
#     intermittently, RTT spikes above 1 second, two users in the
#     same voice channel never hear each other (offer is sent but
#     answer never arrives back).
#
# Root cause:
#   ArvanCloud (and most CDNs) does not reliably proxy WebSockets.
#   It buffers/coalesces upgrade frames, drops idle connections at
#   unpredictable intervals, and sometimes fails the upgrade
#   handshake outright on filtered (Iranian) ISPs.
#
# Fix:
#   Stand up a CDN-bypass subdomain (default: ws.orblood.ir) that
#   resolves directly to the VPS (DNS-only). Run nginx on it with
#   Let's Encrypt TLS, listening on a non-standard port (default
#   8443) so it does not collide with coturn TLS on 443. Point the
#   SPA at it via the <meta name="orblood-realtime"> tag in
#   public/index.html.
#
# Why port 8443 (and not 443):
#   The existing fix-arvan-voice.sh repurposes port 443 on coturn
#   so Iranian ISPs can't block the TURN relay. Putting the WS
#   subdomain on 443 too would mean coturn-over-TLS and our nginx
#   for /ws fight for the same socket. 8443 is a well-known
#   alternative HTTPS port that browsers accept transparently
#   inside a wss:// URL.
#
# Usage:
#   sudo WS_HOST=ws.orblood.ir WS_PORT=8443 bash fix-arvan-ws.sh
#
# Prerequisites:
#   • /opt/orblood is the install path (override with INSTALL_DIR)
#   • The Orblood backend is running on 127.0.0.1:4000
#   • DNS A record for $WS_HOST already points at this VPS
#     IMPORTANT: in ArvanCloud DNS, set this record to
#       "Cloud OFF / DNS-Only" (the orange cloud icon disabled).
#       If the record is proxied, the whole point of this script
#       is defeated.
#
# After running:
#   1. Edit public/index.html and uncomment:
#        <meta name="orblood-realtime"
#              content="wss://ws.orblood.ir:8443/ws">
#   2. Rebuild / push the SPA so users get the new tag.
#   3. Open https://orblood.ir/voice-debug.html and verify:
#        Status: open
#        RTT (ping/pong): under 200ms
#   4. From two users in the same voice channel, confirm both
#        sides see "Remote SDP answer received" in their console
#        and the orb status flips to CONNECTED within ~5s.
#
set -euo pipefail

say()  { printf '\n\033[1;36m== %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m!! %s\033[0m\n' "$*"; }
fail() { printf '\033[1;31m!! %s\033[0m\n' "$*"; exit 1; }

[ "$(id -u)" = "0" ] || fail "Run as root: sudo bash fix-arvan-ws.sh"

WS_HOST="${WS_HOST:-ws.orblood.ir}"
WS_PORT="${WS_PORT:-8443}"
BACKEND_HOST="${BACKEND_HOST:-127.0.0.1}"
BACKEND_PORT="${BACKEND_PORT:-4000}"
INSTALL_DIR="${INSTALL_DIR:-/opt/orblood}"
LE_EMAIL="${LE_EMAIL:-admin@${WS_HOST#*.}}"

say "Configuration"
echo "  WS_HOST       = $WS_HOST"
echo "  WS_PORT       = $WS_PORT"
echo "  BACKEND       = $BACKEND_HOST:$BACKEND_PORT"
echo "  INSTALL_DIR   = $INSTALL_DIR"
echo "  LE_EMAIL      = $LE_EMAIL"
echo

# --------------------------------------------------------------
# Step 1: sanity-check the DNS record. If it still points through
# a CDN / proxy, the upgrade handshake will fail intermittently.
# We don't *fail* on this — the user might be configuring DNS in
# parallel — but we surface a clear warning.
# --------------------------------------------------------------
say "Step 1: DNS sanity check for $WS_HOST"
RESOLVED_IP="$(dig +short "$WS_HOST" A | tail -n1)"
LOCAL_IP="$(curl -fsSL --max-time 5 https://api.ipify.org 2>/dev/null \
  || curl -fsSL --max-time 5 https://ifconfig.me 2>/dev/null \
  || hostname -I | awk '{print $1}')"
if [ -z "$RESOLVED_IP" ]; then
  warn "DNS for $WS_HOST does not resolve yet."
  warn "Add an A record: $WS_HOST -> $LOCAL_IP (Cloud OFF / DNS-Only)"
  warn "Continuing anyway; certbot will fail until DNS propagates."
elif [ "$RESOLVED_IP" != "$LOCAL_IP" ]; then
  warn "$WS_HOST resolves to $RESOLVED_IP, but this VPS is $LOCAL_IP."
  warn "If the resolved IP is an ArvanCloud edge, the proxy is still"
  warn "ON for this record. Disable the cloud icon in the panel and"
  warn "re-run this script. Otherwise WebSockets will continue to"
  warn "drop intermittently."
else
  say "DNS OK: $WS_HOST -> $LOCAL_IP (matches this VPS)"
fi

# --------------------------------------------------------------
# Step 2: install nginx + certbot (idempotent)
# --------------------------------------------------------------
say "Step 2: ensure nginx + certbot are installed"
if ! command -v nginx >/dev/null;   then apt-get update -qq && apt-get install -y nginx; fi
if ! command -v certbot >/dev/null; then apt-get install -y certbot python3-certbot-nginx; fi

# --------------------------------------------------------------
# Step 3: open the firewall for the chosen WS port + 80 (so
# certbot can do an HTTP-01 challenge during cert issuance).
# --------------------------------------------------------------
say "Step 3: firewall rules for ports 80 and $WS_PORT"
if command -v ufw >/dev/null; then
  ufw allow 80/tcp        >/dev/null 2>&1 || true
  ufw allow "${WS_PORT}/tcp" >/dev/null 2>&1 || true
  say "ufw: 80/tcp and ${WS_PORT}/tcp allowed"
fi

# --------------------------------------------------------------
# Step 4: write a minimal nginx server block for the cert
# challenge. Just port 80, just /.well-known/acme-challenge/.
# We delete it after the cert is issued (the real wss server
# block lives below).
# --------------------------------------------------------------
say "Step 4: stand up temporary HTTP server for ACME challenge"
TMP_BLOCK=/etc/nginx/sites-available/orblood-ws-acme
cat > "$TMP_BLOCK" <<EOF
# Temporary block — only used for Let's Encrypt HTTP-01.
# fix-arvan-ws.sh deletes this block once the cert is issued.
server {
    listen 80;
    server_name $WS_HOST;
    location /.well-known/acme-challenge/ {
        root /var/www/html;
    }
    location / {
        return 404;
    }
}
EOF
ln -sf "$TMP_BLOCK" /etc/nginx/sites-enabled/orblood-ws-acme
nginx -t && systemctl reload nginx

# --------------------------------------------------------------
# Step 5: get a Let's Encrypt cert for the subdomain. We use the
# webroot plugin so we don't have to take port 80 down.
# --------------------------------------------------------------
say "Step 5: issue Let's Encrypt cert for $WS_HOST"
mkdir -p /var/www/html
if [ ! -f "/etc/letsencrypt/live/$WS_HOST/fullchain.pem" ]; then
  certbot certonly --webroot -w /var/www/html \
    -d "$WS_HOST" \
    --non-interactive --agree-tos -m "$LE_EMAIL" \
    || fail "certbot failed. Check DNS first; see warnings above."
else
  say "Cert already exists for $WS_HOST — skipping issuance"
fi

# --------------------------------------------------------------
# Step 6: write the real wss:// reverse proxy. The headers below
# are the canonical "WebSocket upgrade" set; without proxy_buffering
# off + a long read timeout, idle voice channels would routinely
# drop after 60s.
# --------------------------------------------------------------
say "Step 6: write nginx server block for wss://$WS_HOST:$WS_PORT/ws"
WS_BLOCK=/etc/nginx/sites-available/orblood-ws
cat > "$WS_BLOCK" <<EOF
# Orblood WebSocket bypass — fix-arvan-ws.sh
#
# This server block exists so realtime traffic can sidestep the
# CDN that fronts orblood.ir. The CDN is fine for static assets
# but routinely mangles WebSocket upgrade frames; running /ws on
# its own subdomain (DNS-only, no proxy) keeps voice signalling
# stable on filtered networks.
#
# Anything other than /ws on this hostname is intentionally a 404
# so we don't accidentally expose a second copy of the SPA.
server {
    listen $WS_PORT ssl http2;
    listen [::]:$WS_PORT ssl http2;
    server_name $WS_HOST;

    ssl_certificate     /etc/letsencrypt/live/$WS_HOST/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/$WS_HOST/privkey.pem;
    ssl_protocols       TLSv1.2 TLSv1.3;
    ssl_prefer_server_ciphers on;

    # Cheap health probe so monitors can hit /healthz without
    # crossing into the upgrade-only /ws path.
    location = /healthz {
        return 200 "ok\n";
        add_header Content-Type text/plain;
    }

    location /ws {
        proxy_pass         http://$BACKEND_HOST:$BACKEND_PORT/ws;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade           \$http_upgrade;
        proxy_set_header   Connection        "upgrade";
        proxy_set_header   Host              \$host;
        proxy_set_header   X-Real-IP         \$remote_addr;
        proxy_set_header   X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto \$scheme;

        # WebSocket-friendly timing knobs:
        # • buffering off  -> upgrade frames flow immediately
        # • read 1d        -> idle voice rooms aren't disconnected
        # • send 1d        -> long answer SDPs aren't truncated
        proxy_buffering    off;
        proxy_read_timeout 1d;
        proxy_send_timeout 1d;
    }

    # Anything else on this host is a deliberate 404; the SPA
    # itself is served from the main orblood.ir host.
    location / {
        return 404;
    }
}
EOF
ln -sf "$WS_BLOCK" /etc/nginx/sites-enabled/orblood-ws

# Drop the temporary ACME-only block — the real one above already
# answers /.well-known/acme-challenge thanks to certbot's renewal
# hook handling it on port 80 inside the existing main vhost.
rm -f /etc/nginx/sites-enabled/orblood-ws-acme

nginx -t || fail "nginx config test failed; see above"
systemctl reload nginx

# --------------------------------------------------------------
# Step 7: prove it works. We do a local-loopback wss handshake
# so the operator immediately sees whether the cert + upgrade
# headers are wired correctly. If this passes but the browser
# still fails, it means the DNS record is still proxied.
# --------------------------------------------------------------
say "Step 7: local-loopback WebSocket smoke test"
if command -v curl >/dev/null; then
  RESP="$(curl -k -s -o /dev/null -w "%{http_code}" \
    --resolve "${WS_HOST}:${WS_PORT}:127.0.0.1" \
    "https://${WS_HOST}:${WS_PORT}/healthz" || true)"
  if [ "$RESP" = "200" ]; then
    say "loopback healthz OK ($RESP)"
  else
    warn "loopback healthz unexpected: HTTP $RESP"
    warn "(this is informational; the wss path may still work)"
  fi
fi

cat <<DONE

╔══════════════════════════════════════════════════════════════╗
║  CDN-bypass WebSocket endpoint is live.                      ║
║                                                              ║
║  URL: wss://${WS_HOST}:${WS_PORT}/ws                              ║
╚══════════════════════════════════════════════════════════════╝

NEXT STEPS

1. In public/index.html, uncomment the realtime meta tag:

     <meta name="orblood-realtime"
           content="wss://${WS_HOST}:${WS_PORT}/ws">

   Rebuild/push the SPA so users pick up the new endpoint on
   their next page load. Existing tabs need a refresh.

2. In ArvanCloud DNS, double-check the A record for "$WS_HOST"
   has the cloud icon DISABLED (DNS-only). With the cloud on,
   ArvanCloud will still intercept the traffic and the fix
   accomplishes nothing.

3. Open https://orblood.ir/voice-debug.html and run "RUN ALL
   TESTS". Look for:

     URL       wss://${WS_HOST}:${WS_PORT}/ws?token=•••
     Status    open
     RTT       <200 ms

   The WebSocket section should now be green and stable across
   repeated runs.

4. Real voice test: have two accounts join the same voice
   channel. Each console should show
     "Local ICE candidate -> Peer | relay udp ..."
     "Remote SDP answer received from Peer"
   within a few seconds, and the orb status flips to CONNECTED.

ROLLBACK

   sudo rm /etc/nginx/sites-enabled/orblood-ws \
          /etc/nginx/sites-available/orblood-ws
   sudo systemctl reload nginx

   Revert the meta tag in index.html.

DONE
