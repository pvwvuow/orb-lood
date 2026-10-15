import { z } from 'zod';
import { cleanText, isSafeImageUrl } from './lib/sanitize.js';

// Reused across signup/login/profile updates. Keep these conservative — the
// frontend has matching client-side validation but we never trust it.

export const emailSchema  = z.string().trim().toLowerCase().email().max(190);
export const handleSchema = z.string().trim().min(2).max(40)
  .transform(s => s.replace(/^@/, '').toLowerCase())
  .refine(s => /^[a-z0-9_.-]+$/.test(s), 'invalid characters in handle');
// Display names are rendered all over the SPA (often via innerHTML), so
// HTML-significant characters are swapped for look-alikes.
export const nameSchema   = z.string().trim().min(1).max(80).transform(cleanText);
export const passwordSchema = z.string().min(8).max(200);
const imageSchema = z.string().max(6291456)
  .refine(isSafeImageUrl, 'unsafe image url');

export const signupSchema = z.object({
  email:    emailSchema,
  handle:   handleSchema,
  name:     nameSchema,
  password: passwordSchema
});

export const loginSchema = z.object({
  email:    emailSchema,
  password: z.string().min(1).max(200)
});

export const profilePatchSchema = z.object({
  name:        nameSchema.optional(),
  handle:      handleSchema.optional(),
  bio:         z.string().trim().max(500).transform(cleanText).optional(),
  baseColor:   z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  rank:        z.string().max(40).transform(cleanText).optional(),
  phone:       z.string().max(40).transform(cleanText).optional(),
  email:       emailSchema.optional(),
  password:    passwordSchema.optional(),
  // Optional today (the current UI does not send it yet). When present it
  // is verified before a password / email change.
  currentPassword: z.string().min(1).max(200).optional(),
  friendsOnly: z.boolean().optional(),
  // Avatar/banner come in as either /uploads/... URLs (after a separate
  // POST /me/avatar upload) or as null to clear.
  avImage:     imageSchema.nullable().optional(),
  bannerImage: imageSchema.nullable().optional()
});

// Run a Zod schema against req.body and either return the parsed value, or
// send a 400 with the first error and return null.
export function parseOr400(schema, body, res) {
  const r = schema.safeParse(body);
  if (!r.success) {
    const issue = r.error.issues[0];
    res.status(400).json({ error: 'validation_failed', field: (issue.path||[]).join('.'), message: issue.message });
    return null;
  }
  return r.data;
}
