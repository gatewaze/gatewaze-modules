import React, { useState, useEffect, useMemo } from 'react';
import { PlusIcon, XMarkIcon } from '@heroicons/react/24/outline';
import { Modal, Button, Tabs } from '@/components/ui';
import { Scraper } from '@/utils/scraperService';
import { AccountService } from '@/utils/accountService';
import { useEventTypes } from '@/hooks/useEventTypes';
import { useContentCategories } from '@/hooks/useContentCategories';

interface ScraperEditorModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (scraper: Partial<Scraper>) => Promise<void>;
  scraper?: Scraper | null;
}

// ---------------------------------------------------------------------------
// Scraper type registry — declarative schema per scraper type.
// Drives the dynamic form so the user never has to write JSON by hand.
// ---------------------------------------------------------------------------

type FieldType = 'text' | 'textarea' | 'url' | 'number' | 'boolean' | 'string-list' | 'keyword-list';

interface ConfigField {
  key: string;
  label: string;
  type: FieldType;
  required?: boolean;
  default?: any;
  placeholder?: string;
  helpText?: string;
  min?: number;
  max?: number;
}

interface ScraperTypeSpec {
  value: string;
  label: string;
  description: string;
  objectType: 'events' | 'jobs' | 'both';
  baseUrlLabel: string;
  baseUrlPlaceholder: string;
  baseUrlHelp?: string;
  requiresBaseUrl: boolean;
  configFields: ConfigField[];
}

// Single source of truth for Luma config fields. The slow + Fast variants
// share these so adding a new field to the slow scraper doesn't require
// remembering to touch the Fast variant. See spec §4.5.
const LUMA_ICAL_CONFIG_FIELDS: ConfigField[] = [
  { key: 'past', label: 'Include past events', type: 'boolean', default: true, helpText: 'If enabled, also ingest all past events (no age limit).' },
];

const LUMA_SEARCH_CONFIG_FIELDS: ConfigField[] = [
  { key: 'keywords', label: 'Search keywords', type: 'keyword-list', required: true, helpText: 'Search terms used to discover Luma calendars via Brave Search (max 10). Each keyword triggers one search. Note: these no longer post-filter ingested events — visibility is managed under Admin → Content Keywords.' },
  { key: 'maxResultsPerKeyword', label: 'Max results per keyword', type: 'number', default: 30, min: 10, max: 100, helpText: 'How many URLs to fetch per keyword (10-100).' },
  { key: 'freshness', label: 'Search freshness', type: 'text', placeholder: 'leave empty for all-time', helpText: 'Brave freshness filter: pd (past day), pw (past week), pm (past month), py (past year), or blank.' },
  { key: 'saveEvents', label: 'Save events as records', type: 'boolean', default: false, helpText: 'When on, each matching event page is also saved as an event record (with hosts + speakers extracted). When off, the scraper only discovers calendars and auto-creates child iCal scrapers — event records then come from those scrapers on their daily schedule.' },
  { key: 'includePastEvents', label: 'Include past events', type: 'boolean', default: true, helpText: 'When on (and "Save events as records" is enabled), also save events whose end time has already passed. Useful for backfilling historical events and their hosts. Also propagates to auto-created child iCal scrapers so they include past events too.' },
];

const LUMA_CATEGORY_CONFIG_FIELDS: ConfigField[] = [
  { key: 'maxScrolls', label: 'Max scroll iterations', type: 'number', default: 200, min: 1, max: 2000, helpText: 'Cap on infinite-scroll passes. Each pass loads the next batch.' },
  { key: 'scrollPauseMs', label: 'Scroll pause (ms)', type: 'number', default: 1500, min: 300, max: 10000, helpText: 'Wait between scrolls so Luma has time to load the next batch.' },
  { key: 'stableScrollChecks', label: 'Stable-height threshold', type: 'number', default: 3, min: 1, max: 20, helpText: 'Stop scrolling after N consecutive scrolls with no new content.' },
  { key: 'maxEventsPerRun', label: 'Max events per run', type: 'number', default: 500, min: 1, max: 5000, helpText: 'Cap on how many event pages to drill into per run (each contributes a calendar).' },
  { key: 'saveEvents', label: 'Save events as records', type: 'boolean', default: false, helpText: 'When on, also stream each event into the events table directly. When off, only the auto-created iCal scrapers will pull events on their daily schedule.' },
  { key: 'includePastEvents', label: 'Include past events', type: 'boolean', default: true, helpText: 'Propagated to auto-created child iCal scrapers (and to event saving when enabled).' },
];

const FAST_CONCURRENCY_FIELD: ConfigField = {
  key: 'fast_concurrency',
  label: 'Fast-path concurrency',
  type: 'number',
  default: 5,
  min: 1,
  max: 20,
  helpText: 'Number of event pages fetched in parallel via the scrapling-fetcher service. Higher = faster but more proxy bandwidth and risk of upstream rate-limiting.',
};

