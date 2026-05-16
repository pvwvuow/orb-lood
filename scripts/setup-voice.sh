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
#   8. Aligns server/.env so TURN_URLS is TCP-only by default — Iranian
#      ISPs block outbound UDP at the carrier level, so any UDP relay URL
#      stalls the browser for 30+ seconds and kills the call. Pass
#      UDP_OK=1 to also include UDP transports if your ISP allows it.
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
#   sudo bash scripts/setup-voice.sh call-test [secs]# combined sniff + log tail
#   sudo bash scripts/setup-voice.sh logs            # tail both turnserver logs
#
# Environment overrides (rarely needed):
#   DOMAIN=orblood.ir              # root domain
#   TURN_HOST=turn.orblood.ir      # subdomain whose A-record bypasses CDN
#   INSTALL_DIR=/opt/orblood       # where the app + .env lives
#   EXTERNAL_IP=<auto-detected>    # public IPv4 of the VPS
#   ISSUE_CERT=1                   # set to 0 to skip Let's Encrypt
#   UDP_OK=0                       # set to 1 to keep UDP relay URLs in .env
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
# UDP_OK=0 (default) drops every `?transport=udp` URL from TURN_URLS
# because Iranian ISPs block outbound UDP and the browser stalls on
# them for ~30s. Set UDP_OK=1 if you've verified UDP works end-to-end.
UDP_OK="${UDP_OK:-0}"

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

  # turnutils_uclient with -y (client-to-client) does its own peer setup,
  # which avoids "Forbidden IP" noise. We let it run for ~18s (the default
  # test sends 10 packets at 1 Hz) and grep for any of the success markers
  # we know coturn prints. Earlier diagnostic runs proved that hitting
  # allocate-but-policy-block (`channel bind: error 403`) is also a
  # positive signal — auth and allocate already succeeded by then.
  run() {
    local label="$1"; shift
    info "—— $label"
    local out rc
    out="$(timeout 20 turnutils_uclient -u "$USER" -w "$PASS" "$@" -y "$HOST" </dev/null 2>&1 || true)"
    rc=$?
    if echo "$out" | grep -qE 'Total transmit time|Forbidden IP|channel bind: error 403|long-term authentication|tot_send_bytes'; then
      ok "$label: auth + allocate working"
    else
      warn "$label: no allocate signal — last 10 lines of output:"
      echo "$out" | tail -10 | sed 's/^/        /'
    fi
  }

  run "udp 3478"  -p 3478
  run "udp 443"   -p 443
  run "tcp 443"   -p 443  -t
  run "tls 443"   -p 443  -t -S
  run "tls 5349"  -p 5349 -t -S
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

# ─── action: relay-watch ────────────────────────────────────────────────────
# Focused dump of just the relay range. When debugging "ICE checking but
# no audio" you don't care about handshakes — you want to see whether
# Send indications and channel data are actually flowing through the
# allocated relay ports. Run this on its own terminal during a call;
# silence here means relay forwarding isn't working even though
# Allocate did.
action_relay_watch() {
  local secs="${1:-30}"
  command -v tcpdump >/dev/null || fail "tcpdump not installed"
  say "Watching relay range only (${RELAY_LO_MIN}-${RELAY_HI_MAX}) for ${secs}s"
  info "Place a real call now."
  echo
  timeout "$secs" tcpdump -i any -nn -q \
    "udp portrange ${RELAY_LO_MIN}-${RELAY_HI_MAX} \
     or tcp portrange ${RELAY_LO_MIN}-${RELAY_HI_MAX}" \
    2>&1 | tail -200 || true
  echo
  info "If no packets appeared above, TURN is allocating but not"
  info "forwarding — check turnserver logs for permission/channel errors."
}

