import { getApiBaseUrl } from '@/config/brands';

export interface EventHost {
  id: string;
  name: string;
  email?: string | null;
  avatar_url?: string | null;
  luma_user_id?: string | null;
  luma_profile_url?: string | null;
  bio?: string | null;
  company?: string | null;
  job_title?: string | null;
  linkedin_url?: string | null;
  twitter_url?: string | null;
  website_url?: string | null;
  source: string;
  outreach_status:
    | 'new'
    | 'enriching'
    | 'ready'
    | 'contacted'
    | 'responded'
    | 'interested'
    | 'converted'
    | 'declined'
    | 'ignored';
  outreach_notes?: string | null;
  contacted_at?: string | null;
  last_activity_at?: string | null;
  enrichment_tried_at?: string | null;
  created_at: string;
  updated_at: string;
  is_company?: boolean;
  event_count: number;
  latest_event_at?: string | null;
  latest_event_title?: string | null;
}

export interface HostEvent {
  source_event_id: string;
  gatewaze_event_id?: string | null;
  event_title: string;
  event_url?: string | null;
  event_start_at?: string | null;
  calendar_name?: string | null;
  role?: string | null;
}

const apiBase = () => getApiBaseUrl();

export const EventHostService = {
  async list(params: { search?: string; status?: string; limit?: number; offset?: number; includeCompanies?: boolean } = {}) {
    const qs = new URLSearchParams();
    if (params.search) qs.set('search', params.search);
    if (params.status) qs.set('status', params.status);
    if (params.limit !== undefined) qs.set('limit', String(params.limit));
    if (params.offset !== undefined) qs.set('offset', String(params.offset));
    if (params.includeCompanies) qs.set('include_companies', '1');

    const res = await fetch(`${apiBase()}/scrapers/hosts?${qs.toString()}`);
    const body = await res.json();
    if (!body.success) return { data: null, error: body.error };
    return { data: body.hosts as EventHost[], error: null };
  },

  async get(id: string) {
    const res = await fetch(`${apiBase()}/scrapers/hosts/${id}`);
    const body = await res.json();
    if (!body.success) return { data: null, error: body.error };
    return { data: { host: body.host as EventHost, events: body.events as HostEvent[] }, error: null };
  },

  async update(id: string, patch: Partial<EventHost>) {
    const res = await fetch(`${apiBase()}/scrapers/hosts/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    const body = await res.json();
    if (!body.success) return { data: null, error: body.error };
    return { data: body.host as EventHost, error: null };
  },

  exportCsvUrl(params: { search?: string; status?: string } = {}) {
    const qs = new URLSearchParams();
    if (params.search) qs.set('search', params.search);
    if (params.status) qs.set('status', params.status);
    return `${apiBase()}/scrapers/hosts/export.csv?${qs.toString()}`;
  },

  linkedinSearchUrl(host: EventHost) {
    const parts = [host.name, host.company].filter(Boolean).map((p) => `"${p}"`).join(' ');
    const q = encodeURIComponent(`${parts} site:linkedin.com/in`);
    return `https://www.google.com/search?q=${q}`;
  },
};
