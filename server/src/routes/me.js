import { Router } from 'express';
import { q, one } from '../db.js';
import { requireAuth } from '../auth/middleware.js';
import { hashPassword, verifyPassword } from '../auth/hash.js';
import { signToken } from '../auth/jwt.js';
import { parseOr400, profilePatchSchema } from '../validators.js';
import { publicUser } from '../lib/userShape.js';
import { emitProfileUpdated } from '../realtime/events.js';
import { getOnlineUids } from '../realtime/ws.js';

// Normalise visible_role_ids to "array or null". MySQL JSON column can come
// back as either a parsed value or a string depending on driver version.
function parseRoleIds(raw) {
  if (raw == null) return null;
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') { try { return JSON.parse(raw); } catch { return null; } }
  return null;
}

const inList = arr => arr.map(() => '?').join(',');

export const meRouter = Router();

meRouter.use(requireAuth);

// Fresh copy of the local user.
meRouter.get('/', async (req, res, next) => {
  try {
    const u = await one('SELECT * FROM users WHERE id = ?', [req.user.id]);
    if (!u) return res.status(404).json({ error: 'not_found' });
    res.json({ user: publicUser(u) });
  } catch (e) { next(e); }
});

// Update profile fields. Password change rehashes; handle/email uniqueness
// are checked here to give a clean error message.
meRouter.patch('/', async (req, res, next) => {
  try {
    const patch = parseOr400(profilePatchSchema, req.body, res); if (!patch) return;
    // If the client sends the current password (newer UI), verify it before
    // any credential change. Older UI does not send it yet.
    if ((patch.password || patch.email) && patch.currentPassword !== undefined) {
      const row = await one('SELECT password_hash FROM users WHERE id = ?', [req.user.id]);
      const ok = row && await verifyPassword(patch.currentPassword, row.password_hash).catch(() => false);
      if (!ok) return res.status(403).json({ error: 'wrong_current_password' });
    }
    if (patch.handle) {
      const taken = await one('SELECT id FROM users WHERE handle = ? AND id != ? LIMIT 1', [patch.handle, req.user.id]);
      if (taken) return res.status(409).json({ error: 'handle_taken' });
    }
    if (patch.email) {
      const taken = await one('SELECT id FROM users WHERE email = ? AND id != ? LIMIT 1', [patch.email, req.user.id]);
      if (taken) return res.status(409).json({ error: 'email_taken' });
    }
    const sets = [];
    const args = [];
    const map = {
      name: 'name', handle: 'handle', email: 'email', phone: 'phone',
      bio: 'bio', baseColor: 'base_color', rank: 'rank_label',
      avImage: 'av_image', bannerImage: 'banner_image',
      friendsOnly: 'friends_only'
    };
    for (const [k, col] of Object.entries(map)) {
      if (patch[k] !== undefined) {
        sets.push('`' + col + '` = ?');
        args.push(k === 'friendsOnly' ? (patch[k] ? 1 : 0) : patch[k]);
      }
    }
    if (patch.password) {
      sets.push('password_hash = ?');
      args.push(await hashPassword(patch.password));
      // New password = every older session token stops working (a thief
      // holding a stolen token is kicked out too).
      sets.push('token_version = token_version + 1');
    }
    if (sets.length) {
      args.push(req.user.id);
      try {
        await q('UPDATE users SET ' + sets.join(', ') + ' WHERE id = ?', args);
      } catch (e) {
        if (e && e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'email_or_handle_taken' });
        throw e;
      }
    }
    const fresh = await one('SELECT * FROM users WHERE id = ?', [req.user.id]);
    const out = { user: publicUser(fresh) };
    // Hand back a fresh token so a client that knows about it stays logged in.
    if (patch.password) out.token = signToken({ uid: fresh.id, tv: Number(fresh.token_version || 0) });
    res.json(out);
    if (Object.keys(patch).some(k => ['name','handle','bio','baseColor','rank','avImage','bannerImage'].includes(k))){
      emitProfileUpdated(req.user.id, {
        name:        fresh.name,
        handle:      fresh.handle ? '@' + fresh.handle : null,
        bio:         fresh.bio || '',
        baseColor:   fresh.base_color || null,
        rank:        fresh.rank_label || 'EXPLORER',
        avImage:     fresh.av_image || null,
        bannerImage: fresh.banner_image || null
      });
    }
  } catch (e) { next(e); }
});

