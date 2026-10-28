#!/usr/bin/env -S node --experimental-strip-types --no-warnings
/**
 * Deliver a folder of photographs through a photographer's upload link,
 * from a laptop rather than a browser.
 *
 * It does what the photographer's page does (PhotographerUpload.tsx):
 * mint twenty at a time, PUT each file to its signed URL, then complete
 * them. The server files them exactly as it files the page's uploads:
 * credited to the link, into the link's album, ordered by the capture
 * time read from each file's own EXIF. No keys are needed. The link's
 * code is the only credential, as it is for the page.
 *
 *   node --experimental-strip-types scripts/deliver-photos.mjs \
 *     <portal origin> <link code> <folder> [--dry-run] [--parallel 4]
 *
 *   e.g. node --experimental-strip-types scripts/deliver-photos.mjs \
 *          https://dan-sarah.com ab12cd34ef ~/Pictures/wedding-stream
 *
 * It can be stopped and run again. What has been completed is recorded
 * in <folder>/.delivered-<code>.json (relative path and size of each
 * file), and a second run skips those. A file that failed is not
 * recorded, so the next run sends it again. The record also keeps the
 * client id the server knows this delivery by.
 *
 * Only .jpg and .jpeg files are sent, from the folder and every folder
 * inside it. Hidden files are skipped.
 */

import { readdir, readFile, writeFile, stat, open } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { exifTakenAt } from '../portal/event-pages/_components/_lib/taken-at.ts';

/** Files per mint call; the server takes twenty (MAX_FILES_PER_MINT). */
const MINT_BATCH = 20;
/** The EXIF header is in the first few kilobytes; this is plenty. */
const HEAD_BYTES = 128 * 1024;
/** How many times one request is retried after a 429 or a network error. */
const RETRIES = 6;

function usage(message) {
  if (message) console.error(`error: ${message}\n`);
  console.error('usage: deliver-photos.mjs <portal origin> <link code> <folder> [--dry-run] [--parallel N]');
  process.exit(2);
}

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const positional = [];
let parallel = 4;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--parallel') { parallel = Number(args[++i]); continue; }
  if (!args[i].startsWith('--')) positional.push(args[i]);
}
const dryRun = flags.has('--dry-run');
const [originArg, code, folderArg] = positional;
if (!originArg || !code || !folderArg) usage();
if (!Number.isInteger(parallel) || parallel < 1 || parallel > 8) usage('--parallel must be 1 to 8');

let origin;
try {
  const u = new URL(originArg);
  if (u.protocol !== 'https:' && u.hostname !== 'localhost' && !u.hostname.endsWith('.localhost')) {
    usage('the portal origin must be https');
  }
  origin = u.origin;
} catch {
  usage('the portal origin is not a URL');
}
if (!/^[A-Za-z0-9_-]{4,64}$/.test(code)) usage('that does not look like a link code');
const folder = resolve(folderArg);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * A request, retried when the server says to slow down (429, honouring
 * Retry-After) or the network drops. Anything else is returned as it is.
 */
async function request(url, init, what) {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, init);
      if (res.status !== 429 && res.status < 500) return res;
      if (attempt >= RETRIES) return res;
      const after = Number(res.headers.get('retry-after'));
      const wait = Number.isFinite(after) && after > 0 ? after * 1000 : 2000 * 2 ** attempt;
      console.error(`  ${what}: ${res.status}, waiting ${Math.round(wait / 1000)}s`);
      await sleep(wait);
    } catch (err) {
      if (attempt >= RETRIES) throw err;
      const wait = 2000 * 2 ** attempt;
      console.error(`  ${what}: ${err.message ?? err}, retrying in ${Math.round(wait / 1000)}s`);
      await sleep(wait);
    }
  }
}

async function jpegsIn(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await jpegsIn(full)));
    else if (entry.isFile() && /\.jpe?g$/i.test(entry.name)) out.push(full);
  }
  return out;
}

async function takenAt(path) {
  const fh = await open(path, 'r');
  try {
    const buf = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await fh.read(buf, 0, HEAD_BYTES, 0);
    return exifTakenAt(new Uint8Array(buf.buffer, buf.byteOffset, bytesRead));
  } catch {
    return null;
  } finally {
    await fh.close();
  }
}

// ── The link ────────────────────────────────────────────────────────
const api = `${origin}/api/public/event-media/links/${encodeURIComponent(code)}`;
const linkRes = await request(api, { headers: { Accept: 'application/json' } }, 'link');
const link = await linkRes.json().catch(() => null);
if (!linkRes.ok || !link?.settings) {
  console.error(`That link did not answer (${linkRes.status}). Check the portal origin and the code, and that the link is active.`);
  process.exit(1);
}
if (link.settings.role !== 'photographer') {
  console.error('That is a guest link, not a photographer\'s. This script only delivers through a photographer\'s link.');
  process.exit(1);
}
const maxBytes = Number(link.settings.max_photo_bytes) || 0;

// ── What to send ────────────────────────────────────────────────────
const recordPath = join(folder, `.delivered-${code}.json`);
let record = { client_id: randomUUID(), done: [] };
try {
  const saved = JSON.parse(await readFile(recordPath, 'utf8'));
  if (saved && typeof saved.client_id === 'string' && Array.isArray(saved.done)) record = saved;
} catch {
  // First run.
}
const done = new Set(record.done);
const keyOf = (path, size) => `${relative(folder, path)}:${size}`;

