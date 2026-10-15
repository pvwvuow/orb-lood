import { Router } from 'express';
import { z } from 'zod';
import { q, one } from '../db.js';
import { requireAuth } from '../auth/middleware.js';
import { uid } from '../lib/ids.js';
import { requireMember, requirePermission } from '../lib/access.js';
import { sanitizePayload } from '../lib/sanitize.js';
import { parseOr400 } from '../validators.js';
import {
  emitChannelMessage, emitVoiceJoin, emitVoiceLeave,
  emitChannelMessageDeleted, emitServerChannelAdded, emitServerChannelDeleted,
  emitServerUpdated, emitChannelMessagePinned, emitVoiceKicked
} from '../realtime/events.js';
import { voiceMembers } from '../realtime/ws.js';

export const channelsRouter = Router();
channelsRouter.use(requireAuth);

const channelSchema = z.object({
  name:       z.string().trim().min(1).max(80),
  style:      z.string().max(40).optional(),
  categoryId: z.string().min(1).max(40).nullable().optional()
});

// ---------------------------------------------------------------------------
// Access helpers
// ---------------------------------------------------------------------------

const _parse = v => {
  if (v == null) return null;
  if (typeof v === 'string') { try { return JSON.parse(v); } catch { return null; } }
  return v;
};

async function userRoleIds(sid, userId) {
  return (await q(
    `SELECT sr.id FROM server_roles sr
       JOIN server_role_members srm
         ON srm.server_id = sr.server_id AND srm.role_id = sr.id
      WHERE sr.server_id = ? AND srm.user_id = ?`, [sid, userId]
  )).map(r => r.id);
}

// Can this member see the channel? Admins / owner always can. Everyone else
// must pass the parent category's visibleRoleIds AND the channel's own,
// unless a per-channel override allows / denies viewChannel.
function canView(ch, roleIds) {
  const allowMap = _parse(ch.permission_allow) || {};
  const denyMap  = _parse(ch.permission_deny)  || {};
  const hasAny = list => (!Array.isArray(list) || !list.length) ? true : roleIds.some(r => list.includes(r));
  const viewAllowed = roleIds.some(r => Array.isArray(allowMap[r]) && allowMap[r].includes('viewChannel'));
  const viewDenied  = roleIds.some(r => Array.isArray(denyMap[r])  && denyMap[r].includes('viewChannel'));
  return !viewDenied && (viewAllowed || (hasAny(_parse(ch.cat_visible_role_ids)) && hasAny(_parse(ch.visible_role_ids))));
}

// Loads a text channel that really belongs to `sid` and that the member may
// see. Sends 404 / 403 itself and returns null when not allowed. This is
// what stops "member of server A reads private channel X" and "read a
// channel of server B through server A's URL".
async function loadTextChannel(req, res, sid, cid, m) {
  const ch = await one(
    `SELECT t.*, c.visible_role_ids AS cat_visible_role_ids
       FROM text_channels t
       LEFT JOIN server_categories c ON c.id = t.category_id
      WHERE t.id = ? AND t.server_id = ?`,
    [cid, sid]);
  if (!ch) { res.status(404).json({ error: 'channel_not_found' }); return null; }
  if (!m.is_admin) {
    const roleIds = await userRoleIds(sid, req.user.id);
    if (!canView(ch, roleIds)) { res.status(403).json({ error: 'channel_not_visible' }); return null; }
    ch._roleIds = roleIds;
  }
  return ch;
}

async function loadVoiceChannel(req, res, sid, cid, m, { checkVisible = true } = {}) {
  const ch = await one(
    `SELECT v.*, c.visible_role_ids AS cat_visible_role_ids
       FROM voice_channels v
       LEFT JOIN server_categories c ON c.id = v.category_id
      WHERE v.id = ? AND v.server_id = ?`,
    [cid, sid]);
  if (!ch) { res.status(404).json({ error: 'not_found' }); return null; }
  if (checkVisible && m && !m.is_admin) {
    const roleIds = await userRoleIds(sid, req.user.id);
    if (!canView(ch, roleIds)) { res.status(403).json({ error: 'channel_not_visible' }); return null; }
  }
  return ch;
}

const memberPayload = rows => ({
  names: rows.map(r => r.name),
  details: rows.map(r => ({ id: String(r.id), name: r.name }))
});

// ---------------------------------------------------------------------------
// Channel CRUD
// ---------------------------------------------------------------------------

