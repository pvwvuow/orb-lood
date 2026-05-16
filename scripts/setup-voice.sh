#!/usr/bin/env bash
# =============================================================================
# Orblood — Voice / TURN end-to-end setup
# =============================================================================
#
# Brings the VPS into a known-good state for WebRTC voice on filtered networks
# (Iran specifically). Every step is idempotent: re-running is safe and only
# rewrites what's drifted.
#
# What this does (in order):
#   1. Installs/updates coturn and tcpdump (used by `diagnose`)
#   2. Issues/renews a Let's Encrypt cert for the TURN subdomain
#   3. Writes /etc/turnserver.conf       (instance #1 — :3478 + :5349)
#   4. Writes /etc/turnserver-443.conf   (instance #2 — :443 plain+TLS)
#   5. Splits the relay port range so the two instances never collide
#        - instance #1: 49152-57343
#        - instance #2: 57344-65535
#   6. Installs systemd unit coturn-443.service and enables both instances
#   7. Fixes /var/log/turnserver*.log ownership so coturn can actually write
#   8. Aligns server/.env so TURN_URLS lists all six transports in priority order
#   9. Opens UFW for every port we use
#  10. Restarts coturn (both), then orblood
#  11. Runs a self-test: turnutils_uclient against every transport, then a
#      packet-level sniff to prove real traffic reaches the server during
#      a live browser call.
#
# Usage:
#   sudo bash scripts/setup-voice.sh                 # full install/update
#   sudo bash scripts/setup-voice.sh diagnose        # read-only health check
#   sudo bash scripts/setup-voice.sh verify          # auth + allocate test
#   sudo bash scripts/setup-voice.sh sniff [seconds] # live tcpdump (default 30s)
#   sudo bash scripts/setup-voice.sh logs            # tail both turnserver logs
#
# Environment overrides (rarely needed):
#   DOMAIN=orblood.ir              # root domain
#   TURN_HOST=turn.orblood.ir      # subdomain whose A-record bypasses CDN
#   INSTALL_DIR=/opt/orblood       # where the app + .env lives
#   EXTERNAL_IP=<auto-detected>    # public IPv4 of the VPS
#   ISSUE_CERT=1                   # set to 0 to skip Let's Encrypt
# =============================================================================

set -euo pipefail

# ─── pretty output ──────────────────────────────────────────────────────────
say()  { printf '\n\033[1;36m== %s\033[0m\n' "$*"; }
ok()   { printf '\033[1;32m  ✓ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m  ! %s\033[0m\n' "$*"; }
fail() { printf '\033[1;31m  ✗ %s\033[0m\n' "$*"; exit 1; }
info() { printf '    %s\n' "$*"; }

[ "$(id -u)" = "0" ] || fail "Run as root: sudo bash scripts/setup-voice.sh"

# ─── config (overridable via env) ───────────────────────────────────────────
DOMAIN="${DOMAIN:-orblood.ir}"
TURN_HOST="${TURN_HOST:-turn.${DOMAIN}}"
INSTALL_DIR="${INSTALL_DIR:-/opt/orblood}"
ENV_FILE="${INSTALL_DIR}/server/.env"
ISSUE_CERT="${ISSUE_CERT:-1}"

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"

# Port-range split between the two coturn instances. Sharing the same range
# leads to a race where each instance allocates ports the other doesn't know
# about, which manifests as ICE going CHECKING → DISCONNECTED in <1s.
RELAY_LO_MIN=49152
RELAY_LO_MAX=57343
RELAY_HI_MIN=57344
RELAY_HI_MAX=65535

