// Must be first: makes Express forward rejected async handlers to next(err).
import './lib/asyncErrors.js';
import express from 'express';
import cors from 'cors';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { pool, pingDb } from './db.js';
import { runMigrations } from './lib/migrate.js';
import { attachUser } from './auth/middleware.js';
import { sanitizeBody } from './lib/sanitize.js';
import { healthRouter } from './routes/health.js';
import { authRouter } from './routes/auth.js';
import { meRouter } from './routes/me.js';
import { serversRouter } from './routes/servers.js';
import { channelsRouter } from './routes/channels.js';
import { dmsRouter } from './routes/dms.js';
import { friendsRouter } from './routes/friends.js';
import { usersRouter } from "./routes/users.js";
import { uploadsRouter } from "./routes/uploads.js";
import { voiceConfigRouter } from './routes/voice-config.js';
import { packsRouter } from './routes/packs.js';
import { attachWs, closeWs } from './realtime/ws.js';
import http from 'node:http';

// Never let one bad promise take the whole server (and every call) down.
process.on('unhandledRejection', (reason) => {
  console.error('[server] unhandled rejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[server] uncaught exception:', err);
});

const app = express();
app.disable('x-powered-by');

// Which proxy hops to trust for the client IP. Default 'loopback': nginx on
// this machine. nginx resolves the real visitor IP behind ArvanCloud and
// overwrites X-Forwarded-For, so clients cannot fake their IP to dodge the
// login rate limit. See TRUST_PROXY in .env.example.
app.set('trust proxy', config.trustProxy);

// Baseline security headers for everything we serve.
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Permissions-Policy', 'microphone=(self), camera=(), geolocation=()');
  next();
});

// CORS — when credentials are sent, browsers refuse to honour a
// wildcard `Access-Control-Allow-Origin: *`. So we reflect the request
// Origin instead of returning '*'. Treat PUBLIC_ORIGIN='*' as "trust
// whatever the request says" (dev tunnel only), and otherwise restrict to
// the configured origin(s) (comma separated).
const allowedOrigins = config.publicOrigin.split(',').map(s => s.trim()).filter(Boolean);
app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    if (allowedOrigins.includes('*')) return cb(null, origin);
    if (allowedOrigins.includes(origin)) return cb(null, origin);
    return cb(null, false);
  },
  credentials: true
}));

// --- request-timing logger ---
// CDNs in front of us (ArvanCloud) time out at ~30s and turn the response
// into a 504 that hides whatever the backend was doing. Log every request
// that errors or runs longer than VERBOSE_REQUEST_MS (default 2s). Query
// strings are stripped so tokens never land in the journal.
const VERBOSE_REQUEST_MS = parseInt(process.env.VERBOSE_REQUEST_MS || '2000', 10);
app.use((req, res, next) => {
  const t0 = Date.now();
  res.on('finish', () => {
    const dur = Date.now() - t0;
    const slow = dur >= VERBOSE_REQUEST_MS;
    const bad  = res.statusCode >= 500;
    if (slow || bad) {
      const tag = bad ? 'ERR ' : 'SLOW';
      console.warn(`[req] ${tag} ${res.statusCode} ${req.method} ${req.path} ${dur}ms`);
    }
  });
  next();
});

// 8MB headroom — avImage / bannerImage can come in as base64 data URLs when
// the multipart upload endpoint is unreachable. The column is MEDIUMTEXT
// and the validator allows up to 6MB, so the body parser must not be the
// tighter gate.
app.use(express.json({ limit: '8mb' }));

