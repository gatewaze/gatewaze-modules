// @ts-nocheck — supabase-js types are resolved at module-host install time.
/**
 * Shared runtime helpers: the service-role client and module config.
 *
 * The API server hands modules a ModuleRuntimeContext whose `supabase` field is
 * null (packages/api/src/server.ts), and workers get no context at all, so both
 * sides build their own client from env. Config is read from
 * installed_modules.config rather than ctx.moduleConfig for the same reason —
 * a worker has no other way to see it, and reading it from one place keeps the
 * API and worker views identical.
 */

import { createClient } from '@supabase/supabase-js';
import { DEFAULT_TIMEZONE_DISTRIBUTION } from './identity';

export const MODULE_ID = 'send-testing';

/** Seeded by migration 001. Stable across installs so the CSV export, the
 *  senders' list pickers, and the add-on all agree on one list. */
export const SEND_TESTING_LIST_ID = '5e4d0000-0000-0000-0000-000000000001';
export const SEND_TESTING_LIST_SLUG = 'send-testing';

export const PROVISION_CHUNK_SIZE = 500;

let _service: ReturnType<typeof createClient> | null = null;

export function serviceClient() {
  if (_service) return _service;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('send-testing: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set');
  }
  _service = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  return _service;
}

export interface SendTestingConfig {
  inboundDomain: string;
  inboundToken: string;
  defaultPopulationSize: number;
  timezoneDistribution: Record<string, number>;
  inspectableCount: number;
  postmasterUrl: string;
  sndsUrl: string;
}

const DEFAULTS: SendTestingConfig = {
  inboundDomain: '',
  inboundToken: '',
  defaultPopulationSize: 25000,
  timezoneDistribution: DEFAULT_TIMEZONE_DISTRIBUTION,
  inspectableCount: 20,
  postmasterUrl: '',
  sndsUrl: '',
};

function parseDistribution(raw: unknown): Record<string, number> {
  if (!raw) return DEFAULT_TIMEZONE_DISTRIBUTION;
  let value = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      // A malformed override silently falling back would make the delivery-wave
      // chart lie about what was tested, so refuse it loudly instead.
      throw new Error('send-testing: timezone_distribution is not valid JSON');
    }
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('send-testing: timezone_distribution must be an object of zone → weight');
  }
  const out: Record<string, number> = {};
  for (const [zone, weight] of Object.entries(value as Record<string, unknown>)) {
    const n = Number(weight);
    if (!Number.isFinite(n) || n < 0) {
      throw new Error(`send-testing: invalid weight for timezone ${zone}`);
    }
    out[zone] = n;
  }
  if (Object.keys(out).length === 0) return DEFAULT_TIMEZONE_DISTRIBUTION;
  return out;
}

export async function loadConfig(supabase = serviceClient()): Promise<SendTestingConfig> {
  const { data } = await supabase
    .from('installed_modules')
    .select('config')
    .eq('id', MODULE_ID)
    .maybeSingle();

  const raw = (data?.config ?? {}) as Record<string, unknown>;
  return {
    inboundDomain: String(raw.inbound_domain ?? DEFAULTS.inboundDomain).trim().toLowerCase(),
    inboundToken: String(raw.inbound_token ?? DEFAULTS.inboundToken).trim(),
    defaultPopulationSize: Number(raw.default_population_size ?? DEFAULTS.defaultPopulationSize),
    timezoneDistribution: parseDistribution(raw.timezone_distribution),
    inspectableCount: Number(raw.inspectable_count ?? DEFAULTS.inspectableCount),
    postmasterUrl: String(raw.postmaster_url ?? DEFAULTS.postmasterUrl),
    sndsUrl: String(raw.snds_url ?? DEFAULTS.sndsUrl),
  };
}

/** The domain gates every write, so an unconfigured install must fail closed
 *  rather than provision people at a domain nobody owns. */
export function assertInboundDomain(config: SendTestingConfig): string {
  const domain = config.inboundDomain;
  if (!domain || !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(domain)) {
    throw new Error(
      'send-testing: inbound_domain is not configured. Set it in the module config before provisioning.',
    );
  }
  return domain;
}
