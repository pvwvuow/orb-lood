import { verifyToken, tokenDigest } from './jwt.js';
import { one } from '../db.js';

let legacyWarned = false;
const USER_COLS = 'u.id, u.email, u.name, u.handle, u.av_image, u.banner_image, u.base_color, u.bio, u.rank_label, u.friends_only, u.token_version';

// Shared by REST and WebSocket auth. Returns the user row, or null when the
// token is invalid, expired, revoked (logout) or older than the user's
// token_version (password change).
export async function userFromToken(tokenStr) {
  if (!tokenStr) return null;
  const claims = verifyToken(tokenStr);
  if (!claims || !claims.uid) return null;
  let user;
  try {
    user = await one(
      `SELECT ${USER_COLS},
              (SELECT 1 FROM auth_tokens t WHERE t.token = ? LIMIT 1) AS revoked
         FROM users u WHERE u.id = ?`,
      [tokenDigest(tokenStr), claims.uid]
    );
  } catch (e) {
    // Migrations not applied yet (no token_version column): degrade to the
    // old behaviour instead of failing every request.
    if (!e || (e.code !== 'ER_BAD_FIELD_ERROR' && e.code !== 'ER_NO_SUCH_TABLE')) throw e;
    if (!legacyWarned) { legacyWarned = true; console.warn('[auth] run `npm run init-db`: token revocation disabled until then'); }
    user = await one(`SELECT ${USER_COLS.replace(', u.token_version', '')} FROM users u WHERE u.id = ?`, [claims.uid]);
  }
  if (!user || user.revoked) return null;
  if (Number(claims.tv || 0) !== Number(user.token_version || 0)) return null;
  delete user.revoked;
  return user;
}

// navigator.sendBeacon cannot set headers, so the voice-leave call made on
// page unload passes ?token=. Only that endpoint accepts it; everywhere else
// a token in the URL is ignored (URLs end up in CDN / proxy logs).
function queryTokenAllowed(req) {
  return req.method === 'POST' && /^\/api\/channels\/voice\/[^/]+\/[^/]+\/leave\/?$/.test(req.path);
}

// Attaches `req.user` when a valid bearer token is present. Routes that
// *require* auth call requireAuth.
export async function attachUser(req, _res, next) {
  try {
    const auth = req.headers.authorization || '';
    const m = /^Bearer\s+(.+)$/i.exec(auth);
    let tokenStr = m ? m[1].trim() : null;
    if (!tokenStr && req.query && req.query.token && queryTokenAllowed(req)) {
      tokenStr = String(req.query.token);
    }
    if (!tokenStr) return next();
    const user = await userFromToken(tokenStr);
    if (user) { req.user = user; req.authToken = tokenStr; }
    next();
  } catch (e) {
    next(e);
  }
}

export function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'unauthorized' });
  next();
}
