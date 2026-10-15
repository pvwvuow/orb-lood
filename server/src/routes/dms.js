import { Router } from 'express';
import { z } from 'zod';
import { q, one } from '../db.js';
import { requireAuth } from '../auth/middleware.js';
import { areFriends, isBlocked } from '../lib/access.js';
import { sanitizePayload } from '../lib/sanitize.js';
import { parseOr400 } from '../validators.js';
import { emitNewDm, emitDmDeleted, emitDmRead } from '../realtime/events.js';
import { sendToUser } from '../realtime/ws.js';

export const dmsRouter = Router();
dmsRouter.use(requireAuth);

// Locale-independent day key (YYYY-MM-DD) shared with the renderer.
function dayKey(d) {
  const dt = (d instanceof Date) ? d : new Date(d);
  const y = dt.getFullYear();
  const m = String(dt.getMonth()+1).padStart(2,'0');
  const dd = String(dt.getDate()).padStart(2,'0');
  return y + '-' + m + '-' + dd;
}

// Get-or-create a thread row atomically. Two parallel first messages used
// to race (SELECT, then INSERT twice) and one of them hit a duplicate-key
// 500. INSERT IGNORE + SELECT is safe under concurrency thanks to the
// uniq_pair (user_a, user_b) key.
async function getOrCreateThread(a, b, isSaved) {
  await q('INSERT IGNORE INTO dm_threads (user_a, user_b, is_saved) VALUES (?, ?, ?)', [a, b, isSaved ? 1 : 0]);
  return one('SELECT * FROM dm_threads WHERE user_a = ? AND user_b = ?', [a, b]);
}

// Resolve "peerKey" (a handle without the @, OR the literal "saved") into the
// thread row used as the storage key.
async function resolveThread(peerKey, me) {
  const key = String(peerKey || '').replace(/^@/, '').toLowerCase();
  if (key === 'saved') {
    return { thread: await getOrCreateThread(me.id, me.id, true), peer: null };
  }
  const peer = await one('SELECT * FROM users WHERE handle = ? LIMIT 1', [key]);
  if (!peer) return { thread: null, peer: null };
  // DMing your own handle routes into Saved Messages.
  if (String(peer.id) === String(me.id)) {
    return { thread: await getOrCreateThread(me.id, me.id, true), peer: null };
  }
  // Threads are stored with min(uid) as user_a so we don't need two rows.
  const a = Math.min(Number(me.id), Number(peer.id)), b = Math.max(Number(me.id), Number(peer.id));
  return { thread: await getOrCreateThread(a, b, false), peer };
}

const toIso = d => ((d instanceof Date) ? d : new Date(d)).toISOString();

// GET returns the NEWEST page (default 500) in chronological order.
// Older pages: ?before=<message id>; `hasMore` says whether more exist.
// (It used to return the OLDEST 500, so long chats lost their newest
// messages after a reload.)
dmsRouter.get('/:peerKey', async (req, res, next) => {
  try {
    const { thread } = await resolveThread(req.params.peerKey, req.user);
    if (!thread) return res.status(404).json({ error: 'peer_not_found' });
    // History is visible to both parties regardless of blocks; composing is
    // what's gated. Honour dm_thread_hidden (one-sided clear).
    const hiddenRow = await one(
      'SELECT last_hidden_id FROM dm_thread_hidden WHERE user_id = ? AND thread_id = ?',
      [req.user.id, thread.id]);
    const hiddenCutoff = hiddenRow ? Number(hiddenRow.last_hidden_id) || 0 : 0;
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 500, 1), 500);
    const before = /^\d+$/.test(String(req.query.before || '')) ? String(req.query.before) : null;
    const rows = await q(
      `SELECT * FROM (
         SELECT m.*, u.handle AS sender_handle FROM dm_messages m
           JOIN users u ON u.id = m.sender_id
          WHERE m.thread_id = ? AND m.id > ? ${before ? 'AND m.id < ?' : ''}
          ORDER BY m.id DESC
          LIMIT ${limit + 1}
       ) page ORDER BY page.id ASC`,
      before ? [thread.id, hiddenCutoff, before] : [thread.id, hiddenCutoff]);
    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(1) : rows;
    const myId = String(req.user.id);
    res.json({
      hasMore,
      messages: pageRows.map(r => {
        const created = toIso(r.created_at);
        return {
          id: r.id,
          sender: String(r.sender_id) === myId ? 'me' : 'them',
          text: r.body || '',
          createdAt: created,
          time:      created,
          day:       dayKey(r.created_at),
          status:    r.status,
          edited:    !!r.edited,
          deleted:   !!r.deleted,
          payload:   r.payload_json
        };
      })
    });
  } catch (e) { next(e); }
});

