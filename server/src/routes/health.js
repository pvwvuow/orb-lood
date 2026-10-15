import { Router } from 'express';
import { pingDb } from '../db.js';
import { config } from '../config.js';

export const healthRouter = Router();

const _bootedAt = Date.now();

// Lightweight liveness probe used by nginx, /voice-debug.html and the
// install/diagnose scripts. Public, so it only returns flags: no DB error
// text, no credentials.
healthRouter.get('/healthz', async (_req, res) => {
  let dbOk = false;
  try { await pingDb(); dbOk = true; }
  catch (e) { console.warn('[healthz] db ping failed:', e && e.message); }
  const uptimeSec = Math.round((Date.now() - _bootedAt) / 1000);
  res.setHeader('Cache-Control', 'no-store');
  res.status(dbOk ? 200 : 503).json({
    ok: dbOk,
    db: dbOk ? 'up' : 'down',
    uptime: uptimeSec,
    publicOrigin: config.publicOrigin,
    voice: {
      hasTurn:     !!(config.voice.urls && config.voice.urls.length),
      hasSelfHost: !!(config.voice.selfHost),
      authMode:    config.voice.secret ? 'rest-secret' : (config.voice.password ? 'static' : 'none'),
      hasUsername: !!(config.voice.secret || config.voice.username),
      hasPassword: !!(config.voice.secret || config.voice.password),
      forceRelay:  config.voice.forceRelay !== false
    }
  });
});
