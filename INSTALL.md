# INSTALL — Voice / TURN deployment

> This file is the single source of truth for getting voice working on a
> fresh deploy or repairing an existing one. Anything else under
> `COTURN-SETUP.md` / `scripts/README.md` is reference material.

## Quickstart (existing VPS)

If the VPS already has the orblood backend, mariadb, and nginx running,
fixing voice is one command:

```bash
cd /opt/orblood
sudo git fetch origin
sudo git checkout voice-turn-multi-port-config-prod   # or main once merged
sudo git pull
sudo bash scripts/setup-voice.sh
```

That script is idempotent — re-running it is always safe and only
rewrites whatever has drifted. Expected runtime: ~30 seconds on a warm
machine, ~2 minutes if it has to issue a Let's Encrypt cert.

When it finishes you'll see a `verify` summary listing each transport
(UDP 3478, TCP 443, TLS 443, TLS 5349) and whether `auth + allocate`
worked. The two TLS lines may print a warning that contains
`ERROR: no private key found!` — that's a turnutils_uclient client-side
quirk, not a server problem. Ignore unless TCP/UDP also failed.

## Verifying with a real call

After the installer, on the VPS run:

```bash
sudo bash scripts/setup-voice.sh call-test 60
```

…then **immediately** open a browser, log in as two different users
(can be the same machine in two tabs / incognito), and have them join
the same voice channel. The script prints four interleaved streams for
60 seconds:

| prefix | meaning |
|---|---|
| `[TCP]` | live `tcpdump` on TURN ports + relay range |
| `[BE]`  | `journalctl -u orblood -f` |
| `[T1]`  | `/var/log/turnserver.log` (3478 + 5349 instance) |
| `[T2]`  | `/var/log/turnserver-443.log` (port 443 instance) |

What healthy traffic looks like:

```
[TCP] In  IP 5.219.x.x.51234 > 194.60.231.226.443: tcp 1400      ← TLS handshake
[T2]  session 005000000000000003: realm <turn.orblood.ir> user <orblood>: incoming packet ALLOCATE processed, success
[TCP] In  IP 5.219.x.x.55005 > 194.60.231.226.59123: UDP, length 110   ← real audio
```

If `[TCP]` shows handshakes but **no packets land in the relay range
(49152-65535)**, the call is failing during ICE connectivity check —
usually because the second peer is on a network where outbound UDP is
blocked. The default install already sets `TURN_URLS` to TCP-only for
exactly this reason; if you've overridden it, set `UDP_OK=0` and re-run.

## Troubleshooting

### `voice-debug.html` says "relay candidate obtained" but real calls don't connect

ICE candidates are gathered against the TURN server — they prove
allocation works, not that the audio path works. Check
`call-test` (above): if there's no UDP traffic in the relay range
during a real call, the network between the two peers is dropping
TURN-relayed media.

The installer drops UDP transports from `TURN_URLS` precisely because
this is the most common symptom on Iranian ISPs. If you've manually
re-added UDP, remove it.

### `POST /api/channels/voice/.../join` returns 504 Gateway Timeout

That 504 comes from ArvanCloud's edge giving up after ~30s, not the
backend. Check the backend journal for the matching `[req] ERR 504`
line — if it's missing, the request never even returned, which
means the route handler hung (almost always a stuck DB query). Run:

```bash
sudo journalctl -u orblood --since "5 min ago" --no-pager | grep -E '\[req\]|error|Error'
```

### Backend logs nothing during a call

The `voice-config.js` endpoint is the only voice request the backend
sees during ICE — everything else goes peer-to-peer through TURN. So
silence in `journalctl -u orblood` during a call is normal. If you
want to confirm the backend is healthy:

```bash
curl -s -w '\n%{http_code} in %{time_total}s\n' http://127.0.0.1:4000/api/healthz
```

### Re-running the installer

It's safe. The credentials from the existing `.env` and
`/etc/turnserver*.conf` are preserved — the installer only rewrites the
files it manages and only generates a fresh password if neither already
exists.

```bash
sudo bash scripts/setup-voice.sh           # full sync
sudo bash scripts/setup-voice.sh diagnose  # read-only health check
sudo bash scripts/setup-voice.sh verify    # auth + allocate test
sudo bash scripts/setup-voice.sh logs      # tail both turnserver logs
```

## What the installer changes on the VPS

- `apt install` → `coturn`, `tcpdump`, `certbot`, `python3`, `ufw`
- `/etc/turnserver.conf` (instance #1, ports 3478 + 5349)
- `/etc/turnserver-443.conf` (instance #2, port 443)
- `/etc/systemd/system/coturn-443.service`
- `/var/log/turnserver*.log` ownership → `turnserver:turnserver`
- `/etc/letsencrypt/live/turn.<DOMAIN>/` (issued via standalone HTTP-01
  if missing — needs port 80 free for ~30 seconds)
- `server/.env` keys: `TURN_HOST`, `TURN_USERNAME`, `TURN_PASSWORD`,
  `TURN_URLS`, `VOICE_FORCE_RELAY`, `VOICE_ALLOW_UDP`
- UFW rules for 443, 3478, 5349, and the relay range 49152-65535/udp
- Restart of `coturn`, `coturn-443`, and `orblood`

## DNS — do this once, manually

In your DNS provider, create an A record:

```
turn.<your-domain>   →   <vps-public-ip>   (proxy / cloud OFF)
```

The proxy must be **off** for this subdomain. If a CDN is in front of
`turn.*` it will terminate TLS itself and the TURN handshake will fail.
The orblood.ir production deploy uses ArvanCloud and has the cloud
toggle disabled for the `turn` record specifically.