// Create a text channel.
channelsRouter.post('/text/:sid', async (req, res, next) => {
  try {
    const sid = req.params.sid;
    if (!await requirePermission(req, res, sid, "manageTextCh")) return;
    const body = parseOr400(channelSchema, req.body, res); if (!body) return;
    if (body.categoryId) {
      const cat = await one('SELECT id FROM server_categories WHERE id = ? AND server_id = ?', [body.categoryId, sid]);
      if (!cat) return res.status(400).json({ error: 'category_not_found' });
    }
    const cid = uid();
    await q(
      `INSERT INTO text_channels (id, server_id, category_id, name, style, position)
       VALUES (?, ?, ?, ?, ?, (SELECT COALESCE(MAX(position),0)+1 FROM (SELECT * FROM text_channels) AS x WHERE x.server_id = ?))`,
      [cid, sid, body.categoryId || null, body.name, body.style || 'glow', sid]
    );
    const channel = { id: cid, name: body.name, style: body.style || 'glow', unread: 0, categoryId: body.categoryId || null };
    res.status(201).json({ channel });
    emitServerChannelAdded(sid, 'text', channel, body.categoryId || null);
  } catch (e) { next(e); }
});

channelsRouter.delete('/text/:sid/:cid', async (req, res, next) => {
  try {
    const sid = req.params.sid;
    if (!await requirePermission(req, res, sid, "manageTextCh")) return;
    await q('DELETE FROM text_channels WHERE id = ? AND server_id = ?', [req.params.cid, sid]);
    res.json({ ok: true });
    emitServerChannelDeleted(sid, 'text', req.params.cid);
  } catch (e) { next(e); }
});

// Create a voice channel.
channelsRouter.post('/voice/:sid', async (req, res, next) => {
  try {
    const sid = req.params.sid;
    if (!await requirePermission(req, res, sid, "manageVoiceCh")) return;
    const body = parseOr400(channelSchema, req.body, res); if (!body) return;
    if (body.categoryId) {
      const cat = await one('SELECT id FROM server_categories WHERE id = ? AND server_id = ?', [body.categoryId, sid]);
      if (!cat) return res.status(400).json({ error: 'category_not_found' });
    }
    const cid = uid();
    await q(
      `INSERT INTO voice_channels (id, server_id, category_id, name, style, position)
       VALUES (?, ?, ?, ?, ?, (SELECT COALESCE(MAX(position),0)+1 FROM (SELECT * FROM voice_channels) AS x WHERE x.server_id = ?))`,
      [cid, sid, body.categoryId || null, body.name, body.style || 'indigo', sid]
    );
    const channel = { id: cid, name: body.name, style: body.style || 'indigo', categoryId: body.categoryId || null };
    res.status(201).json({ channel });
    emitServerChannelAdded(sid, 'voice', channel, body.categoryId || null);
  } catch (e) { next(e); }
});

channelsRouter.delete('/voice/:sid/:cid', async (req, res, next) => {
  try {
    const sid = req.params.sid;
    if (!await requirePermission(req, res, sid, "manageVoiceCh")) return;
    await q('DELETE FROM voice_channels WHERE id = ? AND server_id = ?', [req.params.cid, sid]);
    res.json({ ok: true });
    emitServerChannelDeleted(sid, 'voice', req.params.cid);
  } catch (e) { next(e); }
});

// ---------------------------------------------------------------------------
// Voice membership
// ---------------------------------------------------------------------------

