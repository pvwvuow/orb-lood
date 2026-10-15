#!/usr/bin/env bash
# Refresh nginx's list of ArvanCloud edge IPs so $remote_addr is the real
# visitor (taken from Arvan's `ar-real-ip` header), not the CDN edge.
# Only requests that really come from an Arvan edge are trusted, so a
# visitor hitting the VPS directly cannot fake their IP.
#
# Installed by deploy.sh as /etc/cron.weekly/orblood-arvan-realip.
# Manual run: sudo bash scripts/arvan-realip.sh
set -euo pipefail

OUT=/etc/nginx/conf.d/orblood-realip.conf
URL="${ARVAN_IPS_URL:-https://www.arvancloud.ir/en/ips.txt}"
TMP="$(mktemp)"
trap 'rm -f "$TMP" "$TMP.conf"' EXIT

if ! curl -fsSL --max-time 20 "$URL" -o "$TMP"; then
  echo "!! could not download $URL — keeping the current list" >&2
  exit 0
fi

{
  echo "# Managed by scripts/arvan-realip.sh — regenerated weekly."
  echo "# Source: $URL ($(date -u +%Y-%m-%dT%H:%MZ))"
  n=0
  while read -r cidr; do
    cidr="$(echo "$cidr" | tr -d '[:space:]')"
    if [[ "$cidr" =~ ^[0-9a-fA-F:.]+/[0-9]+$ ]]; then
      echo "set_real_ip_from $cidr;"
      n=$((n+1))
    fi
  done < "$TMP"
  echo "real_ip_header ar-real-ip;"
  echo "real_ip_recursive on;"
  echo "# $n ranges"
} > "$TMP.conf"

if ! grep -q '^set_real_ip_from' "$TMP.conf"; then
  echo "!! downloaded list had no CIDR ranges — keeping the current list" >&2
  exit 0
fi

cp "$TMP.conf" "$OUT"
if nginx -t >/dev/null 2>&1; then
  systemctl reload nginx 2>/dev/null || true
  echo "✓ $OUT updated ($(grep -c '^set_real_ip_from' "$OUT") ranges)"
else
  echo "!! nginx -t failed with the new list; removing it" >&2
  rm -f "$OUT"
  nginx -t && systemctl reload nginx || true
  exit 1
fi
