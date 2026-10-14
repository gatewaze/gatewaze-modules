/**
 * Outside services that hold copies of a person's data. Each adapter takes
 * the identifiers resolved before the database erasure and reports what it
 * did. Credentials come from the same environment variables the owning
 * integration modules use; a missing credential makes the step manual
 * rather than failing.
 *
 * No third-party imports: global fetch only.
 */

export type ProcessorStatus = 'erased' | 'not_found' | 'manual' | 'failed' | 'skipped';

export interface ProcessorResult {
  id: string;
  name: string;
  status: ProcessorStatus;
  detail?: string;
  at: string;
}

export interface Identifiers {
  emails: string[];
  person_ids: string[];
  auth_user_ids: string[];
  cio_ids: string[];
  slack_user_ids: string[];
}

export interface ChecklistItem {
  id: string;
  title: string;
  detail?: string;
  done: boolean;
  done_by?: string | null;
  done_at?: string | null;
}

type Fetch = typeof fetch;
type Env = Record<string, string | undefined>;

const now = () => new Date().toISOString();
const TIMEOUT_MS = 20_000;

async function call(f: Fetch, url: string, init: RequestInit): Promise<Response> {
  return f(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
}

/**
 * Customer.io: suppress each identifier. Suppression deletes the profile and
 * stops Customer.io accepting it again, which covers erasure and the
 * marketing objection together.
 */
export async function customerio(ids: Identifiers, env: Env, f: Fetch = fetch): Promise<ProcessorResult> {
  const base = { id: 'customerio', name: 'Customer.io' };
  const site = env.CUSTOMERIO_SITE_ID;
  const key = env.CUSTOMERIO_API_KEY;
  if (!site || !key) {
    return { ...base, status: 'skipped', detail: 'Customer.io is not configured on this instance.', at: now() };
  }
  const host = env.CUSTOMERIO_REGION === 'eu' ? 'https://track-eu.customer.io' : 'https://track.customer.io';
  const auth = 'Basic ' + Buffer.from(`${site}:${key}`).toString('base64');
  const targets = [...ids.cio_ids.map((c) => `cio_${c}`), ...ids.emails];
  let done = 0;
  const failures: string[] = [];
  for (const t of targets) {
    try {
      const res = await call(f, `${host}/api/v1/customers/${encodeURIComponent(t)}/suppress`, {
        method: 'POST',
        headers: { Authorization: auth },
      });
      if (res.ok || res.status === 404) done++;
      else failures.push(`HTTP ${res.status}`);
    } catch (e) {
      failures.push((e as Error).message);
    }
  }
  if (failures.length) {
    return { ...base, status: 'failed', detail: `${done} of ${targets.length} identifiers suppressed; errors: ${[...new Set(failures)].join(', ')}`, at: now() };
  }
  return { ...base, status: 'erased', detail: `Suppressed and deleted ${targets.length} identifier(s).`, at: now() };
}

/**
 * SendGrid: add every address to the global unsubscribe list (suppression,
 * which may persist), then delete any Marketing Campaigns contacts.
 */
export async function sendgrid(ids: Identifiers, env: Env, f: Fetch = fetch): Promise<ProcessorResult> {
  const base = { id: 'sendgrid', name: 'SendGrid' };
  const key = env.SENDGRID_API_KEY;
  if (!key) return { ...base, status: 'skipped', detail: 'SendGrid is not configured on this instance.', at: now() };
  const headers = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
  const notes: string[] = [];
  try {
    const res = await call(f, 'https://api.sendgrid.com/v3/asm/suppressions/global', {
      method: 'POST',
      headers,
      body: JSON.stringify({ recipient_emails: ids.emails }),
    });
    if (!res.ok) return { ...base, status: 'failed', detail: `global unsubscribe failed: HTTP ${res.status}`, at: now() };
    notes.push('Added to the global unsubscribe list.');

    const search = await call(f, 'https://api.sendgrid.com/v3/marketing/contacts/search/emails', {
      method: 'POST',
      headers,
      body: JSON.stringify({ emails: ids.emails }),
    });
    if (search.status === 404) {
      notes.push('No Marketing Campaigns contacts.');
    } else if (search.status === 401 || search.status === 403) {
      return { ...base, status: 'manual', detail: `${notes.join(' ')} The API key cannot read Marketing Campaigns contacts; check for and delete any contact by hand.`, at: now() };
    } else if (!search.ok) {
      return { ...base, status: 'failed', detail: `${notes.join(' ')} Contact search failed: HTTP ${search.status}`, at: now() };
    } else {
      const body = (await search.json()) as { result?: Record<string, { contact?: { id?: string } }> };
      const contactIds = Object.values(body.result ?? {}).map((r) => r.contact?.id).filter((v): v is string => !!v);
      if (contactIds.length) {
        const del = await call(f, `https://api.sendgrid.com/v3/marketing/contacts?ids=${contactIds.map(encodeURIComponent).join(',')}`, {
          method: 'DELETE',
          headers,
        });
        if (!del.ok) return { ...base, status: 'failed', detail: `${notes.join(' ')} Contact delete failed: HTTP ${del.status}`, at: now() };
        notes.push(`Deleted ${contactIds.length} Marketing Campaigns contact(s).`);
      } else {
        notes.push('No Marketing Campaigns contacts.');
      }
    }
  } catch (e) {
    return { ...base, status: 'failed', detail: (e as Error).message, at: now() };
  }
  return { ...base, status: 'erased', detail: notes.join(' '), at: now() };
}

/**
 * Segment: deletion needs a Public API token, which Gatewaze doesn't hold.
 * Reported as a manual step with what to enter.
 */
export function segment(ids: Identifiers, env: Env): ProcessorResult | null {
  if (!env.SEGMENT_WRITE_KEY) return null;
  return {
    id: 'segment',
    name: 'Segment',
    status: 'manual',
    detail: `Create a "Delete and suppress" request in Segment (Privacy > Deletion requests) for userId ${ids.auth_user_ids.length ? ids.auth_user_ids.join(', ') : '(none: the person never signed in)'} and the request emails.`,
    at: now(),
  };
}

export async function runProcessors(ids: Identifiers, env: Env, f: Fetch = fetch): Promise<ProcessorResult[]> {
  const out: ProcessorResult[] = [];
  out.push(await customerio(ids, env, f));
  out.push(await sendgrid(ids, env, f));
  const seg = segment(ids, env);
  if (seg) out.push(seg);
  return out;
}

/** Manual steps that follow from what the plan found. */
export function buildChecklist(
  plan: { tables?: Array<{ table: string; rows: number }> } | null,
  ids: Identifiers,
  processors: ProcessorResult[],
): ChecklistItem[] {
  const tables = new Set((plan?.tables ?? []).map((t) => t.table));
  const items: ChecklistItem[] = [];
  const add = (id: string, title: string, detail?: string) => items.push({ id, title, detail, done: false });

  if ([...tables].some((t) => t.startsWith('integrations_luma_'))) {
    add('luma', 'Remove the person from Luma', 'They registered through Luma. Remove them from the calendar and the events they registered for in Luma itself.');
  }
  if ([...tables].some((t) => t.startsWith('integrations_gradual_'))) {
    add('gradual', 'Remove the person from Gradual', 'They registered through Gradual. Ask Gradual to delete the member record.');
  }
  if (ids.slack_user_ids.length) {
    add('slack', 'Deactivate the Slack account', `Slack user ${ids.slack_user_ids.join(', ')}. Deactivate them in the workspace admin; message history is governed by the workspace retention settings.`);
  }
  if ([...tables].some((t) => t.startsWith('payments_stripe_'))) {
    add('stripe', 'Check Stripe', 'Payment records are kept for the legal retention period. Confirm no marketing data is held on the Stripe customer.');
  }
  for (const p of processors) {
    if (p.status === 'manual') add(`processor:${p.id}`, `Complete the ${p.name} deletion`, p.detail);
  }
  return items;
}

/** Done when every automatic processor finished and every manual step is ticked. */
export function isComplete(processors: ProcessorResult[], checklist: ChecklistItem[]): boolean {
  const procOk = processors.every((p) => p.status === 'erased' || p.status === 'not_found' || p.status === 'skipped' || p.status === 'manual');
  return procOk && checklist.every((c) => c.done);
}
