# scripts/

| Script | What it does |
|---|---|
| `setup-voice.sh` | The one voice installer. coturn on :443 with a TURN REST secret, cert for `turn.<domain>`, `.env` alignment. Sub-commands: `install` (default), `diagnose`, `verify`, `sniff`, `call-test`, `relay-watch`, `logs`. |
| `rotate-secrets.sh` | New JWT secret + new TURN secret (+ DB password with `ROTATE_DB=1`). Run once after the October 2026 upgrade. |
| `arvan-realip.sh` | Refreshes nginx's ArvanCloud edge list so the backend sees real visitor IPs. Installed weekly by `deploy.sh`. |
| `patch-frontend.mjs` | Exact-match safety patches for `public/js/app.js` (run by `deploy.sh`; `--check` to only report). |

## Voice troubleshooting

| Symptom | Check |
|---|---|
| No relay candidate in `/voice-debug.html` | `sudo bash scripts/setup-voice.sh verify` — auth/allocate per transport |
| ICE goes CHECKING → DISCONNECTED | `call-test 45` while calling: does relay traffic show up? Only one coturn instance should run (`diagnose`). |
| `[voice-signal] ... is not in the sender's voice channel` in the journal | the client signalled before/after the room join; rejoin the channel |
| WebSocket `open timeout` / 1006 | the CDN is in the way: run `fix-arvan-ws.sh` |
