#!/usr/bin/env node
// Applies small, exact-match safety patches to public/js/app.js.
//
// app.js is one 650 KB file; these patches fix spots found in the 15 Oct
// audit without hand-editing the whole bundle. Every patch:
//   - only applies when its exact `find` text is present (else: skipped,
//     reported), and is idempotent (already patched → skipped)
//   - the result must still parse (node --check) or nothing is written
//
// Usage:  node scripts/patch-frontend.mjs [path/to/app.js]   (deploy.sh runs it)
//         node scripts/patch-frontend.mjs --check            (report only)

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
const file = args.find(a => !a.startsWith('--')) || path.resolve(here, '..', 'public', 'js', 'app.js');

const PATCHES = [
  {
    id: 'xss-orb-slide-label',
    why: 'channel name rendered raw in renderOrbSlides()',
    find: `'<div class="vlabel">'+data.name+'</div>'`,
    replace: `'<div class="vlabel">'+escapeHtml(data.name)+'</div>'`
  },
  {
    id: 'xss-voice-group-label',
    why: 'channel name rendered raw (text + title attribute) in renderVoiceUsers()',
    find: `'<div class="vu-group-label" title="'+data.name+'">'+data.name+'</div>'`,
    replace: `'<div class="vu-group-label" title="'+escapeHtml(data.name)+'">'+escapeHtml(data.name)+'</div>'`
  },
  {
    id: 'xss-marked-sidebar-name',
    why: 'channel name rendered raw in updateMarkedSidebar()',
    find: `'<div class="mc-name">'+data.name+'</div>'`,
    replace: `'<div class="mc-name">'+escapeHtml(data.name)+'</div>'`
  },
  {
    id: 'xss-dm-image-src',
    why: 'DM image src inserted into an HTML attribute unescaped',
    find: `'<img class="dm-bubble-img" src="'+m.src+'"`,
    replace: `'<img class="dm-bubble-img" src="'+escapeHtml(m.src)+'"`,
    all: true
  },
  {
    id: 'dm-markread-real-handle',
    why: 'read receipts sent with the synthetic __u_<name> key failed on the server',
    find: `backend.dms.markRead(peerKey)`,
    replace: `backend.dms.markRead((typeof resolvePeerKeyForBackend === 'function' && resolvePeerKeyForBackend(peerKey)) || peerKey)`,
    all: true
  },
  {
    id: 'voice-no-invented-turn-creds',
    why: 'client invented TURN credentials when /api/voice/config failed, hiding the real error',
    find: `{ username: 'orblood', credential: 'orblood' }`,
    replace: `{ username: '', credential: '' }`,
    all: true
  }
];

function countOf(hay, needle) {
  let n = 0, i = 0;
  while ((i = hay.indexOf(needle, i)) !== -1) { n++; i += needle.length; }
  return n;
}

if (!fs.existsSync(file)) {
  console.error('[patch-frontend] not found:', file);
  process.exit(1);
}
let src = fs.readFileSync(file, 'utf8');
const hasEscape = /function\s+escapeHtml\s*\(|(?:const|let|var)\s+escapeHtml\s*=/.test(src);
let changed = 0;

for (const p of PATCHES) {
  if (p.replace.includes('escapeHtml(') && !hasEscape) {
    console.log(`[patch-frontend] skip  ${p.id}: escapeHtml() not defined in this build`);
    continue;
  }
  const have = countOf(src, p.find);
  if (!have) {
    const done = countOf(src, p.replace) > 0;
    console.log(`[patch-frontend] ${done ? 'ok   ' : 'miss '} ${p.id}${done ? ' (already applied)' : ': pattern not found, review by hand — ' + p.why}`);
    continue;
  }
  if (have > 1 && !p.all) {
    console.log(`[patch-frontend] skip  ${p.id}: pattern found ${have}x, expected 1`);
    continue;
  }
  src = src.split(p.find).join(p.replace);
  changed += have;
  console.log(`[patch-frontend] apply ${p.id} (${have}x) — ${p.why}`);
}

if (checkOnly) { console.log('[patch-frontend] --check: nothing written'); process.exit(0); }
if (!changed) { console.log('[patch-frontend] nothing to change'); process.exit(0); }

// Never write a bundle that no longer parses.
const tmp = path.join(os.tmpdir(), 'orblood-app-' + process.pid + '.js');
fs.writeFileSync(tmp, src);
try {
  execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' });
} catch (e) {
  fs.unlinkSync(tmp);
  console.error('[patch-frontend] patched file does not parse — NOT written');
  console.error(String(e.stderr || e.message));
  process.exit(1);
}
fs.unlinkSync(tmp);
fs.writeFileSync(file, src);
console.log(`[patch-frontend] wrote ${file} (${changed} replacements)`);
