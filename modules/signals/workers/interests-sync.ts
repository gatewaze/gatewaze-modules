// @ts-nocheck — depends on supabase-js; resolved at worker-host install time.

/**
 * signals:interests-sync (spec-plays-audience-intelligence.md §4.2).
 *
 * Runs every ENABLED interest source's deriveBulk(), normalises the raw topics
 * through topic_vocabulary (normalize_topic), and upserts weighted, source-tagged
 * rows into signals_interests. The person_topic_interests view then aggregates
 * them source-weighted + recency-decayed. This is the ingestion half of the topic
 * hub; person_topics() is the read half.
 *
 * Sources are contributed by modules via `<module>/interests/register.js`
 * (discovered across MODULE_SOURCES) and toggled/weighted via the
 * signals_interest_sources config table.
 */

import { promises as fs } from 'node:fs';
import * as nodePath from 'node:path';
import { pathToFileURL } from 'node:url';
import { createClient } from '@supabase/supabase-js';

if (typeof globalThis.WebSocket === 'undefined') {
  globalThis.WebSocket = class { addEventListener() {} removeEventListener() {} close() {} send() {} };
}

function moduleRoots() {
  const fromEnv = (process.env.MODULE_SOURCES ?? '')
    .split(',').map((s) => s.split('#')[0].trim()).filter(Boolean)
    .map((s) => (s.endsWith('/modules') ? s : nodePath.join(s, 'modules')));
  return fromEnv.length ? fromEnv : ['/lf-gatewaze-modules/modules', '/gatewaze-modules/modules'];
}

async function discoverSources(log) {
  const out = [];
  for (const root of moduleRoots()) {
    let entries = [];
    try { entries = await fs.readdir(root); } catch { continue; }
    for (const name of entries) {
      const candidate = nodePath.join(root, name, 'interests', 'register.js');
      try {
        await fs.access(candidate);
        const mod = await import(pathToFileURL(candidate).href);
        const exp = mod.default ?? mod;
        const list = Array.isArray(exp) ? exp : (exp.sources ?? (exp.key ? [exp] : []));
        for (const s of list) if (s && s.key) out.push(s);
      } catch (e) {
        log.warn(`interest source not loaded from ${candidate}: ${e.message}`);
      }
    }
  }
  return out;
}

export default async function handler(job, ctx) {
  const logger = ctx?.logger ?? console;
  const log = {
    info: (m, x) => logger.info?.(`[signals:interests-sync] ${m}`, x) ?? console.log(`[signals:interests-sync] ${m}`, x ?? ''),
    warn: (m, x) => logger.warn?.(`[signals:interests-sync] ${m}`, x) ?? console.warn(`[signals:interests-sync] ${m}`, x ?? ''),
  };
  const supabase = ctx?.supabase ?? createClient(process.env.SUPABASE_URL ?? '', process.env.SUPABASE_SERVICE_ROLE_KEY ?? '', {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const onlySource = job?.data?.source ?? null;
  const days = Number(job?.data?.days ?? 30);
  const sinceIso = new Date(Date.now() - days * 86_400_000).toISOString();

  // config (enabled + weight + requires_lawful_basis) per source
  const cfg = {};
  try {
    const r = await supabase.from('signals_interest_sources').select('source,enabled,requires_lawful_basis');
    for (const c of (r.data || [])) cfg[c.source] = c;
  } catch (e) { log.warn(`could not read signals_interest_sources: ${e.message}`); }

  const sources = await discoverSources(log);
  const normCache = new Map();
  async function normalize(raw) {
    if (normCache.has(raw)) return normCache.get(raw);
    let slug = null;
    try {
      const r = await supabase.rpc('normalize_topic', { raw });
      const row = Array.isArray(r.data) ? r.data[0] : r.data;
      slug = row?.slug || null;
    } catch { slug = null; }
    normCache.set(raw, slug);
    return slug;
  }

  const summary = {};
  for (const src of sources) {
    if (onlySource && src.key !== onlySource) continue;
    const conf = cfg[src.key];
    const enabled = conf ? conf.enabled : (src.default_enabled !== false);
    if (!enabled) { summary[src.key] = 'disabled'; continue; }
    if (typeof src.deriveBulk !== 'function') { summary[src.key] = 'no deriveBulk'; continue; }

    let rows = [];
    try { rows = await src.deriveBulk({ supabase, sinceIso }); }
    catch (e) { log.warn(`${src.key} deriveBulk threw: ${e.message}`); summary[src.key] = 'error'; continue; }

    // normalise topics + build upsert rows
    const now = new Date().toISOString();
    const upserts = [];
    for (const r of (rows || [])) {
      if (!r || !r.person_id || !r.topic) continue;
      const slug = await normalize(String(r.topic));
      if (!slug) continue;
      upserts.push({
        person_id: r.person_id,
        topic: slug,
        weight: Math.max(0.01, Math.min(10, Number(r.weight) || 1.0)),
        source: src.key,
        observed_at: r.observed_at ?? now,
        evidence: r.evidence ?? null,
        updated_at: now,
      });
    }
    // dedupe on (person_id, topic) keeping the max weight (a person may hit the same topic via many items)
    const best = new Map();
    for (const u of upserts) {
      const k = `${u.person_id}|${u.topic}`;
      const prev = best.get(k);
      if (!prev || u.weight > prev.weight) best.set(k, u);
    }
    const final = [...best.values()];
    let written = 0;
    for (let i = 0; i < final.length; i += 1000) {
      const chunk = final.slice(i, i + 1000);
      const w = await supabase.from('signals_interests').upsert(chunk, { onConflict: 'person_id,topic,source' });
      if (!w.error) written += chunk.length;
      else log.warn(`${src.key} upsert failed: ${w.error.message}`);
    }
    summary[src.key] = written;
  }

  log.info(`sync complete: ${JSON.stringify(summary)}`);
  return { summary };
}
