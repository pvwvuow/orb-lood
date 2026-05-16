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

  // On filtered networks (Iran in particular) outbound UDP is dropped
  // at the carrier level. With iceTransportPolicy:'relay' set, every
  // RTP packet flows through TURN — so a single UDP relay URL in the
  // candidate list causes the browser to spend 30+ seconds probing it
  // before failing over to TCP, and the call dies on the wait.
  //
  // Filter UDP transports out of TURN URLs unless the operator
  // explicitly opts in by setting VOICE_ALLOW_UDP=true. STUN URLs
  // (which are read-only and don't carry media) are kept as-is.
  const allowUdp = String(process.env.VOICE_ALLOW_UDP || '').toLowerCase() === 'true';
  const isUdpTurn = u => /^turns?:/.test(u) && /[?&]transport=udp(\b|$)/i.test(u);
  const turnUrls = allowUdp
    ? config.voice.urls
    : config.voice.urls.filter(u => !isUdpTurn(u));

  if (turnUrls.length) {
    // Primary: operator-configured TURN/STUN (coturn on your own server).
    ice.push({
      urls: turnUrls,
      username: config.voice.username,
      credential: config.voice.password
    });

    // Also expose the same host as a STUN endpoint (free, no auth needed).
    // STUN doesn't carry media, only does NAT discovery — keeping it on
    // UDP is fine even when TURN is forced to TCP.
    const stunUrls = turnUrls
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

  // forceRelay tells the client to set iceTransportPolicy:'relay' so every
  // RTP packet flows through our coturn server. This is what makes voice
  // actually work on heavily-filtered networks (Iran, China, corporate
  // firewalls) where direct P2P fails. Operators on open networks can flip
  // VOICE_FORCE_RELAY=false in .env to allow P2P (saves coturn bandwidth).
  res.json({
    iceServers: ice,
    forceRelay: config.voice.forceRelay !== false
  });
});

// Helper to extract hostname from a URL string.
function _extractHost(url) {
  try {
    return new URL(url).hostname;
  } catch (_) {
    return '';
  }
}