# ─── helpers ────────────────────────────────────────────────────────────────
detect_external_ip() {
  if [ -n "${EXTERNAL_IP:-}" ]; then echo "$EXTERNAL_IP"; return; fi
  for url in https://api.ipify.org https://ifconfig.me https://checkip.amazonaws.com; do
    ip="$(curl -fsSL --max-time 5 "$url" 2>/dev/null | tr -d '[:space:]')"
    [ -n "$ip" ] && [[ "$ip" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] && { echo "$ip"; return; }
  done
  ip route get 1.1.1.1 2>/dev/null | awk '{print $7; exit}'
}

read_env() {
  # echo the value of a key in $ENV_FILE, or empty if missing
  local key="$1"
  [ -f "$ENV_FILE" ] || return 0
  grep -E "^${key}=" "$ENV_FILE" | tail -1 | cut -d= -f2-
}

set_env() {
  # set or replace KEY=VALUE in $ENV_FILE (creates file if needed)
  local key="$1" val="$2"
  mkdir -p "$(dirname "$ENV_FILE")"
  touch "$ENV_FILE"
  if grep -qE "^${key}=" "$ENV_FILE"; then
    # use a delimiter that won't appear in URLs/passwords
    python3 - "$ENV_FILE" "$key" "$val" <<'PY'
import sys, pathlib
path, key, val = sys.argv[1], sys.argv[2], sys.argv[3]
p = pathlib.Path(path)
out = []
replaced = False
for line in p.read_text().splitlines():
    if line.startswith(key + '='):
        out.append(f"{key}={val}")
        replaced = True
    else:
        out.append(line)
if not replaced:
    out.append(f"{key}={val}")
p.write_text('\n'.join(out) + '\n')
PY
  else
    printf '%s=%s\n' "$key" "$val" >> "$ENV_FILE"
  fi
}

# ─── action: diagnose ───────────────────────────────────────────────────────
action_diagnose() {
  say "TURN/voice diagnostic — read-only"

  info "DNS"
  for h in "$DOMAIN" "$TURN_HOST"; do
    resolved="$(getent ahostsv4 "$h" 2>/dev/null | awk 'NR==1{print $1}')"
    [ -n "$resolved" ] && ok "$h → $resolved" || warn "$h does not resolve"
  done
  EXT_IP="$(detect_external_ip)"
  info "VPS public IP: ${EXT_IP:-unknown}"
  if [ -n "${EXT_IP:-}" ]; then
    turn_ip="$(getent ahostsv4 "$TURN_HOST" 2>/dev/null | awk 'NR==1{print $1}')"
    if [ "$turn_ip" = "$EXT_IP" ]; then
      ok "$TURN_HOST points directly at the VPS (good — CDN is bypassed)"
    else
      warn "$TURN_HOST → $turn_ip but VPS IP is $EXT_IP"
      info  "If a CDN is in front of $TURN_HOST it will eat TLS handshakes."
    fi
  fi

  say "coturn processes"
  if pgrep -af 'turnserver' >/dev/null; then
    pgrep -af 'turnserver' | while read -r line; do info "$line"; done
  else
    warn "no turnserver process running"
  fi

  say "Listening sockets"
  for proto in tcp udp; do
    info "$proto:"
    ss -lnp -"$proto" 2>/dev/null | awk '/:443 |:3478|:5349/ {print "    " $0}' | head -20
  done

  say "systemd units"
  for u in coturn coturn-443 orblood nginx; do
    if systemctl list-unit-files "$u.service" 2>/dev/null | grep -q "$u.service"; then
      state="$(systemctl is-active "$u" 2>/dev/null || true)"
      [ "$state" = active ] && ok "$u: active" || warn "$u: $state"
    fi
  done

  say "Config files"
  for f in /etc/turnserver.conf /etc/turnserver-443.conf; do
    if [ -f "$f" ]; then
      info "$f:"
      grep -E '^(listening-port|tls-listening-port|external-ip|realm|min-port|max-port|user)=' "$f" \
        | sed 's/^/    /'
    else
      warn "$f missing"
    fi
  done

  say "Log files"
  ls -la /var/log/turnserver*.log 2>/dev/null | sed 's/^/    /' || warn "no turnserver logs found"

  say ".env (relevant keys only)"
  for k in TURN_HOST TURN_USERNAME TURN_PASSWORD TURN_URLS VOICE_FORCE_RELAY; do
    v="$(read_env "$k")"
    if [ -n "$v" ]; then
      case "$k" in
        TURN_PASSWORD) info "$k=*** (${#v} chars)" ;;
        *) info "$k=$v" ;;
      esac
    else
      warn "$k not set in $ENV_FILE"
    fi
  done

  say "Backend"
  if curl -fsS --max-time 3 http://127.0.0.1:4000/api/healthz >/tmp/_hz 2>/dev/null; then
    ok "$(cat /tmp/_hz)"
  else
    warn "backend not reachable on 127.0.0.1:4000"
  fi
  rm -f /tmp/_hz
}