// Static uploads. Anything written to UPLOAD_DIR is served from /uploads/*.
// Locked down so a file can never run as a page on our origin.
const here = path.dirname(fileURLToPath(import.meta.url));
const uploadsAbs = path.isAbsolute(config.uploads.dir)
  ? config.uploads.dir
  : path.resolve(here, '..', config.uploads.dir.replace(/^\.\//, ''));
app.use(config.uploads.publicBase, express.static(uploadsAbs, {
  index: false,
  dotfiles: 'deny',
  setHeaders: (res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox");
    res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
  }
}));

// Serve the static frontend from the same origin so the SPA can call /api
// without CORS. In production nginx does this; this fallback is for
// dev/preview deployments where the backend is the only public process.
const publicDir = path.resolve(here, '..', '..', 'public');

// Boot stamp shared across this process, used to cache-bust the frontend
// bundle so a fresh deploy is visible the moment the renderer loads.
const _bootStamp = Date.now().toString(36);

let _indexHtmlCache = null;
function _serveIndexHtml(_req, res) {
  if (!_indexHtmlCache) {
    try {
      _indexHtmlCache = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
    } catch (e) {
      return res.status(500).type('text/plain').send('index.html missing');
    }
  }
  const stamped = _indexHtmlCache
    .replace(/(<script\s+[^>]*src=")(\/[^"?]+\.js)(")/g,             '$1$2?v='+_bootStamp+'$3')
    .replace(/(<link\s+[^>]*href=")(\/[^"?]+\.css)(")/g,             '$1$2?v='+_bootStamp+'$3');
  res.setHeader('Cache-Control', 'no-cache, must-revalidate');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(stamped);
}

app.get('/', _serveIndexHtml);
app.use(express.static(publicDir, {
  index: false,
  setHeaders: (res, filePath) => {
    res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    if (filePath.endsWith('/sw.js') || filePath.endsWith('\\sw.js')) {
      res.setHeader('Service-Worker-Allowed', '/');
      res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    }
    if (filePath.endsWith('manifest.webmanifest')) {
      res.setHeader('Content-Type', 'application/manifest+json; charset=utf-8');
    }
  }
}));

// Bearer-token decoder runs on every request.
app.use(attachUser);

// Name / image hygiene for everything that ends up rendered as HTML.
app.use(['/api/servers', '/api/channels', '/api/me'], sanitizeBody);

// Routes
app.use('/api', healthRouter);
app.use('/api', voiceConfigRouter);
app.use('/api/auth',     authRouter);
app.use('/api/me',       meRouter);
app.use('/api/servers',  serversRouter);
app.use('/api/channels', channelsRouter);
app.use('/api/dms',      dmsRouter);
app.use('/api/friends',  friendsRouter);
app.use('/api/users',    usersRouter);
app.use('/api/uploads',  uploadsRouter);
app.use('/api/packs',    packsRouter);

// 404 — JSON for API routes, fallback to SPA index.html for everything else.
app.use('/api', (_req, res) => res.status(404).json({ error: 'not_found' }));
app.use(_serveIndexHtml);

// Error handler: details go to the journal, never to the client.
app.use((err, req, res, _next) => {
  if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'payload_too_large' });
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'invalid_json' });
  console.error('[server]', req.method, req.path, err);
  if (res.headersSent) return;
  res.status(500).json({ error: 'internal_error' });
});

let httpServer = null;

(async () => {
  try {
    await pingDb();
    console.log('[server] db ok');
    try { await runMigrations(pool); }
    catch (e) { console.warn('[server] migrations failed (run `npm run init-db`):', e.message); }
  } catch (e) {
    console.warn('[server] db unreachable at startup:', e.message);
    console.warn('[server] continuing — fix the connection then restart.');
  }
  // Wrap Express in a bare HTTP server so we can also attach the WebSocket
  // upgrade handler on the same port. nginx reverse-proxies /ws → backend.
  httpServer = http.createServer(app);
  httpServer.keepAliveTimeout = 65_000;
  httpServer.headersTimeout = 66_000;
  attachWs(httpServer);
  httpServer.listen(config.port, config.host, () => {
    console.log(`[server] listening on http://${config.host}:${config.port}`);
    console.log(`[server] websocket on    ws://${config.host}:${config.port}/ws`);
  });
})();

// Graceful shutdown: stop accepting, close sockets, drain, close the pool.
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[server] ${signal} received, shutting down`);
  const force = setTimeout(() => process.exit(0), 10_000);
  force.unref();
  try { closeWs(); } catch (_) {}
  if (httpServer) await new Promise(r => httpServer.close(() => r()));
  try { await pool.end(); } catch (_) {}
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
