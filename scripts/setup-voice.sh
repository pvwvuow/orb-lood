#!/usr/bin/env bash
# =============================================================================
# Orblood — Voice / TURN end-to-end setup  (the ONE supported voice installer)
# =============================================================================
#
# Brings the VPS into a known-good state for WebRTC voice on filtered networks
# (Iran specifically). Every step is idempotent: re-running is safe and only
# rewrites what's drifted.
#
# What this does (in order):
#   1. Installs/updates coturn and tcpdump (used by `diagnose`)
#   2. Issues/renews a Let's Encrypt cert for the TURN subdomain
#   3. Writes /etc/turnserver.conf       (instance #1 — :3478 + :5349, off by default)
#   4. Writes /etc/turnserver-443.conf   (instance #2 — :443 plain+TLS)
#   5. Auth = TURN REST secret (`use-auth-secret`). The backend hands every
#      browser short-lived credentials derived from TURN_SECRET; no shared
#      password ever leaves the server.
#   6. Installs systemd unit coturn-443.service and enables it
#   7. Fixes /var/log/turnserver*.log ownership so coturn can actually write
#   8. Aligns server/.env (TURN_SECRET, TURN_URLS TCP-only by default —
#      Iranian ISPs block outbound UDP; UDP_OK=1 adds UDP/443)
#   9. Opens UFW for every port we use
#  10. Restarts coturn, then orblood
#  11. Runs a self-test: turnutils_uclient against every transport.
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
#   KEEP_INSTANCE_1=0              # set to 1 to also run coturn on 3478/5349
#   NEW_TURN_SECRET=1              # force a fresh TURN_SECRET (rotation)
#   TURN_VERBOSE=0                 # set to 1 for per-packet coturn logging
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
SECRETS_FILE="/etc/orblood/secrets.env"
ISSUE_CERT="${ISSUE_CERT:-1}"
UDP_OK="${UDP_OK:-0}"
KEEP_INSTANCE_1="${KEEP_INSTANCE_1:-0}"
TURN_VERBOSE="${TURN_VERBOSE:-0}"

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"

# Relay UDP port ranges. Two coturn processes cannot share allocation
# state, and overlapping ranges make ICE go CHECKING → DISCONNECTED.
#   - only instance #2 running (default): it owns 49152-65535
#   - both running (KEEP_INSTANCE_1=1):   #1 = 49152-57343, #2 = 57344-65535
RELAY_LO_MIN=49152
RELAY_LO_MAX=57343
if [ "$KEEP_INSTANCE_1" = "1" ]; then RELAY_HI_MIN=57344; else RELAY_HI_MIN=49152; fi
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
  grep -E "^${key}=" "$ENV_FILE" | tail -1 | cut -d= -f2- || true
}

set_kv() {
  # set or replace KEY=VALUE in file $1 (creates file if needed)
  local file="$1" key="$2" val="$3"
  mkdir -p "$(dirname "$file")"
  touch "$file"
  python3 - "$file" "$key" "$val" <<'PY'
import sys, pathlib
path, key, val = sys.argv[1], sys.argv[2], sys.argv[3]
p = pathlib.Path(path)
out = []
replaced = False
for line in p.read_text().splitlines():
    if line.startswith(key + '='):
        if not replaced:
            out.append(f"{key}={val}")
        replaced = True
    else:
        out.append(line)
if not replaced:
    out.append(f"{key}={val}")
p.write_text('\n'.join(out) + '\n')
PY
}
set_env() { set_kv "$ENV_FILE" "$1" "$2"; }

del_env() {
  local key="$1"
  [ -f "$ENV_FILE" ] || return 0
  sed -i "/^${key}=/d" "$ENV_FILE"
}