const SCRAPER_TYPE_SPECS: ScraperTypeSpec[] = [
  {
    value: 'LumaICalScraper',
    label: 'Luma iCal',
    description: 'Pulls events from a Luma calendar via its iCal feed. Best for continuously tracking a known community.',
    objectType: 'events',
    baseUrlLabel: 'Calendar URL',
    baseUrlPlaceholder: 'https://lu.ma/example-community',
    baseUrlHelp: 'The public URL of the Luma calendar (lu.ma/<slug>). The iCal feed will be resolved automatically.',
    requiresBaseUrl: true,
    configFields: LUMA_ICAL_CONFIG_FIELDS,
  },
  {
    value: 'LumaICalScraperFast',
    label: 'Luma iCal (Fast)',
    description: 'Same as Luma iCal but fetches event pages through the scrapling-fetcher service. ~10–20× faster on healthy calendars; falls back to the browser path automatically when the fast path fails.',
    objectType: 'events',
    baseUrlLabel: 'Calendar URL',
    baseUrlPlaceholder: 'https://lu.ma/example-community',
    baseUrlHelp: 'The public URL of the Luma calendar (lu.ma/<slug>). The iCal feed will be resolved automatically.',
    requiresBaseUrl: true,
    configFields: [...LUMA_ICAL_CONFIG_FIELDS, FAST_CONCURRENCY_FIELD],
  },
  {
    value: 'LumaSearchScraper',
    label: 'Luma Search',
    description: 'Discovers Luma calendars (communities) by searching for keywords via Brave Search, then auto-creates a LumaICalScraper for each one found.',
    objectType: 'events',
    baseUrlLabel: 'Base URL',
    baseUrlPlaceholder: 'https://lu.ma',
    baseUrlHelp: 'Fixed — the scraper targets lu.ma event URLs found via web search.',
    requiresBaseUrl: false,
    configFields: LUMA_SEARCH_CONFIG_FIELDS,
  },
  {
    value: 'LumaSearchScraperFast',
    label: 'Luma Search (Fast)',
    description: 'Same as Luma Search but fetches each candidate event page through the scrapling-fetcher service. Falls back to the browser path automatically when the fast path fails.',
    objectType: 'events',
    baseUrlLabel: 'Base URL',
    baseUrlPlaceholder: 'https://lu.ma',
    baseUrlHelp: 'Fixed — the scraper targets lu.ma event URLs found via web search.',
    requiresBaseUrl: false,
    configFields: [...LUMA_SEARCH_CONFIG_FIELDS, FAST_CONCURRENCY_FIELD],
  },
  {
    value: 'LumaEventsScraper',
    label: 'Luma Events (single URL)',
    description: 'Scrapes events from a specific Luma page (e.g. a themed landing page).',
    objectType: 'events',
    baseUrlLabel: 'Page URL',
    baseUrlPlaceholder: 'https://lu.ma/discover',
    requiresBaseUrl: true,
    configFields: [
      // Keyword filtering removed — managed centrally under Admin → Content Keywords.
    ],
  },
  {
    value: 'LumaCategoryScraper',
    label: 'Luma Category (infinite-scroll)',
    description: 'Scrapes a top-level Luma category page (e.g. https://luma.com/ai). Infinite-scrolls to discover all events, then for each event auto-creates a LumaICalScraper for the parent calendar — same as Luma Search but driven by a category instead of search terms.',
    objectType: 'events',
    baseUrlLabel: 'Category URL',
    baseUrlPlaceholder: 'https://luma.com/ai',
    baseUrlHelp: 'A Luma top-level category landing page (e.g. /ai, /startups, /design).',
    requiresBaseUrl: true,
    configFields: LUMA_CATEGORY_CONFIG_FIELDS,
  },
  {
    value: 'LumaCategoryScraperFast',
    label: 'Luma Category (Fast)',
    description: 'Same as Luma Category but the per-event-page fetches go through the scrapling-fetcher service. Infinite scroll still uses the browser. Falls back automatically when the fast path fails.',
    objectType: 'events',
    baseUrlLabel: 'Category URL',
    baseUrlPlaceholder: 'https://luma.com/ai',
    baseUrlHelp: 'A Luma top-level category landing page (e.g. /ai, /startups, /design).',
    requiresBaseUrl: true,
    configFields: [...LUMA_CATEGORY_CONFIG_FIELDS, FAST_CONCURRENCY_FIELD],
  },
  {
    value: 'DevEventsConferenceScraper',
    label: 'DevEvents (Conferences)',
    description: 'Scrapes conference listings from dev.events.',
    objectType: 'events',
    baseUrlLabel: 'Source URL',
    baseUrlPlaceholder: 'https://dev.events/',
    requiresBaseUrl: true,
    configFields: [
      // Keyword filtering removed — managed centrally under Admin → Content Keywords.
    ],
  },
  {
    value: 'LumaHostEnricher',
    label: 'Luma Host Enricher',
    description: 'Fills in missing company / LinkedIn / website fields on event hosts by visiting their Luma profile pages. Runs against existing event_hosts rows that still have gaps after Tier 0 extraction.',
    objectType: 'events',
    baseUrlLabel: 'Base URL',
    baseUrlPlaceholder: 'https://lu.ma',
    baseUrlHelp: 'Fixed — operates on event_hosts rows, not a specific page.',
    requiresBaseUrl: false,
    configFields: [
      { key: 'maxHosts', label: 'Max hosts per run', type: 'number', default: 50, min: 10, max: 200, helpText: 'Cap to keep a single run bounded (10–200).' },
      { key: 'retryAfterDays', label: 'Retry after (days)', type: 'number', default: 30, min: 1, max: 365, helpText: 'How long to wait before re-trying a host whose previous enrichment attempt yielded nothing.' },
      { key: 'onlyActiveHosts', label: 'Only active hosts', type: 'boolean', default: true, helpText: 'When on, only enrich hosts that are linked to at least one event. Prevents spending requests on rows nobody is asking about.' },
      { key: 'processHostEvents', label: 'Discover events from profile', type: 'boolean', default: true, helpText: 'When on, also pulls each host\'s past + upcoming events from their profile and ingests any not already in the events table.' },
      { key: 'maxEventsPerHost', label: 'Max events per host', type: 'number', default: 50, min: 1, max: 200, helpText: 'Cap on how many new events to ingest from one host per run.' },
      { key: 'eventsScanRetryDays', label: 'Re-scan events after (days)', type: 'number', default: 14, min: 1, max: 90, helpText: 'How long to wait before walking a host\'s profile again to refresh their event list.' },
    ],
  },
  {
    value: 'DevEventsMeetupScraper',
    label: 'DevEvents (Meetups)',
    description: 'Scrapes meetup listings from dev.events.',
    objectType: 'events',
    baseUrlLabel: 'Source URL',
    baseUrlPlaceholder: 'https://dev.events/meetups',
    requiresBaseUrl: true,
    configFields: [
      // Keyword filtering removed — managed centrally under Admin → Content Keywords.
    ],
  },
  {
    value: 'LinuxFoundationEventsScraper',
    label: 'Linux Foundation Events',
    description: 'Scrapes events.linuxfoundation.org. The base URL can carry the WordPress Search & Filter plugin\'s `?_sft_lfevent-category=…` (or `_sft_lfevent-tag=…`) query string to limit results to a specific LF event category — e.g. just EXAMPLE events. Each event\'s detail page is fetched through scrapling-fetcher to enrich venue address, region, full description, and cover image. Action-button URLs (Register / Sponsor / Schedule / Videos / Speak) are persisted into source_details.action_links for downstream features.',
    objectType: 'events',
    baseUrlLabel: 'Listing URL (with optional ?_sft_… filter)',
    baseUrlPlaceholder: 'https://events.linuxfoundation.org/?_sft_lfevent-category=agentic-ai-foundation-events',
    baseUrlHelp: 'The LF events listing page. Add a `?_sft_lfevent-category=<slug>` parameter to scope to one event category. Find the slug by browsing events.linuxfoundation.org → category filter → copy the URL.',
    requiresBaseUrl: true,
    configFields: [
      // The scraper currently has no per-instance config — listing URL
      // carries the filter, detail enrichment is always on. Add fields
      // here if we expose toggles like "skip detail enrichment" later.
    ],
  },
];