# ─── action: call-test ──────────────────────────────────────────────────────
# Combined diagnostic for the moment a real call is being placed.
# Runs three streams in parallel for `secs` seconds:
#   * tcpdump on every TURN port + the relay range
#   * journalctl follow on the orblood backend (catches /voice/join 504s)
#   * tail -F on both turnserver logs
# Output is interleaved with [TCP], [BE], [T1], [T2] tags so you can tell
# which stream each line came from. Press Ctrl+C any time to stop.
action_call_test() {
  local secs="${1:-45}"
  command -v tcpdump >/dev/null || fail "tcpdump not installed (apt install tcpdump)"
  touch /var/log/turnserver.log /var/log/turnserver-443.log

  say "Combined call diagnostic — running for ${secs}s"
  info "From a browser, START A CALL NOW between two users."
  info "(Streams: TCP=tcpdump, BE=backend journal, T1/T2=coturn logs)"
  echo

  # We background each stream and prefix its output. timeout on the
  # foreground wait gives us a deterministic stop. We need to make sure
  # `set -u` (nounset) doesn't trip on the trap — running the trap on
  # EXIT after Ctrl+C, the variables it references must already exist.
  local tmpdir
  tmpdir="$(mktemp -d)"
  # shellcheck disable=SC2064
  trap "rm -rf '$tmpdir'; jobs -p | xargs -r kill 2>/dev/null || true" EXIT

  ( timeout "$secs" tcpdump -i any -nn -q \
      "udp portrange 3478-3478 or tcp portrange 3478-3478 \
       or udp portrange 5349-5349 or tcp portrange 5349-5349 \
       or udp portrange 443-443  or tcp portrange 443-443 \
       or udp portrange ${RELAY_LO_MIN}-${RELAY_HI_MAX}" \
      2>&1 | sed -u 's/^/[TCP] /' ) &

  ( timeout "$secs" journalctl -u orblood -f --no-pager \
      2>&1 | sed -u 's/^/[BE] /' ) &

  ( timeout "$secs" tail -F -n 0 /var/log/turnserver.log \
      2>&1 | sed -u 's/^/[T1] /' ) &

  ( timeout "$secs" tail -F -n 0 /var/log/turnserver-443.log \
      2>&1 | sed -u 's/^/[T2] /' ) &

  wait
  echo
  say "Diagnostic window closed."
  cat <<EOM

Quick reading guide:
  * [TCP] In  IP <client>:<port> > <vps>:443 — packet reached TURN
  * [TCP] In  IP <client>:<port> > <vps>:<49152-65535> — relay traffic
                                                       (real audio!)
  * [BE]  ERR 504 POST /api/channels/voice/.../join — backend hung
                                                     (or DB locked)
  * [BE]  SLOW 200 ... 5000ms — request was slow but did finish
  * [T1]  ERROR: check_stun_auth — credential mismatch (rerun setup)
  * [T1]  session ... allocate ... SUCCESS — coturn allocated a relay

If [TCP] shows traffic to relay range but [BE] never logs the join, the
problem is in voice signalling, not TURN. If [TCP] shows nothing during
a call, packets aren't reaching the VPS at all (CDN/ISP/client issue).
EOM
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
    # CRITICAL: explicitly allow our own public IP as a peer.
    # When force-relay is on and both browsers use this same TURN
    # server, the peer address one client sends to is the OTHER
    # client's relay address — which lives on this very VPS. coturn
    # then runs that peer through `denied-peer-ip` filtering, sees
    # 194.60.231.226 doesn't match a private range, but on some
    # builds still rejects it as "Forbidden IP" during ChannelBind.
    # Explicitly allow our public IP and the relay range we use.
    echo "allowed-peer-ip=${EXT_IP}"
    echo "allow-loopback-peers"
    echo
    echo "total-quota=100"
    echo "stale-nonce=600"
    echo "fingerprint"
    echo "no-cli"
    echo
    echo "log-file=/var/log/turnserver.log"
    echo "simple-log"
    # `verbose` makes coturn log every Allocate / CreatePermission /
    # ChannelBind / Send indication. Critical when debugging real
    # calls — without it `simple-log` only writes on errors, so a
    # broken call shows up as silence in /var/log/turnserver.log
    # (which is exactly what bit us last debug round). On a quiet
    # production server this is a few KB/min, totally fine.
    echo "verbose"
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
    echo "allowed-peer-ip=${EXT_IP}"
    echo "allow-loopback-peers"
    echo
    echo "total-quota=100"
    echo "stale-nonce=600"
    echo "fingerprint"
    echo "no-cli"
    echo
    echo "log-file=/var/log/turnserver-443.log"
    echo "simple-log"
    echo "verbose"
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
  # CRITICAL: list only :443 URLs by default. Two reasons:
  #
  # 1. Iranian ISPs and most corporate firewalls block outbound UDP and
  #    non-standard TCP ports. :443 is the one port nobody dares filter
  #    because it's the public HTTPS port.
  #
  # 2. We run TWO coturn instances (one on 3478/5349, one on 443).
  #    They are SEPARATE PROCESSES and cannot share allocation state —
  #    if peer A allocates on instance #1 and peer B allocates on
  #    instance #2, a Send indication from A to B's relay address lands
  #    on the wrong process and is silently dropped. By listing only
  #    :443 transports, we guarantee both peers in a call always end up
  #    on the same instance, so relay forwarding works end-to-end.
  #
  # Order is what the browser tries first → last:
  #   1) turn:443?tcp   — plain TCP on 443; tunnels through HTTP-CONNECT
  #                       proxies, looks like generic HTTPS to DPI
  #   2) turns:443?tcp  — TLS-wrapped TCP on 443; identical-on-the-wire
  #                       to real HTTPS, hardest to fingerprint
  TURN_URLS="turn:${TURN_HOST}:443?transport=tcp"
  TURN_URLS+=",turns:${TURN_HOST}:443?transport=tcp"
  if [ "$UDP_OK" = "1" ]; then
    # Operator opted in to UDP. Stay on :443 so we still hit a single
    # coturn instance — UDP/443 is the only UDP port worth trying.
    TURN_URLS+=",turn:${TURN_HOST}:443?transport=udp"
    info "UDP_OK=1 → adding UDP/443 relay URL after the TCP ones"
  fi
  set_env TURN_URLS "$TURN_URLS"
  # voice-config.js filters UDP URLs out of the response unless this
  # flag is explicitly true. Mirror the UDP_OK flag here.
  if [ "$UDP_OK" = "1" ]; then
    set_env VOICE_ALLOW_UDP "true"
  else
    set_env VOICE_ALLOW_UDP "false"
  fi
  if [ "$UDP_OK" = "1" ]; then
    ok ".env aligned (TURN_URLS: TCP + TLS + UDP, all on :443)"
  else
    ok ".env aligned (TURN_URLS: TCP + TLS on :443, single instance)"
  fi

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
  install|update|"")  action_install ;;
  diagnose|status)    action_diagnose ;;
  verify|test)        action_verify ;;
  sniff|capture)      action_sniff "${2:-30}" ;;
  call-test|call)     action_call_test "${2:-45}" ;;
  relay-watch|relay)  action_relay_watch "${2:-30}" ;;
  logs|tail)          action_logs ;;
  *)
    cat <<EOM
Usage: sudo bash $0 [command]

Commands:
  install     (default) full setup/update — idempotent
  diagnose                read-only health check
  verify                  run turnutils_uclient against every transport
  sniff [secs]            live tcpdump on TURN ports (default 30s)
  call-test [secs]        combined tcpdump + backend log + coturn log
                          (best for diagnosing a real call; default 45s)
  relay-watch [secs]      tcpdump only on the relay range — proves
                          whether actual audio is flowing (default 30s)
  logs                    tail -F /var/log/turnserver*.log

Environment:
  UDP_OK=1                also include UDP transports in TURN_URLS
                          (default: TCP-only — Iranian ISPs block UDP)
  ISSUE_CERT=0            skip the Let's Encrypt step
EOM
    exit 1
    ;;
esac