const sendSchema = z.object({
  text:    z.string().max(4000).optional(),
  payload: z.any().optional(),
  replyTo: z.union([z.string(), z.number()]).optional()
});

dmsRouter.post('/:peerKey', async (req, res, next) => {
  try {
    const body = parseOr400(sendSchema, req.body, res); if (!body) return;
    const { thread, peer } = await resolveThread(req.params.peerKey, req.user);
    if (!thread) return res.status(404).json({ error: 'peer_not_found' });
    if (peer){
      if (await isBlocked(req.user.id, peer.id)) return res.status(403).json({ error: 'blocked' });
      if (peer.friends_only && !(await areFriends(req.user.id, peer.id))) {
        return res.status(403).json({ error: 'friends_only' });
      }
    }
    const payload = body.payload ? sanitizePayload(body.payload) : null;
    const result = await q(
      `INSERT INTO dm_messages (thread_id, sender_id, body, payload_json)
       VALUES (?, ?, ?, ?)`,
      [thread.id, req.user.id, body.text || '', payload ? JSON.stringify(payload) : null]
    );
    await q('UPDATE dm_threads SET last_msg_at = CURRENT_TIMESTAMP WHERE id = ?', [thread.id]);
    const created = new Date().toISOString();
    const day  = dayKey(new Date());
    res.status(201).json({
      message: {
        id: result.insertId,
        sender: 'me',
        text: body.text || '',
        createdAt: created,
        time:      created,
        day,
        status: 'sent',
        payload
      }
    });
    // Push to the peer in realtime. They see `sender:'them'` for the same row.
    if (peer && String(peer.id) !== String(req.user.id)){
      emitNewDm(req.user.id, peer.id, {
        id: result.insertId,
        sender: 'them',
        text: body.text || '',
        createdAt: created,
        time:      created,
        day,
        payload,
        peerHandle: req.user.handle ? '@' + req.user.handle : null,
        peerName: req.user.name,
        peerId: String(req.user.id)
      });
    }
  } catch (e) { next(e); }
});

// Pin / unpin a single message in a DM thread. Pass {messageId: null} to clear.
const pinSchema = z.object({ messageId: z.union([z.string(), z.number()]).nullable().optional() });
dmsRouter.post('/:peerKey/pin', async (req, res, next) => {
  try {
    const { thread } = await resolveThread(req.params.peerKey, req.user);
    if (!thread) return res.status(404).json({ error: 'peer_not_found' });
    const body = parseOr400(pinSchema, req.body, res); if (!body) return;
    if (!body.messageId){
      await q('DELETE FROM dm_pinned WHERE thread_id = ?', [thread.id]);
      res.json({ ok: true, pinnedMessageId: null });
      sendToUser(thread.user_a, { type: 'dm:pin', threadId: thread.id, messageId: null });
      if (thread.user_b !== thread.user_a) sendToUser(thread.user_b, { type: 'dm:pin', threadId: thread.id, messageId: null });
      return;
    }
    const mid = Number(body.messageId);
    const m = await one('SELECT id FROM dm_messages WHERE id = ? AND thread_id = ?', [mid, thread.id]);
    if (!m) return res.status(404).json({ error: 'message_not_found' });
    await q(
      `INSERT INTO dm_pinned (thread_id, message_id) VALUES (?, ?)
       ON DUPLICATE KEY UPDATE message_id = VALUES(message_id), pinned_at = CURRENT_TIMESTAMP`,
      [thread.id, mid]);
    res.json({ ok: true, pinnedMessageId: mid });
    sendToUser(thread.user_a, { type: 'dm:pin', threadId: thread.id, messageId: mid });
    if (thread.user_b !== thread.user_a) sendToUser(thread.user_b, { type: 'dm:pin', threadId: thread.id, messageId: mid });
  } catch (e) { next(e); }
});