// Heaviest endpoint: returns everything the frontend needs to hydrate state.
meRouter.get('/snapshot', async (req, res, next) => {
  try {
    const me = await one('SELECT * FROM users WHERE id = ?', [req.user.id]);
    if (!me) return res.status(404).json({ error: 'not_found' });

    // Friends + blocks + requests
    const friendRows = await q(
      `SELECT u.* FROM friendships f
         JOIN users u ON u.id = f.friend_id
        WHERE f.user_id = ?
        ORDER BY u.name`, [me.id]);
    const blockedRows = await q(
      `SELECT u.* FROM blocked_users b
         JOIN users u ON u.id = b.blocked_id
        WHERE b.user_id = ?`, [me.id]);
    const blockedByRows = await q(
      `SELECT u.handle FROM blocked_users b
         JOIN users u ON u.id = b.user_id
        WHERE b.blocked_id = ?`, [me.id]);
    const incoming = await q(
      `SELECT fr.id, fr.created_at, u.id AS uid, u.name, u.handle, u.av_image, u.base_color
         FROM friend_requests fr
         JOIN users u ON u.id = fr.from_id
        WHERE fr.to_id = ? AND fr.status = 'pending'`, [me.id]);
    const outgoing = await q(
      `SELECT fr.id, fr.created_at, u.id AS uid, u.name, u.handle, u.av_image, u.base_color
         FROM friend_requests fr
         JOIN users u ON u.id = fr.to_id
        WHERE fr.from_id = ? AND fr.status = 'pending'`, [me.id]);

    // Conversations keyed by friend handle. Saved Messages = "saved".
    const conversations = {
      saved: {
        name: 'Saved Messages', online: true, unread: 0,
        avColor: 'linear-gradient(135deg,#b91c4a,#7f1d1d)',
        initial: '★', handle: '@saved',
        bio: 'Personal notes, bookmarks and forwarded messages — only you can see this.',
        rank: 'NOTES', isSaved: true
      }
    };
    const onlineUids = new Set(getOnlineUids());
    const convShape = (row, extra) => ({
      uid: String(row.id),
      peerId: String(row.id),
      name: row.name,
      online: onlineUids.has(String(row.id)),
      unread: 0,
      avColor: row.base_color
        ? `linear-gradient(135deg,${row.base_color},#1e1b4b)`
        : 'linear-gradient(135deg,#a78bfa,#1e1b4b)',
      avImage: row.av_image || null,
      bannerImage: row.banner_image || null,
      initial: (row.name || '?').charAt(0).toUpperCase(),
      handle: '@' + row.handle.replace(/^@/, ''),
      bio: row.bio || '',
      rank: row.rank_label || 'EXPLORER',
      baseColor: row.base_color || null,
      friendsOnly: !!row.friends_only,
      ...(extra || {})
    });
    friendRows.forEach(row => { conversations[row.handle.toLowerCase()] = convShape(row); });

    // Servers I'm a member of, plus everything they contain.
    const memberRows = await q(
      `SELECT s.* FROM server_members sm
         JOIN servers s ON s.id = sm.server_id
        WHERE sm.user_id = ?`, [me.id]);
    // The home rail only shows servers the user explicitly pinned.
    const pinnedOrderRows = await q(
      `SELECT server_id FROM user_pinned_servers WHERE user_id = ? ORDER BY position`, [me.id]);
    const pinnedOrder = pinnedOrderRows.map(r => r.server_id);
    const memberSet = new Set(memberRows.map(s => s.id));
    const myServers = pinnedOrder.filter(id => memberSet.has(id));
    const servers = {};
    if (memberRows.length) {
      const sids = memberRows.map(s => s.id);
      const placeholders = inList(sids);
      const allMembers   = await q(`SELECT sm.server_id, sm.user_id, sm.is_admin, u.name, u.av_image, u.base_color FROM server_members sm JOIN users u ON u.id = sm.user_id WHERE sm.server_id IN (${placeholders})`, sids);
      const cats         = await q(`SELECT * FROM server_categories WHERE server_id IN (${placeholders}) ORDER BY position`, sids);
      const tcs          = await q(`SELECT * FROM text_channels    WHERE server_id IN (${placeholders}) ORDER BY position`, sids);
      const vcs          = await q(`SELECT * FROM voice_channels   WHERE server_id IN (${placeholders}) ORDER BY position`, sids);
      const roleRows     = await q(`SELECT * FROM server_roles WHERE server_id IN (${placeholders}) ORDER BY position, id`, sids);
      const roleMembers  = roleRows.length
        ? await q(
            `SELECT rm.server_id, rm.role_id, u.name FROM server_role_members rm
               JOIN users u ON u.id = rm.user_id
              WHERE rm.server_id IN (${placeholders})`,
            sids)
        : [];
      memberRows.forEach(row => {
        const sid = row.id;
        const sm  = allMembers.filter(x => x.server_id === sid);
        servers[sid] = {
          id: sid,
          name: row.name,
          initial: row.initial || (row.name||'?').charAt(0).toUpperCase(),
          desc: row.description || '',
          baseColor: row.base_color || null,
          grad: row.grad || null,
          glow: row.glow || null,
          cover: row.cover || null,
          emblemImage: row.emblem_image || null,
          inviteKey: row.invite_key || null,
          isPrivate: !!row.is_private,
          styleName: row.style_name || null,
          stylePin:  row.style_pin  || null, styleCover: row.style_cover || null, styleEmblem: row.style_emblem || null,
          members: sm.map(x => x.name),
          memberDetails: sm.map(x => ({ id: String(x.user_id), name: x.name, isAdmin: !!x.is_admin, avImage: x.av_image || null, baseColor: x.base_color || null })),
          admins: sm.filter(x => x.is_admin).map(x => x.name),
          pinned: row.pinned_text ? { text: row.pinned_text, by: null, time: null } : null,
          categories: cats.filter(c => c.server_id === sid).map(c => ({
            id: c.id, name: c.name,
            pinned: c.pinned_text ? { text: c.pinned_text, by: null, time: null } : null,
            visibleRoleIds: parseRoleIds(c.visible_role_ids),
            customStyle: c.custom_style || null,
            textChannels:  tcs.filter(t => t.server_id === sid && t.category_id === c.id).map(t => t.id),
            voiceChannels: vcs.filter(v => v.server_id === sid && v.category_id === c.id).map(v => v.id)
          })),
          textChannels: tcs.filter(t => t.server_id === sid).map(t => ({
            id: t.id, name: t.name, style: t.style || 'glow', unread: 0,
            customStyle: t.custom_style || null,
            pinnedMsgId: t.pinned_msg_id || null,
            visibleRoleIds:  parseRoleIds(t.visible_role_ids),
            permissionAllow: parseRoleIds(t.permission_allow),
            permissionDeny:  parseRoleIds(t.permission_deny)
          })),
          voiceChannels: vcs.filter(v => v.server_id === sid).map(v => ({
            id: v.id, name: v.name, style: v.style || 'indigo',
            customStyle: v.custom_style || null,
            visibleRoleIds:  parseRoleIds(v.visible_role_ids),
            permissionAllow: parseRoleIds(v.permission_allow),
            permissionDeny:  parseRoleIds(v.permission_deny),
            bitrate: v.bitrate == null ? 64 : Number(v.bitrate)
          })),
          roles: (function(){
            const here = roleRows.filter(r => r.server_id === sid);
            if (!here.length) return null;
            return here.map(r => ({
              id: r.id,
              name: r.name,
              color: r.color || null,
              system: !!r.is_system,
              position: r.position || 0,
              perms: typeof r.permissions === 'string' ? JSON.parse(r.permissions) : (r.permissions || {}),
              members: roleMembers.filter(m => m.server_id === sid && m.role_id === r.id).map(m => m.name)
            }));
          })()
        };
      });
    }

    // Last message preview for every DM thread the user is part of.
    const previewRows = await q(
      `SELECT t.id AS tid, t.user_a, t.user_b, t.is_saved,
              m.id AS mid, m.body, m.deleted, m.payload_json, m.created_at, m.sender_id,
              COALESCE(h.last_hidden_id, 0) AS hidden_cutoff
         FROM dm_threads t
         LEFT JOIN dm_thread_hidden h ON h.thread_id = t.id AND h.user_id = ?
         LEFT JOIN dm_messages m ON m.id = (
           SELECT id FROM dm_messages
            WHERE thread_id = t.id AND id > COALESCE(h.last_hidden_id, 0)
            ORDER BY id DESC LIMIT 1
         )
        WHERE t.user_a = ? OR t.user_b = ?`, [me.id, me.id, me.id]);
    const peerOf = r => (String(r.user_a) === String(me.id) ? r.user_b : r.user_a);
    const peerIds = new Set();
    previewRows.forEach(r => { if (!r.is_saved) peerIds.add(peerOf(r)); });
    const dmPinRows = await q(
      `SELECT dp.thread_id, dp.message_id
         FROM dm_pinned dp
         JOIN dm_threads t ON t.id = dp.thread_id
        WHERE t.user_a = ? OR t.user_b = ?`, [me.id, me.id]);
    const pinByThread = new Map(dmPinRows.map(r => [r.thread_id, Number(r.message_id)]));
    const peerHandleByUid = new Map();
    const peerUserRows = peerIds.size
      ? await q(`SELECT * FROM users WHERE id IN (${inList([...peerIds])})`, [...peerIds])
      : [];
    peerUserRows.forEach(r => peerHandleByUid.set(String(r.id), r.handle.toLowerCase()));
    const keyOf = r => r.is_saved ? 'saved' : peerHandleByUid.get(String(peerOf(r)));
    const messagePreviews = {};
    const dmPinned = {};
    previewRows.forEach(r => {
      const pid = pinByThread.get(r.tid);
      if (!pid) return;
      const k = keyOf(r);
      if (k) dmPinned[k] = pid;
    });
    previewRows.forEach(r => {
      if (!r.mid) return;
      const k = keyOf(r);
      if (!k) return;
      const sender = String(r.sender_id) === String(me.id) ? 'me' : 'them';
      let payload = r.payload_json;
      if (typeof payload === 'string'){ try { payload = JSON.parse(payload); } catch { payload = null; } }
      messagePreviews[k] = {
        id: r.mid,
        sender,
        text: r.body || '',
        createdAt: new Date(r.created_at).toISOString(),
        time: new Date(r.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        day:  new Date(r.created_at).toLocaleDateString().toUpperCase(),
        deleted: !!r.deleted,
        payload,
        type: payload && payload.type ? payload.type : undefined
      };
    });

    // Non-friend DM peers also become conversations, so a chat doesn't
    // vanish after a refresh just because they aren't friends yet.
    if (peerUserRows.length){
      const knownKeys = new Set(Object.keys(conversations));
      peerUserRows.forEach(row => {
        const k = row.handle.toLowerCase();
        if (knownKeys.has(k)) return;
        conversations[k] = convShape(row, { isFriend: false });
      });
    }

    // Persistent unread counts: ONE grouped query per kind (it used to be
    // one COUNT query per thread / per channel, which made the snapshot
    // slow for active users).
    const unreadDm = {};
    if (previewRows.length){
      const tids = previewRows.map(r => r.tid);
      const rows = await q(
        `SELECT m.thread_id, COUNT(*) AS n
           FROM dm_messages m
           LEFT JOIN dm_read_state rs ON rs.thread_id = m.thread_id AND rs.user_id = ?
           LEFT JOIN dm_thread_hidden h ON h.thread_id = m.thread_id AND h.user_id = ?
          WHERE m.thread_id IN (${inList(tids)})
            AND m.sender_id != ?
            AND m.id > GREATEST(COALESCE(rs.last_read_id, 0), COALESCE(h.last_hidden_id, 0))
          GROUP BY m.thread_id`,
        [me.id, me.id, ...tids, me.id]);
      const byTid = new Map(previewRows.map(r => [String(r.tid), r]));
      rows.forEach(row => {
        const t = byTid.get(String(row.thread_id));
        if (!t || t.is_saved) return;
        const k = keyOf(t);
        if (k && Number(row.n) > 0) unreadDm[k] = Number(row.n);
      });
    }
    const unreadChannels = {};
    if (memberRows.length){
      const sids = memberRows.map(r => r.id);
      const rows = await q(
        `SELECT t.server_id, m.channel_id, COUNT(*) AS n
           FROM text_channel_messages m
           JOIN text_channels t ON t.id = m.channel_id
           LEFT JOIN text_channel_read_state rs ON rs.channel_id = m.channel_id AND rs.user_id = ?
          WHERE t.server_id IN (${inList(sids)})
            AND m.sender_id != ?
            AND m.id > COALESCE(rs.last_read_id, 0)
          GROUP BY t.server_id, m.channel_id`,
        [me.id, ...sids, me.id]);
      rows.forEach(row => {
        if (Number(row.n) > 0) unreadChannels[row.server_id + '__' + row.channel_id] = Number(row.n);
      });
    }

    // Marks
    const markedOrbs = await q(
      `SELECT channel_id FROM user_marked_orbits WHERE user_id = ? ORDER BY position`, [me.id]);
    const markedTcs  = await q(
      `SELECT mt.channel_id, t.server_id FROM user_marked_text_channels mt
         JOIN text_channels t ON t.id = mt.channel_id
        WHERE mt.user_id = ? ORDER BY mt.position`, [me.id]);
    const markedFr   = await q(
      `SELECT u.handle FROM user_marked_friends mf
         JOIN users u ON u.id = mf.friend_id
        WHERE mf.user_id = ? ORDER BY mf.position`, [me.id]);

    // Live voice channel members per channel id.
    const allVoiceIds = [];
    Object.values(servers).forEach(srv => (srv.voiceChannels||[]).forEach(v => allVoiceIds.push(v.id)));
    const voiceMembersByChannel = {};
    if (allVoiceIds.length) {
      const rows = await q(
        `SELECT vm.channel_id, u.id, u.name FROM voice_channel_members vm
           JOIN users u ON u.id = vm.user_id
          WHERE vm.channel_id IN (${inList(allVoiceIds)})
          ORDER BY vm.joined_at, u.id`,
        allVoiceIds);
      rows.forEach(r => {
        const e = voiceMembersByChannel[r.channel_id] || (voiceMembersByChannel[r.channel_id] = { users: [], userDetails: [] });
        e.users.push(r.name);
        e.userDetails.push({ id: String(r.id), name: r.name });
      });
    }

    // Notifications
    const notifs = await q(
      `SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 50`,
      [me.id]);

    // DM list ordering, newest first.
    const dmListOrder = [];
    const previewsSorted = previewRows
      .filter(r => r.mid && r.created_at)
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    const seenOrder = new Set();
    previewsSorted.forEach(r => {
      const k = keyOf(r);
      if (k && !seenOrder.has(k)){ dmListOrder.push(k); seenOrder.add(k); }
    });

    res.json({
      user: publicUser(me),
      servers,
      myServers,
      channelData: voiceMembersByChannel,
      conversations,
      messages: { saved: [] }, // DM threads loaded lazily per-thread
      messagePreviews,
      dmListOrder,
      dmPinned,
      unreadDm,
      unreadChannels,
      friendsList: friendRows.map(u => u.handle.toLowerCase()),
      markedFriends: markedFr.map(r => r.handle.toLowerCase()),
      markedTextChannels: markedTcs.map(r => r.server_id + '__' + r.channel_id),
      marked: markedOrbs.map(r => r.channel_id),
      blockedUsers: blockedRows.map(u => u.handle.toLowerCase()),
      blockedBy: blockedByRows.map(u => u.handle.toLowerCase()),
      notifications: notifs.map(n => ({
        id: n.id, type: n.kind, title: n.title, desc: n.description,
        time: new Date(n.created_at).toISOString(), unread: !n.read_at
      })),
      friendRequests: {
        incoming: incoming.map(r => ({
          id: r.id, name: r.name,
          handle: r.handle ? '@' + r.handle : '',
          initial: (r.name||'?').charAt(0).toUpperCase(),
          avColor: r.base_color ? `linear-gradient(135deg,${r.base_color},#1e1b4b)` : 'linear-gradient(135deg,#818cf8,#1e1b4b)',
          meta: 'received'
        })),
        outgoing: outgoing.map(r => ({
          id: r.id, name: r.name,
          handle: r.handle ? '@' + r.handle : '',
          initial: (r.name||'?').charAt(0).toUpperCase(),
          avColor: r.base_color ? `linear-gradient(135deg,${r.base_color},#1e1b4b)` : 'linear-gradient(135deg,#818cf8,#1e1b4b)',
          meta: 'sent'
        }))
      }
    });
  } catch (e) { next(e); }
});

// --- Persistence for user-specific layout state -----------------------------
// Each endpoint replaces the whole list for the caller. Lists are capped and
// validated in one query instead of one query per item.

const MAX_MARKS = 200;

// Marked voice channels (orbits) — only channels of servers I'm in.
meRouter.put('/marks/orbits', async (req, res, next) => {
  try {
    const ids = (Array.isArray(req.body && req.body.ids) ? req.body.ids : [])
      .filter(c => typeof c === 'string' && c).slice(0, MAX_MARKS);
    const valid = ids.length ? new Set((await q(
      `SELECT vc.id FROM voice_channels vc
         JOIN server_members sm ON sm.server_id = vc.server_id AND sm.user_id = ?
        WHERE vc.id IN (${inList(ids)})`, [req.user.id, ...ids])).map(r => r.id)) : new Set();
    await q('DELETE FROM user_marked_orbits WHERE user_id = ?', [req.user.id]);
    let i = 0;
    for (const cid of ids) {
      if (!valid.has(cid)) continue;
      await q('INSERT IGNORE INTO user_marked_orbits (user_id, channel_id, position) VALUES (?, ?, ?)',
        [req.user.id, cid, ++i]);
    }
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// Marked text channels. Client sends "<serverId>__<channelId>" composite keys.
meRouter.put('/marks/text-channels', async (req, res, next) => {
  try {
    const raw = (req.body && (req.body.keys || req.body.ids)) || [];
    const ids = (Array.isArray(raw) ? raw : [])
      .filter(k => typeof k === 'string' && k.includes('__'))
      .map(k => k.slice(k.indexOf('__') + 2))
      .slice(0, MAX_MARKS);
    const valid = ids.length ? new Set((await q(
      `SELECT t.id FROM text_channels t
         JOIN server_members sm ON sm.server_id = t.server_id AND sm.user_id = ?
        WHERE t.id IN (${inList(ids)})`, [req.user.id, ...ids])).map(r => r.id)) : new Set();
    await q('DELETE FROM user_marked_text_channels WHERE user_id = ?', [req.user.id]);
    let i = 0;
    for (const tcId of ids) {
      if (!valid.has(tcId)) continue;
      await q('INSERT IGNORE INTO user_marked_text_channels (user_id, channel_id, position) VALUES (?, ?, ?)',
        [req.user.id, tcId, ++i]);
    }
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// Marked friends. Client sends an array of @handles (case-insensitive).
meRouter.put('/marks/friends', async (req, res, next) => {
  try {
    const handles = (Array.isArray(req.body && req.body.handles) ? req.body.handles : [])
      .filter(h => typeof h === 'string' && h)
      .map(h => h.replace(/^@/, '').toLowerCase())
      .slice(0, MAX_MARKS);
    const rows = handles.length
      ? await q(`SELECT id, handle FROM users WHERE handle IN (${inList(handles)})`, handles)
      : [];
    const idByHandle = new Map(rows.map(r => [r.handle.toLowerCase(), r.id]));
    await q('DELETE FROM user_marked_friends WHERE user_id = ?', [req.user.id]);
    let i = 0;
    for (const h of handles) {
      const id = idByHandle.get(h);
      if (!id) continue;
      await q('INSERT IGNORE INTO user_marked_friends (user_id, friend_id, position) VALUES (?, ?, ?)',
        [req.user.id, id, ++i]);
    }
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// Pinned servers (display order on the rail).
meRouter.put('/marks/pinned-servers', async (req, res, next) => {
  try {
    const ids = (Array.isArray(req.body && req.body.ids) ? req.body.ids : [])
      .filter(s => typeof s === 'string' && s).slice(0, MAX_MARKS);
    const valid = ids.length ? new Set((await q(
      `SELECT server_id FROM server_members WHERE user_id = ? AND server_id IN (${inList(ids)})`,
      [req.user.id, ...ids])).map(r => r.server_id)) : new Set();
    await q('DELETE FROM user_pinned_servers WHERE user_id = ?', [req.user.id]);
    let i = 0;
    for (const sid of ids) {
      if (!valid.has(sid)) continue;
      await q('INSERT IGNORE INTO user_pinned_servers (user_id, server_id, position) VALUES (?, ?, ?)',
        [req.user.id, sid, ++i]);
    }
    res.json({ ok: true });
  } catch (e) { next(e); }
});