// Join a voice channel — records the current member set so other clients
// can see who's there and so signaling is only relayed inside the room.
channelsRouter.post('/voice/:sid/:cid/join', async (req, res, next) => {
  try {
    const { sid, cid } = req.params;
    const m = await requireMember(req, res, sid); if (!m) return;
    const ch = await loadVoiceChannel(req, res, sid, cid, m); if (!ch) return;
    // A user can only be in one voice channel at a time. Drop them out of
    // any *other* voice channel first and fan out leave events.
    const stale = await q(
      `SELECT vm.channel_id, vc.server_id
         FROM voice_channel_members vm
         JOIN voice_channels vc ON vc.id = vm.channel_id
        WHERE vm.user_id = ? AND vm.channel_id != ?`,
      [req.user.id, cid]);
    if (stale.length){
      await q('DELETE FROM voice_channel_members WHERE user_id = ? AND channel_id != ?', [req.user.id, cid]);
    }
    await q(
      `INSERT INTO voice_channel_members (channel_id, user_id) VALUES (?, ?)
       ON DUPLICATE KEY UPDATE joined_at = joined_at`,
      [cid, req.user.id]
    );
    const mp = memberPayload(await voiceMembers(cid));
    // `members` (names) kept for older clients; `memberDetails` has ids.
    res.json({ ok: true, members: mp.names, memberDetails: mp.details, selfId: String(req.user.id) });
    for (const s of stale){
      const rem = memberPayload(await voiceMembers(s.channel_id));
      emitVoiceLeave(s.server_id, s.channel_id, req.user.name, rem.names,
        { userId: String(req.user.id), memberDetails: rem.details });
    }
    emitVoiceJoin(sid, cid, req.user.name, mp.names,
      { userId: String(req.user.id), memberDetails: mp.details });
  } catch (e) { next(e); }
});

channelsRouter.post('/voice/:sid/:cid/leave', async (req, res, next) => {
  try {
    const { sid, cid } = req.params;
    const m = await requireMember(req, res, sid); if (!m) return;
    const ch = await loadVoiceChannel(req, res, sid, cid, m, { checkVisible: false }); if (!ch) return;
    await q('DELETE FROM voice_channel_members WHERE channel_id = ? AND user_id = ?', [cid, req.user.id]);
    const mp = memberPayload(await voiceMembers(cid));
    res.json({ ok: true });
    emitVoiceLeave(sid, cid, req.user.name, mp.names,
      { userId: String(req.user.id), memberDetails: mp.details });
  } catch (e) { next(e); }
});

// Kick another user out of a voice channel. Requires kickFromVoice. The
// channel must belong to this server and the target must be in it.
const voiceKickSchema = z.object({ userId: z.union([z.string(), z.number()]) });
channelsRouter.post('/voice/:sid/:cid/kick', async (req, res, next) => {
  try {
    const { sid, cid } = req.params;
    const m = await requirePermission(req, res, sid, 'kickFromVoice'); if (!m) return;
    const ch = await loadVoiceChannel(req, res, sid, cid, m, { checkVisible: false }); if (!ch) return;
    const body = parseOr400(voiceKickSchema, req.body, res); if (!body) return;
    const targetId = String(body.userId);
    if (String(req.user.id) === targetId) return res.status(400).json({ error: 'cannot_kick_self' });
    const inRoom = await one(
      `SELECT u.id, u.name FROM voice_channel_members vm JOIN users u ON u.id = vm.user_id
        WHERE vm.channel_id = ? AND vm.user_id = ?`, [cid, targetId]);
    if (!inRoom) return res.status(404).json({ error: 'target_not_in_channel' });
    // Admins cannot be kicked by non-admins.
    const tm = await one('SELECT is_admin FROM server_members WHERE server_id = ? AND user_id = ?', [sid, targetId]);
    if (tm && tm.is_admin && !m.is_admin) return res.status(403).json({ error: 'cannot_kick_admin' });
    await q('DELETE FROM voice_channel_members WHERE channel_id = ? AND user_id = ?', [cid, targetId]);
    const mp = memberPayload(await voiceMembers(cid));
    res.json({ ok: true });
    emitVoiceKicked(targetId, sid, cid);
    emitVoiceLeave(sid, cid, inRoom.name, mp.names, { userId: targetId, memberDetails: mp.details });
  } catch (e) { next(e); }
});

// ---------------------------------------------------------------------------
// Text-channel messages
// ---------------------------------------------------------------------------

const textMessageSchema = z.object({
  text:    z.string().max(4000).optional(),
  payload: z.any().optional(),
  replyTo: z.union([z.string(), z.number()]).optional()
});

const toIso = d => ((d instanceof Date) ? d : new Date(d)).toISOString();