// Mark every message in this thread as read for the caller.
dmsRouter.post('/:peerKey/read', async (req, res, next) => {
  try {
    const { thread, peer } = await resolveThread(req.params.peerKey, req.user);
    if (!thread) return res.status(404).json({ error: 'peer_not_found' });
    const top = await one('SELECT MAX(id) AS m FROM dm_messages WHERE thread_id = ?', [thread.id]);
    const maxId = (top && top.m) ? Number(top.m) : 0;
    await q(
      `INSERT INTO dm_read_state (user_id, thread_id, last_read_id) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE last_read_id = GREATEST(last_read_id, VALUES(last_read_id)), updated_at = CURRENT_TIMESTAMP`,
      [req.user.id, thread.id, maxId]);
    // Also flip the stored status so ticks survive a reload.
    if (maxId > 0) {
      await q(`UPDATE dm_messages SET status = 'read'
                WHERE thread_id = ? AND sender_id != ? AND id <= ? AND status != 'read'`,
        [thread.id, req.user.id, maxId]);
    }
    res.json({ ok: true, lastReadId: maxId });
    if (peer && peer.id && String(peer.id) !== String(req.user.id) && maxId > 0){
      emitDmRead(req.user.id, peer.id, maxId);
    }
  } catch (e) { next(e); }
});

dmsRouter.post('/:peerKey/clear', async (req, res, next) => {
  try {
    const { thread } = await resolveThread(req.params.peerKey, req.user);
    if (!thread) return res.status(404).json({ error: 'peer_not_found' });
    // One-sided delete: hide every message currently in the thread for the
    // caller only. The peer keeps their full history.
    const top = await one('SELECT MAX(id) AS m FROM dm_messages WHERE thread_id = ?', [thread.id]);
    const maxId = (top && top.m) ? Number(top.m) : 0;
    await q(
      `INSERT INTO dm_thread_hidden (user_id, thread_id, last_hidden_id) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE last_hidden_id = GREATEST(last_hidden_id, VALUES(last_hidden_id)), updated_at = CURRENT_TIMESTAMP`,
      [req.user.id, thread.id, maxId]);
    await q(
      `INSERT INTO dm_read_state (user_id, thread_id, last_read_id) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE last_read_id = GREATEST(last_read_id, VALUES(last_read_id)), updated_at = CURRENT_TIMESTAMP`,
      [req.user.id, thread.id, maxId]);
    res.json({ ok: true, hiddenUpTo: maxId });
  } catch (e) { next(e); }
});

dmsRouter.delete('/:peerKey/:mid', async (req, res, next) => {
  try {
    const { thread, peer } = await resolveThread(req.params.peerKey, req.user);
    if (!thread) return res.status(404).json({ error: 'peer_not_found' });
    const msg = await one('SELECT * FROM dm_messages WHERE id = ? AND thread_id = ?', [req.params.mid, thread.id]);
    if (!msg) return res.status(404).json({ error: 'not_found' });
    if (String(msg.sender_id) !== String(req.user.id)) return res.status(403).json({ error: 'forbidden' });
    await q('UPDATE dm_messages SET deleted = 1, body = NULL, payload_json = NULL WHERE id = ? AND thread_id = ?', [req.params.mid, thread.id]);
    res.json({ ok: true });
    if (peer && String(peer.id) !== String(req.user.id)) emitDmDeleted(req.user.id, peer.id, Number(req.params.mid));
  } catch (e) { next(e); }
});

const editSchema = z.object({ text: z.string().max(4000) });

dmsRouter.patch('/:peerKey/:mid', async (req, res, next) => {
  try {
    const body = parseOr400(editSchema, req.body, res); if (!body) return;
    const { thread, peer } = await resolveThread(req.params.peerKey, req.user);
    if (!thread) return res.status(404).json({ error: 'peer_not_found' });
    const msg = await one('SELECT * FROM dm_messages WHERE id = ? AND thread_id = ?', [req.params.mid, thread.id]);
    if (!msg) return res.status(404).json({ error: 'not_found' });
    if (String(msg.sender_id) !== String(req.user.id)) return res.status(403).json({ error: 'forbidden' });
    if (msg.deleted) return res.status(409).json({ error: 'message_deleted' });
    await q('UPDATE dm_messages SET body = ?, edited = 1 WHERE id = ? AND thread_id = ?', [body.text, req.params.mid, thread.id]);
    res.json({ ok: true });
    if (peer && String(peer.id) !== String(req.user.id)) {
      sendToUser(peer.id, { type: 'dm:edited', from: String(req.user.id), messageId: Number(req.params.mid), text: body.text });
    }
  } catch (e) { next(e); }
});
