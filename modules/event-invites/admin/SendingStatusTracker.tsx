import { useState, useEffect, useCallback, useMemo } from 'react';
import { supabase } from '@/lib/supabase';
import { Card, Table, THead, TBody, Tr, Th, Td, Badge } from '@/components/ui';
import { CheckCircleIcon, MagnifyingGlassIcon } from '@heroicons/react/24/outline';
import { toast } from 'sonner';
import {
  getDeliveriesForParties,
  markDeliverySent,
  clearDeliveryForChannel,
  type InviteDelivery,
} from './utils/inviteTemplateService';

interface SendingStatusTrackerProps {
  eventUuid: string;
}

interface PartyRow {
  id: string;
  name: string;
  short_code: string;
  lead_first_name: string | null;
  lead_last_name: string | null;
  lead_email: string | null;
  member_count: number;
}

type Channel = 'pdf' | 'email' | 'sms' | 'whatsapp';

const CHANNELS: { id: Channel; label: string; verb: string }[] = [
  { id: 'pdf', label: 'Print', verb: 'Posted' },
  { id: 'email', label: 'Email', verb: 'Sent' },
  { id: 'sms', label: 'SMS', verb: 'Sent' },
  { id: 'whatsapp', label: 'WhatsApp', verb: 'Sent' },
];

function formatWhen(iso: string | null): string {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      month: 'short', day: 'numeric', year: 'numeric',
    });
  } catch {
    return iso;
  }
}

/**
 * Build a lookup of deliveries keyed by `${partyId}:${channel}` → most recent
 * "sent" delivery row (if any).
 */
function indexDeliveries(deliveries: InviteDelivery[]): Map<string, InviteDelivery> {
  const map = new Map<string, InviteDelivery>();
  // deliveries arrive ordered created_at desc, so the first one we see for a
  // given key is the most recent.
  for (const d of deliveries) {
    if (d.status !== 'sent' && d.status !== 'delivered' && d.status !== 'downloaded') continue;
    const key = `${d.party_id}:${d.channel}`;
    if (!map.has(key)) map.set(key, d);
  }
  return map;
}