function getSpec(type: string): ScraperTypeSpec | undefined {
  return SCRAPER_TYPE_SPECS.find((s) => s.value === type);
}

// Postgres TIME columns round-trip as "HH:MM:SS"; <input type="time"> prefers
// "HH:MM" and some browsers refuse the seconds-bearing form.
function toHHMM(t?: string | null): string {
  if (!t) return '';
  const parts = String(t).split(':');
  if (parts.length < 2) return '';
  return `${parts[0].padStart(2, '0')}:${parts[1].padStart(2, '0')}`;
}

// Random time between 00:00 and 08:59 — matches the auto-discovery default so
// manually-created scrapers don't all stack up at 9am.
function randomPreMorningTime(): string {
  const h = Math.floor(Math.random() * 9);
  const m = Math.floor(Math.random() * 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Cron validation (kept from original)
// ---------------------------------------------------------------------------

function validateCron(cronExpression: string): { valid: boolean; error?: string } {
  if (!cronExpression || cronExpression.trim() === '') return { valid: false, error: 'Cron expression is required' };
  const parts = cronExpression.trim().split(/\s+/);
  if (parts.length !== 5 && parts.length !== 6) {
    return { valid: false, error: `Invalid format. Expected 5 or 6 parts, got ${parts.length}.` };
  }
  const validatePart = (part: string, min: number, max: number, name: string): string | null => {
    if (part === '*' || part === '?') return null;
    if (part.includes('/')) {
      const [range, step] = part.split('/');
      if (isNaN(Number(step)) || Number(step) <= 0) return `${name}: Invalid step value`;
      if (range !== '*' && !range.includes('-') && (isNaN(Number(range)) || Number(range) < min || Number(range) > max))
        return `${name}: Range value out of bounds (${min}-${max})`;
      return null;
    }
    if (part.includes('-')) {
      const [start, end] = part.split('-').map(Number);
      if (isNaN(start) || isNaN(end) || start < min || end > max || start > end) return `${name}: Invalid range (${min}-${max})`;
      return null;
    }
    if (part.includes(',')) {
      const values = part.split(',').map(Number);
      if (values.some((v) => isNaN(v) || v < min || v > max)) return `${name}: Invalid list values (${min}-${max})`;
      return null;
    }
    const value = Number(part);
    if (isNaN(value) || value < min || value > max) return `${name}: Value out of bounds (${min}-${max})`;
    return null;
  };
  const ranges = parts.length === 6
    ? [{ min: 0, max: 59, name: 'Second' }, { min: 0, max: 59, name: 'Minute' }, { min: 0, max: 23, name: 'Hour' }, { min: 1, max: 31, name: 'Day' }, { min: 1, max: 12, name: 'Month' }, { min: 0, max: 7, name: 'Weekday' }]
    : [{ min: 0, max: 59, name: 'Minute' }, { min: 0, max: 23, name: 'Hour' }, { min: 1, max: 31, name: 'Day' }, { min: 1, max: 12, name: 'Month' }, { min: 0, max: 7, name: 'Weekday' }];
  for (let i = 0; i < parts.length; i++) {
    const error = validatePart(parts[i], ranges[i].min, ranges[i].max, ranges[i].name);
    if (error) return { valid: false, error };
  }
  return { valid: true };
}

const inputClass = 'w-full px-3 py-1.5 border border-[var(--gray-a6)] rounded-md bg-[var(--color-surface)] text-sm focus:outline-none focus:ring-2 focus:ring-[var(--accent-8)]';

// ---------------------------------------------------------------------------
// Reusable keyword list field (used for titleFilters, keywords, etc.)
// ---------------------------------------------------------------------------

function KeywordListInput({ values, onChange, placeholder }: { values: string[]; onChange: (next: string[]) => void; placeholder?: string }) {
  const [draft, setDraft] = useState('');
  const add = () => {
    const v = draft.trim();
    if (v && !values.includes(v)) onChange([...values, v]);
    setDraft('');
  };
  return (
    <div className="space-y-2">
      {values.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {values.map((v, i) => (
            <span key={i} className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-[var(--gray-a3)] text-sm">
              {v}
              <button type="button" onClick={() => onChange(values.filter((_, j) => j !== i))} className="text-[var(--gray-9)] hover:text-red-500">
                <XMarkIcon className="h-3.5 w-3.5" />
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && draft.trim()) {
              e.preventDefault();
              add();
            }
          }}
          placeholder={placeholder || 'Type and press Enter...'}
          className={inputClass}
        />
        <button type="button" onClick={add} disabled={!draft.trim()} className="p-1.5 rounded text-[var(--accent-9)] hover:text-[var(--accent-11)] disabled:opacity-40">
          <PlusIcon className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main modal
// ---------------------------------------------------------------------------

export function ScraperEditorModal({ isOpen, onClose, onSave, scraper }: ScraperEditorModalProps) {
  const { eventTypes } = useEventTypes();
  const { contentCategories } = useContentCategories();
  const EVENT_TYPES = [...eventTypes.map((t) => t.value), 'mixed'];

  const [activeTab, setActiveTab] = useState<'basics' | 'config' | 'schedule' | 'advanced'>('basics');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [cronError, setCronError] = useState('');
  const [availableAccounts, setAvailableAccounts] = useState<Array<{ name: string; id: string }>>([]);

  // Step 1 state: only asks for scraper type upfront
  const [typeSelected, setTypeSelected] = useState(false);

  // Full form state. Note: timezone is NOT a scraper-level config — it's
  // auto-detected per event from the event source (e.g. Luma's timezone field).
  const [formData, setFormData] = useState({
    name: '',
    description: '',
    scraper_type: '',
    object_type: 'events' as 'events' | 'jobs',
    event_type: '',
    content_category: '',
    base_url: '',
    enabled: true,
    account: '',
    timeout_minutes: 30,
    alert_on_failure: true,
    default_publish_state: 'pending_review' as 'published' | 'pending_review',
    schedule_enabled: false,
    schedule_frequency: 'none' as 'none' | '5min' | 'hourly' | 'daily' | 'weekly' | 'custom',
    schedule_time: randomPreMorningTime(),
    schedule_days: [] as number[],
    schedule_cron: '',
  });

  // Per-field config values, dynamically built per scraper type
  const [configValues, setConfigValues] = useState<Record<string, any>>({});

  const currentSpec = useMemo(() => getSpec(formData.scraper_type), [formData.scraper_type]);

  // Load accounts once
  useEffect(() => {
    (async () => {
      const { accounts } = await AccountService.getActiveAccounts();
      if (accounts) setAvailableAccounts(accounts.map((a) => ({ name: a.name, id: a.id })));
    })();
  }, [isOpen]);

  // Initialise form from an existing scraper, or reset for a new one
  useEffect(() => {
    if (!isOpen) return;
    if (scraper) {
      const cfg = (scraper.config as Record<string, any>) || {};
      setFormData({
        name: scraper.name || '',
        description: scraper.description || '',
        scraper_type: scraper.scraper_type || '',
        object_type: scraper.object_type || 'events',
        event_type: scraper.event_type || '',
        content_category: scraper.content_category || '',
        base_url: scraper.base_url || '',
        enabled: scraper.enabled ?? true,
        account: (scraper as any).account || cfg.account || '',
        timeout_minutes: (scraper as any).timeout_minutes ?? 30,
        alert_on_failure: (scraper as any).alert_on_failure ?? true,
        default_publish_state: ((scraper as any).default_publish_state ?? 'pending_review') as 'published' | 'pending_review',
        schedule_enabled: scraper.schedule_enabled || false,
        schedule_frequency: scraper.schedule_frequency || 'none',
        schedule_time: toHHMM(scraper.schedule_time) || randomPreMorningTime(),
        schedule_days: scraper.schedule_days || [],
        schedule_cron: scraper.schedule_cron || '',
      });
      // Extract the per-type config values
      const spec = getSpec(scraper.scraper_type || '');
      const cfgVals: Record<string, any> = {};
      if (spec) {
        for (const field of spec.configFields) {
          if (cfg[field.key] !== undefined) cfgVals[field.key] = cfg[field.key];
          else if (field.default !== undefined) cfgVals[field.key] = field.default;
        }
      }
      setConfigValues(cfgVals);
      setTypeSelected(true);
    } else {
      setFormData({
        name: '', description: '', scraper_type: '', object_type: 'events',
        event_type: '', content_category: '', base_url: '', enabled: true,
        account: '', timeout_minutes: 30, alert_on_failure: true, default_publish_state: 'pending_review',
        schedule_enabled: false, schedule_frequency: 'none', schedule_time: randomPreMorningTime(),
        schedule_days: [], schedule_cron: '',
      });
      setConfigValues({});
      setTypeSelected(false);
    }
    setActiveTab('basics');
    setError('');
    setCronError('');
  }, [scraper, isOpen]);

  // When scraper type changes, reset config values to their defaults
  const selectScraperType = (type: string) => {
    const spec = getSpec(type);
    if (!spec) return;
    const defaults: Record<string, any> = {};
    if (spec.configFields) {
      for (const f of spec.configFields) {
        if (f.default !== undefined) defaults[f.key] = f.default;
      }
    }
    setFormData((prev) => ({
      ...prev,
      scraper_type: type,
      object_type: spec.objectType === 'both' ? prev.object_type : (spec.objectType as 'events' | 'jobs'),
    }));
    setConfigValues(defaults);
    setTypeSelected(true);
  };

  const setConfigValue = (key: string, value: any) => {
    setConfigValues((prev) => ({ ...prev, [key]: value }));
  };

  const handleSubmit = async () => {
    setError('');
    setSaving(true);

    try {
      if (!formData.scraper_type) {
        setError('Please select a scraper type');
        setActiveTab('basics');
        setSaving(false);
        return;
      }
      if (!formData.name.trim()) {
        setError('Name is required');
        setActiveTab('basics');
        setSaving(false);
        return;
      }
      if (currentSpec?.requiresBaseUrl && !formData.base_url.trim()) {
        setError(`${currentSpec.baseUrlLabel} is required for ${currentSpec.label}`);
        setActiveTab('basics');
        setSaving(false);
        return;
      }

      // Validate per-type required config fields
      if (currentSpec) {
        for (const field of currentSpec.configFields) {
          if (!field.required) continue;
          const v = configValues[field.key];
          const empty = v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
          if (empty) {
            setError(`${field.label} is required for ${currentSpec.label}`);
            setActiveTab('config');
            setSaving(false);
            return;
          }
        }
      }

      if (formData.schedule_enabled && formData.schedule_frequency === 'custom') {
        const validation = validateCron(formData.schedule_cron);
        if (!validation.valid) {
          setError(validation.error || 'Invalid cron expression');
          setCronError(validation.error || 'Invalid cron expression');
          setActiveTab('schedule');
          setSaving(false);
          return;
        }
      }

      // Build the final config object from the per-type fields.
      // Timezone is deliberately NOT written — scrapers determine it per event
      // from source-native metadata (Luma's timezone field, iCal TZID, etc.).
      const cleanedConfig: Record<string, any> = {};
      for (const [k, v] of Object.entries(configValues)) {
        if (v === undefined || v === null || v === '') continue;
        if (Array.isArray(v) && v.length === 0) continue;
        cleanedConfig[k] = v;
      }
      if (formData.account) cleanedConfig.account = formData.account;

      const scraperData: Partial<Scraper> = {
        name: formData.name,
        description: formData.description,
        scraper_type: formData.scraper_type,
        object_type: formData.object_type,
        event_type: formData.event_type,
        content_category: formData.content_category || null,
        // URL-less scraper types (requiresBaseUrl=false) always persist NULL —
        // the partial-unique index on base_url only applies to NOT NULL rows,
        // so multiple Search / Host Enricher scrapers can coexist.
        base_url: currentSpec?.requiresBaseUrl ? formData.base_url : (null as any),
        enabled: formData.enabled,
        account: formData.account || undefined,
        timeout_minutes: formData.timeout_minutes,
        alert_on_failure: formData.alert_on_failure,
        // default_publish_state (migration 017) replaces the deprecated triage_mode.
        // The scraper handler reads this first and only falls back to triage_mode
        // if this column is null — since the column is NOT NULL, always send it.
        default_publish_state: formData.default_publish_state,
        config: cleanedConfig,
        schedule_enabled: formData.schedule_enabled,
        schedule_frequency: formData.schedule_frequency,
        schedule_time: formData.schedule_time,
        schedule_days: formData.schedule_days.length > 0 ? formData.schedule_days : undefined,
        schedule_cron: formData.schedule_cron || undefined,
      };

      await onSave(scraperData);
      onClose();
    } catch (err: any) {
      setError(err.message || 'Failed to save scraper');
    } finally {
      setSaving(false);
    }
  };

  // Type-selection step (only for new scrapers)
  if (!typeSelected && !scraper) {
    return (
      <Modal
        isOpen={isOpen}
        onClose={onClose}
        title="Create New Scraper"
        size="xl"
        footer={
          <div className="flex justify-end">
            <Button variant="outline" onClick={onClose}>
              Cancel
            </Button>
          </div>
        }
      >
        <div className="space-y-3">
          <p className="text-sm text-[var(--gray-11)]">Pick a scraper type to get started:</p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {SCRAPER_TYPE_SPECS.map((spec) => (
              <button
                key={spec.value}
                type="button"
                onClick={() => selectScraperType(spec.value)}
                className="text-left p-4 border border-[var(--gray-a6)] rounded-lg hover:border-[var(--accent-8)] hover:bg-[var(--accent-a2)] transition"
              >
                <div className="font-semibold text-[var(--gray-12)]">{spec.label}</div>
                <div className="text-xs text-[var(--gray-10)] mt-1">{spec.description}</div>
              </button>
            ))}
          </div>
        </div>
      </Modal>
    );
  }

  const tabs = [
    { id: 'basics', label: 'Basics' },
    { id: 'config', label: 'Configuration' },
    { id: 'schedule', label: 'Schedule' },
    { id: 'advanced', label: 'Advanced' },
  ];

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={scraper ? `Edit Scraper: ${scraper.name}` : `New ${currentSpec?.label || 'Scraper'}`}
      size="xl"
      footer={
        <div className="flex items-center justify-between w-full">
          <div>
            {!scraper && (
              <Button variant="outline" onClick={() => setTypeSelected(false)}>
                ← Change type
              </Button>
            )}
          </div>
          <div className="flex gap-3">
            <Button variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="solid" onClick={handleSubmit} disabled={saving}>
              {saving ? 'Saving...' : scraper ? 'Update Scraper' : 'Create Scraper'}
            </Button>
          </div>
        </div>
      }
    >
      <div className="space-y-3">
        {error && (
          <div className="p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg text-red-600 dark:text-red-400 text-sm">
            {error}
          </div>
        )}

        <Tabs value={activeTab} onChange={(t) => setActiveTab(t as any)} tabs={tabs} />

        {activeTab === 'basics' && (
          <div className="space-y-3 pt-2">
            {currentSpec && (
              <div className="p-3 bg-[var(--gray-a2)] rounded-md text-xs text-[var(--gray-11)]">
                <span className="font-medium text-[var(--gray-12)]">{currentSpec.label}</span> — {currentSpec.description}
              </div>
            )}

            <div>
              <label className="block text-sm font-medium text-[var(--gray-11)] mb-1">Name *</label>
              <input type="text" required value={formData.name} onChange={(e) => setFormData({ ...formData, name: e.target.value })} className={inputClass} placeholder="e.g. Luma Search: AI Agents" />
            </div>

            <div>
              <label className="block text-sm font-medium text-[var(--gray-11)] mb-1">Description</label>
              <input type="text" value={formData.description} onChange={(e) => setFormData({ ...formData, description: e.target.value })} className={inputClass} placeholder="What does this scraper do?" />
            </div>

            {currentSpec?.requiresBaseUrl && (
              <div>
                <label className="block text-sm font-medium text-[var(--gray-11)] mb-1">{currentSpec.baseUrlLabel} *</label>
                <input type="url" required value={formData.base_url} onChange={(e) => setFormData({ ...formData, base_url: e.target.value })} placeholder={currentSpec.baseUrlPlaceholder} className={inputClass} />
                {currentSpec.baseUrlHelp && <p className="text-xs text-[var(--gray-9)] mt-1">{currentSpec.baseUrlHelp}</p>}
              </div>
            )}

            <div className="grid grid-cols-2 gap-3">
              {currentSpec?.objectType === 'both' && (
                <div>
                  <label className="block text-sm font-medium text-[var(--gray-11)] mb-1">Object Type *</label>
                  <select value={formData.object_type} onChange={(e) => setFormData({ ...formData, object_type: e.target.value as 'events' | 'jobs' })} className={inputClass}>
                    <option value="events">Events</option>
                    <option value="jobs">Jobs</option>
                  </select>
                </div>
              )}
              <div>
                <label className="block text-sm font-medium text-[var(--gray-11)] mb-1">
                  {formData.object_type === 'events' ? 'Event Type *' : 'Category *'}
                </label>
                <select required value={formData.event_type} onChange={(e) => setFormData({ ...formData, event_type: e.target.value })} className={inputClass}>
                  <option value="">Select...</option>
                  {EVENT_TYPES.map((type) => (
                    <option key={type} value={type}>
                      {type}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-[var(--gray-11)] mb-1">Content Category</label>
                <select value={formData.content_category} onChange={(e) => setFormData({ ...formData, content_category: e.target.value })} className={inputClass}>
                  <option value="">No category</option>
                  {contentCategories.map((c) => (
                    <option key={c.value} value={c.value}>
                      {c.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-[var(--gray-11)] mb-1">Account <span className="text-xs text-[var(--gray-9)]">(Optional)</span></label>
              <select value={formData.account} onChange={(e) => setFormData({ ...formData, account: e.target.value })} className={inputClass}>
                <option value="">None</option>
                {availableAccounts.map((a) => (
                  <option key={a.id} value={a.name}>
                    {a.name}
                  </option>
                ))}
              </select>
              <p className="text-xs text-[var(--gray-9)] mt-1">Timezone is detected automatically per event from the source (e.g. Luma's timezone field, iCal TZID).</p>
            </div>

            <label className="flex items-center gap-2 text-sm font-medium text-[var(--gray-11)] pt-1">
              <input type="checkbox" checked={formData.enabled} onChange={(e) => setFormData({ ...formData, enabled: e.target.checked })} className="rounded" />
              Scraper enabled
            </label>
          </div>
        )}

        {activeTab === 'config' && (
          <div className="space-y-4 pt-2">
            {!currentSpec?.configFields.length && (
              <p className="text-sm text-[var(--gray-10)]">This scraper type has no type-specific configuration.</p>
            )}
            {currentSpec?.configFields.map((field) => (
              <div key={field.key}>
                <label className="block text-sm font-medium text-[var(--gray-11)] mb-1">
                  {field.label} {field.required && <span className="text-red-500">*</span>}
                </label>
                {field.type === 'text' && (
                  <input
                    type="text"
                    value={configValues[field.key] || ''}
                    onChange={(e) => setConfigValue(field.key, e.target.value)}
                    placeholder={field.placeholder}
                    className={inputClass}
                  />
                )}
                {field.type === 'url' && (
                  <input
                    type="url"
                    value={configValues[field.key] || ''}
                    onChange={(e) => setConfigValue(field.key, e.target.value)}
                    placeholder={field.placeholder}
                    className={inputClass}
                  />
                )}
                {field.type === 'textarea' && (
                  <textarea
                    value={configValues[field.key] || ''}
                    onChange={(e) => setConfigValue(field.key, e.target.value)}
                    placeholder={field.placeholder}
                    rows={4}
                    className={inputClass}
                  />
                )}
                {field.type === 'number' && (
                  <input
                    type="number"
                    value={configValues[field.key] ?? field.default ?? ''}
                    onChange={(e) => setConfigValue(field.key, e.target.value === '' ? undefined : Number(e.target.value))}
                    min={field.min}
                    max={field.max}
                    className={inputClass}
                  />
                )}
                {field.type === 'boolean' && (
                  <label className="flex items-center gap-2 text-sm font-medium text-[var(--gray-11)]">
                    <input
                      type="checkbox"
                      checked={configValues[field.key] ?? field.default ?? false}
                      onChange={(e) => setConfigValue(field.key, e.target.checked)}
                      className="rounded"
                    />
                    {field.placeholder || 'Enabled'}
                  </label>
                )}
                {field.type === 'keyword-list' && (
                  <KeywordListInput
                    values={Array.isArray(configValues[field.key]) ? configValues[field.key] : []}
                    onChange={(vals) => setConfigValue(field.key, vals)}
                    placeholder={field.placeholder}
                  />
                )}
                {field.helpText && <p className="text-xs text-[var(--gray-9)] mt-1">{field.helpText}</p>}
              </div>
            ))}
          </div>
        )}

        {activeTab === 'schedule' && (
          <div className="space-y-3 pt-2">
            <label className="flex items-center gap-2 text-sm font-medium text-[var(--gray-11)]">
              <input type="checkbox" checked={formData.schedule_enabled} onChange={(e) => setFormData({ ...formData, schedule_enabled: e.target.checked })} className="rounded" />
              Enable automatic scheduling
            </label>

            {formData.schedule_enabled && (
              <div className="space-y-3">
                <div>
                  <label className="block text-sm font-medium text-[var(--gray-11)] mb-1">Frequency</label>
                  <select value={formData.schedule_frequency} onChange={(e) => setFormData({ ...formData, schedule_frequency: e.target.value as any })} className={inputClass}>
                    <option value="none">Manual only</option>
                    <option value="5min">Every 5 minutes</option>
                    <option value="hourly">Hourly</option>
                    <option value="daily">Daily</option>
                    <option value="weekly">Weekly</option>
                    <option value="custom">Custom (cron)</option>
                  </select>
                </div>

                {(formData.schedule_frequency === 'daily' || formData.schedule_frequency === 'weekly') && (
                  <div>
                    <label className="block text-sm font-medium text-[var(--gray-11)] mb-1">Time of day</label>
                    <input type="time" value={formData.schedule_time} onChange={(e) => setFormData({ ...formData, schedule_time: e.target.value })} className={inputClass} />
                  </div>
                )}

                {formData.schedule_frequency === 'weekly' && (
                  <div>
                    <label className="block text-sm font-medium text-[var(--gray-11)] mb-1">Days of week</label>
                    <div className="flex gap-2 flex-wrap">
                      {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((day, index) => (
                        <label key={index} className="flex items-center gap-1 text-sm text-[var(--gray-11)]">
                          <input
                            type="checkbox"
                            checked={formData.schedule_days.includes(index)}
                            onChange={(e) => {
                              const days = e.target.checked
                                ? [...formData.schedule_days, index]
                                : formData.schedule_days.filter((d) => d !== index);
                              setFormData({ ...formData, schedule_days: days.sort() });
                            }}
                            className="rounded"
                          />
                          {day}
                        </label>
                      ))}
                    </div>
                  </div>
                )}

                {formData.schedule_frequency === 'custom' && (
                  <div>
                    <label className="block text-sm font-medium text-[var(--gray-11)] mb-1">Cron expression</label>
                    <input
                      type="text"
                      value={formData.schedule_cron}
                      onChange={(e) => {
                        setFormData({ ...formData, schedule_cron: e.target.value });
                        if (e.target.value.trim()) {
                          const v = validateCron(e.target.value);
                          setCronError(v.valid ? '' : v.error || 'Invalid');
                        } else setCronError('');
                      }}
                      placeholder="*/5 * * * *"
                      className={`${inputClass} font-mono ${cronError ? '!border-red-500' : ''}`}
                    />
                    {cronError && <p className="text-xs text-red-600 mt-1">{cronError}</p>}
                    <p className="text-xs text-[var(--gray-9)] mt-1">
                      Format: minute hour day month weekday.{' '}
                      <a href="https://crontab.guru" target="_blank" rel="noopener noreferrer" className="underline">
                        Help
                      </a>
                    </p>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {activeTab === 'advanced' && (
          <div className="space-y-3 pt-2">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium text-[var(--gray-11)] mb-1">Timeout (minutes)</label>
                <input
                  type="number"
                  min={5}
                  max={120}
                  value={formData.timeout_minutes}
                  onChange={(e) => setFormData({ ...formData, timeout_minutes: parseInt(e.target.value) || 30 })}
                  className={inputClass}
                />
                <p className="text-xs text-[var(--gray-9)] mt-1">Max time a single job can run before it's marked failed.</p>
              </div>
              <div className="flex items-end pb-1">
                <label className="flex items-center gap-2 text-sm font-medium text-[var(--gray-11)]">
                  <input type="checkbox" checked={formData.alert_on_failure} onChange={(e) => setFormData({ ...formData, alert_on_failure: e.target.checked })} className="rounded" />
                  Alert on failure
                </label>
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-[var(--gray-11)] mb-1">Default publish state</label>
              <select
                value={formData.default_publish_state}
                onChange={(e) => setFormData({ ...formData, default_publish_state: e.target.value as 'published' | 'pending_review' })}
                className={inputClass}
              >
                <option value="published">published — content goes live immediately (auto-publish)</option>
                <option value="pending_review">pending_review — content enters the review queue before going live</option>
              </select>
              <p className="text-xs text-[var(--gray-9)] mt-1">
                Initial publish_state for events created by this scraper. See spec-content-publishing-pipeline §5.2.
              </p>
            </div>

            <div>
              <p className="text-xs text-[var(--gray-9)]">
                Current scraper type: <code className="bg-[var(--gray-a3)] px-1 rounded">{formData.scraper_type}</code>
              </p>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
