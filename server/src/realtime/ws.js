// WebSocket server — attaches to the same HTTP server Express listens on.
//
// Clients connect to ws://<host>/ws?token=<JWT>. On connection we verify the
// token, store the socket in a per-user map, and push events when mutations
// happen elsewhere in the REST layer.
//
// Event envelope: JSON { type, ...payload }.

import { WebSocketServer } from 'ws';
import { userFromToken } from '../auth/middleware.js';
import { q } from '../db.js';
import { config } from '../config.js';

// uid → Set<WebSocket>. A single user can have multiple tabs / devices.
const clients = new Map();

let wss = null;
let heartbeat = null;

// Limits. SDP offers are a few KB; nothing legit comes close to 64 KB.
const MAX_PAYLOAD = 64 * 1024;
const HEARTBEAT_MS = 30_000;
// Per-socket message budget: ICE gathering bursts ~50 messages, so allow
// 300 per 10 s and drop (not disconnect) anything above.
const RATE_WINDOW_MS = 10_000;
const RATE_MAX = 300;

export function attachWs(httpServer) {
  wss = new WebSocketServer({ server: httpServer, path: '/ws', maxPayload: MAX_PAYLOAD });

  wss.on('error', e => console.error('[ws] server error:', e && e.message));

  wss.on('connection', (ws, req) => {
    ws._alive = true;
    ws.on('pong', () => { ws._alive = true; });
    ws.on('error', e => console.warn('[ws] socket error:', e && e.message));
    onConnection(ws, req).catch(e => {
      console.error('[ws] connection setup failed:', e && e.message);
      try { ws.close(1011, 'server_error'); } catch (_) {}
    });
  });

  // Kill sockets that stopped answering pings (phone went to sleep, NAT
  // dropped the mapping...). Without this, ghosts keep "online" presence
  // and voice membership forever.
  heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws._alive === false) { try { ws.terminate(); } catch (_) {} continue; }
      ws._alive = false;
      try { ws.ping(); } catch (_) {}
    }
  }, HEARTBEAT_MS);
  heartbeat.unref();
}

export function closeWs() {
  if (heartbeat) clearInterval(heartbeat);
  if (!wss) return;
  for (const ws of wss.clients) { try { ws.close(1001, 'server_restart'); } catch (_) {} }
  wss.close();
}

async function onConnection(ws, req) {
  const url = new URL(req.url, 'http://localhost');
  const token = url.searchParams.get('token');
  if (!token) { ws.close(4001, 'missing_token'); return; }

  const user = await userFromToken(token);
  if (!user) { ws.close(4001, 'invalid_token'); return; }

  const uid = String(user.id);
  ws._uid = uid;
  ws._userName = user.name;
  ws._handle = user.handle;
  ws._rate = { start: Date.now(), n: 0 };

  if (!clients.has(uid)) clients.set(uid, new Set());
  const firstSocket = clients.get(uid).size === 0;
  clients.get(uid).add(ws);

  // Presence only goes to people who have a reason to see it (friends, DM
  // peers, server co-members), not to every connected account.
  const related = await relatedUids(uid);
  ws._related = related;
  if (firstSocket) sendPresence(uid, user.name, true, related);

  ws.on('close', () => onClose(ws, uid, user.name));

  ws.on('message', raw => {
    if (!allowMessage(ws)) return;
    let msg;
    try { msg = JSON.parse(raw); } catch (_) { return; }
    if (!msg || typeof msg !== 'object') return;
    handleClientMessage(ws, uid, msg).catch(e => console.warn('[ws] handler error:', e && e.message));
  });

  // Ack so the client knows auth succeeded. Include the related users that
  // are online so the client can paint presence without waiting.
  const onlineUids = [...related].filter(u => clients.has(u));
  safeSend(ws, JSON.stringify({ type: 'hello', uid, name: user.name, online: onlineUids }));
}

