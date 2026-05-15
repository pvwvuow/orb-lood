import { Router } from 'express';
import { config } from '../config.js';
import { requireAuth } from '../auth/middleware.js';

export const voiceConfigRouter = Router();

// The frontend calls this to learn which TURN/STUN servers to use when
// negotiating WebRTC. Keeping the credential server-side means we don't ship
// the long-lived ExpressTurn key to the browser bundle.
//
// Strategy: the user's own VPS runs coturn, so we ALWAYS include that as the
// primary relay. This guarantees connectivity even behind symmetric NAT
// (common in Iran) without depending on any external service.
voiceConfigRouter.get('/voice/config', requireAuth, (_req, res) => {
  const ice = [];

  if (config.voice.urls.length) {
    // Explicit TURN URLs configured via EXPRESSTURN_* env vars — use them
    // as the primary relay (this is coturn on the same VPS).
    ice.push({
      urls: config.voice.urls,
      username: config.voice.username,
      credential: config.voice.password
    });
    // Derive STUN from the same host so NAT discovery also goes through
    // the user's server (avoids reliance on Google/Cloudflare STUN).
    const stunUrls = config.voice.urls
      .map(u => u.replace(/^turns?:/, 'stun:').split('?')[0])
      .filter((u, i, arr) => arr.indexOf(u) === i);
    if (stunUrls.length) ice.push({ urls: stunUrls });
  } else {
    // No explicit TURN configured. Derive relay URLs from PUBLIC_ORIGIN
    // domain — the assumption is that coturn runs on the same VPS on the
    // standard ports (3478 UDP/TCP + 5349 TLS). The install.sh script
    // always sets up coturn with a simple user/password pair stored in
    // /etc/orblood/secrets.env. We read the fallback credentials from
    // COTURN_USERNAME / COTURN_PASSWORD env vars (set by install.sh in
    // the .env file) or use a well-known default that matches the
    // install script's generated coturn config.
    const domain = (() => {
      try {
        const origin = config.publicOrigin || '';
        if (origin === '*') return null;
        return new URL(origin).hostname;
      } catch { return null; }
    })();

    const turnUser = process.env.COTURN_USERNAME || process.env.EXPRESSTURN_USERNAME || 'orblood';
    const turnPass = process.env.COTURN_PASSWORD || process.env.EXPRESSTURN_PASSWORD || '';

    if (domain && turnPass) {
      // Primary: TURNS over TCP 443/5349 (works even if UDP is blocked)
      ice.push({
        urls: [
          `turns:${domain}:5349?transport=tcp`,
          `turn:${domain}:3478?transport=udp`,
          `turn:${domain}:3478?transport=tcp`
        ],
        username: turnUser,
        credential: turnPass
      });
      // STUN on same host
      ice.push({ urls: [`stun:${domain}:3478`] });
    } else {
      // Absolute fallback: free public TURN relays (rate-limited, may be
      // unreachable from Iran but better than nothing).
      ice.push({
        urls: ['turn:openrelay.metered.ca:80'],
        username: 'openrelayproject',
        credential: 'openrelayproject'
      });
      ice.push({
        urls: ['turn:openrelay.metered.ca:443?transport=tcp'],
        username: 'openrelayproject',
        credential: 'openrelayproject'
      });
    }
  }

  // Public STUN as last-resort fallback (may be filtered in Iran but
  // costs nothing to include — the browser tries them in order).
  ice.push({ urls: ['stun:stun.l.google.com:19302'] });
  res.json({ iceServers: ice });
});
