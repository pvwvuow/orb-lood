# Voice / TURN troubleshooting scripts

Two scripts for diagnosing and fixing voice connectivity issues on the orblood server.

## diagnose-voice.sh

Read-only health check. Run it first to see what's broken.

```bash
sudo bash /opt/orblood/scripts/diagnose-voice.sh
```

It checks:
- Whether `coturn`, `orblood` (backend), `nginx`, `mariadb` are running
- Whether the right ports are listening (3478 UDP/TCP, 5349 TLS, 4000 backend)
- Whether UFW allows the TURN ports (especially the 49152-65535/udp relay range)
- Whether `/etc/turnserver.conf`'s `external-ip` matches the actual public IP
- Whether DNS resolves the domain to the right IP
- Whether the backend API responds locally
- Recent coturn + backend logs

## fix-voice.sh

Repair script. Re-writes `/etc/turnserver.conf` with the correct values, opens
firewall ports, and restarts coturn + the backend. Re-runs are safe.

```bash
sudo bash /opt/orblood/scripts/fix-voice.sh
```

It:
1. Reads existing TURN credentials from `/opt/orblood/server/.env`
2. Auto-detects the server's public IP
3. Writes a clean `/etc/turnserver.conf` matching the credentials in `.env`
4. Aligns `.env` so frontend `iceServers` use the right URLs
5. Opens UFW firewall ports (3478, 5349, 49152-65535/udp)
6. Restarts coturn and the orblood backend
7. Verifies everything is listening

After running, test from a browser at:
<https://webrtc.github.io/samples/src/content/peerconnection/trickle-ice/>

Add this server:
- URL: `turn:<your-domain>:3478`
- Username + password: shown in the script's output (also saved in `.env`)

Click "Gather candidates". You **must** see a candidate of type `relay` —
that proves TURN is working from outside your network.

## Common problems

| Symptom | Likely cause | Fix |
|---|---|---|
| Users see ICE go to `disconnected` then `failed` | UDP 3478 blocked OR relay range (49152-65535) blocked | run `fix-voice.sh` to open UFW ports |
| TURN server unreachable (no `relay` candidate) | `external-ip` in `turnserver.conf` is wrong (e.g. behind NAT) | run `fix-voice.sh` — it auto-detects the IP |
| Username/password mismatch | `/etc/turnserver.conf` and `server/.env` got out of sync | run `fix-voice.sh` — it syncs them |
| `setRemoteDescription failed: wrong state: stable` | client-side glare bug | already fixed in client build `2026-05-16-a` (refresh browser) |

## Manual server restart

```bash
# After tweaking config:
sudo systemctl restart coturn
sudo systemctl restart orblood

# Watch logs in real time:
sudo journalctl -u coturn -f
sudo journalctl -u orblood -f
sudo tail -f /var/log/turnserver.log
```
