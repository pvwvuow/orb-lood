#!/usr/bin/env bash
# diagnose-voice.sh — Quick health check for voice/TURN connectivity.
#
# Usage:  sudo bash /opt/orblood/scripts/diagnose-voice.sh

set -uo pipefail

INSTALL_DIR="${INSTALL_DIR:-/opt/orblood}"
ENV_FILE="$INSTALL_DIR/server/.env"

ok()   { printf '  \033[1;32m\u2713\033[0m  %s\n' "$*"; }
warn() { printf '  \033[1;33m!\033[0m   %s\n' "$*"; }
bad()  { printf '  \033[1;31m\u2717\033[0m  %s\n' "$*"; }
hdr()  { printf '\n\033[1;36m== %s ==\033[0m\n' "$*"; }

[ -f "$ENV_FILE" ] || { echo "$ENV_FILE not found"; exit 1; }

DOMAIN="$(awk -F= '/^PUBLIC_ORIGIN=/{print $2}' "$ENV_FILE" | sed -E 's|https?://||' | tr -d ' "'"'"'')"
TURN_USER="$(awk -F= '/^TURN_USERNAME=/{print $2}' "$ENV_FILE" | tr -d ' "'"'"'')"
TURN_PASS="$(awk -F= '/^TURN_PASSWORD=/{print $2}' "$ENV_FILE" | tr -d ' "'"'"'')"
[ -z "$TURN_USER" ] && TURN_USER="$(awk -F= '/^EXPRESSTURN_USERNAME=/{print $2}' "$ENV_FILE" | tr -d ' "'"'"'')"
[ -z "$TURN_PASS" ] && TURN_PASS="$(awk -F= '/^EXPRESSTURN_PASSWORD=/{print $2}' "$ENV_FILE" | tr -d ' "'"'"'')"

hdr "Configuration"
echo "  Domain:    $DOMAIN"
echo "  TURN user: $TURN_USER"
echo "  TURN pass: ${TURN_PASS:0:6}..."

hdr "Service status"
if systemctl is-active --quiet coturn; then ok "coturn is running"; else bad "coturn is NOT running"; fi
if systemctl is-active --quiet orblood; then ok "orblood backend is running"; else bad "orblood backend is NOT running"; fi
if systemctl is-active --quiet nginx;  then ok "nginx is running"; else bad "nginx is NOT running"; fi
if systemctl is-active --quiet mariadb; then ok "mariadb is running"; else warn "mariadb is NOT running (mysql also OK if you use that instead)"; fi

hdr "Listening ports"
if ss -lun 2>/dev/null | grep -q ':3478 '; then ok "UDP 3478 is open (STUN/TURN)"; else bad "UDP 3478 is NOT listening"; fi
if ss -ltn 2>/dev/null | grep -q ':3478 '; then ok "TCP 3478 is open (TURN/TCP)"; else bad "TCP 3478 is NOT listening"; fi
if ss -ltn 2>/dev/null | grep -q ':5349 '; then ok "TCP 5349 is open (TURNS/TLS)"; else warn "TCP 5349 is NOT listening (TURNS disabled — OK if no TLS cert yet)"; fi
if ss -ltn 2>/dev/null | grep -q ':4000 '; then ok "TCP 4000 is open (backend)"; else bad "TCP 4000 is NOT listening"; fi
if ss -ltn 2>/dev/null | grep -q ':80 ';   then ok "TCP 80 is open (HTTP)"; else warn "TCP 80 is NOT listening"; fi
if ss -ltn 2>/dev/null | grep -q ':443 ';  then ok "TCP 443 is open (HTTPS)"; else warn "TCP 443 is NOT listening"; fi

hdr "Firewall (UFW)"
if command -v ufw >/dev/null; then
  if ufw status | grep -q "Status: active"; then
    if ufw status | grep -q "3478/udp"; then ok "UFW allows 3478/udp"; else bad "UFW does NOT allow 3478/udp"; fi
    if ufw status | grep -q "3478/tcp"; then ok "UFW allows 3478/tcp"; else bad "UFW does NOT allow 3478/tcp"; fi
    if ufw status | grep -q "49152:65535/udp"; then ok "UFW allows 49152-65535/udp (TURN relay)"; else bad "UFW does NOT allow 49152-65535/udp — TURN relay will fail!"; fi
  else
    warn "UFW is installed but inactive. Make sure another firewall is configured."
  fi
else
  warn "UFW not installed. Check iptables/nftables manually."
fi

hdr "External IP detection"
EXT_IP="$(curl -fsSL --max-time 5 https://api.ipify.org 2>/dev/null \
  || curl -fsSL --max-time 5 https://ifconfig.me 2>/dev/null \
  || curl -fsSL --max-time 5 https://checkip.amazonaws.com 2>/dev/null \
  || true)"
if [ -n "$EXT_IP" ]; then
  ok "Detected public IP: $EXT_IP"
  if grep -q "external-ip=$EXT_IP" /etc/turnserver.conf 2>/dev/null; then
    ok "/etc/turnserver.conf has correct external-ip"
  else
    bad "/etc/turnserver.conf has wrong (or missing) external-ip — current: $(grep '^external-ip' /etc/turnserver.conf 2>/dev/null || echo 'not set')"
  fi
else
  warn "Could not detect public IP automatically"
fi

hdr "DNS check"
RESOLVED="$(getent hosts "$DOMAIN" 2>/dev/null | awk '{print $1}' | head -1)"
if [ -n "$RESOLVED" ]; then
  ok "$DOMAIN resolves to $RESOLVED"
  if [ -n "$EXT_IP" ] && [ "$RESOLVED" != "$EXT_IP" ]; then
    warn "DNS points to $RESOLVED but server's IP is $EXT_IP — might be a CDN/proxy in front"
  fi
else
  bad "$DOMAIN does NOT resolve"
fi

hdr "Backend API"
if curl -fsSL --max-time 5 "http://127.0.0.1:4000/api/healthz" >/dev/null 2>&1; then
  ok "Backend API responds locally"
else
  bad "Backend API not responding on :4000"
fi

hdr "Recent coturn logs (last 10 lines)"
if [ -f /var/log/turnserver.log ]; then
  tail -10 /var/log/turnserver.log | sed 's/^/  /'
else
  journalctl -u coturn --no-pager -n 10 2>/dev/null | sed 's/^/  /' || warn "no coturn logs found"
fi

hdr "Recent backend logs (last 10 lines)"
journalctl -u orblood --no-pager -n 10 2>/dev/null | sed 's/^/  /' || warn "no backend logs"

echo ""
echo "  Test TURN from a browser:"
echo "  https://webrtc.github.io/samples/src/content/peerconnection/trickle-ice/"
echo "    URL:      turn:${DOMAIN}:3478"
echo "    User:     ${TURN_USER}"
echo "    Pass:     ${TURN_PASS}"
echo "  Click 'Add Server' then 'Gather candidates'."
echo "  You MUST see a 'relay' candidate. If you only see 'host' and 'srflx',"
echo "  TURN is broken (UDP relay range blocked, or external-ip wrong)."
echo ""
