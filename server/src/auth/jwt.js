import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';

// Every token carries:
//   uid - user id
//   tv  - the user's token_version at sign time (bumped on password change,
//         which kills every older token at once)
//   jti - random id, so a single token can be revoked on logout
export function signToken(payload) {
  const jti = crypto.randomBytes(16).toString('hex');
  return jwt.sign({ ...payload, jti }, config.jwt.secret, {
    expiresIn: config.jwt.expiresIn,
    algorithm: 'HS256'
  });
}

export function verifyToken(token) {
  try {
    return jwt.verify(token, config.jwt.secret, { algorithms: ['HS256'] });
  } catch (_) {
    return null;
  }
}

// Revocation list key: sha256 of the raw token (fits auth_tokens.token CHAR(64)).
export function tokenDigest(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}