# ─── action: verify (real Allocate test against every transport) ────────────
action_verify() {
  say "Verifying TURN auth + allocate on every transport"

  USER="$(read_env TURN_USERNAME)"
  PASS="$(read_env TURN_PASSWORD)"
  HOST="$(read_env TURN_HOST)"
  HOST="${HOST:-$TURN_HOST}"

  [ -n "$USER" ] && [ -n "$PASS" ] || fail "TURN_USERNAME / TURN_PASSWORD missing in $ENV_FILE"
  command -v turnutils_uclient >/dev/null || fail "turnutils_uclient not installed (apt install coturn)"

  # External peer that's reachable but doesn't actually answer — we don't
  # care about the echo, only whether Allocate succeeds.
  PEER="${PEER_IP:-194.60.231.226}"

  run() {
    local label="$1"; shift
    info "—— $label"
    # short timeout, single message, suppress stdin
    if timeout 8 turnutils_uclient -u "$USER" -w "$PASS" "$@" -e "$PEER" -m 1 -n 1 "$HOST" \
         </dev/null 2>&1 | grep -qE 'Total transmit time|Forbidden IP|channel bind: error 403'; then
      ok "$label: allocate succeeded"
    else
      warn "$label: allocate FAILED (check log file for the corresponding instance)"
    fi
  }

  run "udp 3478"      -p 3478
  run "udp 443"       -p 443
  run "tcp 443"       -p 443  -t
  run "tls 443"       -p 443  -t -S
  run "tls 5349"      -p 5349 -t -S
}

# ─── action: sniff (live packet capture during a real browser call) ─────────
action_sniff() {
  local secs="${1:-30}"
  say "Listening for TURN traffic on every relevant port for ${secs}s"
  info "From a browser, START A CALL NOW between two users."
  info "(Filter: udp/tcp on 3478, 5349, 443, and the relay range ${RELAY_LO_MIN}-${RELAY_HI_MAX}.)"
  echo
  command -v tcpdump >/dev/null || fail "tcpdump not installed (apt install tcpdump)"
  # We don't filter on -c so we see the full picture; output is noisy but
  # truthful. `-q` keeps each packet on a single line.
  timeout "$secs" tcpdump -i any -nn -q \
    "udp portrange 3478-3478 or tcp portrange 3478-3478 \
     or udp portrange 5349-5349 or tcp portrange 5349-5349 \
     or udp portrange 443-443  or tcp portrange 443-443 \
     or udp portrange ${RELAY_LO_MIN}-${RELAY_HI_MAX}" \
    2>&1 | tail -200 || true
}

# ─── action: logs ───────────────────────────────────────────────────────────
action_logs() {
  say "tail -F both turnserver logs (Ctrl+C to stop)"
  touch /var/log/turnserver.log /var/log/turnserver-443.log
  tail -F /var/log/turnserver.log /var/log/turnserver-443.log
}