turn_secret() {
  # TURN_SECRET from .env, then /etc/orblood/secrets.env, else generate.
  local s=""
  if [ "${NEW_TURN_SECRET:-0}" != "1" ]; then
    s="$(read_env TURN_SECRET)"
    if [ -z "$s" ] && [ -f "$SECRETS_FILE" ]; then
      s="$(grep -E '^TURN_SECRET=' "$SECRETS_FILE" | tail -1 | cut -d= -f2- || true)"
    fi
  fi
  if [ -z "$s" ]; then
    s="$(openssl rand -hex 32)"
  fi
  echo "$s"
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
      grep -E '^(listening-port|tls-listening-port|external-ip|realm|min-port|max-port|use-auth-secret|lt-cred-mech)' "$f" \
        | sed 's/^/    /'
      grep -qE '^user=' "$f" && warn "$f still has a static user= line (re-run install)"
      grep -qE '^allow-loopback-peers' "$f" && warn "$f allows loopback peers (re-run install)"
    else
      warn "$f missing"
    fi
  done

  say "Log files"
  ls -la /var/log/turnserver*.log 2>/dev/null | sed 's/^/    /' || warn "no turnserver logs found"

  say ".env (relevant keys only)"
  for k in TURN_HOST TURN_SECRET TURN_USERNAME TURN_PASSWORD TURN_URLS VOICE_FORCE_RELAY; do
    v="$(read_env "$k")"
    if [ -n "$v" ]; then
      case "$k" in
        TURN_PASSWORD|TURN_SECRET) info "$k=*** (${#v} chars)" ;;
        *) info "$k=$v" ;;
      esac
    else
      case "$k" in
        TURN_USERNAME|TURN_PASSWORD) : ;;  # not needed with TURN_SECRET
        *) warn "$k not set in $ENV_FILE" ;;
      esac
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

  SECRET="$(read_env TURN_SECRET)"
  USER="$(read_env TURN_USERNAME)"
  PASS="$(read_env TURN_PASSWORD)"
  HOST="$(read_env TURN_HOST)"
  HOST="${HOST:-$TURN_HOST}"

  command -v turnutils_uclient >/dev/null || fail "turnutils_uclient not installed (apt install coturn)"
  if [ -n "$SECRET" ]; then
    AUTH=(-u orblood-verify -W "$SECRET")
  elif [ -n "$USER" ] && [ -n "$PASS" ]; then
    AUTH=(-u "$USER" -w "$PASS")
  else
    fail "Neither TURN_SECRET nor TURN_USERNAME/TURN_PASSWORD set in $ENV_FILE"
  fi

  # -y (client-to-client) sets up its own peer. We grep for any success
  # marker coturn prints; a 403 on channel bind also proves auth+allocate.
  run() {
    local label="$1"; shift
    info "—— $label"
    local out
    out="$(timeout 20 turnutils_uclient "${AUTH[@]}" "$@" -y "$HOST" </dev/null 2>&1 || true)"
    if echo "$out" | grep -qE 'Total transmit time|Forbidden IP|channel bind: error 403|long-term authentication|tot_send_bytes'; then
      ok "$label: auth + allocate working"
    else
      warn "$label: no allocate signal — last 10 lines of output:"
      echo "$out" | tail -10 | sed 's/^/        /'
    fi
  }

  if [ "$KEEP_INSTANCE_1" = "1" ]; then
    run "udp 3478"  -p 3478
    run "tls 5349"  -p 5349 -t -S
  fi
  run "udp 443"   -p 443
  run "tcp 443"   -p 443  -t
  run "tls 443"   -p 443  -t -S
}