// GET returns the NEWEST page (default 200) in chronological order.
// Older pages: ?before=<message id>. `hasMore` tells the client whether
// there is anything older. (Previously this returned the OLDEST 200, so in
// busy channels new messages never showed after a reload.)
channelsRouter.get('/text/:sid/:cid/messages', async (req, res, next) => {
  try {
    const { sid, cid } = req.params;
    const m = await requireMember(req, res, sid); if (!m) return;
    const ch = await loadTextChannel(req, res, sid, cid, m); if (!ch) return;
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 200, 1), 200);
    const before = /^\d+$/.test(String(req.query.before || '')) ? String(req.query.before) : null;
    const rows = await q(
      `SELECT * FROM (
         SELECT m.*, u.name AS sender_name, u.id AS sender_uid FROM text_channel_messages m
           JOIN users u ON u.id = m.sender_id
          WHERE m.channel_id = ? ${before ? 'AND m.id < ?' : ''}
          ORDER BY m.id DESC
          LIMIT ${limit + 1}
       ) page ORDER BY page.id ASC`,
      before ? [cid, before] : [cid]);
    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(1) : rows;
    res.json({
      hasMore,
      messages: pageRows.map(r => ({
        id: r.id,
        user: r.sender_name,
        userId: String(r.sender_uid),
        text: r.body || '',
        time: toIso(r.created_at),
        replyTo: r.reply_to,
        edited: !!r.edited,
        deleted: !!r.deleted,
        payload: r.payload_json
      }))
    });
  } catch (e) { next(e); }
});

channelsRouter.post('/text/:sid/:cid/messages', async (req, res, next) => {
  try {
    const { sid, cid } = req.params;
    const m = await requireMember(req, res, sid); if (!m) return;
    const ch = await loadTextChannel(req, res, sid, cid, m); if (!ch) return;
    // sendMessages deny — allow beats deny on the same role.
    if (!m.is_admin) {
      const denyMap  = _parse(ch.permission_deny)  || {};
      const allowMap = _parse(ch.permission_allow) || {};
      for (const rid of (ch._roleIds || [])) {
        const denied  = Array.isArray(denyMap[rid])  && denyMap[rid].includes('sendMessages');
        const allowed = Array.isArray(allowMap[rid]) && allowMap[rid].includes('sendMessages');
        if (denied && !allowed) return res.status(403).json({ error: 'channel_send_denied' });
      }
    }
    const body = parseOr400(textMessageSchema, req.body, res); if (!body) return;
    const payload = body.payload ? sanitizePayload(body.payload) : null;
    let replyTo = null;
    if (body.replyTo != null && /^\d+$/.test(String(body.replyTo))) {
      const ref = await one('SELECT id FROM text_channel_messages WHERE id = ? AND channel_id = ?', [String(body.replyTo), cid]);
      replyTo = ref ? ref.id : null;
    }
    const result = await q(
      `INSERT INTO text_channel_messages (channel_id, sender_id, body, payload_json, reply_to)
       VALUES (?, ?, ?, ?, ?)`,
      [cid, req.user.id, body.text || '', payload ? JSON.stringify(payload) : null, replyTo]
    );
    const messagePayload = {
      id: result.insertId,
      user: req.user.name,
      userId: String(req.user.id),
      text: body.text || '',
      time: new Date().toISOString(),
      replyTo,
      payload
    };
    res.status(201).json({ message: messagePayload });
    emitChannelMessage(sid, cid, messagePayload);
  } catch (e) { next(e); }
});

channelsRouter.delete('/text/:sid/:cid/messages/:mid', async (req, res, next) => {
  try {
    const { sid, cid, mid } = req.params;
    const m = await requireMember(req, res, sid); if (!m) return;
    const ch = await loadTextChannel(req, res, sid, cid, m); if (!ch) return;
    const msg = await one('SELECT * FROM text_channel_messages WHERE id = ? AND channel_id = ?', [mid, cid]);
    if (!msg) return res.status(404).json({ error: 'not_found' });
    if (String(msg.sender_id) !== String(req.user.id) && !m.is_admin) {
      return res.status(403).json({ error: 'forbidden' });
    }
    await q('UPDATE text_channel_messages SET deleted = 1, body = NULL, payload_json = NULL WHERE id = ? AND channel_id = ?', [mid, cid]);
    res.json({ ok: true });
    emitChannelMessageDeleted(sid, cid, Number(mid));
  } catch (e) { next(e); }
});

// Mark every message in this text channel as read for the caller.
channelsRouter.post('/text/:sid/:cid/read', async (req, res, next) => {
  try {
    const { sid, cid } = req.params;
    const m = await requireMember(req, res, sid); if (!m) return;
    const ch = await loadTextChannel(req, res, sid, cid, m); if (!ch) return;
    const top = await one('SELECT MAX(id) AS m FROM text_channel_messages WHERE channel_id = ?', [cid]);
    const maxId = (top && top.m) ? Number(top.m) : 0;
    await q(
      `INSERT INTO text_channel_read_state (user_id, channel_id, last_read_id) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE last_read_id = GREATEST(last_read_id, VALUES(last_read_id)), updated_at = CURRENT_TIMESTAMP`,
      [req.user.id, cid, maxId]);
    res.json({ ok: true, lastReadId: maxId });
  } catch (e) { next(e); }
});