# ─── action: install / update (the default) ─────────────────────────────────
action_install() {
  say "Installing prerequisites"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq coturn tcpdump curl ca-certificates python3 ufw certbot >/dev/null
  ok "coturn, tcpdump, certbot, python3 installed"

  # coturn ships with TURNSERVER_ENABLED=0 by default
  sed -i 's/^#TURNSERVER_ENABLED=1$/TURNSERVER_ENABLED=1/' /etc/default/coturn 2>/dev/null || true
  grep -q '^TURNSERVER_ENABLED=1' /etc/default/coturn 2>/dev/null \
    || echo 'TURNSERVER_ENABLED=1' >> /etc/default/coturn

  # ── public IP ────────────────────────────────────────────────────────────
  EXT_IP="$(detect_external_ip)"
  [ -n "$EXT_IP" ] || fail "Could not detect public IP. Set EXTERNAL_IP env var."
  ok "public IP: $EXT_IP"

  # ── credentials ──────────────────────────────────────────────────────────
  TURN_USER="$(read_env TURN_USERNAME)"
  TURN_USER="${TURN_USER:-orblood}"
  TURN_PASS="$(read_env TURN_PASSWORD)"
  if [ -z "$TURN_PASS" ]; then
    # Try to recover from an existing turnserver.conf so we don't lock out
    # already-deployed clients during an upgrade.
    TURN_PASS="$(grep -E '^user=' /etc/turnserver.conf 2>/dev/null | head -1 | cut -d: -f2- || true)"
  fi
  if [ -z "$TURN_PASS" ]; then
    TURN_PASS="$(openssl rand -hex 16)"
    info "Generated new TURN_PASSWORD (will be written to .env)"
  fi
  ok "TURN credentials: ${TURN_USER} / *** (${#TURN_PASS} chars)"

  # ── Let's Encrypt cert for the TURN subdomain ────────────────────────────
  CERT_FULLCHAIN="/etc/letsencrypt/live/${TURN_HOST}/fullchain.pem"
  CERT_PRIVKEY="/etc/letsencrypt/live/${TURN_HOST}/privkey.pem"
  if [ "$ISSUE_CERT" = "1" ]; then
    if [ -f "$CERT_FULLCHAIN" ] && [ -f "$CERT_PRIVKEY" ]; then
      ok "TLS cert for $TURN_HOST already exists (skipping issue)"
    else
      say "Issuing Let's Encrypt cert for $TURN_HOST (standalone mode on :80)"
      # certbot --standalone needs :80 free for ~30 seconds.
      systemctl stop nginx 2>/dev/null || true
      if certbot certonly --standalone --non-interactive --agree-tos \
            --register-unsafely-without-email -d "$TURN_HOST" >/tmp/_cb.log 2>&1; then
        ok "cert issued"
      else
        warn "certbot failed; TLS will not work until you provide certs manually."
        warn "Last 20 lines of certbot output:"
        tail -20 /tmp/_cb.log | sed 's/^/    /'
      fi
      systemctl start nginx 2>/dev/null || true
    fi
  else
    info "ISSUE_CERT=0 — skipping Let's Encrypt step"
  fi
  HAS_CERT=0
  [ -f "$CERT_FULLCHAIN" ] && [ -f "$CERT_PRIVKEY" ] && HAS_CERT=1

  # ── /etc/turnserver.conf  (instance #1: 3478 + 5349) ─────────────────────
  say "Writing /etc/turnserver.conf"
  {
    echo "# Managed by scripts/setup-voice.sh — DO NOT EDIT BY HAND."
    echo "# Re-run the script to regenerate. Pair: /etc/turnserver-443.conf."
    echo
    echo "listening-port=3478"
    echo "tls-listening-port=5349"
    echo "listening-ip=0.0.0.0"
    echo "external-ip=${EXT_IP}"
    echo "realm=${TURN_HOST}"
    echo
    echo "lt-cred-mech"
    echo "user=${TURN_USER}:${TURN_PASS}"
    if [ "$HAS_CERT" = 1 ]; then
      echo "cert=${CERT_FULLCHAIN}"
      echo "pkey=${CERT_PRIVKEY}"
    fi
    echo "no-tlsv1"
    echo "no-tlsv1_1"
    echo
    echo "min-port=${RELAY_LO_MIN}"
    echo "max-port=${RELAY_LO_MAX}"
    echo
    echo "no-multicast-peers"
    echo "denied-peer-ip=10.0.0.0-10.255.255.255"
    echo "denied-peer-ip=172.16.0.0-172.31.255.255"
    echo "denied-peer-ip=192.168.0.0-192.168.255.255"
    echo "denied-peer-ip=127.0.0.0-127.255.255.255"
    echo "allow-loopback-peers"
    echo
    echo "total-quota=100"
    echo "stale-nonce=600"
    echo "fingerprint"
    echo "no-cli"
    echo
    echo "log-file=/var/log/turnserver.log"
    echo "simple-log"
    echo "pidfile=/var/run/turnserver.pid"
  } > /etc/turnserver.conf
  ok "wrote /etc/turnserver.conf (relay range ${RELAY_LO_MIN}-${RELAY_LO_MAX})"

  # ── /etc/turnserver-443.conf  (instance #2: 443 plain + TLS) ─────────────
  say "Writing /etc/turnserver-443.conf"
  {
    echo "# Managed by scripts/setup-voice.sh — DO NOT EDIT BY HAND."
    echo "# Pair: /etc/turnserver.conf. Listens on :443 to bypass IR ISP filters."
    echo
    echo "listening-port=443"
    echo "tls-listening-port=443"
    echo "listening-ip=0.0.0.0"
    echo "external-ip=${EXT_IP}"
    echo "realm=${TURN_HOST}"
    echo
    echo "lt-cred-mech"
    echo "user=${TURN_USER}:${TURN_PASS}"
    if [ "$HAS_CERT" = 1 ]; then
      echo "cert=${CERT_FULLCHAIN}"
      echo "pkey=${CERT_PRIVKEY}"
    fi
    echo "no-tlsv1"
    echo "no-tlsv1_1"
    echo
    echo "min-port=${RELAY_HI_MIN}"
    echo "max-port=${RELAY_HI_MAX}"
    echo
    echo "no-multicast-peers"
    echo "denied-peer-ip=10.0.0.0-10.255.255.255"
    echo "denied-peer-ip=172.16.0.0-172.31.255.255"
    echo "denied-peer-ip=192.168.0.0-192.168.255.255"
    echo "denied-peer-ip=127.0.0.0-127.255.255.255"
    echo "allow-loopback-peers"
    echo
    echo "total-quota=100"
    echo "stale-nonce=600"
    echo "fingerprint"
    echo "no-cli"
    echo
    echo "log-file=/var/log/turnserver-443.log"
    echo "simple-log"
    echo "pidfile=/var/run/turnserver-443.pid"
  } > /etc/turnserver-443.conf
  ok "wrote /etc/turnserver-443.conf (relay range ${RELAY_HI_MIN}-${RELAY_HI_MAX})"

  # ── systemd unit for instance #2 ─────────────────────────────────────────
  say "Installing coturn-443.service"
  if [ -f "${REPO_DIR}/coturn-443.service" ]; then
    cp "${REPO_DIR}/coturn-443.service" /etc/systemd/system/coturn-443.service
  else
    cat > /etc/systemd/system/coturn-443.service <<'UNIT'
[Unit]
Description=coTURN STUN/TURN Server (port 443)
After=network.target coturn.service

[Service]
Type=simple
User=turnserver
Group=turnserver
ExecStart=/usr/bin/turnserver -c /etc/turnserver-443.conf
AmbientCapabilities=CAP_NET_BIND_SERVICE
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT
  fi
  systemctl daemon-reload
  ok "coturn-443.service installed"

  # ── log file ownership (silent killer of debugging) ──────────────────────
  for f in /var/log/turnserver.log /var/log/turnserver-443.log; do
    touch "$f"
    chown turnserver:turnserver "$f"
    chmod 640 "$f"
  done
  ok "/var/log/turnserver*.log owned by turnserver:turnserver"

  # ── server/.env alignment ────────────────────────────────────────────────
  say "Aligning ${ENV_FILE}"
  set_env TURN_HOST       "$TURN_HOST"
  set_env TURN_USERNAME   "$TURN_USER"
  set_env TURN_PASSWORD   "$TURN_PASS"
  set_env VOICE_FORCE_RELAY "true"
  # Six URLs, ordered by reliability on filtered networks:
  #   1) turns:443?tcp   — TLS over 443, looks like HTTPS, hardest to block
  #   2) turn:443?tcp    — plain TCP over 443
  #   3) turn:443?udp    — UDP over 443 where ISP allows
  #   4) turns:5349?tcp  — standard TURNS port
  #   5) turn:3478?udp   — standard TURN UDP
  #   6) turn:3478?tcp   — last-resort plain TCP
  TURN_URLS="turns:${TURN_HOST}:443?transport=tcp"
  TURN_URLS+=",turn:${TURN_HOST}:443?transport=tcp"
  TURN_URLS+=",turn:${TURN_HOST}:443?transport=udp"
  TURN_URLS+=",turns:${TURN_HOST}:5349?transport=tcp"
  TURN_URLS+=",turn:${TURN_HOST}:3478?transport=udp"
  TURN_URLS+=",turn:${TURN_HOST}:3478?transport=tcp"
  set_env TURN_URLS "$TURN_URLS"
  ok ".env aligned (TURN_URLS has 6 transports)"

  # ── firewall ─────────────────────────────────────────────────────────────
  if command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q '^Status: active'; then
    say "Opening UFW for TURN/voice ports"
    ufw allow 443/tcp     >/dev/null 2>&1 || true
    ufw allow 443/udp     >/dev/null 2>&1 || true
    ufw allow 3478/tcp    >/dev/null 2>&1 || true
    ufw allow 3478/udp    >/dev/null 2>&1 || true
    ufw allow 5349/tcp    >/dev/null 2>&1 || true
    ufw allow 5349/udp    >/dev/null 2>&1 || true
    ufw allow "${RELAY_LO_MIN}:${RELAY_HI_MAX}/udp" >/dev/null 2>&1 || true
    ok "UFW rules applied (443, 3478, 5349, ${RELAY_LO_MIN}-${RELAY_HI_MAX}/udp)"
  fi

  # ── stop anything that might be sitting on :443 (not us) ─────────────────
  if ss -tlnp 'sport = :443' 2>/dev/null | grep -v turnserver | grep -q LISTEN; then
    blocker="$(ss -tlnp 'sport = :443' | grep -v turnserver | grep LISTEN | head -1)"
    warn "another process is on :443 — $blocker"
    info "If this is nginx with TLS termination, you must move it off :443."
    info "On orblood.ir, ArvanCloud terminates TLS so nginx only needs :80."
  fi

  # ── start the services ───────────────────────────────────────────────────
  say "Restarting coturn instances"
  systemctl enable coturn coturn-443 >/dev/null 2>&1 || true
  systemctl restart coturn
  systemctl restart coturn-443
  sleep 2

  for u in coturn coturn-443; do
    if systemctl is-active --quiet "$u"; then
      ok "$u is active"
    else
      warn "$u failed to start — last 20 lines:"
      journalctl -u "$u" --no-pager -n 20 | sed 's/^/    /'
    fi
  done

  # ── restart backend so it picks up the new .env ──────────────────────────
  if systemctl list-unit-files orblood.service 2>/dev/null | grep -q orblood.service; then
    say "Restarting orblood backend"
    systemctl restart orblood
    sleep 1
    if systemctl is-active --quiet orblood; then
      ok "orblood is active"
    else
      warn "orblood failed to start"
    fi
  fi

  # ── verify everything is listening ───────────────────────────────────────
  say "Listening sockets"
  ss -lnp 2>/dev/null | awk '/:443 |:3478|:5349/ {print "    " $0}' | head -20

  # ── live verification ────────────────────────────────────────────────────
  echo
  action_verify

  # ── done ─────────────────────────────────────────────────────────────────
  echo
  say "All done."
  cat <<EOM

Next steps:
  1. From a browser, open https://${DOMAIN}/voice-debug.html?nocache=1
     and run "FULL DIAGNOSTIC RUN". You should see a relay candidate in
     under one second, and the URL list should include all 6 transports.

  2. Have two real users join the same voice channel. While they connect,
     run this to confirm packets are actually flowing:

       sudo bash $0 sniff 30

     If you see lots of UDP/TCP traffic to the relay range
     (${RELAY_LO_MIN}-${RELAY_HI_MAX}), TURN is working. If you see nothing,
     the issue is upstream of the VPS (CDN, ISP, client firewall).

  3. Tail logs while debugging:

       sudo bash $0 logs

EOM
}

# ─── dispatch ───────────────────────────────────────────────────────────────
case "${1:-install}" in
  install|update|"") action_install ;;
  diagnose|status)   action_diagnose ;;
  verify|test)       action_verify ;;
  sniff|capture)     action_sniff "${2:-30}" ;;
  logs|tail)         action_logs ;;
  *)
    cat <<EOM
Usage: sudo bash $0 [command]

Commands:
  install   (default) full setup/update — idempotent
  diagnose             read-only health check
  verify               run turnutils_uclient against every transport
  sniff [secs]         live tcpdump on TURN ports (default 30s)
  logs                 tail -F /var/log/turnserver*.log
EOM
    exit 1
    ;;
esac
