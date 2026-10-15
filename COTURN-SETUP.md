# coturn (voice relay)

Everything is automated by `scripts/setup-voice.sh`:

```bash
sudo bash scripts/setup-voice.sh            # install / update (idempotent)
sudo bash scripts/setup-voice.sh diagnose   # read-only health check
sudo bash scripts/setup-voice.sh verify     # Allocate test on every transport
sudo bash scripts/setup-voice.sh call-test 45
```

Design:
- **DNS:** `turn.<domain>` points straight at the VPS (ArvanCloud cloud
  **off**). The CDN would swallow TURN on :443.
- **One instance on :443** (`coturn-443.service`, TCP + TLS, UDP optional
  with `UDP_OK=1`). Iranian carriers block UDP and 3478, never 443. Both
  peers must use the same coturn process, so the 3478/5349 instance is
  off by default (`KEEP_INSTANCE_1=1` brings it back with a separate
  relay range).
- **Auth:** `use-auth-secret`. The backend signs per-user credentials
  valid for `TURN_CREDENTIAL_TTL` seconds with `TURN_SECRET`; no password
  is ever shipped to browsers or stored in git.
- **Relay policy:** private, loopback, link-local and CGNAT ranges are
  denied; the VPS public IP is allowed (peers are relay addresses on the
  same box). Keep MySQL and the API bound to 127.0.0.1.

`turnserver.conf` / `turnserver-443.conf` in the repo are reference
templates only.