// ---------------------------------------------------------------------------
// Patch (rename / restyle / restrict) channels
// ---------------------------------------------------------------------------
// Per-role permission overrides:
//   permissionAllow / permissionDeny shape: { "<role-id>": ["sendMessages", ...] }
const overrideMapSchema = z.record(
  z.string().min(1).max(40),
  z.array(z.string().min(1).max(40)).max(40)
).nullable().optional();

const channelPatchSchema = z.object({
  name:            z.string().trim().min(1).max(80).optional(),
  style:           z.string().max(40).optional(),
  customStyle:     z.string().max(40).nullable().optional(),
  visibleRoleIds:  z.array(z.string().min(1).max(40)).max(50).nullable().optional(),
  permissionAllow: overrideMapSchema,
  permissionDeny:  overrideMapSchema,
  // Voice-channel-only. Opus bitrate in kbps.
  bitrate:         z.number().int().min(8).max(510).optional(),
});

function _buildChannelPatch(body) {
  const sets = [], args = [];
  if (body.name  !== undefined) { sets.push('name = ?');  args.push(body.name); }
  if (body.style !== undefined) { sets.push('style = ?'); args.push(body.style); }
  if (body.customStyle !== undefined) {
    sets.push('custom_style = ?');
    args.push(body.customStyle || null);
  }
  if (body.visibleRoleIds !== undefined) {
    sets.push('visible_role_ids = ?');
    args.push(body.visibleRoleIds === null ? null : JSON.stringify(body.visibleRoleIds));
  }
  if (body.permissionAllow !== undefined) {
    sets.push('permission_allow = ?');
    args.push(body.permissionAllow === null ? null : JSON.stringify(body.permissionAllow));
  }
  if (body.permissionDeny !== undefined) {
    sets.push('permission_deny = ?');
    args.push(body.permissionDeny === null ? null : JSON.stringify(body.permissionDeny));
  }
  if (body.bitrate !== undefined) {
    sets.push('bitrate = ?');
    args.push(Number(body.bitrate));
  }
  return { sets, args };
}

channelsRouter.patch('/text/:sid/:cid', async (req, res, next) => {
  try {
    const sid = req.params.sid;
    if (!await requirePermission(req, res, sid, "manageTextCh")) return;
    const body = parseOr400(channelPatchSchema, req.body, res); if (!body) return;
    const { sets, args } = _buildChannelPatch(body);
    if (sets.length) {
      args.push(req.params.cid, sid);
      await q('UPDATE text_channels SET ' + sets.join(', ') + ' WHERE id = ? AND server_id = ?', args);
    }
    res.json({ ok: true });
    emitServerUpdated(sid, await __buildServerPayload(sid));
  } catch (e) { next(e); }
});

channelsRouter.patch('/voice/:sid/:cid', async (req, res, next) => {
  try {
    const sid = req.params.sid;
    if (!await requirePermission(req, res, sid, "manageVoiceCh")) return;
    const body = parseOr400(channelPatchSchema, req.body, res); if (!body) return;
    const { sets, args } = _buildChannelPatch(body);
    if (sets.length) {
      args.push(req.params.cid, sid);
      await q('UPDATE voice_channels SET ' + sets.join(', ') + ' WHERE id = ? AND server_id = ?', args);
    }
    res.json({ ok: true });
    emitServerUpdated(sid, await __buildServerPayload(sid));
  } catch (e) { next(e); }
});

// --- Pin / unpin a message inside a text channel ---
const channelPinSchema = z.object({ messageId: z.union([z.number(), z.string()]).nullable().optional() });