export function SendingStatusTracker({ eventUuid }: SendingStatusTrackerProps) {
  const [parties, setParties] = useState<PartyRow[]>([]);
  const [deliveries, setDeliveries] = useState<InviteDelivery[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [updating, setUpdating] = useState<string | null>(null);
  const [bulkUpdating, setBulkUpdating] = useState<Channel | null>(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const { data: partyData, error } = await supabase
        .from('invite_parties_with_stats')
        .select('id, name, short_code, lead_first_name, lead_last_name, lead_email, member_count, event_ids')
        .contains('event_ids', [eventUuid])
        .order('created_at', { ascending: false });
      if (error) throw error;

      const rows = (partyData || []) as PartyRow[];
      setParties(rows);

      const partyIds = rows.map(p => p.id);
      const deliveryData = await getDeliveriesForParties(partyIds);
      setDeliveries(deliveryData);
    } catch (err: any) {
      console.error('Failed to load sending status data:', err);
      toast.error(`Failed to load sending status: ${err.message || err}`);
    } finally {
      setLoading(false);
    }
  }, [eventUuid]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const deliveryIndex = useMemo(() => indexDeliveries(deliveries), [deliveries]);

  const filteredParties = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return parties;
    return parties.filter(p =>
      (p.name || '').toLowerCase().includes(term) ||
      (p.lead_first_name || '').toLowerCase().includes(term) ||
      (p.lead_last_name || '').toLowerCase().includes(term) ||
      (p.lead_email || '').toLowerCase().includes(term),
    );
  }, [parties, search]);

  const channelTotals = useMemo(() => {
    const totals: Record<Channel, { sent: number; total: number }> = {
      pdf: { sent: 0, total: parties.length },
      email: { sent: 0, total: parties.length },
      sms: { sent: 0, total: parties.length },
      whatsapp: { sent: 0, total: parties.length },
    };
    for (const party of parties) {
      for (const ch of CHANNELS) {
        if (deliveryIndex.has(`${party.id}:${ch.id}`)) {
          totals[ch.id].sent += 1;
        }
      }
    }
    return totals;
  }, [parties, deliveryIndex]);

  const handleToggle = async (party: PartyRow, channel: Channel) => {
    const key = `${party.id}:${channel}`;
    const existing = deliveryIndex.get(key);
    setUpdating(key);
    try {
      if (existing) {
        await clearDeliveryForChannel(party.id, channel);
        setDeliveries(prev => prev.filter(d => !(d.party_id === party.id && d.channel === channel)));
      } else {
        const created = await markDeliverySent(party.id, channel, 'manual', null);
        setDeliveries(prev => [created, ...prev]);
      }
    } catch (err: any) {
      toast.error(`Failed to update: ${err.message || err}`);
    } finally {
      setUpdating(null);
    }
  };

  const handleBulkMark = async (channel: Channel) => {
    const unmarked = filteredParties.filter(p => !deliveryIndex.has(`${p.id}:${channel}`));
    if (unmarked.length === 0) {
      toast.info(`All visible parties are already marked as ${CHANNELS.find(c => c.id === channel)?.verb.toLowerCase()}`);
      return;
    }
    const channelLabel = CHANNELS.find(c => c.id === channel)?.label || channel;
    if (!confirm(`Mark ${unmarked.length} parties as ${CHANNELS.find(c => c.id === channel)?.verb.toLowerCase()} via ${channelLabel}?`)) return;

    setBulkUpdating(channel);
    try {
      const created: InviteDelivery[] = [];
      for (const party of unmarked) {
        const row = await markDeliverySent(party.id, channel, 'manual', null);
        created.push(row);
      }
      setDeliveries(prev => [...created, ...prev]);
      toast.success(`Marked ${created.length} parties as ${CHANNELS.find(c => c.id === channel)?.verb.toLowerCase()}`);
    } catch (err: any) {
      toast.error(`Bulk update failed: ${err.message || err}`);
    } finally {
      setBulkUpdating(null);
    }
  };

  const handleBulkClear = async (channel: Channel) => {
    const marked = filteredParties.filter(p => deliveryIndex.has(`${p.id}:${channel}`));
    if (marked.length === 0) return;
    const channelLabel = CHANNELS.find(c => c.id === channel)?.label || channel;
    if (!confirm(`Clear ${CHANNELS.find(c => c.id === channel)?.verb.toLowerCase()} status for ${marked.length} parties via ${channelLabel}?`)) return;

    setBulkUpdating(channel);
    try {
      for (const party of marked) {
        await clearDeliveryForChannel(party.id, channel);
      }
      setDeliveries(prev => prev.filter(d => !(d.channel === channel && marked.some(p => p.id === d.party_id))));
      toast.success(`Cleared ${marked.length} entries`);
    } catch (err: any) {
      toast.error(`Bulk clear failed: ${err.message || err}`);
    } finally {
      setBulkUpdating(null);
    }
  };

  const formatLeadBooker = (p: PartyRow): string => {
    const parts = [p.lead_first_name, p.lead_last_name].filter(Boolean);
    if (parts.length > 0) return parts.join(' ');
    return p.lead_email || '--';
  };

  return (
    <Card className="p-4 space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-[var(--gray-12)]">Sending Status</h3>
        <p className="text-xs text-[var(--gray-9)] mt-0.5">
          Track which invites have been sent or posted per channel. Auto-logged when sent via Gatewaze; tick manually for printed invites once posted.
        </p>
      </div>

      {/* Channel summary + bulk actions */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        {CHANNELS.map(ch => {
          const totals = channelTotals[ch.id];
          const pct = totals.total > 0 ? Math.round((totals.sent / totals.total) * 100) : 0;
          return (
            <div key={ch.id} className="rounded-md border border-[var(--gray-6)] p-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-[var(--gray-12)]">{ch.label}</span>
                <Badge color={pct === 100 ? 'green' : pct > 0 ? 'blue' : 'gray'}>
                  {totals.sent}/{totals.total}
                </Badge>
              </div>
              <div className="mt-1.5 h-1 bg-[var(--gray-4)] rounded-full overflow-hidden">
                <div
                  className="h-full bg-[var(--accent-9)] transition-all"
                  style={{ width: `${pct}%` }}
                />
              </div>
              <div className="mt-2 flex gap-1">
                <button
                  type="button"
                  disabled={bulkUpdating !== null || loading}
                  onClick={() => handleBulkMark(ch.id)}
                  className="flex-1 text-[10px] px-1.5 py-0.5 rounded border border-[var(--gray-6)] hover:bg-[var(--gray-3)] disabled:opacity-50 cursor-pointer"
                >
                  Mark all
                </button>
                <button
                  type="button"
                  disabled={bulkUpdating !== null || loading}
                  onClick={() => handleBulkClear(ch.id)}
                  className="flex-1 text-[10px] px-1.5 py-0.5 rounded border border-[var(--gray-6)] hover:bg-[var(--gray-3)] disabled:opacity-50 cursor-pointer"
                >
                  Clear all
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {/* Search */}
      <div className="relative max-w-sm">
        <MagnifyingGlassIcon className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--gray-9)]" />
        <input
          type="text"
          placeholder="Search parties..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="w-full pl-9 pr-3 py-1.5 rounded-md border border-[var(--gray-6)] bg-[var(--color-background)] text-sm focus:outline-none focus:ring-2 focus:ring-[var(--accent-7)]"
        />
      </div>

      {/* Matrix */}
      {loading ? (
        <p className="text-sm text-[var(--gray-9)]">Loading...</p>
      ) : filteredParties.length === 0 ? (
        <p className="text-sm text-[var(--gray-9)] text-center py-6">
          {parties.length === 0 ? 'No parties yet.' : 'No parties match your search.'}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <THead>
              <Tr>
                <Th>Party</Th>
                <Th>Lead Booker</Th>
                {CHANNELS.map(ch => (
                  <Th key={ch.id} style={{ width: 110, textAlign: 'center' }}>{ch.label}</Th>
                ))}
              </Tr>
            </THead>
            <TBody>
              {filteredParties.map(party => (
                <Tr key={party.id}>
                  <Td>
                    <div className="font-medium text-[var(--gray-12)]">{party.name || '--'}</div>
                    <div className="text-xs text-[var(--gray-9)]">{party.member_count} member{party.member_count !== 1 ? 's' : ''}</div>
                  </Td>
                  <Td>
                    <div>{formatLeadBooker(party)}</div>
                    {party.lead_email && (
                      <div className="text-xs text-[var(--gray-9)]">{party.lead_email}</div>
                    )}
                  </Td>
                  {CHANNELS.map(ch => {
                    const key = `${party.id}:${ch.id}`;
                    const delivery = deliveryIndex.get(key);
                    const isSent = !!delivery;
                    const source = (delivery?.metadata as Record<string, unknown> | undefined)?.source as string | undefined;
                    const isAuto = source === 'auto' || (isSent && !source);
                    const tooltip = delivery
                      ? `${ch.verb} ${formatWhen(delivery.sent_at || delivery.created_at)}${isAuto ? ' (auto)' : ' (manual)'}`
                      : `Click to mark as ${ch.verb.toLowerCase()}`;
                    return (
                      <Td key={ch.id} style={{ textAlign: 'center' }}>
                        <button
                          type="button"
                          disabled={updating === key || bulkUpdating !== null}
                          onClick={() => handleToggle(party, ch.id)}
                          title={tooltip}
                          className={`inline-flex items-center justify-center w-7 h-7 rounded-md border transition-colors cursor-pointer disabled:opacity-50 ${
                            isSent
                              ? 'bg-[var(--green-3)] border-[var(--green-7)] text-[var(--green-11)] hover:bg-[var(--green-4)]'
                              : 'bg-transparent border-[var(--gray-6)] text-[var(--gray-8)] hover:bg-[var(--gray-3)] hover:border-[var(--gray-8)]'
                          }`}
                          aria-label={tooltip}
                        >
                          {isSent ? <CheckCircleIcon className="w-4 h-4" /> : null}
                        </button>
                        {isSent && delivery?.sent_at && (
                          <div className="text-[10px] text-[var(--gray-9)] mt-0.5">
                            {formatWhen(delivery.sent_at)}
                          </div>
                        )}
                      </Td>
                    );
                  })}
                </Tr>
              ))}
            </TBody>
          </Table>
        </div>
      )}
    </Card>
  );
}