const all = (await jpegsIn(folder)).sort();
const queue = [];
let tooBig = 0;
for (const path of all) {
  const { size } = await stat(path);
  if (done.has(keyOf(path, size))) continue;
  if (maxBytes && size > maxBytes) { tooBig += 1; console.error(`  skipping ${relative(folder, path)}: larger than the link allows`); continue; }
  queue.push({ path, size });
}
const totalBytes = queue.reduce((n, f) => n + f.size, 0);

console.log(`Event:    ${link.event?.name ?? '(untitled)'}`);
console.log(`Credit:   ${link.settings.credit ?? 'Photographer'}`);
console.log(`Album:    ${link.settings.album ?? 'Photographer'}`);
console.log(`Folder:   ${folder}`);
console.log(`Found ${all.length} JPEGs. ${all.length - queue.length - tooBig} already delivered, ${tooBig} too large, ${queue.length} to send (${(totalBytes / 1e9).toFixed(2)} GB).`);
if (dryRun || queue.length === 0) process.exit(0);

async function saveRecord() {
  record.done = [...done];
  await writeFile(recordPath, JSON.stringify(record));
}
await saveRecord();

// ── Send ────────────────────────────────────────────────────────────
let sent = 0;
let failed = 0;
let bytesSent = 0;
const started = Date.now();
let stopping = false;
process.on('SIGINT', () => {
  if (stopping) process.exit(130);
  stopping = true;
  console.log('\nStopping after this batch. Press Ctrl-C again to stop now.');
});

function progress() {
  const secs = (Date.now() - started) / 1000;
  const rate = bytesSent / Math.max(secs, 1);
  const left = rate > 0 ? (totalBytes - bytesSent) / rate : 0;
  const eta = left > 0 ? ` about ${Math.ceil(left / 60)} min left` : '';
  process.stdout.write(`\r${sent} sent, ${failed} failed of ${queue.length}. ${(rate * 8 / 1e6).toFixed(1)} Mbit/s,${eta}   `);
}

for (let i = 0; i < queue.length && !stopping; i += MINT_BATCH) {
  const batch = queue.slice(i, i + MINT_BATCH);
  const times = await Promise.all(batch.map((f) => takenAt(f.path)));

  const mintRes = await request(`${api}/uploads`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: record.client_id,
      files: batch.map((f, n) => ({
        filename: f.path.split('/').pop(),
        mime_type: 'image/jpeg',
        bytes: f.size,
        captured: false,
        taken_at: times[n] ?? null,
      })),
    }),
  }, 'mint');
  const minted = await mintRes.json().catch(() => null);
  if (!minted?.items) {
    console.error(`\nThe server would not take this batch (${mintRes.status}: ${minted?.message ?? 'no reason given'}). Run the script again to carry on.`);
    process.exit(1);
  }

  // Upload a few at a time. The connection is the limit, and more at
  // once is slower, not faster.
  const tickets = [];
  const ticketFile = new Map();
  let next = 0;
  async function worker() {
    while (next < batch.length) {
      const n = next++;
      const file = batch[n];
      const item = minted.items[n];
      if (!item || item.status !== 'ready' || !item.upload_url) {
        failed += 1;
        console.error(`\n  ${relative(folder, file.path)}: ${item?.message ?? item?.error ?? 'not accepted'}`);
        continue;
      }
      try {
        const body = await readFile(file.path);
        const put = await request(item.upload_url, {
          method: 'PUT',
          headers: { 'Content-Type': 'image/jpeg' },
          body,
        }, `upload ${relative(folder, file.path)}`);
        if (!put.ok) throw new Error(`upload answered ${put.status}`);
        tickets.push(item.ticket);
        ticketFile.set(item.media_id, file);
        bytesSent += file.size;
      } catch (err) {
        failed += 1;
        console.error(`\n  ${relative(folder, file.path)}: ${err.message ?? err}`);
      }
      progress();
    }
  }
  await Promise.all(Array.from({ length: Math.min(parallel, batch.length) }, worker));

  if (tickets.length === 0) continue;
  const completeRes = await request(`${api}/uploads/complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tickets }),
  }, 'complete');
  const completed = await completeRes.json().catch(() => null);
  if (completeRes.status === 409 && completed?.error === 'album_unavailable') {
    console.error('\nThe album this link delivers into is gone. Nothing in this batch was filed. Check the link in the admin, then run again.');
    process.exit(1);
  }
  if (!completed?.items) {
    // Uploaded but not filed. The next run sends these again; the copies
    // left in storage are swept by sweep-orphan-guest-media.mjs.
    failed += tickets.length;
    console.error(`\n  This batch uploaded but was not filed (${completeRes.status}). It will be sent again next run.`);
    continue;
  }
  for (const it of completed.items) {
    const file = ticketFile.get(it.media_id);
    if (!file) continue;
    if (it.status === 'created' || it.status === 'already_created') {
      done.add(keyOf(file.path, file.size));
      sent += 1;
    } else {
      failed += 1;
      console.error(`\n  ${relative(folder, file.path)}: ${it.error ?? 'not filed'}`);
    }
  }
  await saveRecord();
  progress();
}

console.log(`\nDone. ${sent} delivered, ${failed} failed.${failed ? ' Run the script again to retry the failures.' : ''}`);
process.exit(failed ? 1 : 0);
