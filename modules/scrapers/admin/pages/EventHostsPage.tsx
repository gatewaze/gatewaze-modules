import { useState, useEffect, useCallback, useMemo } from 'react';
import { ArrowDownTrayIcon, ArrowTopRightOnSquareIcon } from '@heroicons/react/24/outline';
import { Badge, Button, Card, Table, THead, TBody, Tr, Th, Td, Tabs } from '@/components/ui';
import { SideDrawer } from '@/components/shared/SideDrawer';
import { EventHostService, EventHost, HostEvent } from '@/utils/eventHostService';
import { getApiBaseUrl } from '@/config/brands';
import { MapContainer, TileLayer, CircleMarker, Tooltip, Popup } from 'react-leaflet';
// NOTE: leaflet CSS is loaded globally by the core admin (src/main.tsx). We
// don't re-import here because the `leaflet` package lives in core's node_modules,
// not this module's — direct import would break Vite module resolution.

const STATUS_OPTIONS: Array<{ value: EventHost['outreach_status']; label: string; color: string }> = [
  { value: 'new', label: 'New', color: 'gray' },
  { value: 'enriching', label: 'Enriching', color: 'blue' },
  { value: 'ready', label: 'Ready', color: 'cyan' },
  { value: 'contacted', label: 'Contacted', color: 'amber' },
  { value: 'responded', label: 'Responded', color: 'purple' },
  { value: 'interested', label: 'Interested', color: 'green' },
  { value: 'converted', label: 'Converted', color: 'emerald' },
  { value: 'declined', label: 'Declined', color: 'red' },
  { value: 'ignored', label: 'Ignored', color: 'gray' },
];

const inputClass =
  'w-full px-3 py-1.5 border border-[var(--gray-a6)] rounded-md bg-[var(--color-surface)] text-sm focus:outline-none focus:ring-2 focus:ring-[var(--accent-8)]';

type Tab = 'outreach' | 'leaderboard' | 'map';

