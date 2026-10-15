import 'dotenv/config';
import crypto from 'node:crypto';

const required = (name, def) => {
  const v = process.env[name] ?? def;
  if (v === undefined || v === '') {
    console.error(`[config] missing required env var: ${name}`);
    process.exit(1);
  }
  return v;
};

const sha256 = s => crypto.createHash('sha256').update(String(s)).digest('hex');

// Secrets that were published in the public git history. Refuse to run with
// them: anyone could forge a login token for any account.
const LEAKED_JWT = new Set([
  '344ba8eee178726136829d4f3cd818f6e13560818bb8a8ffe7a3f7aaa0037ad8'
]);
const LEAKED_TURN = new Set([
  '2c0aa744102f9a1910c303ad33c5f6693523009dffc2fbb69ff6132930caadac'
]);
const WEAK_JWT = new Set(['change-me-in-prod', 'changeme', 'secret', 'CHANGE_ME']);

function jwtSecret() {
  const s = required('JWT_SECRET');
  if (LEAKED_JWT.has(sha256(s)) || WEAK_JWT.has(s) || s.length < 32) {
    console.error('[config] JWT_SECRET is a published / weak value. Generate a new one:');
    console.error("[config]   node -e \"console.log(require('crypto').randomBytes(48).toString('hex'))\"");
    console.error('[config] or run: sudo bash scripts/rotate-secrets.sh');
    process.exit(1);
  }
  return s;
}

// "trust proxy" decides which X-Forwarded-For hop is the real client.
// Default: only trust a proxy on this machine (nginx on 127.0.0.1). nginx
// itself resolves the real client IP behind ArvanCloud (real_ip module) and
// overwrites X-Forwarded-For, so a client cannot spoof it.
function trustProxy() {
  const raw = (process.env.TRUST_PROXY || 'loopback').trim();
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (/^\d+$/.test(raw)) return parseInt(raw, 10);
  return raw;
}

const turnPassword = process.env.TURN_PASSWORD || process.env.EXPRESSTURN_PASSWORD || '';
if (turnPassword && LEAKED_TURN.has(sha256(turnPassword))) {
  console.warn('[config] WARNING: TURN_PASSWORD is the published value from git history.');
  console.warn('[config] Run `sudo bash scripts/rotate-secrets.sh` to switch coturn to TURN_SECRET.');
}

export const config = {
  port: parseInt(process.env.PORT || '4000', 10),
  // 127.0.0.1 in production (nginx in front). Docker sets HOST=0.0.0.0.
  host: process.env.HOST || '0.0.0.0',
  publicOrigin: process.env.PUBLIC_ORIGIN || 'http://localhost:5173',
  trustProxy: trustProxy(),

  db: {
    host: required('DB_HOST', 'localhost'),
    port: parseInt(process.env.DB_PORT || '3306', 10),
    user: required('DB_USER', 'orblood'),
    password: process.env.DB_PASSWORD || '',
    database: required('DB_NAME', 'orblood'),
    waitForConnections: true,
    connectionLimit: parseInt(process.env.DB_POOL || '10', 10),
    queueLimit: 0,
    charset: 'utf8mb4',
    enableKeepAlive: true
  },

  jwt: {
    secret: jwtSecret(),
    expiresIn: process.env.JWT_EXPIRES_IN || '7d'
  },

  uploads: {
    dir: process.env.UPLOAD_DIR || './uploads',
    publicBase: process.env.PUBLIC_UPLOADS_BASE || '/uploads',
    maxBytes: parseInt(process.env.UPLOAD_MAX_BYTES || (5 * 1024 * 1024), 10),
    // Per-user upload budget (count per hour) to stop disk-filling abuse.
    perHour: parseInt(process.env.UPLOAD_PER_HOUR || '60', 10)
  },

  voice: {
    // Preferred: coturn `use-auth-secret` + `static-auth-secret=<TURN_SECRET>`.
    // The API then hands out short-lived per-user credentials, so nothing
    // long-lived ever reaches a browser.
    secret: process.env.TURN_SECRET || '',
    credentialTtlSec: parseInt(process.env.TURN_CREDENTIAL_TTL || String(24 * 3600), 10),
    // Legacy static credentials (only used when TURN_SECRET is empty).
    username: process.env.TURN_USERNAME || process.env.EXPRESSTURN_USERNAME || '',
    password: turnPassword,
    urls: (process.env.TURN_URLS || process.env.EXPRESSTURN_URLS || '').split(',').map(s => s.trim()).filter(Boolean),
    // If set, this is used as the hostname for the self-hosted coturn.
    // If empty, the hostname is derived from PUBLIC_ORIGIN.
    selfHost: process.env.TURN_HOST || '',
    // When true (default), the client uses iceTransportPolicy:'relay' so all
    // audio flows through our coturn server. This is what makes voice work
    // on filtered networks (Iran/China/corporate) where direct P2P is
    // blocked. Set VOICE_FORCE_RELAY=false to let clients try P2P first.
    forceRelay: (process.env.VOICE_FORCE_RELAY || 'true').toLowerCase() !== 'false',
    allowUdp: String(process.env.VOICE_ALLOW_UDP || '').toLowerCase() === 'true',
    logSignals: String(process.env.VOICE_SIGNAL_LOG || '1') !== '0'
  }
};
