import { Router } from 'express';
import multer from 'multer';
import rateLimit from 'express-rate-limit';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { requireAuth } from '../auth/middleware.js';

export const uploadsRouter = Router();
uploadsRouter.use(requireAuth);

// Same resolution as the static /uploads mount in index.js (relative to
// the server/ folder), so a file we write is always the file we serve.
const here = path.dirname(fileURLToPath(import.meta.url));
const uploadAbs = path.isAbsolute(config.uploads.dir)
  ? config.uploads.dir
  : path.resolve(here, '..', '..', config.uploads.dir.replace(/^\.\//, ''));
fs.mkdirSync(uploadAbs, { recursive: true });

// Per-user budget so one account cannot fill the disk.
const uploadLimiter = rateLimit({
  windowMs: 60 * 60_000,
  max: config.uploads.perHour,
  standardHeaders: true,
  legacyHeaders: false,
  validate: false,
  keyGenerator: (req) => 'upl:' + String(req.user && req.user.id),
  message: { error: 'upload_rate_limited' }
});

const EXT_BY_MIME = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadAbs),
  filename: (_req, file, cb) => {
    const ext = EXT_BY_MIME[String(file.mimetype).toLowerCase()] || 'bin';
    cb(null, crypto.randomBytes(12).toString('hex') + '.' + ext);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: config.uploads.maxBytes, files: 1, fields: 10 },
  fileFilter: (_req, file, cb) => {
    if (!EXT_BY_MIME[String(file.mimetype).toLowerCase()]) return cb(new Error('only_images'));
    cb(null, true);
  }
});

// The browser-supplied MIME type is just a claim. Check the real bytes.
function sniffImage(buf) {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return 'png';
  if (buf.length >= 3 && buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'jpg';
  if (buf.length >= 6 && buf.slice(0, 6).toString('ascii').match(/^GIF8[79]a$/)) return 'gif';
  if (buf.length >= 12 && buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') return 'webp';
  return null;
}

// POST /api/uploads/image — returns { url } pointing at /uploads/<file>.
uploadsRouter.post('/image', uploadLimiter, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no_file' });
  const filePath = req.file.path;
  try {
    const fh = await fs.promises.open(filePath, 'r');
    const head = Buffer.alloc(16);
    await fh.read(head, 0, 16, 0);
    await fh.close();
    const real = sniffImage(head);
    const claimed = req.file.filename.split('.').pop();
    if (!real || (real !== claimed)) {
      await fs.promises.unlink(filePath).catch(() => {});
      return res.status(400).json({ error: 'only_images_supported' });
    }
  } catch (e) {
    await fs.promises.unlink(filePath).catch(() => {});
    console.warn('[uploads] verify failed:', e && e.message);
    return res.status(500).json({ error: 'upload_failed' });
  }
  const publicUrl = config.uploads.publicBase.replace(/\/$/, '') + '/' + req.file.filename;
  res.status(201).json({ url: publicUrl });
});

// Multer's own errors become a clean JSON response.
uploadsRouter.use((err, _req, res, _next) => {
  if (err && err.message === 'only_images') return res.status(400).json({ error: 'only_images_supported' });
  if (err && err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'file_too_large' });
  console.warn('[uploads] error:', err && err.message);
  res.status(500).json({ error: 'upload_failed' });
});