# ─── action: sniff (live packet capture during a real browser call) ─────────
action_sniff() {
  local secs="${1:-30}"
  say "Listening for TURN traffic on every relevant port for ${secs}s"
  info "From a browser, START A CALL NOW between two users."
  info "(Filter: udp/tcp on 3478, 5349, 443, and the relay range ${RELAY_LO_MIN}-${RELAY_HI_MAX}.)"
  echo
  command -v tcpdump >/dev/null || fail "tcpdump not installed (apt install tcpdump)"
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
# Focused dump of just the relay range: silence here during a call means
# Allocate worked but nothing is being forwarded.
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
# tcpdump + backend journal + both coturn logs in parallel, tagged
# [TCP] [BE] [T1] [T2]. Ctrl+C any time to stop.
action_call_test() {
  local secs="${1:-45}"
  command -v tcpdump >/dev/null || fail "tcpdump not installed (apt install tcpdump)"
  touch /var/log/turnserver.log /var/log/turnserver-443.log

  say "Combined call diagnostic — running for ${secs}s"
  info "From a browser, START A CALL NOW between two users."
  info "(Streams: TCP=tcpdump, BE=backend journal, T1/T2=coturn logs)"
  echo

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
  * [BE]  [voice-signal] ... is not in the sender's voice channel
          — the client signalled someone who is not in the room
  * [T1]  ERROR: check_stun_auth — credential mismatch (rerun setup)
  * [T1]  session ... allocate ... SUCCESS — coturn allocated a relay

If [TCP] shows traffic to relay range but [BE] never logs the join, the
problem is in voice signalling, not TURN. If [TCP] shows nothing during
a call, packets aren't reaching the VPS at all (CDN/ISP/client issue).
Tip: TURN_VERBOSE=1 sudo bash $0 install  enables per-packet coturn logs.
EOM
}

# Writes one coturn config. $1=file $2=listen port $3=tls port $4=min $5=max $6=log $7=pid
write_turn_conf() {
  local file="$1" lport="$2" tport="$3" minp="$4" maxp="$5" logf="$6" pidf="$7"
  {
    echo "# Managed by scripts/setup-voice.sh — DO NOT EDIT BY HAND."
    echo "# Re-run the script to regenerate."
    echo
    echo "listening-port=${lport}"
    echo "tls-listening-port=${tport}"
    echo "listening-ip=0.0.0.0"
    echo "external-ip=${EXT_IP}"
    echo "realm=${TURN_HOST}"
    echo
    # TURN REST API auth: the backend derives per-user, time-limited
    # credentials from this secret (see server/src/routes/voice-config.js).
    echo "use-auth-secret"
    echo "static-auth-secret=${TURN_SECRET}"
    if [ "$HAS_CERT" = 1 ]; then
      echo "cert=${CERT_FULLCHAIN}"
      echo "pkey=${CERT_PRIVKEY}"
    fi
    echo "no-tlsv1"
    echo "no-tlsv1_1"
    echo
    echo "min-port=${minp}"
    echo "max-port=${maxp}"
    echo
    # Never let the relay reach private / local addresses (SSRF into the
    # VPS: MySQL, the Node API, metadata services...).
    echo "no-multicast-peers"
    echo "denied-peer-ip=0.0.0.0-0.255.255.255"
    echo "denied-peer-ip=10.0.0.0-10.255.255.255"
    echo "denied-peer-ip=100.64.0.0-100.127.255.255"
    echo "denied-peer-ip=127.0.0.0-127.255.255.255"
    echo "denied-peer-ip=169.254.0.0-169.254.255.255"
    echo "denied-peer-ip=172.16.0.0-172.31.255.255"
    echo "denied-peer-ip=192.0.0.0-192.0.0.255"
    echo "denied-peer-ip=192.168.0.0-192.168.255.255"
    echo "denied-peer-ip=198.18.0.0-198.19.255.255"
    echo "denied-peer-ip=240.0.0.0-255.255.255.255"
    echo "denied-peer-ip=::1"
    echo "denied-peer-ip=fc00::-fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff"
    echo "denied-peer-ip=fe80::-febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff"
    # With forced relay both browsers use this same server, so a peer
    # address is the OTHER client's relay address on this VPS. Allow our
    # public IP explicitly (some builds reject it as "Forbidden IP").
    # Keep MySQL / the API bound to 127.0.0.1 so this cannot reach them.
    echo "allowed-peer-ip=${EXT_IP}"
    echo
    echo "user-quota=12"
    echo "total-quota=300"
    echo "stale-nonce=600"
    echo "fingerprint"
    echo "no-cli"
    echo
    echo "log-file=${logf}"
    echo "simple-log"
    if [ "$TURN_VERBOSE" = "1" ]; then echo "verbose"; fi
    echo "pidfile=${pidf}"
  } > "$file"
  chmod 640 "$file"
  chown root:turnserver "$file" 2>/dev/null || true
}

# ─── action: install / update (the default) ─────────────────────────────────
action_install() {
  say "Installing prerequisites"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq || warn "apt-get update failed (offline mirror?) — continuing"
  apt-get install -y -qq coturn tcpdump curl ca-certificates python3 ufw certbot openssl >/dev/null \
    || warn "apt-get install failed — make sure coturn is installed"
  command -v turnserver >/dev/null || fail "coturn is not installed"
  ok "coturn, tcpdump, certbot, python3 present"

  # coturn ships with TURNSERVER_ENABLED=0 by default
  sed -i 's/^#TURNSERVER_ENABLED=1$/TURNSERVER_ENABLED=1/' /etc/default/coturn 2>/dev/null || true
  grep -q '^TURNSERVER_ENABLED=1' /etc/default/coturn 2>/dev/null \
    || echo 'TURNSERVER_ENABLED=1' >> /etc/default/coturn

  # ── public IP ────────────────────────────────────────────────────────────
  EXT_IP="$(detect_external_ip)"
  [ -n "$EXT_IP" ] || fail "Could not detect public IP. Set EXTERNAL_IP env var."
  ok "public IP: $EXT_IP"

  # ── credentials: one server-side secret ──────────────────────────────────
  TURN_SECRET="$(turn_secret)"
  mkdir -p /etc/orblood && chmod 700 /etc/orblood
  set_kv "$SECRETS_FILE" TURN_SECRET "$TURN_SECRET"
  chmod 600 "$SECRETS_FILE"
  ok "TURN_SECRET ready (${#TURN_SECRET} chars, kept in $SECRETS_FILE)"

  # ── Let's Encrypt cert for the TURN subdomain ────────────────────────────
  CERT_FULLCHAIN="/etc/letsencrypt/live/${TURN_HOST}/fullchain.pem"
  CERT_PRIVKEY="/etc/letsencrypt/live/${TURN_HOST}/privkey.pem"
  if [ "$ISSUE_CERT" = "1" ]; then
    if [ -f "$CERT_FULLCHAIN" ] && [ -f "$CERT_PRIVKEY" ]; then
      ok "TLS cert for $TURN_HOST already exists (skipping issue)"
    else
      say "Issuing Let's Encrypt cert for $TURN_HOST (standalone mode on :80)"
      systemctl stop nginx 2>/dev/null || true
      if certbot certonly --standalone --non-interactive --agree-tos \
            --register-unsafely-without-email -d "$TURN_HOST" >/tmp/_cb.log 2>&1; then
        ok "cert issued"
      else
        warn "certbot failed; TLS will not work until you provide certs manually."
        tail -20 /tmp/_cb.log | sed 's/^/    /'
      fi
      systemctl start nginx 2>/dev/null || true
    fi
    # Renewal: stop nginx for the few seconds standalone needs, then
    # restart coturn so it loads the renewed cert.
    mkdir -p /etc/letsencrypt/renewal-hooks/pre /etc/letsencrypt/renewal-hooks/post
    printf '#!/bin/sh\nsystemctl stop nginx 2>/dev/null || true\n' > /etc/letsencrypt/renewal-hooks/pre/orblood-stop-nginx.sh
    printf '#!/bin/sh\nsystemctl start nginx 2>/dev/null || true\nsystemctl restart coturn-443 2>/dev/null || true\nsystemctl try-restart coturn 2>/dev/null || true\n' > /etc/letsencrypt/renewal-hooks/post/orblood-restart.sh
    chmod +x /etc/letsencrypt/renewal-hooks/pre/orblood-stop-nginx.sh /etc/letsencrypt/renewal-hooks/post/orblood-restart.sh
  else
    info "ISSUE_CERT=0 — skipping Let's Encrypt step"
  fi
  HAS_CERT=0
  [ -f "$CERT_FULLCHAIN" ] && [ -f "$CERT_PRIVKEY" ] && HAS_CERT=1
  # coturn runs as `turnserver` and must be able to read the key.
  if [ "$HAS_CERT" = 1 ] && getent group turnserver >/dev/null; then
    for d in "/etc/letsencrypt/live/${TURN_HOST}" "/etc/letsencrypt/archive/${TURN_HOST}"; do
      [ -d "$d" ] || continue
      chgrp -R turnserver "$d" 2>/dev/null || true
      chmod -R g+rX "$d" 2>/dev/null || true
    done
    chmod o+x /etc/letsencrypt/live /etc/letsencrypt/archive 2>/dev/null || true
  fi

  # ── coturn configs ───────────────────────────────────────────────────────
  say "Writing /etc/turnserver.conf and /etc/turnserver-443.conf"
  write_turn_conf /etc/turnserver.conf 3478 5349 "$RELAY_LO_MIN" "$RELAY_LO_MAX" \
    /var/log/turnserver.log /var/run/turnserver.pid
  write_turn_conf /etc/turnserver-443.conf 443 443 "$RELAY_HI_MIN" "$RELAY_HI_MAX" \
    /var/log/turnserver-443.log /var/run/turnserver-443.pid
  ok "configs written (#1 ${RELAY_LO_MIN}-${RELAY_LO_MAX}, #2 ${RELAY_HI_MIN}-${RELAY_HI_MAX})"

  # ── systemd unit for instance #2 ─────────────────────────────────────────
  say "Installing coturn-443.service"
  if [ -f "${REPO_DIR}/coturn-443.service" ]; then
    cp "${REPO_DIR}/coturn-443.service" /etc/systemd/system/coturn-443.service
  else
    cat > /etc/systemd/system/coturn-443.service <<'UNIT'
[Unit]
Description=coTURN STUN/TURN Server (port 443)
After=network.target

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

  # ── log files + rotation ─────────────────────────────────────────────────
  for f in /var/log/turnserver.log /var/log/turnserver-443.log; do
    touch "$f"
    chown turnserver:turnserver "$f"
    chmod 640 "$f"
  done
  cat > /etc/logrotate.d/orblood-coturn <<'ROT'
/var/log/turnserver.log /var/log/turnserver-443.log {
  weekly
  rotate 4
  compress
  missingok
  notifempty
  copytruncate
}
ROT
  ok "/var/log/turnserver*.log owned by turnserver (rotated weekly)"

  # ── server/.env alignment ────────────────────────────────────────────────
  say "Aligning ${ENV_FILE}"
  set_env TURN_HOST       "$TURN_HOST"
  set_env TURN_SECRET     "$TURN_SECRET"
  # Static credentials are gone: the published password stops working.
  del_env TURN_USERNAME
  del_env TURN_PASSWORD
  set_env VOICE_FORCE_RELAY "true"
  # Only :443 transports by default: (1) Iranian ISPs block UDP and odd
  # ports; (2) both peers must land on the SAME coturn process, otherwise
  # relay forwarding silently fails.
  TURN_URLS="turn:${TURN_HOST}:443?transport=tcp"
  TURN_URLS+=",turns:${TURN_HOST}:443?transport=tcp"
  if [ "$UDP_OK" = "1" ]; then
    TURN_URLS+=",turn:${TURN_HOST}:443?transport=udp"
    info "UDP_OK=1 → adding UDP/443 relay URL after the TCP ones"
  fi
  set_env TURN_URLS "$TURN_URLS"
  if [ "$UDP_OK" = "1" ]; then set_env VOICE_ALLOW_UDP "true"; else set_env VOICE_ALLOW_UDP "false"; fi
  chmod 600 "$ENV_FILE"
  id orblood >/dev/null 2>&1 && chown orblood:orblood "$ENV_FILE" || true
  ok ".env aligned (TURN_SECRET + TURN_URLS on :443)"

  # ── firewall ─────────────────────────────────────────────────────────────
  if command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q '^Status: active'; then
    say "Opening UFW for TURN/voice ports"
    ufw allow 443/tcp     >/dev/null 2>&1 || true
    ufw allow 443/udp     >/dev/null 2>&1 || true
    if [ "$KEEP_INSTANCE_1" = "1" ]; then
      ufw allow 3478/tcp  >/dev/null 2>&1 || true
      ufw allow 3478/udp  >/dev/null 2>&1 || true
      ufw allow 5349/tcp  >/dev/null 2>&1 || true
      ufw allow 5349/udp  >/dev/null 2>&1 || true
    fi
    ufw allow "${RELAY_LO_MIN}:${RELAY_HI_MAX}/udp" >/dev/null 2>&1 || true
    ok "UFW rules applied"
  fi

  # ── anything else sitting on :443? ───────────────────────────────────────
  if ss -tlnp 'sport = :443' 2>/dev/null | grep -v turnserver | grep -q LISTEN; then
    blocker="$(ss -tlnp 'sport = :443' | grep -v turnserver | grep LISTEN | head -1)"
    warn "another process is on :443 — $blocker"
    info "ArvanCloud terminates TLS for the site, so nginx only needs :80."
  fi

  # ── start the services ───────────────────────────────────────────────────
  # Only instance #2 (:443) by default, so every peer lands on one process.
  say "Restarting coturn"
  if [ "$KEEP_INSTANCE_1" = "1" ]; then
    systemctl enable coturn coturn-443 >/dev/null 2>&1 || true
    systemctl restart coturn
    systemctl restart coturn-443
    UNITS_TO_CHECK="coturn coturn-443"
  else
    systemctl disable coturn >/dev/null 2>&1 || true
    systemctl stop coturn >/dev/null 2>&1 || true
    systemctl enable coturn-443 >/dev/null 2>&1 || true
    systemctl restart coturn-443
    UNITS_TO_CHECK="coturn-443"
    info "instance #1 (3478/5349) disabled — only :443 accepts TURN"
  fi
  sleep 2
  for u in $UNITS_TO_CHECK; do
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
    if systemctl is-active --quiet orblood; then ok "orblood is active"; else warn "orblood failed to start"; fi
  fi

  say "Listening sockets"
  ss -lnp 2>/dev/null | awk '/:443 |:3478|:5349/ {print "    " $0}' | head -20

  echo
  action_verify

  echo
  say "All done."
  cat <<EOM

Next steps:
  1. Open https://${DOMAIN}/voice-debug.html?nocache=1 and run the full
     diagnostic. You should see a relay candidate in under a second.
  2. Have two users join the same voice channel and watch:
       sudo bash $0 call-test 45
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
  relay-watch [secs]      tcpdump only on the relay range
  logs                    tail -F /var/log/turnserver*.log

Environment:
  UDP_OK=1                also include UDP/443 in TURN_URLS
  ISSUE_CERT=0            skip the Let's Encrypt step
  KEEP_INSTANCE_1=1       also run coturn on 3478/5349 (split relay ranges)
  NEW_TURN_SECRET=1       rotate TURN_SECRET
  TURN_VERBOSE=1          per-packet coturn logging
EOM
    exit 1
    ;;
esac
