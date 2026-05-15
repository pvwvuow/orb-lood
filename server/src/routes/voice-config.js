import { Router } from 'express';
import { config } from '../config.js';
import { requireAuth } from '../auth/middleware.js';

export const voiceConfigRouter = Router();

// The frontend calls this to learn which TURN/STUN servers to use when
// negotiating WebRTC. Keeping the credential server-side means we don't ship
// the long-lived ExpressTurn key to the browser bundle.
voiceConfigRouter.get('/voice/config', requireAuth, (_req, res) => {
  const ice = [];
  if (config.voice.urls.length) {
    ice.push({
      urls: config.voice.urls,
      username: config.voice.username,
      credential: config.voice.password
    });
    const stunUrls = config.voice.urls
      .map(u => u.replace(/^turns?:/, 'stun:').split('?')[0])
      .filter((u, i, arr) => arr.indexOf(u) === i);
    if (stunUrls.length) ice.push({ urls: stunUrls });
  }
  // Free public TURN relays as fallback. These are rate-limited but work
  // well enough for 1-on-1 or small calls. Essential for Iran where most
  // ISPs do symmetric NAT and STUN-only connections fail.
  if (!config.voice.urls.length) {
    ice.push({
      urls: ['turn:openrelay.metered.ca:80'],
      username: 'openrelayproject',
      credential: 'openrelayproject'
    });
    ice.push({
      urls: ['turn:openrelay.metered.ca:443'],
      username: 'openrelayproject',
      credential: 'openrelayproject'
    });
    ice.push({
      urls: ['turn:openrelay.metered.ca:443?transport=tcp'],
      username: 'openrelayproject',
      credential: 'openrelayproject'
    });
  }
  // Public STUN fallback as a last resort.
  ice.push({ urls: ['stun:stun.l.google.com:19302'] });
  ice.push({ urls: ['stun:stun1.l.google.com:19302'] });
  res.json({ iceServers: ice });
});
