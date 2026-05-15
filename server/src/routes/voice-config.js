import { Router } from 'express';
import { config } from '../config.js';
import { requireAuth } from '../auth/middleware.js';

export const voiceConfigRouter = Router();

// The frontend calls this to learn which TURN/STUN servers to use when
// negotiating WebRTC. Keeping the credential server-side means we don't ship
// the long-lived key to the browser bundle.
//
// For users in Iran (or any filtered network), all external STUN/TURN servers
// (Google, Metered, Twilio, etc.) are blocked. The solution is to run coturn
// on the SAME server that hosts this app, so all ICE traffic stays on our own
// domain/IP which is already reachable by clients.
voiceConfigRouter.get('/voice/config', requireAuth, (_req, res) => {
  const ice = [];

  if (config.voice.urls.length) {
    // Primary: operator-configured TURN/STUN (coturn on your own server).
    ice.push({
      urls: config.voice.urls,
      username: config.voice.username,
      credential: config.voice.password
    });

    // Also expose the same host as a STUN endpoint (free, no auth needed).
    const stunUrls = config.voice.urls
      .map(u => u.replace(/^turns?:/, 'stun:').split('?')[0])
      .filter((u, i, arr) => arr.indexOf(u) === i);
    if (stunUrls.length) ice.push({ urls: stunUrls });
  }

  // If no TURN is configured at all, use the server's own public IP/domain
  // as a minimal STUN endpoint. This won't relay but at least lets peers on
  // the same network or with compatible NATs connect directly.
  if (!ice.length) {
    // Derive host from PUBLIC_ORIGIN (e.g. https://chat.example.com → chat.example.com)
    const host = config.voice.selfHost || _extractHost(config.publicOrigin);
    if (host) {
      // STUN on port 3478 (coturn default) — works even without credentials.
      ice.push({ urls: [`stun:${host}:3478`] });
      // TURN UDP
      ice.push({
        urls: [`turn:${host}:3478`],
        username: config.voice.username || 'orblood',
        credential: config.voice.password || 'orblood'
      });
      // TURN TCP (for restrictive firewalls that block UDP)
      ice.push({
        urls: [`turn:${host}:3478?transport=tcp`],
        username: config.voice.username || 'orblood',
        credential: config.voice.password || 'orblood'
      });
      // TURNS over 443 (looks like HTTPS, hardest to block)
      ice.push({
        urls: [`turns:${host}:5349`],
        username: config.voice.username || 'orblood',
        credential: config.voice.password || 'orblood'
      });
    }
  }

  // NOTE: We intentionally do NOT add Google/Metered/external STUN as
  // fallback because those are blocked in Iran and would only cause
  // timeouts that slow down ICE gathering.

  res.json({ iceServers: ice });
});

// Helper to extract hostname from a URL string.
function _extractHost(url) {
  try {
    return new URL(url).hostname;
  } catch (_) {
    return '';
  }
}
