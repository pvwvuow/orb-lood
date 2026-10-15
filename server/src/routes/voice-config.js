import crypto from 'node:crypto';
import { Router } from 'express';
import { config } from '../config.js';
import { requireAuth } from '../auth/middleware.js';

export const voiceConfigRouter = Router();

// The frontend calls this to learn which TURN/STUN servers to use.
//
// Users in Iran (or any filtered network) cannot reach external STUN/TURN
// servers, so coturn runs on our own VPS (turn.<domain>, NOT behind the CDN).
//
// Credentials: when TURN_SECRET is set (coturn `use-auth-secret`), every
// call gets its own short-lived username/password (TURN REST API scheme):
//   username   = "<expiry-unix-ts>:<user-id>"
//   credential = base64(HMAC-SHA1(TURN_SECRET, username))
// so nothing long-lived ever reaches a browser or the debug page.
voiceConfigRouter.get('/voice/config', requireAuth, (req, res) => {
  // Never cacheable: a stale copy once put two peers on different coturn
  // instances and the call died silently.
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');

  const creds = turnCredentials(req.user.id);
  const ice = [];

  // On filtered networks outbound UDP is dropped at the carrier level, and
  // with iceTransportPolicy:'relay' a UDP TURN URL just burns 30 s of ICE
  // time. UDP TURN URLs are dropped unless VOICE_ALLOW_UDP=true.
  const isUdpTurn = u => /^turns?:/.test(u) && !/[?&]transport=tcp\b/i.test(u) && (/[?&]transport=udp\b/i.test(u) || !/^turns:/.test(u) && !/\?/.test(u));
  const turnOnly = config.voice.urls.filter(u => /^turns?:/.test(u));
  const turnUrls = config.voice.allowUdp ? turnOnly : turnOnly.filter(u => !isUdpTurn(u));
  const stunConfigured = config.voice.urls.filter(u => /^stun:/.test(u));

  if (turnUrls.length && creds) {
    ice.push({ urls: turnUrls, username: creds.username, credential: creds.credential });
  }

  // STUN on the same host (no auth, no media). Harmless even when TURN is
  // TCP-only.
  const stunUrls = stunConfigured.length
    ? stunConfigured
    : turnUrls.map(u => u.replace(/^turns?:/, 'stun:').split('?')[0]);
  const uniqueStun = [...new Set(stunUrls)];
  if (uniqueStun.length) ice.push({ urls: uniqueStun });

  const hasRelay = ice.some(e => (Array.isArray(e.urls) ? e.urls : [e.urls]).some(u => /^turns?:/.test(u)));

  // NOTE: no Google/Metered fallback on purpose: blocked in Iran, they only
  // slow ICE gathering down. And no invented credentials: if TURN is not
  // configured we say so instead of handing out a guess that cannot work.
  res.json({
    iceServers: ice,
    // Forcing relay without a TURN server would gather zero candidates.
    forceRelay: config.voice.forceRelay !== false && hasRelay,
    turnConfigured: hasRelay,
    ttl: creds && creds.ttl ? creds.ttl : null
  });
});

function turnCredentials(userId) {
  if (config.voice.secret) {
    const ttl = Math.max(600, config.voice.credentialTtlSec || 86400);
    const username = `${Math.floor(Date.now() / 1000) + ttl}:${userId}`;
    const credential = crypto.createHmac('sha1', config.voice.secret).update(username).digest('base64');
    return { username, credential, ttl };
  }
  if (config.voice.username && config.voice.password) {
    return { username: config.voice.username, credential: config.voice.password, ttl: null };
  }
  return null;
}