function onClose(ws, uid, name) {
  const set = clients.get(uid);
  if (set) { set.delete(ws); if (set.size === 0) clients.delete(uid); }
  if (clients.has(uid)) return;
  // No sockets left: offline. Also drop them from voice after a grace
  // period, so a reload / network blip does not kick them out of a call.
  sendPresence(uid, name, false, ws._related || new Set());
  const evictionDelayMs = 12000;
  setTimeout(() => {
    if (clients.has(uid)) return;  // they came back; bail.
    evictFromVoice(uid, name).catch(e => console.warn('[ws] voice eviction failed:', e && e.message));
  }, evictionDelayMs).unref();
}

async function evictFromVoice(uid, name) {
  const rows = await q(
    `SELECT vm.channel_id AS cid, vc.server_id AS sid
       FROM voice_channel_members vm
       JOIN voice_channels vc ON vc.id = vm.channel_id
      WHERE vm.user_id = ?`, [uid]);
  if (!rows.length) return;
  await q('DELETE FROM voice_channel_members WHERE user_id = ?', [uid]);
  for (const row of rows) {
    const remaining = await voiceMembers(row.cid);
    const memberRows = await q('SELECT user_id FROM server_members WHERE server_id = ?', [row.sid]);
    sendToServer(memberRows.map(r => String(r.user_id)), {
      type: 'voice:leave', serverId: row.sid, channelId: row.cid,
      userName: name, userId: uid,
      members: remaining.map(r => r.name),
      memberDetails: remaining.map(r => ({ id: String(r.id), name: r.name }))
    });
  }
}

// Current members of a voice channel: [{ id, name }].
export async function voiceMembers(channelId) {
  return q(
    `SELECT u.id, u.name FROM voice_channel_members vm
       JOIN users u ON u.id = vm.user_id
      WHERE vm.channel_id = ?
      ORDER BY vm.joined_at, u.id`, [channelId]);
}

function allowMessage(ws) {
  const now = Date.now();
  if (now - ws._rate.start > RATE_WINDOW_MS) { ws._rate.start = now; ws._rate.n = 0; }
  ws._rate.n++;
  return ws._rate.n <= RATE_MAX;
}

function safeSend(ws, data) {
  try { if (ws.readyState === 1) ws.send(data); return true; } catch (_) { return false; }
}

// Everyone who may see this user's presence.
async function relatedUids(uid) {
  const rows = await q(
    `SELECT friend_id AS id FROM friendships WHERE user_id = ?
     UNION SELECT user_id FROM friendships WHERE friend_id = ?
     UNION SELECT IF(user_a = ?, user_b, user_a) FROM dm_threads
            WHERE (user_a = ? OR user_b = ?) AND is_saved = 0
     UNION SELECT sm2.user_id FROM server_members sm
            JOIN server_members sm2 ON sm2.server_id = sm.server_id
           WHERE sm.user_id = ?`,
    [uid, uid, uid, uid, uid, uid]);
  const set = new Set(rows.map(r => String(r.id)));
  set.delete(String(uid));
  return set;
}

function sendPresence(uid, name, online, recipients) {
  const data = JSON.stringify({ type: 'presence', uid, name, online });
  for (const rid of recipients) {
    const set = clients.get(rid);
    if (!set) continue;
    for (const ws of set) safeSend(ws, data);
  }
}

// --- Helpers called by REST routes to push events to connected clients ---

// Send to every socket of a specific user. Returns how many sockets were
// written to (0 = offline).
export function sendToUser(uid, payload) {
  const set = clients.get(String(uid));
  if (!set) return 0;
  const data = JSON.stringify(payload);
  let n = 0;
  for (const ws of set) if (safeSend(ws, data)) n++;
  return n;
}

// Send to every connected client (global announcements only).
export function broadcast(payload) {
  if (!wss) return;
  const data = JSON.stringify(payload);
  for (const ws of wss.clients) safeSend(ws, data);
}

// Send to every member of a server (caller passes the member uid list).
export function sendToServer(memberUids, payload) {
  const data = JSON.stringify(payload);
  for (const uid of memberUids) {
    const set = clients.get(String(uid));
    if (!set) continue;
    for (const ws of set) safeSend(ws, data);
  }
}