channelsRouter.post('/text/:sid/:cid/pin', async (req, res, next) => {
  try {
    const sid = req.params.sid, cid = req.params.cid;
    const m = await requirePermission(req, res, sid, "managePins"); if (!m) return;
    const ch = await loadTextChannel(req, res, sid, cid, m); if (!ch) return;
    const body = parseOr400(channelPinSchema, req.body, res); if (!body) return;
    let pinnedMsg = null, pinnedBy = null, pinnedMsgId = null;
    if (body.messageId) {
      const row = await one('SELECT m.*, u.name AS sender_name FROM text_channel_messages m JOIN users u ON u.id = m.sender_id WHERE m.id = ? AND m.channel_id = ?', [Number(body.messageId), cid]);
      if (!row) return res.status(404).json({ error: 'message_not_found' });
      pinnedMsgId = row.id; pinnedMsg = row.body || ''; pinnedBy = row.sender_name;
      await q('UPDATE text_channels SET pinned_msg_id = ? WHERE id = ? AND server_id = ?', [row.id, cid, sid]);
    } else {
      await q('UPDATE text_channels SET pinned_msg_id = NULL WHERE id = ? AND server_id = ?', [cid, sid]);
    }
    res.json({ ok: true, pinnedMsgId, pinnedMsg, pinnedBy });
    emitChannelMessagePinned(sid, cid, pinnedMsgId, pinnedMsg, pinnedBy);
  } catch (e) { next(e); }
});

// Helper: rebuild the same payload servers.js exports. Inline to avoid a
// circular import; keeps emitServerUpdated honest after channel mutations.
async function __buildServerPayload(sid) {
  const s = await one('SELECT * FROM servers WHERE id = ?', [sid]);
  if (!s) return null;
  const members = await q(`SELECT sm.user_id, sm.is_admin, u.name, u.av_image, u.base_color FROM server_members sm JOIN users u ON u.id = sm.user_id WHERE sm.server_id = ?`, [sid]);
  const cats = await q('SELECT * FROM server_categories WHERE server_id = ? ORDER BY position', [sid]);
  const tcs  = await q('SELECT * FROM text_channels    WHERE server_id = ? ORDER BY position', [sid]);
  const vcs  = await q('SELECT * FROM voice_channels   WHERE server_id = ? ORDER BY position', [sid]);
  return {
    id: s.id, name: s.name, initial: s.initial || (s.name||'?').charAt(0).toUpperCase(),
    desc: s.description || '', baseColor: s.base_color || null,
    grad: s.grad || null, glow: s.glow || null, cover: s.cover || null,
    emblemImage: s.emblem_image || null, inviteKey: s.invite_key || null,
    isPrivate: !!s.is_private,
    styleName: s.style_name || null,
    stylePin:  s.style_pin  || null, styleCover: s.style_cover || null, styleEmblem: s.style_emblem || null,
    members: members.map(x => x.name),
    memberDetails: members.map(x => ({ id: String(x.user_id), name: x.name, isAdmin: !!x.is_admin, avImage: x.av_image || null, baseColor: x.base_color || null })),
    admins:  members.filter(x => x.is_admin).map(x => x.name),
    pinned: s.pinned_text ? { text: s.pinned_text, by: null, time: null } : null,
    categories: cats.map(c => ({
      id: c.id, name: c.name,
      pinned: c.pinned_text ? { text: c.pinned_text, by: null, time: null } : null,
      visibleRoleIds: __parseRoleIds(c.visible_role_ids),
      customStyle: c.custom_style || null,
      textChannels:  tcs.filter(t => t.category_id === c.id).map(t => t.id),
      voiceChannels: vcs.filter(v => v.category_id === c.id).map(v => v.id)
    })),
    textChannels: tcs.map(t => ({
      id: t.id, name: t.name, style: t.style || 'glow', unread: 0,
      customStyle: t.custom_style || null,
      pinnedMsgId: t.pinned_msg_id || null,
      visibleRoleIds:  __parseRoleIds(t.visible_role_ids),
      permissionAllow: __parseRoleIds(t.permission_allow),
      permissionDeny:  __parseRoleIds(t.permission_deny)
    })),
    voiceChannels: vcs.map(v => ({
      id: v.id, name: v.name, style: v.style || 'indigo',
      customStyle: v.custom_style || null,
      visibleRoleIds:  __parseRoleIds(v.visible_role_ids),
      permissionAllow: __parseRoleIds(v.permission_allow),
      permissionDeny:  __parseRoleIds(v.permission_deny),
      bitrate: v.bitrate == null ? 64 : Number(v.bitrate)
    }))
  };
}

function __parseRoleIds(raw) {
  if (raw == null) return null;
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') { try { return JSON.parse(raw); } catch { return null; } }
  return null;
}