export default function EventHostsPage() {
  const [activeTab, setActiveTab] = useState<Tab>('outreach');
  const [hosts, setHosts] = useState<EventHost[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [includeCompanies, setIncludeCompanies] = useState(false);
  const [selectedHostId, setSelectedHostId] = useState<string | null>(null);
  const [selectedHost, setSelectedHost] = useState<EventHost | null>(null);
  const [selectedEvents, setSelectedEvents] = useState<HostEvent[]>([]);
  const [drawerLoading, setDrawerLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const { data } = await EventHostService.list({
      search: search || undefined,
      status: statusFilter || undefined,
      limit: 200,
      includeCompanies,
    });
    setHosts(data || []);
    setLoading(false);
  }, [search, statusFilter, includeCompanies]);

  useEffect(() => {
    load();
  }, [load]);

  const openDrawer = async (id: string) => {
    setSelectedHostId(id);
    setDrawerLoading(true);
    const { data } = await EventHostService.get(id);
    if (data) {
      setSelectedHost(data.host);
      setSelectedEvents(data.events);
    }
    setDrawerLoading(false);
  };

  const closeDrawer = () => {
    setSelectedHostId(null);
    setSelectedHost(null);
    setSelectedEvents([]);
  };

  const updateSelected = async (patch: Partial<EventHost>) => {
    if (!selectedHost) return;
    const { data } = await EventHostService.update(selectedHost.id, patch);
    if (data) {
      setSelectedHost(data);
      // Refresh the list row in-place
      setHosts((prev) => prev.map((h) => (h.id === data.id ? { ...h, ...data } : h)));
    }
  };

  const statusBadge = (status: EventHost['outreach_status']) => {
    const opt = STATUS_OPTIONS.find((o) => o.value === status) || STATUS_OPTIONS[0];
    return <Badge variant="soft" color={opt.color as any}>{opt.label}</Badge>;
  };

  return (
    <div className="space-y-4">
        <div className="flex items-start justify-between gap-4">
          <p className="text-sm text-[var(--gray-11)]">
            Organizers of scraped events — outreach pipeline. Reach out to offer them Gatewaze for managing their events.
          </p>
          <a
            href={EventHostService.exportCsvUrl({ search, status: statusFilter })}
            className="inline-flex items-center gap-2 px-3 py-2 border border-[var(--gray-a6)] rounded-md text-sm hover:bg-[var(--gray-a2)]"
          >
            <ArrowDownTrayIcon className="h-4 w-4" />
            Export CSV
          </a>
        </div>

        <div className="mb-4">
          <Tabs
            value={activeTab}
            onChange={(t) => setActiveTab(t as Tab)}
            tabs={[
              { id: 'outreach', label: 'Outreach' },
              { id: 'leaderboard', label: 'League Table' },
              { id: 'map', label: 'Map' },
            ]}
          />
        </div>

        {activeTab === 'leaderboard' && <LeaderboardTab statusFilter={statusFilter} setStatusFilter={setStatusFilter} onOpenHost={openDrawer} statusBadge={statusBadge} />}
        {activeTab === 'map' && <MapTab statusFilter={statusFilter} setStatusFilter={setStatusFilter} onOpenHost={openDrawer} />}

        {activeTab === 'outreach' && (
        <>
        {/* Filters */}
        <div className="flex gap-3 mb-4">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by name, company or email..."
            className={`${inputClass} max-w-md`}
          />
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className={`${inputClass} max-w-xs`}>
            <option value="">All statuses</option>
            {STATUS_OPTIONS.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
          <label className="flex items-center gap-2 text-sm text-[var(--gray-11)]">
            <input
              type="checkbox"
              checked={includeCompanies}
              onChange={(e) => setIncludeCompanies(e.target.checked)}
              className="rounded"
            />
            Include companies
          </label>
        </div>

        {/* Hosts table */}
        <Card variant="surface" className="p-0 overflow-hidden">
          <Table>
            <THead>
              <Tr>
                <Th>Name</Th>
                <Th>Company</Th>
                <Th>Events</Th>
                <Th>Latest event</Th>
                <Th>Status</Th>
                <Th>Links</Th>
              </Tr>
            </THead>
            <TBody>
              {loading && (
                <Tr>
                  <Td colSpan={6} className="text-center py-6 text-[var(--gray-10)]">Loading…</Td>
                </Tr>
              )}
              {!loading && hosts.length === 0 && (
                <Tr>
                  <Td colSpan={6} className="text-center py-6 text-[var(--gray-10)]">
                    No hosts yet — run a scraper that discovers events to populate this list.
                  </Td>
                </Tr>
              )}
              {hosts.map((h) => (
                <Tr key={h.id} className="cursor-pointer hover:bg-[var(--gray-a2)]" onClick={() => openDrawer(h.id)}>
                  <Td>
                    <div className="flex items-center gap-2">
                      {h.avatar_url && <img src={h.avatar_url} alt="" className="h-6 w-6 rounded-full" />}
                      <div>
                        <div className="font-medium">{h.name}</div>
                        {h.job_title && <div className="text-xs text-[var(--gray-10)]">{h.job_title}</div>}
                      </div>
                    </div>
                  </Td>
                  <Td>{h.company || <span className="text-[var(--gray-9)]">—</span>}</Td>
                  <Td>
                    <Badge variant="soft">{h.event_count}</Badge>
                  </Td>
                  <Td>
                    {h.latest_event_title ? (
                      <div>
                        <div className="text-sm truncate max-w-xs">{h.latest_event_title}</div>
                        {h.latest_event_at && (
                          <div className="text-xs text-[var(--gray-10)]">
                            {new Date(h.latest_event_at).toLocaleDateString()}
                          </div>
                        )}
                      </div>
                    ) : (
                      <span className="text-[var(--gray-9)]">—</span>
                    )}
                  </Td>
                  <Td>{statusBadge(h.outreach_status)}</Td>
                  <Td onClick={(e) => e.stopPropagation()}>
                    <div className="flex items-center gap-2">
                      {h.linkedin_url && (
                        <a href={h.linkedin_url} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline text-xs">
                          LinkedIn
                        </a>
                      )}
                      {h.luma_profile_url && (
                        <a href={h.luma_profile_url} target="_blank" rel="noopener noreferrer" className="text-[var(--gray-10)] hover:underline text-xs">
                          Luma
                        </a>
                      )}
                    </div>
                  </Td>
                </Tr>
              ))}
            </TBody>
          </Table>
        </Card>
        </>
        )}

        {/* Detail drawer */}
        <SideDrawer
          open={!!selectedHostId}
          onClose={closeDrawer}
          width="min(640px, 100vw)"
        >
          <div className="p-6">
            {drawerLoading || !selectedHost ? (
              <div className="text-[var(--gray-10)]">Loading…</div>
            ) : (
              <HostDetail
                host={selectedHost}
                events={selectedEvents}
                onUpdate={updateSelected}
              />
            )}
          </div>
        </SideDrawer>
    </div>
  );
}

// ---------------------------------------------------------------------------

function HostDetail({
  host,
  events,
  onUpdate,
}: {
  host: EventHost;
  events: HostEvent[];
  onUpdate: (patch: Partial<EventHost>) => Promise<void>;
}) {
  const [notes, setNotes] = useState(host.outreach_notes || '');
  const [savingNotes, setSavingNotes] = useState(false);
  const [linkedinUrl, setLinkedinUrl] = useState(host.linkedin_url || '');
  const [email, setEmail] = useState(host.email || '');
  const [company, setCompany] = useState(host.company || '');
  const [jobTitle, setJobTitle] = useState(host.job_title || '');

  useEffect(() => {
    setNotes(host.outreach_notes || '');
    setLinkedinUrl(host.linkedin_url || '');
    setEmail(host.email || '');
    setCompany(host.company || '');
    setJobTitle(host.job_title || '');
  }, [host.id]);

  const saveNotes = async () => {
    setSavingNotes(true);
    await onUpdate({ outreach_notes: notes });
    setSavingNotes(false);
  };

  const saveContactDetails = async () => {
    await onUpdate({
      linkedin_url: linkedinUrl || null,
      email: email || null,
      company: company || null,
      job_title: jobTitle || null,
    });
  };

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3">
        {host.avatar_url && <img src={host.avatar_url} alt="" className="h-12 w-12 rounded-full" />}
        <div>
          <h2 className="text-xl font-semibold">{host.name}</h2>
          {(host.company || host.job_title) && (
            <p className="text-sm text-[var(--gray-11)]">
              {[host.job_title, host.company].filter(Boolean).join(' · ')}
            </p>
          )}
        </div>
      </div>

      {host.bio && (
        <div>
          <h3 className="text-xs font-semibold text-[var(--gray-12)] uppercase tracking-wide mb-1">Bio</h3>
          <p className="text-sm text-[var(--gray-11)] whitespace-pre-wrap">{host.bio}</p>
        </div>
      )}

      {/* Outreach status */}
      <div>
        <h3 className="text-xs font-semibold text-[var(--gray-12)] uppercase tracking-wide mb-2">Outreach status</h3>
        <div className="flex flex-wrap gap-2">
          {STATUS_OPTIONS.map((s) => (
            <button
              key={s.value}
              onClick={() => onUpdate({ outreach_status: s.value })}
              className={`px-2 py-1 text-xs rounded-md border transition ${
                host.outreach_status === s.value
                  ? 'border-[var(--accent-9)] bg-[var(--accent-a3)] text-[var(--accent-11)]'
                  : 'border-[var(--gray-a6)] text-[var(--gray-11)] hover:border-[var(--gray-a8)]'
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>
        {host.contacted_at && (
          <p className="text-xs text-[var(--gray-10)] mt-2">
            Contacted {new Date(host.contacted_at).toLocaleString()}
          </p>
        )}
      </div>

      {/* Contact details */}
      <div className="space-y-3">
        <h3 className="text-xs font-semibold text-[var(--gray-12)] uppercase tracking-wide">Contact details</h3>

        <div>
          <label className="block text-xs font-medium text-[var(--gray-11)] mb-1">Email</label>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            onBlur={saveContactDetails}
            placeholder="name@example.com"
            className={inputClass}
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs font-medium text-[var(--gray-11)] mb-1">Company</label>
            <input
              type="text"
              value={company}
              onChange={(e) => setCompany(e.target.value)}
              onBlur={saveContactDetails}
              className={inputClass}
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-[var(--gray-11)] mb-1">Job title</label>
            <input
              type="text"
              value={jobTitle}
              onChange={(e) => setJobTitle(e.target.value)}
              onBlur={saveContactDetails}
              className={inputClass}
            />
          </div>
        </div>

        <div>
          <label className="block text-xs font-medium text-[var(--gray-11)] mb-1">LinkedIn URL</label>
          <div className="flex gap-2">
            <input
              type="url"
              value={linkedinUrl}
              onChange={(e) => setLinkedinUrl(e.target.value)}
              onBlur={saveContactDetails}
              placeholder="https://linkedin.com/in/..."
              className={inputClass}
            />
            <a
              href={`https://www.google.com/search?q=${encodeURIComponent(
                [host.name, host.company].filter(Boolean).map((p) => `"${p}"`).join(' ') + ' site:linkedin.com/in',
              )}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 px-3 py-1.5 text-xs border border-[var(--gray-a6)] rounded-md hover:bg-[var(--gray-a2)] whitespace-nowrap"
              title="Search for this person on LinkedIn via Google"
            >
              <ArrowTopRightOnSquareIcon className="h-3.5 w-3.5" />
              Find
            </a>
          </div>
        </div>

        {host.luma_profile_url && (
          <p className="text-xs">
            <a href={host.luma_profile_url} target="_blank" rel="noopener noreferrer" className="text-[var(--accent-9)] hover:underline">
              View Luma profile →
            </a>
          </p>
        )}
      </div>

      {/* Outreach notes */}
      <div>
        <h3 className="text-xs font-semibold text-[var(--gray-12)] uppercase tracking-wide mb-1">Notes</h3>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={4}
          placeholder="e.g. spoke at AI Summit 2025, mentioned interest in community tools..."
          className={inputClass}
        />
        <Button variant="soft" onClick={saveNotes} disabled={savingNotes} className="mt-2">
          {savingNotes ? 'Saving…' : 'Save notes'}
        </Button>
      </div>

      {/* Associated events */}
      <div>
        <h3 className="text-xs font-semibold text-[var(--gray-12)] uppercase tracking-wide mb-2">
          Events ({events.length})
        </h3>
        <div className="space-y-2">
          {events.length === 0 && <p className="text-sm text-[var(--gray-10)]">No events linked yet.</p>}
          {events.map((e) => (
            <div key={e.source_event_id} className="p-2 border border-[var(--gray-a6)] rounded-md text-sm">
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <div className="font-medium truncate">{e.event_title}</div>
                  <div className="text-xs text-[var(--gray-10)] mt-0.5">
                    {e.calendar_name && <>via {e.calendar_name} · </>}
                    {e.event_start_at && new Date(e.event_start_at).toLocaleDateString()}
                  </div>
                </div>
                {e.event_url && (
                  <a
                    href={e.event_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[var(--gray-10)] hover:text-[var(--accent-9)]"
                  >
                    <ArrowTopRightOnSquareIcon className="h-3.5 w-3.5" />
                  </a>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// League Table — ranks hosts by weighted score. Default filter is everyone
// we haven't yet spoken to ('new', 'enriching', 'ready') so the top rows are
// the people actually worth reaching out to next.
// ---------------------------------------------------------------------------

interface LeaderboardRow {
  host_id: string;
  name: string;
  avatar_url: string | null;
  outreach_status: string;
  events_count: number;
  primary_events_count: number;
  total_guests: number;
  weighted_score: number;
  avg_event_size: number | null;
  primary_city: string | null;
  primary_country_code: string | null;
  linkedin_url: string | null;
  luma_profile_url: string | null;
}

const DEFAULT_TO_CONTACT = ['new', 'enriching', 'ready'];

type RangePreset = 'all' | '1m' | '3m' | '6m' | '1y' | 'custom';

const RANGE_PRESETS: Array<{ id: RangePreset; label: string; months: number | null }> = [
  { id: '1m', label: 'Last 30 days', months: 1 },
  { id: '3m', label: 'Last 3 months', months: 3 },
  { id: '6m', label: 'Last 6 months', months: 6 },
  { id: '1y', label: 'Last year', months: 12 },
  { id: 'all', label: 'All time', months: null },
];

function presetToRange(preset: RangePreset): { from: string | null; to: string | null } {
  if (preset === 'all' || preset === 'custom') return { from: null, to: null };
  const months = RANGE_PRESETS.find(p => p.id === preset)?.months ?? null;
  if (!months) return { from: null, to: null };
  const from = new Date();
  from.setMonth(from.getMonth() - months);
  return { from: from.toISOString(), to: null };
}

function LeaderboardTab({
  statusFilter,
  setStatusFilter,
  onOpenHost,
  statusBadge,
}: {
  statusFilter: string;
  setStatusFilter: (v: string) => void;
  onOpenHost: (id: string) => void;
  statusBadge: (s: EventHost['outreach_status']) => JSX.Element;
}) {
  const [rows, setRows] = useState<LeaderboardRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [onlyToContact, setOnlyToContact] = useState(true);
  const [rangePreset, setRangePreset] = useState<RangePreset>('6m');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');

  useEffect(() => {
    setLoading(true);
    const qs = new URLSearchParams();
    if (onlyToContact && !statusFilter) qs.set('status', DEFAULT_TO_CONTACT.join(','));
    else if (statusFilter) qs.set('status', statusFilter);
    qs.set('limit', '200');

    let from: string | null = null;
    let to: string | null = null;
    if (rangePreset === 'custom') {
      if (customFrom) from = new Date(customFrom).toISOString();
      if (customTo) to = new Date(customTo).toISOString();
    } else {
      ({ from, to } = presetToRange(rangePreset));
    }
    if (from) qs.set('from', from);
    if (to) qs.set('to', to);

    fetch(`${getApiBaseUrl()}/scrapers/hosts/leaderboard?${qs}`)
      .then((r) => r.json())
      .then((body) => setRows(body.hosts || []))
      .finally(() => setLoading(false));
  }, [onlyToContact, statusFilter, rangePreset, customFrom, customTo]);

  return (
    <div>
      {/* Date range picker — primary control for "active hosts" */}
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <span className="text-sm text-[var(--gray-11)] mr-1">Active during:</span>
        {RANGE_PRESETS.map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => setRangePreset(p.id)}
            className={`px-2.5 py-1 text-xs rounded-md border transition ${
              rangePreset === p.id
                ? 'border-[var(--accent-9)] bg-[var(--accent-a3)] text-[var(--accent-11)]'
                : 'border-[var(--gray-a6)] text-[var(--gray-11)] hover:border-[var(--gray-a8)]'
            }`}
          >
            {p.label}
          </button>
        ))}
        <button
          type="button"
          onClick={() => setRangePreset('custom')}
          className={`px-2.5 py-1 text-xs rounded-md border transition ${
            rangePreset === 'custom'
              ? 'border-[var(--accent-9)] bg-[var(--accent-a3)] text-[var(--accent-11)]'
              : 'border-[var(--gray-a6)] text-[var(--gray-11)] hover:border-[var(--gray-a8)]'
          }`}
        >
          Custom
        </button>
        {rangePreset === 'custom' && (
          <div className="flex items-center gap-2">
            <input type="date" value={customFrom} onChange={(e) => setCustomFrom(e.target.value)} className="text-xs px-2 py-1 border border-[var(--gray-a6)] rounded-md" />
            <span className="text-xs text-[var(--gray-10)]">→</span>
            <input type="date" value={customTo} onChange={(e) => setCustomTo(e.target.value)} className="text-xs px-2 py-1 border border-[var(--gray-a6)] rounded-md" />
          </div>
        )}
      </div>

      <div className="flex items-center gap-3 mb-4">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={onlyToContact}
            onChange={(e) => setOnlyToContact(e.target.checked)}
            className="rounded"
          />
          Only people to contact (new / enriching / ready)
        </label>
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className={`${inputClass} max-w-xs`}>
          <option value="">All statuses</option>
          {STATUS_OPTIONS.map((s) => (
            <option key={s.value} value={s.value}>{s.label}</option>
          ))}
        </select>
      </div>

      <Card variant="surface" className="p-0 overflow-hidden">
        <Table>
          <THead>
            <Tr>
              <Th>#</Th>
              <Th>Name</Th>
              <Th>Score</Th>
              <Th>Events</Th>
              <Th>Total guests</Th>
              <Th>Avg size</Th>
              <Th>City</Th>
              <Th>Status</Th>
            </Tr>
          </THead>
          <TBody>
            {loading && (
              <Tr><Td colSpan={8} className="text-center py-6 text-[var(--gray-10)]">Loading…</Td></Tr>
            )}
            {!loading && rows.length === 0 && (
              <Tr><Td colSpan={8} className="text-center py-6 text-[var(--gray-10)]">No hosts match that filter.</Td></Tr>
            )}
            {rows.map((r, i) => (
              <Tr key={r.host_id} className="cursor-pointer hover:bg-[var(--gray-a2)]" onClick={() => onOpenHost(r.host_id)}>
                <Td className="text-[var(--gray-10)]">{i + 1}</Td>
                <Td>
                  <div className="flex items-center gap-2">
                    {r.avatar_url && <img src={r.avatar_url} alt="" className="h-6 w-6 rounded-full" />}
                    <div className="font-medium">{r.name}</div>
                  </div>
                </Td>
                <Td><Badge variant="soft" color="cyan">{r.weighted_score.toLocaleString()}</Badge></Td>
                <Td>
                  {r.events_count}
                  {r.primary_events_count > 0 && (
                    <span className="ml-1 text-xs text-[var(--gray-10)]">({r.primary_events_count} primary)</span>
                  )}
                </Td>
                <Td>{r.total_guests?.toLocaleString() || '—'}</Td>
                <Td>{r.avg_event_size?.toLocaleString() || '—'}</Td>
                <Td>{r.primary_city || <span className="text-[var(--gray-9)]">—</span>}</Td>
                <Td>{statusBadge(r.outreach_status as any)}</Td>
              </Tr>
            ))}
          </TBody>
        </Table>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Map — city markers sized by top-host count. Only plots cities with actual
// coords (read from events.event_location via the /map endpoint). Status
// filter + min-events slider narrows to "people worth talking to".
// ---------------------------------------------------------------------------

interface MapMarker {
  city: string;
  country_code: string | null;
  lat: number;
  lng: number;
  host_count: number;
  by_status: Record<string, number>;
  top_hosts: Array<{
    host_id: string;
    name: string;
    avatar_url: string | null;
    weighted_score: number;
    events_count: number;
    outreach_status: string;
  }>;
}

function MapTab({
  statusFilter,
  setStatusFilter,
  onOpenHost,
}: {
  statusFilter: string;
  setStatusFilter: (v: string) => void;
  onOpenHost: (id: string) => void;
}) {
  const [markers, setMarkers] = useState<MapMarker[]>([]);
  const [loading, setLoading] = useState(true);
  const [minEvents, setMinEvents] = useState(2);

  useEffect(() => {
    setLoading(true);
    const qs = new URLSearchParams();
    if (statusFilter) qs.set('status', statusFilter);
    qs.set('min_events', String(minEvents));
    qs.set('top', '5');
    fetch(`${getApiBaseUrl()}/scrapers/hosts/map?${qs}`)
      .then((r) => r.json())
      .then((body) => setMarkers(body.markers || []))
      .finally(() => setLoading(false));
  }, [statusFilter, minEvents]);

  const center = useMemo<[number, number]>(() => {
    if (markers.length === 0) return [20, 0];
    const avgLat = markers.reduce((s, m) => s + m.lat, 0) / markers.length;
    const avgLng = markers.reduce((s, m) => s + m.lng, 0) / markers.length;
    return [avgLat, avgLng];
  }, [markers]);

  const radius = (hostCount: number) => Math.min(6 + Math.sqrt(hostCount) * 4, 30);

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className={`${inputClass} max-w-xs`}>
          <option value="">All statuses</option>
          {STATUS_OPTIONS.map((s) => (
            <option key={s.value} value={s.value}>{s.label}</option>
          ))}
        </select>
        <label className="flex items-center gap-2 text-sm text-[var(--gray-11)]">
          Min events per host:
          <input
            type="range"
            min={1}
            max={10}
            value={minEvents}
            onChange={(e) => setMinEvents(Number(e.target.value))}
          />
          <span className="font-medium">{minEvents}</span>
        </label>
        <div className="text-sm text-[var(--gray-10)]">
          {loading ? 'Loading…' : `${markers.length} cities · ${markers.reduce((s, m) => s + m.host_count, 0)} hosts`}
        </div>
      </div>

      <Card variant="surface" className="p-0 overflow-hidden">
        <div style={{ height: '600px', width: '100%' }}>
          <MapContainer center={center} zoom={2} style={{ height: '100%', width: '100%' }} scrollWheelZoom>
            <TileLayer
              attribution='&copy; OpenStreetMap contributors'
              url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            />
            {markers.map((m) => (
              <CircleMarker
                key={`${m.city}-${m.lat}-${m.lng}`}
                center={[m.lat, m.lng]}
                radius={radius(m.host_count)}
                pathOptions={{ color: 'var(--accent-9)', fillColor: 'var(--accent-9)', fillOpacity: 0.6 }}
              >
                <Tooltip>
                  <strong>{m.city}</strong>{m.country_code ? ` (${m.country_code.toUpperCase()})` : ''} — {m.host_count} hosts
                </Tooltip>
                <Popup>
                  <div style={{ minWidth: 220 }}>
                    <div style={{ fontWeight: 600, marginBottom: 4 }}>{m.city}{m.country_code ? ` · ${m.country_code.toUpperCase()}` : ''}</div>
                    <div style={{ fontSize: 12, color: '#666', marginBottom: 8 }}>
                      {m.host_count} hosts · {Object.entries(m.by_status).map(([s, n]) => `${n} ${s}`).join(' · ')}
                    </div>
                    <div style={{ borderTop: '1px solid #eee', paddingTop: 6 }}>
                      <div style={{ fontSize: 11, textTransform: 'uppercase', color: '#888', marginBottom: 4 }}>Top hosts</div>
                      {m.top_hosts.map((h) => (
                        <div key={h.host_id} style={{ padding: '3px 0', fontSize: 13, cursor: 'pointer' }} onClick={() => onOpenHost(h.host_id)}>
                          <strong>{h.name}</strong>
                          <span style={{ color: '#888', marginLeft: 6 }}>
                            · {h.weighted_score} pts · {h.events_count} events · {h.outreach_status}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                </Popup>
              </CircleMarker>
            ))}
          </MapContainer>
        </div>
      </Card>
    </div>
  );
}
