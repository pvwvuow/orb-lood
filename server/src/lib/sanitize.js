// Input hygiene for values the SPA later renders as HTML.
//
// The frontend builds a lot of markup with string concatenation, and not
// every spot escapes. Until every render path is fixed, the server makes
// sure "name-like" fields can never carry HTML / attribute breakouts and
// that image / link URLs only use safe schemes.

// Look-alike replacements: the text still reads the same for humans but
// can no longer open a tag or close an HTML attribute.
const LOOKALIKE = { '<': '\u2039', '>': '\u203A', '"': '\u201D', "'": '\u2019', '`': '\u02CB' };

export function cleanText(v) {
  if (typeof v !== 'string') return v;
  return v.replace(/[<>"'`]/g, ch => LOOKALIKE[ch]).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
}

const DATA_IMAGE = /^data:image\/(png|jpe?g|gif|webp);base64,[A-Za-z0-9+/=\r\n]+$/i;
const HTTP_URL   = /^https?:\/\/[^\s"'<>`\\]+$/i;
const LOCAL_PATH = /^\/(?!\/)[A-Za-z0-9._~\/%+-]*(\?[A-Za-z0-9._~=&%+-]*)?$/;

// Image sources: same-origin paths, http(s), or raster data URLs.
// SVG data URLs are refused because they can carry script.
export function isSafeImageUrl(v) {
  if (v == null || v === '') return true;
  if (typeof v !== 'string') return false;
  const s = v.trim();
  return LOCAL_PATH.test(s) || HTTP_URL.test(s) || DATA_IMAGE.test(s);
}

// Clickable links: http(s) or same-origin only (no javascript:, data:, ...).
export function isSafeLinkUrl(v) {
  if (v == null || v === '') return true;
  if (typeof v !== 'string') return false;
  const s = v.trim();
  return LOCAL_PATH.test(s) || HTTP_URL.test(s);
}

const IMAGE_KEYS = /^(src|image|img|thumb|thumbnail|poster|avImage|bannerImage|cover|emblem|emblemImage|avatar|icon|preview)$/i;
const LINK_KEYS  = /^(url|href|link)$/i;
const NAME_KEYS  = /^(name|fileName|filename|title|user|userName|peerName|label)$/i;

// Message payloads are free-form JSON (replies, attachments, forwards...).
// Walk them and neutralise anything that would end up in src/href or in a
// name label. Message *text* is left alone on purpose: people paste code.
export function sanitizePayload(value, depth = 0) {
  if (depth > 8 || value == null) return value;
  if (Array.isArray(value)) return value.slice(0, 200).map(v => sanitizePayload(v, depth + 1));
  if (typeof value !== 'object') return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    if (typeof v === 'string') {
      if (IMAGE_KEYS.test(k)) { out[k] = isSafeImageUrl(v) ? v : null; continue; }
      if (LINK_KEYS.test(k))  { out[k] = (isSafeLinkUrl(v) || isSafeImageUrl(v)) ? v : null; continue; }
      if (NAME_KEYS.test(k))  { out[k] = cleanText(v); continue; }
      out[k] = v;
    } else {
      out[k] = sanitizePayload(v, depth + 1);
    }
  }
  return out;
}

// Express middleware for the server / channel / profile routers:
// cleans name-like fields and rejects unsafe image URLs before Zod runs.
const BODY_TEXT_KEYS  = ['name', 'desc', 'description', 'initial', 'rank', 'title'];
const BODY_IMAGE_KEYS = ['cover', 'emblemImage', 'avImage', 'bannerImage'];

export function sanitizeBody(req, res, next) {
  const b = req.body;
  if (!b || typeof b !== 'object' || Array.isArray(b)) return next();
  for (const k of BODY_TEXT_KEYS) if (typeof b[k] === 'string') b[k] = cleanText(b[k]);
  for (const k of BODY_IMAGE_KEYS) {
    if (b[k] != null && !isSafeImageUrl(b[k])) {
      return res.status(400).json({ error: 'validation_failed', field: k, message: 'unsafe image url' });
    }
  }
  if (Array.isArray(b.roles)) {
    for (const r of b.roles) {
      if (r && typeof r === 'object' && typeof r.name === 'string') r.name = cleanText(r.name);
    }
  }
  next();
}