// Returns true if the user has at least one live socket.
export function isOnline(uid) {
  return clients.has(String(uid));
}

// Snapshot helper for /me/snapshot.
export function getOnlineUids() {
  return Array.from(clients.keys());
}

// --- Voice signaling peer resolution ---
//
// A signal may only go to someone who is in the SAME voice channel as the
// sender right now. The client may address the peer by uid, handle or
// display name; names are resolved only among that channel's members, so a
// duplicate display name elsewhere in the app can no longer steal the call.
const peerCache = new Map(); // `${uid}|${target}` -> { id, exp }
const PEER_CACHE_MS = 5000;

async function resolveVoicePeer(uid, target) {
  const key = uid + '|' + target;
  const hit = peerCache.get(key);
  if (hit && hit.exp > Date.now()) return hit.id;
  const noAt = target.replace(/^@/, '');
  const numeric = /^\d+$/.test(target) ? target : '0';
  const rows = await q(
    `SELECT DISTINCT u.id
       FROM voice_channel_members me
       JOIN voice_channel_members peer ON peer.channel_id = me.channel_id
       JOIN users u ON u.id = peer.user_id
      WHERE me.user_id = ? AND u.id != ?
        AND (u.id = ? OR u.handle = ? OR u.name = ?)
      LIMIT 2`,
    [uid, uid, numeric, noAt.toLowerCase(), target]);
  // Two different people with the same name in one room: refuse to guess.
  const id = rows.length === 1 ? String(rows[0].id) : null;
  // Only cache hits: a miss may just be a join that is still landing.
  if (id) peerCache.set(key, { id, exp: Date.now() + PEER_CACHE_MS });
  if (peerCache.size > 5000) {
    const now = Date.now();
    for (const [k, v] of peerCache) if (v.exp <= now) peerCache.delete(k);
  }
  return id;
}

// --- Client → server messages (typing, voice signaling) ---

async function handleClientMessage(ws, uid, msg) {
  switch (msg.type) {
    case 'typing': {
      // { type:'typing', to:'<peerHandle>' } → forwarded unless either
      // side has blocked the other.
      if (typeof msg.to !== 'string' || !msg.to) return;
      const rows = await q(
        `SELECT u.id FROM users u
          WHERE u.handle = ?
            AND NOT EXISTS (SELECT 1 FROM blocked_users b
                             WHERE (b.user_id = u.id AND b.blocked_id = ?)
                                OR (b.user_id = ? AND b.blocked_id = u.id))
          LIMIT 1`,
        [msg.to.replace(/^@/, '').toLowerCase(), uid, uid]);
      if (rows[0] && String(rows[0].id) !== uid) {
        sendToUser(rows[0].id, { type: 'typing', from: ws._handle });
      }
      break;
    }
    case 'ping': {
      // Lightweight RTT probe used by the orb HUD.
      const t = (typeof msg.t === 'number' || typeof msg.t === 'string') ? msg.t : null;
      safeSend(ws, JSON.stringify({ type: 'pong', t }));
      break;
    }
    case 'voice-signal': {
      // WebRTC signaling relay. `to` may be a uid, a handle or a name.
      if (msg.to == null || !msg.signal || typeof msg.signal !== 'object') return;
      const target = String(msg.to).slice(0, 120);
      const sigKind = msg.signal.kind;
      const peerId = await resolveVoicePeer(uid, target);
      if (!peerId) {
        if (config.voice.logSignals) {
          console.warn(`[voice-signal] ${ws._userName}(${uid}) → "${target}" is not in the sender's voice channel, dropping ${sigKind}`);
        }
        return;
      }
      const recipients = sendToUser(peerId, {
        type: 'voice-signal',
        from: uid,
        fromName: ws._userName,
        fromHandle: ws._handle,
        signal: msg.signal
      });
      if (config.voice.logSignals) {
        console.log(`[voice-signal] ${ws._userName}(${uid}) → uid=${peerId} kind=${sigKind} recipients=${recipients}`);
      }
      break;
    }
    default: break;
  }
}
