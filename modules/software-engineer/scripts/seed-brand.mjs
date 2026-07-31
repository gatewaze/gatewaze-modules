// Seed a brand's software-engineer config directly (skip the Setup UI). Encrypts credentials in
// the exact AES-256-GCM format the platform's decryptSecret expects, so the phases can read them.
//
// Run (from anywhere @supabase/supabase-js resolves, e.g. the module dir):
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... GATEWAZE_SECRETS_KEY=... \
//   SE_GITHUB_TOKEN=ghp_... SE_MODEL_CRED=sk-ant-... SE_MODEL_CRED_KIND=anthropic_api_key \
//   SE_REPO=gatewaze/gatewaze-modules SE_LABELLER=<your-gh-login> [SE_SITE_ID=<uuid>] \
//   node scripts/seed-brand.mjs
import { createClient } from '@supabase/supabase-js';
import { createCipheriv, randomBytes } from 'node:crypto';

const need = (k) => { const v = process.env[k]; if (!v) { console.error(`Missing env ${k}`); process.exit(1); } return v; };

function encryptSecret(plaintext) {
  const key = Buffer.from(need('GATEWAZE_SECRETS_KEY'), 'base64');
  if (key.length !== 32) { console.error('GATEWAZE_SECRETS_KEY must decode to 32 bytes'); process.exit(1); }
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return 'v1:' + Buffer.concat([nonce, enc, tag]).toString('base64');
}
const last4 = (s) => s.slice(-4);

const sb = createClient(need('SUPABASE_URL'), need('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } });

let siteId = process.env.SE_SITE_ID;
if (!siteId) {
  const { data: sites } = await sb.from('sites').select('id, name');
  if (!sites?.length) { console.error('No rows in public.sites — create a site (brand) first.'); process.exit(1); }
  if (sites.length > 1) { console.error('Multiple sites — set SE_SITE_ID to one of:\n' + sites.map((s) => `  ${s.id}  ${s.name}`).join('\n')); process.exit(1); }
  siteId = sites[0].id;
  console.log(`Using the only site: ${sites[0].name} (${siteId})`);
}

const ghTok = need('SE_GITHUB_TOKEN');
const modelCred = need('SE_MODEL_CRED');
const [owner, name] = need('SE_REPO').split('/');
if (!owner || !name) { console.error('SE_REPO must be owner/name'); process.exit(1); }

const gh = encryptSecret(ghTok);
const mc = encryptSecret(modelCred);

const { error: e1 } = await sb.from('se_brand_settings').upsert({
  site_id: siteId,
  github_token_ciphertext: gh, github_token_last4: last4(ghTok), github_token_kind: 'pat', github_health: 'unknown',
  model_cred_ciphertext: mc, model_cred_last4: last4(modelCred),
  model_cred_kind: process.env.SE_MODEL_CRED_KIND ?? 'anthropic_api_key',
  model: process.env.SE_MODEL ?? 'claude-opus-4-8', model_health: 'unknown',
  allowed_labellers: process.env.SE_LABELLER ? [process.env.SE_LABELLER] : [],
  intake_enabled: true,
  autonomy_mode: 'pr_only',
}, { onConflict: 'site_id' });
if (e1) { console.error('se_brand_settings upsert failed:', e1.message); process.exit(1); }

const { error: e2 } = await sb.from('se_repos').upsert(
  { site_id: siteId, repo_owner: owner, repo_name: name, enabled: true },
  { onConflict: 'repo_owner,repo_name' },
);
if (e2) { console.error('se_repos upsert failed:', e2.message); process.exit(1); }

console.log(`✓ Seeded brand ${siteId}: repo ${owner}/${name}, autonomy=pr_only, intake=enabled.`);
console.log('  Now create a real issue on that repo, then run simulate-webhook.sh with its number.');
