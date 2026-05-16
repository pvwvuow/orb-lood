import { Router } from 'express';
import { pingDb } from '../db.js';
import { config } from '../config.js';

export const healthRouter = Router();

const _bootedAt = Date.now();

// Lightweight liveness probe used by:
//   - nginx upstream health checks
//   - /voice-debug.html (the in-app voice diagnostics page)
//   - the install/diagnose scripts
//
// Returns:
//   { ok, db, uptime, publicOrigin, voice: { hasTurn, forceRelay } }
//
// Note: we DO NOT leak TURN credentials here — only flags that say whether
// the operator configured a TURN server and whether forceRelay is on. The
// credentials still come from the auth-gated /voice/config endpoint.
healthRouter.get('/healthz', async (_req, res) => {
  let dbOk = false;
  let dbDetail = null;
  try { await pingDb(); dbOk = true; }
  catch (e) { dbDetail = String(e && e.message); }
  const uptimeSec = Math.round((Date.now() - _bootedAt) / 1000);
  const payload = {
    ok: dbOk,
    db: dbOk ? 'up' : 'down',
    dbDetail,
    uptime: uptimeSec,
    publicOrigin: config.publicOrigin,
    voice: {
      hasTurn:    !!(config.voice.urls && config.voice.urls.length),
      hasSelfHost: !!(config.voice.selfHost),
      hasUsername: !!(config.voice.username),
      hasPassword: !!(config.voice.password),
      forceRelay:  config.voice.forceRelay !== false
    }
  };
  res.status(dbOk ? 200 : 503).json(payload);
});
