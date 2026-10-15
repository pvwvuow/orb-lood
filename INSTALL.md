# Installing / updating ORBLOOD on a VPS

## Fresh VPS (Ubuntu 22.04 / 24.04)

```bash
sudo DOMAIN=orblood.ir bash install.sh
```

Installs Node 20, MariaDB, nginx, coturn; generates secrets into
`/etc/orblood/secrets.env`; runs `deploy.sh` and `scripts/setup-voice.sh`.

## Update an existing install

From a ZIP of this repo (works without git on the VPS):

```bash
cd /tmp && unzip orb-lood-main.zip
sudo bash /tmp/orb-lood-main/deploy.sh
```

`deploy.sh` keeps `server/.env`, uploads and `node_modules`, applies DB
migrations (stops if they fail), and only rewrites the nginx vhost /
systemd unit it generated itself (`FORCE_NGINX=1`, `FORCE_SYSTEMD=1` to
override).

**Upgrading from before October 2026?** Read `UPGRADE-2026-10.md` and run
`sudo bash scripts/rotate-secrets.sh` once.

## DNS (ArvanCloud)

| Record | Cloud (CDN) |
|---|---|
| `orblood.ir` → VPS | ON (Arvan terminates HTTPS, origin is :80) |
| `turn.orblood.ir` → VPS | **OFF** |
| `ws.orblood.ir` → VPS (optional, `fix-arvan-ws.sh`) | **OFF** |

## Checks

```bash
curl -s http://127.0.0.1:4000/api/healthz
sudo bash scripts/setup-voice.sh diagnose
journalctl -u orblood -f
```
