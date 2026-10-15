// Thin wrappers around sendToUser / sendToServer so each route file doesn't
// need to import the ws module directly.
//
// Routes call these fire-and-forget AFTER responding. Every async emitter is
// wrapped so a DB hiccup here is logged instead of becoming an unhandled
// rejection that could take the process down.

import { sendToUser, sendToServer } from './ws.js';
import { q } from '../db.js';

const guard = (name, fn) => (...args) =>
  Promise.resolve()
    .then(() => fn(...args))
    .catch(e => { console.warn(`[events] ${name} failed:`, e && e.message); });

// --- DM events ---

export function emitNewDm(senderUid, peerUid, message) {
  sendToUser(peerUid, { type: 'dm:new', from: String(senderUid), message });
}

// --- Friend events ---

export function emitFriendRequest(toUid, request) {
  sendToUser(toUid, { type: 'friend:request', request });
}

export function emitFriendAccepted(toUid, peer) {
  sendToUser(toUid, { type: 'friend:accepted', peer });
}

// --- Server events ---

// Helper: get all user ids who are members of a server.
async function serverMemberUids(serverId) {
  const rows = await q('SELECT user_id FROM server_members WHERE server_id = ?', [serverId]);
  return rows.map(r => String(r.user_id));
}

export const emitServerMemberJoined = guard('emitServerMemberJoined', async (serverId, userName) => {
  const uids = await serverMemberUids(serverId);
  sendToServer(uids, { type: 'server:member-joined', serverId, name: userName });
});

export const emitServerMemberLeft = guard('emitServerMemberLeft', async (serverId, userName) => {
  const uids = await serverMemberUids(serverId);
  sendToServer(uids, { type: 'server:member-left', serverId, name: userName });
});

export const emitChannelMessage = guard('emitChannelMessage', async (serverId, channelId, message) => {
  const uids = await serverMemberUids(serverId);
  sendToServer(uids, { type: 'channel:message', serverId, channelId, message });
});

// `members` stays a list of display names for older clients; `extra` can
// carry { userId, memberDetails:[{id,name}] } so newer clients key peers by
// stable user id.
export const emitVoiceJoin = guard('emitVoiceJoin', async (serverId, channelId, userName, members, extra) => {
  const uids = await serverMemberUids(serverId);
  sendToServer(uids, { type: 'voice:join', serverId, channelId, userName, members, ...(extra || {}) });
});

export const emitVoiceLeave = guard('emitVoiceLeave', async (serverId, channelId, userName, members, extra) => {
  const uids = await serverMemberUids(serverId);
  sendToServer(uids, { type: 'voice:leave', serverId, channelId, userName, members, ...(extra || {}) });
});

export const emitChannelMessageDeleted = guard('emitChannelMessageDeleted', async (serverId, channelId, messageId) => {
  const uids = await serverMemberUids(serverId);
  sendToServer(uids, { type: 'channel:message:deleted', serverId, channelId, messageId });
});

export const emitServerPinChanged = guard('emitServerPinChanged', async (serverId, pinnedText) => {
  const uids = await serverMemberUids(serverId);
  sendToServer(uids, { type: 'server:pin', serverId, pinned: pinnedText ? { text: pinnedText, by: null, time: null } : null });
});

export const emitServerCategoryAdded = guard('emitServerCategoryAdded', async (serverId, category) => {
  const uids = await serverMemberUids(serverId);
  sendToServer(uids, { type: 'server:category-added', serverId, category });
});

export const emitServerCategoryDeleted = guard('emitServerCategoryDeleted', async (serverId, categoryId) => {
  const uids = await serverMemberUids(serverId);
  sendToServer(uids, { type: 'server:category-deleted', serverId, categoryId });
});

export const emitServerChannelAdded = guard('emitServerChannelAdded', async (serverId, channelKind, channel, categoryId) => {
  const uids = await serverMemberUids(serverId);
  sendToServer(uids, { type: 'server:channel-added', serverId, channelKind, channel, categoryId });
});

export const emitServerChannelDeleted = guard('emitServerChannelDeleted', async (serverId, channelKind, channelId) => {
  const uids = await serverMemberUids(serverId);
  sendToServer(uids, { type: 'server:channel-deleted', serverId, channelKind, channelId });
});

// Generic "the server just changed" — used when many fields change at once.
export const emitServerUpdated = guard('emitServerUpdated', async (serverId, serverPayload) => {
  const uids = await serverMemberUids(serverId);
  sendToServer(uids, { type: 'server:updated', serverId, server: serverPayload });
});

// "The server is gone" — emitted to the member uid list captured BEFORE the
// DELETE statement runs (server_members rows cascade away).
export function emitServerDeleted(memberUids, serverId) {
  sendToServer(memberUids.map(String), { type: 'server:deleted', serverId });
}

export const emitChannelMessagePinned = guard('emitChannelMessagePinned', async (serverId, channelId, pinnedMsgId, pinnedText, pinnedBy) => {
  const uids = await serverMemberUids(serverId);
  sendToServer(uids, { type: 'channel:pin', serverId, channelId, pinnedMsgId, pinnedText, pinnedBy });
});

// Notify a single user that they were kicked / banned / promoted, etc.
export function emitToUser(uid, payload) {
  sendToUser(uid, payload);
}

// "the sender deleted one of their messages".
export function emitDmDeleted(senderUid, peerUid, messageId) {
  sendToUser(peerUid, { type: 'dm:deleted', from: String(senderUid), messageId });
}

// "I just read your messages up to maxId".
export function emitDmRead(readerUid, peerUid, maxId) {
  sendToUser(peerUid, { type: 'dm:read', from: String(readerUid), upToId: Number(maxId) });
}

// "the user emptied this conversation".
export function emitDmCleared(senderUid, peerUid) {
  sendToUser(peerUid, { type: 'dm:cleared', from: String(senderUid) });
}

// "the other person unfriended you".
export function emitFriendRemoved(toUid, peerUid, peerHandle) {
  sendToUser(toUid, { type: 'friend:removed', peerId: String(peerUid), peerHandle: peerHandle || null });
}

// "you were kicked from this voice channel".
export function emitVoiceKicked(toUid, serverId, channelId) {
  sendToUser(toUid, { type: 'voice:kicked', serverId, channelId });
}

// "this user just blocked / unblocked you".
export function emitBlockedByPeer(toUid, byUid, byHandle, on) {
  sendToUser(toUid, { type: 'block:status', from: String(byUid), handle: byHandle || null, on: !!on });
}

// "this user updated their public profile fields" — friends + server peers.
export const emitProfileUpdated = guard('emitProfileUpdated', async (uid, payload) => {
  const friendRows = await q(
    `SELECT f.friend_id AS id FROM friendships f WHERE f.user_id = ?`, [uid]);
  const serverRows = await q(
    `SELECT DISTINCT sm2.user_id AS id
       FROM server_members sm
       JOIN server_members sm2 ON sm2.server_id = sm.server_id
      WHERE sm.user_id = ? AND sm2.user_id != ?`, [uid, uid]);
  const ids = new Set();
  friendRows.forEach(r => ids.add(String(r.id)));
  serverRows.forEach(r => ids.add(String(r.id)));
  const data = { type: 'profile:updated', uid: String(uid), ...payload };
  ids.forEach(rid => sendToUser(rid, data));
});
