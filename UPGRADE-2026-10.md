# Security & voice upgrade (October 2026)

This release fixes the problems found in the October audit. **Read the
"after deploying" part: one step on the VPS is required.**

## What changed

**Security**
- Secrets that were published in this public repo (JWT secret, TURN
  password, DB password defaults) are gone from every file. The server
  refuses to start with the leaked JWT secret; `deploy.sh` replaces it
  automatically.
- TURN no longer uses a shared password. coturn runs with
  `use-auth-secret` and the API hands each user a short-lived credential
  (`TURN_SECRET`, see `server/.env.example`).
- Logout really revokes the token; changing the password logs out every
  other session.
- Private text channels are checked on read / delete / pin / mark-read;
  channel ids from another server are rejected.
- Voice signaling only reaches people in the same voice channel.
  Presence only goes to friends, DM peers and server co-members.
- Names (users, servers, channels, roles) can no longer carry HTML;
  image URLs must be http(s), same-origin or raster data URLs. A one-time
  migration cleans existing rows.
- Uploads: real file signature check, per-user hourly limit, served with
  `nosniff` + a sandbox CSP.
- Login rate limit can't be bypassed with a fake `X-Forwarded-For`
  (nginx resolves the real IP behind ArvanCloud, see
  `scripts/arvan-realip.sh`). Tokens never land in nginx/app logs.
- Electron apps: sandboxed, navigation locked to the app, microphone only
  for the app origin, updates only from `pvwvuow/orb-lood` releases.
- docker-compose: no public MySQL port, no default passwords, backend
  runs as non-root.

**Voice**
- Peers are resolved by user id inside the room (duplicate display names
  no longer steal a call). Join / leave events now also carry
  `memberDetails: [{id, name}]`.
- `/api/voice/config` never invents credentials and turns off
  `forceRelay` when no TURN server is configured.
- `fix-arvan-ws.sh` now switches the SPA to the CDN-bypass WebSocket by
  itself (nginx injects the `orblood-realtime` meta tag).
- Service worker is network-first for HTML/JS, so a deploy is live on the
  next load (no more "old voice code" after updates).

**Stability**
- Async errors can no longer crash the process or hang requests.
- WebSocket: heartbeat (dead sockets are dropped), 64 KB message limit,
  per-socket rate limit.
- Message history returns the **newest** messages (it used to return the
  oldest 200/500, so busy chats lost new messages after a reload), with
  `?before=<id>` paging.
- `/me/snapshot` unread counts: 2 queries instead of one per chat.
- Migrations run on boot and in `npm run init-db`; `schema.sql` drift no
  longer breaks fresh installs.
- `deploy.sh`: no more `rm -rf` of the install dir, keeps hand-edited
  nginx/systemd files, stops if migrations fail.

## After deploying (required, once)

```bash
cd /opt/orblood            # or wherever deploy.sh installed it
sudo bash scripts/rotate-secrets.sh
```

That rotates the JWT secret (everyone logs in again once) and switches
coturn to the new TURN secret. Then check voice:

```bash
sudo bash scripts/setup-voice.sh diagnose
```

Optional but recommended for calls behind ArvanCloud:

```bash
sudo WS_HOST=ws.orblood.ir bash fix-arvan-ws.sh   # DNS record with cloud OFF first
```

The old secrets still exist in git history. They are useless after the
rotation; to remove them anyway, rewrite history (git-filter-repo) and
force-push, or make the repository private.

## Removed

`fix-arvan-voice.sh`, `scripts/fix-voice.sh`, `scripts/diagnose-voice.sh`
(they rewrote coturn/nginx in conflicting ways). Use
`scripts/setup-voice.sh` (`install`, `diagnose`, `verify`, `call-test`).
