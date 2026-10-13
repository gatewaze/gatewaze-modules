/**
 * Analytics for a shared-code offer (one code for everyone; migration 003).
 *
 * The event-based detail page reads a code pool. A shared offer has none, so
 * everything here comes from events_discount_claims ('viewed' rows excluded)
 * and the claimants' people records: claim timeline, new versus existing
 * contacts, and where claimants are.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import ReactApexChart from 'react-apexcharts';
import { ApexOptions } from 'apexcharts';
import { ArrowDownTrayIcon, ArrowPathIcon, MapIcon, TicketIcon } from '@heroicons/react/24/outline';
import { toast } from 'sonner';
import { Card, Button } from '@/components/ui';
import { supabase } from '@/lib/supabase';
import { GeographicHeatmap } from '@/components/charts/GeographicHeatmap';
import { GeographicMapLeaflet } from '@/components/charts/GeographicMapLeaflet';

interface Claim {
  email: string;
  status: string;
  created_at: string;
  code_issued_at: string | null;
}

interface GeoPoint {
  country: string;
  city: string;
  lat: number;
  lng: number;
  count: number;
}

interface Props {
  discountId: string;
  slug: string;
}

const HOUR = 60 * 60 * 1000;

function claimTime(c: Claim): number {
  return new Date(c.code_issued_at || c.created_at).getTime();
}

async function loadClaims(discountId: string): Promise<Claim[]> {
  const rows: Claim[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from('events_discount_claims')
      .select('email, status, created_at, code_issued_at')
      .eq('discount_id', discountId)
      .neq('status', 'viewed')
      .order('created_at')
      .range(from, from + 999);
    if (error) throw error;
    rows.push(...((data || []) as Claim[]));
    if (!data || data.length < 1000) break;
  }
  return rows;
}

async function loadPeople(emails: string[]): Promise<Map<string, Record<string, unknown>>> {
  const out = new Map<string, Record<string, unknown>>();
  for (let i = 0; i < emails.length; i += 100) {
    const { data, error } = await supabase
      .from('people')
      .select('email, attributes')
      .in('email', emails.slice(i, i + 100));
    if (error) {
      console.error('Error loading claimant people:', error);
      continue;
    }
    for (const p of data || []) {
      if (p.email) out.set(String(p.email).toLowerCase(), (p.attributes || {}) as Record<string, unknown>);
    }
  }
  return out;
}

function toCsvCell(v: string | null): string {
  const s = v ?? '';
  // Neutralise spreadsheet formulas, then quote.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return `"${safe.replace(/"/g, '""')}"`;
}

export function SharedOfferAnalytics({ discountId, slug }: Props) {
  const [claims, setClaims] = useState<Claim[]>([]);
  const [people, setPeople] = useState<Map<string, Record<string, unknown>>>(new Map());
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const rows = await loadClaims(discountId);
      setClaims(rows);
      const emails = [...new Set(rows.map((r) => r.email.toLowerCase()))];
      setPeople(await loadPeople(emails));
    } catch (err) {
      console.error('Error loading offer analytics:', err);
      toast.error('Could not load analytics');
    } finally {
      setLoading(false);
    }
  }, [discountId]);

  useEffect(() => {
    load();
  }, [load]);

  const stats = useMemo(() => {
    const now = Date.now();
    const times = claims.map(claimTime).filter((t) => !Number.isNaN(t)).sort((a, b) => a - b);
    let newContacts = 0;
    for (const c of claims) {
      if (people.get(c.email.toLowerCase())?.signup_source === 'discount_offer_claim') newContacts++;
    }
    return {
      total: claims.length,
      last24h: times.filter((t) => now - t <= 24 * HOUR).length,
      newContacts,
      existingContacts: claims.length - newContacts,
      first: times[0] ?? null,
      latest: times[times.length - 1] ?? null,
    };
  }, [claims, people]);

  // Hourly buckets from the first claim to the latest.
  const timeline = useMemo(() => {
    const counts = new Map<number, number>();
    for (const c of claims) {
      const t = claimTime(c);
      if (Number.isNaN(t)) continue;
      const bucket = Math.floor(t / HOUR) * HOUR;
      counts.set(bucket, (counts.get(bucket) || 0) + 1);
    }
    const buckets = [...counts.keys()].sort((a, b) => a - b);
    if (buckets.length === 0) return [] as { t: number; count: number; cumulative: number }[];
    const out: { t: number; count: number; cumulative: number }[] = [];
    let cumulative = 0;
    for (let t = buckets[0]; t <= buckets[buckets.length - 1]; t += HOUR) {
      const count = counts.get(t) || 0;
      cumulative += count;
      out.push({ t, count, cumulative });
    }
    return out;
  }, [claims]);

  const geo = useMemo(() => {
    const byPoint = new Map<string, GeoPoint>();
    for (const c of claims) {
      const attrs = people.get(c.email.toLowerCase());
      const loc = typeof attrs?.location === 'string' ? attrs.location : '';
      const [lat, lng] = loc.split(',').map((v) => parseFloat(v.trim()));
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
      const key = `${lat},${lng}`;
      const existing = byPoint.get(key);
      if (existing) existing.count++;
      else byPoint.set(key, {
        country: String(attrs?.country || 'Unknown'),
        city: String(attrs?.city || 'Unknown'),
        lat,
        lng,
        count: 1,
      });
    }
    return [...byPoint.values()];
  }, [claims, people]);

  const downloadCsv = () => {
    const header = 'email,status,claimed_at,new_contact,city,country';
    const lines = claims.map((c) => {
      const attrs = people.get(c.email.toLowerCase());
      return [
        c.email,
        c.status,
        c.code_issued_at || c.created_at,
        attrs?.signup_source === 'discount_offer_claim' ? 'yes' : 'no',
        typeof attrs?.city === 'string' ? attrs.city : '',
        typeof attrs?.country === 'string' ? attrs.country : '',
      ].map(toCsvCell).join(',');
    });
    const blob = new Blob([[header, ...lines].join('\n')], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${slug || 'offer'}-claims.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const fmt = (t: number | null) => (t ? new Date(t).toLocaleString() : '—');

  const baseChart: ApexOptions = {
    chart: { toolbar: { show: true }, zoom: { enabled: false } },
    dataLabels: { enabled: false },
    xaxis: { type: 'datetime', labels: { format: 'MMM dd HH:mm', datetimeUTC: false } },
    tooltip: { x: { format: 'MMM dd, yyyy HH:mm' }, y: { formatter: (v) => `${Math.floor(v)} claims` } },
    grid: { borderColor: '#e5e7eb', strokeDashArray: 4 },
  };
  const cumulativeOptions: ApexOptions = {
    ...baseChart,
    chart: { ...baseChart.chart, type: 'area' },
    stroke: { curve: 'smooth', width: 2 },
    yaxis: { title: { text: 'Cumulative claims' }, labels: { formatter: (v) => Math.floor(v).toString() } },
    fill: { type: 'gradient', gradient: { shadeIntensity: 1, opacityFrom: 0.7, opacityTo: 0.3, stops: [0, 90, 100] } },
    colors: ['#3b82f6'],
  };
  const hourlyOptions: ApexOptions = {
    ...baseChart,
    chart: { ...baseChart.chart, type: 'bar' },
    plotOptions: { bar: { borderRadius: 4, columnWidth: '60%' } },
    yaxis: { title: { text: 'Claims per hour' }, labels: { formatter: (v) => Math.floor(v).toString() } },
    colors: ['#10b981'],
  };

  if (loading) {
    return <div className="py-12 text-center text-sm text-gray-500">Loading analytics…</div>;
  }

  return (
    <div className="space-y-6">
      <div className="flex justify-end gap-2">
        <Button variant="outlined" className="gap-2" onClick={downloadCsv} disabled={claims.length === 0}>
          <ArrowDownTrayIcon className="size-4" />
          Download claims CSV
        </Button>
        <Button variant="outlined" className="gap-2" onClick={load}>
          <ArrowPathIcon className="size-4" />
          Refresh
        </Button>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
        <Card variant="surface" className="p-4">
          <div className="text-xs font-medium text-neutral-500 uppercase">Claims</div>
          <div className="text-2xl font-bold mt-1 text-blue-600">{stats.total.toLocaleString()}</div>
        </Card>
        <Card variant="surface" className="p-4">
          <div className="text-xs font-medium text-neutral-500 uppercase">Last 24 hours</div>
          <div className="text-2xl font-bold mt-1">{stats.last24h.toLocaleString()}</div>
        </Card>
        <Card variant="surface" className="p-4">
          <div className="text-xs font-medium text-neutral-500 uppercase">New contacts</div>
          <div className="text-2xl font-bold mt-1 text-purple-600">{stats.newContacts.toLocaleString()}</div>
          <div className="text-xs text-neutral-500">
            {stats.total > 0 ? Math.round((stats.newContacts / stats.total) * 100) : 0}% joined through this offer
          </div>
        </Card>
        <Card variant="surface" className="p-4">
          <div className="text-xs font-medium text-neutral-500 uppercase">Existing contacts</div>
          <div className="text-2xl font-bold mt-1 text-green-600">{stats.existingContacts.toLocaleString()}</div>
        </Card>
        <Card variant="surface" className="p-4">
          <div className="text-xs font-medium text-neutral-500 uppercase">First / latest claim</div>
          <div className="text-xs mt-2">{fmt(stats.first)}</div>
          <div className="text-xs">{fmt(stats.latest)}</div>
        </Card>
      </div>

      {timeline.length > 0 ? (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <Card variant="surface" className="p-6">
            <h2 className="text-lg font-semibold mb-1">Cumulative claims over time</h2>
            <p className="text-sm text-gray-500 mb-4">Total number of people who claimed the code</p>
            <ReactApexChart
              options={cumulativeOptions}
              series={[{ name: 'Cumulative claims', data: timeline.map((d) => [d.t, d.cumulative]) }]}
              type="area"
              height={300}
            />
          </Card>
          <Card variant="surface" className="p-6">
            <h2 className="text-lg font-semibold mb-1">Claims per hour</h2>
            <p className="text-sm text-gray-500 mb-4">Number of claims in each hour</p>
            <ReactApexChart
              options={hourlyOptions}
              series={[{ name: 'Claims per hour', data: timeline.map((d) => [d.t, d.count]) }]}
              type="bar"
              height={300}
            />
          </Card>
        </div>
      ) : (
        <Card variant="surface" className="p-12">
          <div className="text-center">
            <TicketIcon className="mx-auto h-12 w-12 text-gray-400" />
            <h3 className="mt-2 text-sm font-medium">No claims yet</h3>
            <p className="mt-1 text-sm text-gray-500">Claims appear here as people take the code.</p>
          </div>
        </Card>
      )}

      <div>
        <h3 className="text-lg font-semibold flex items-center gap-2 mb-4">
          <MapIcon className="size-5" />
          Geographic distribution
        </h3>
        {geo.length > 0 ? (
          <div className="space-y-6">
            <Card variant="surface" className="p-6">
              <GeographicMapLeaflet claimed={geo} registered={[]} attended={[]} />
            </Card>
            <Card variant="surface" className="p-6">
              <GeographicHeatmap claimed={geo} registered={[]} attended={[]} />
            </Card>
          </div>
        ) : (
          <Card variant="surface" className="p-12">
            <div className="text-center">
              <MapIcon className="mx-auto h-12 w-12 text-gray-400" />
              <h3 className="mt-2 text-sm font-medium">No location data yet</h3>
              <p className="mt-1 text-sm text-gray-500">Claimants with a known location appear on the map.</p>
            </div>
          </Card>
        )}
      </div>
    </div>
  );
}
