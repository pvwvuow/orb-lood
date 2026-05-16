# Voice / TURN scripts

Three scripts for managing voice connectivity on the orblood VPS.

## setup-voice.sh — recommended

End-to-end installer/updater. Idempotent — re-running is safe and only
rewrites things that have drifted. This is what you want for production.

```bash
sudo bash /opt/orblood/scripts/setup-voice.sh
```

What it does:

1. Installs `coturn`, `tcpdump`, `certbot`, `python3` if missing.
2. Issues a Let's Encrypt cert for `turn.${DOMAIN}` (set `ISSUE_CERT=0` to skip).
3. Writes `/etc/turnserver.conf` (instance #1, ports 3478 + 5349) and
   `/etc/turnserver-443.conf` (instance #2, port 443 plain + TLS).
4. **Splits the relay port range** between the two instances (49152-57343
   for #1, 57344-65535 for #2) so they never allocate the same UDP port —
   port collisions cause ICE to flip CHECKING → DISCONNECTED in under a
   second and break every call.
5. Installs `coturn-443.service` and enables both units.
6. Fixes ownership of `/var/log/turnserver*.log` so coturn can write
   (a missed `chown` here turns into "no logs at all", which is the
   single most confusing failure mode).
7. Aligns `server/.env` so `TURN_URLS` lists six transports in priority
   order (turns:443?tcp first because TLS-on-443 looks like HTTPS and
   survives DPI; plain 3478 last because IR mobile carriers block it).
8. Opens UFW for every port involved.
9. Restarts `coturn`, `coturn-443`, and `orblood`.
10. Runs `turnutils_uclient` against every transport and reports which
    ones can complete an Allocate.

Sub-commands:

```bash
sudo bash setup-voice.sh diagnose      # read-only health check
sudo bash setup-voice.sh verify        # auth + Allocate test on every transport
sudo bash setup-voice.sh sniff 30      # tcpdump for 30s — start a call from browser
sudo bash setup-voice.sh logs          # tail -F both turnserver logs
```

Environment overrides (rarely needed):

```bash
DOMAIN=orblood.ir            # default
TURN_HOST=turn.orblood.ir    # default
INSTALL_DIR=/opt/orblood     # default
EXTERNAL_IP=1.2.3.4          # auto-detected if unset
ISSUE_CERT=0                 # skip Let's Encrypt step
```

### Confirming a call really uses the relay

After two users join a channel, on the VPS run:

```bash
sudo bash /opt/orblood/scripts/setup-voice.sh sniff 30
```

You should see lots of UDP packets to/from ports in the **49152-65535**
range. If you see traffic only on 3478/5349/443 and nothing in the relay
range, the Allocate is failing silently (almost always a credential
mismatch — the password in `.env` doesn't match the one in
`/etc/turnserver*.conf`). Re-running `setup-voice.sh` will resync them.

If you see **no traffic at all** during a live call, the problem is
upstream of the VPS:

- DNS for `turn.${DOMAIN}` doesn't point at this VPS
- A CDN is intercepting `turn.*` (the cloud toggle on the DNS record
  must be **off** for the TURN subdomain)
- The client's network blocks every transport (rare — six different
  ports/protocols would all have to be filtered)

---

## diagnose-voice.sh (legacy)

Older read-only health check. Still works, but `setup-voice.sh diagnose`
covers the same ground and knows about the two-instance setup.

```bash
sudo bash /opt/orblood/scripts/diagnose-voice.sh
```

## fix-voice.sh (legacy)

Older single-instance repair script. Predates the dual-instance setup
on port 443, so it doesn't know about `/etc/turnserver-443.conf` or the
split relay range. **Prefer `setup-voice.sh`** — it does everything
`fix-voice.sh` did and more.

## Manual restart

```bash
sudo systemctl restart coturn coturn-443 orblood

sudo journalctl -u coturn        -f
sudo journalctl -u coturn-443    -f
sudo journalctl -u orblood       -f
sudo tail -f /var/log/turnserver.log /var/log/turnserver-443.log
```

## Troubleshooting matrix

| Symptom | Likely cause | Fix |
|---|---|---|
| `voice-debug.html` says "relay candidate obtained" but real calls go CHECKING → DISCONNECTED in <1s | Both coturn instances allocating from the same UDP port range, packets land on the wrong process | re-run `setup-voice.sh` (it splits the range) |
| `voice-debug.html` shows zero relay candidates | `TURN_URLS` empty, password mismatch, or DNS broken | `setup-voice.sh diagnose` then `setup-voice.sh` |
| `/var/log/turnserver*.log` is always 0 bytes | coturn user can't write to the file (silent fallback to /dev/null) | `setup-voice.sh` chowns these files; or `chown turnserver:turnserver /var/log/turnserver*.log` |
| `setRemoteDescription failed: wrong state: stable` in browser console | client glare bug | already fixed in the JS bundle — hard-refresh the page |
| `403 (Forbidden IP)` when running `turnutils_uclient -e <peer>` from the VPS itself | the peer is in `denied-peer-ip`, not a real failure | use a different `-e` peer, or ignore — auth + allocate already succeeded |
