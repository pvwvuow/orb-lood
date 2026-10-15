import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { q, one } from '../db.js';
import { hashPassword, verifyPassword } from '../auth/hash.js';
import { signToken, verifyToken, tokenDigest } from '../auth/jwt.js';
import { parseOr400, signupSchema, loginSchema } from '../validators.js';
import { publicUser } from '../lib/userShape.js';

export const authRouter = Router();

// Brute-force protection, two layers:
//  - per IP: 8 attempts / minute on the whole auth surface
//  - per account: 10 login attempts / 15 minutes for the same email, so
//    rotating IPs (or a shared CDN edge IP) cannot hammer one account.
const ipLimiter = rateLimit({
  windowMs: 60_000,
  max: 8,
  standardHeaders: true,
  legacyHeaders: false,
  validate: false
});
const accountLimiter = rateLimit({
  windowMs: 15 * 60_000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  validate: false,
  keyGenerator: (req) => 'acct:' + String((req.body && req.body.email) || '').trim().toLowerCase()
});

// A dummy hash so a login for an unknown email costs the same bcrypt time as
// a real one (no user-enumeration by timing).
const DUMMY_HASH = '$2a$10$CwTycUXWue0Thq9StjUM0uJ8.Zx5t0pM1Lr1Qp2Gq7m0cX9sX0F8e';

authRouter.post('/signup', ipLimiter, async (req, res, next) => {
  try {
    const body = parseOr400(signupSchema, req.body, res); if (!body) return;
    const existing = await one('SELECT id FROM users WHERE email = ? OR handle = ? LIMIT 1', [body.email, body.handle]);
    if (existing) return res.status(409).json({ error: 'email_or_handle_taken' });
    const hash = await hashPassword(body.password);
    const result = await q(
      'INSERT INTO users (email, handle, name, password_hash) VALUES (?, ?, ?, ?)',
      [body.email, body.handle, body.name, hash]
    );
    const userId = result.insertId;
    // Auto-create the user's Saved Messages thread.
    await q(
      'INSERT INTO dm_threads (user_a, user_b, is_saved) VALUES (?, ?, 1) ON DUPLICATE KEY UPDATE id = id',
      [userId, userId]
    );
    const user = await one('SELECT * FROM users WHERE id = ?', [userId]);
    const token = signToken({ uid: userId, tv: Number(user.token_version || 0) });
    res.status(201).json({ token, user: publicUser(user) });
  } catch (e) {
    if (e && e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'email_or_handle_taken' });
    next(e);
  }
});

authRouter.post('/login', ipLimiter, accountLimiter, async (req, res, next) => {
  try {
    const body = parseOr400(loginSchema, req.body, res); if (!body) return;
    const row = await one('SELECT * FROM users WHERE email = ? LIMIT 1', [body.email]);
    const ok = await verifyPassword(body.password, row ? row.password_hash : DUMMY_HASH).catch(() => false);
    if (!row || !ok) return res.status(401).json({ error: 'invalid_credentials' });
    await q('UPDATE users SET last_seen_at = CURRENT_TIMESTAMP WHERE id = ?', [row.id]);
    const token = signToken({ uid: row.id, tv: Number(row.token_version || 0) });
    res.json({ token, user: publicUser(row) });
  } catch (e) { next(e); }
});

// Logout really revokes the token now: its digest goes into auth_tokens
// until the token would have expired anyway. ?all=1 logs out every device.
authRouter.post('/logout', async (req, res, next) => {
  try {
    const auth = req.headers.authorization || '';
    const m = /^Bearer\s+(.+)$/i.exec(auth);
    const tokenStr = m ? m[1].trim() : null;
    const claims = tokenStr ? verifyToken(tokenStr) : null;
    if (claims && claims.uid) {
      const exp = claims.exp ? new Date(claims.exp * 1000) : new Date(Date.now() + 7 * 864e5);
      await q(
        'INSERT IGNORE INTO auth_tokens (token, user_id, expires_at) VALUES (?, ?, ?)',
        [tokenDigest(tokenStr), claims.uid, exp]
      );
      if (String(req.query.all || '') === '1') {
        await q('UPDATE users SET token_version = token_version + 1 WHERE id = ?', [claims.uid]);
      }
      // Housekeeping: drop revocations whose tokens have expired.
      q('DELETE FROM auth_tokens WHERE expires_at < CURRENT_TIMESTAMP').catch(() => {});
    }
    res.json({ ok: true });
  } catch (e) { next(e); }
});
