/**
 * Hosts tab for the event detail page.
 *
 * Shows two sources of hosts for an event:
 *   1. Hosts discovered by the scraper from Luma's __NEXT_DATA__ (the primary
 *      source for scraped events). These come from event_host_events with the
 *      position they appeared in on Luma, so position 1 is the primary host.
 *   2. (TODO) People records explicitly assigned as hosts from the admin UI —
 *      mirrors how calendars have admin users. Not yet wired up — placeholder
 *      below for when the events module gains an "assign host" action.
 */

import { useEffect, useState } from 'react';
import { Badge, Card, Table, THead, TBody, Tr, Th, Td } from '@/components/ui';
import { getApiBaseUrl } from '@/config/brands';

interface HostEventRow {
  host_id: string;
  source_event_id: string;
  host_position: number | null;
  guest_count: number | null;
  role: string | null;
  event_start_at: string | null;
  host: {
    id: string;
    name: string;
    email: string | null;
    avatar_url: string | null;
    luma_profile_url: string | null;
    linkedin_url: string | null;
    outreach_status: string;
    bio: string | null;
    company: string | null;
    job_title: string | null;
  };
}

export default function EventHostsTab({ eventUuid }: { eventUuid?: string }) {
  const [rows, setRows] = useState<HostEventRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!eventUuid) { setLoading(false); return; }
    setLoading(true);
    fetch(`${getApiBaseUrl()}/events/${eventUuid}/hosts`)
      .then((r) => r.json())
      .then((body) => setRows(body.hosts || []))
      .finally(() => setLoading(false));
  }, [eventUuid]);

  const positionLabel = (pos: number | null) => {
    if (pos === null) return null;
    if (pos === 1) return <Badge variant="soft" color="cyan">Primary</Badge>;
    return <Badge variant="soft">#{pos}</Badge>;
  };

  return (
    <Card>
      <div className="p-6">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h3 className="text-lg font-semibold text-[var(--gray-12)]">Event Hosts</h3>
            <p className="text-sm text-[var(--gray-11)] mt-1">
              Hosts discovered from Luma, ordered by their position on the event page.
              Primary host (position 1) receives full credit in the host leaderboard.
            </p>
          </div>
        </div>

        <Table>
          <THead>
            <Tr>
              <Th>Position</Th>
              <Th>Name</Th>
              <Th>Company</Th>
              <Th>Status</Th>
              <Th>Links</Th>
            </Tr>
          </THead>
          <TBody>
            {loading && (
              <Tr><Td colSpan={5} className="text-center py-6 text-[var(--gray-10)]">Loading…</Td></Tr>
            )}
            {!loading && rows.length === 0 && (
              <Tr><Td colSpan={5} className="text-center py-6 text-[var(--gray-10)]">
                No hosts recorded for this event yet.
              </Td></Tr>
            )}
            {rows.map((r) => (
              <Tr key={`${r.host_id}:${r.source_event_id}`}>
                <Td>{positionLabel(r.host_position) || <span className="text-[var(--gray-9)]">—</span>}</Td>
                <Td>
                  <div className="flex items-center gap-2">
                    {r.host.avatar_url && <img src={r.host.avatar_url} alt="" className="h-6 w-6 rounded-full" />}
                    <div>
                      <div className="font-medium">{r.host.name}</div>
                      {r.host.job_title && <div className="text-xs text-[var(--gray-10)]">{r.host.job_title}</div>}
                    </div>
                  </div>
                </Td>
                <Td>{r.host.company || <span className="text-[var(--gray-9)]">—</span>}</Td>
                <Td><Badge variant="soft">{r.host.outreach_status}</Badge></Td>
                <Td>
                  <div className="flex items-center gap-2">
                    {r.host.linkedin_url && (
                      <a href={r.host.linkedin_url} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline text-xs">LinkedIn</a>
                    )}
                    {r.host.luma_profile_url && (
                      <a href={r.host.luma_profile_url} target="_blank" rel="noopener noreferrer" className="text-[var(--gray-10)] hover:underline text-xs">Luma</a>
                    )}
                  </div>
                </Td>
              </Tr>
            ))}
          </TBody>
        </Table>

        {/* Placeholder for the future "people assigned as hosts" section —
            mirrors calendar admin users. Populated once the events module has
            an "assign host" action. */}
        <div className="mt-6 pt-4 border-t border-[var(--gray-a5)]">
          <h4 className="text-sm font-medium text-[var(--gray-11)] mb-2">Assigned Gatewaze admins</h4>
          <p className="text-xs text-[var(--gray-9)]">
            Coming soon — similar to calendar admin users, you'll be able to manually assign people records
            from your CRM as hosts on an event.
          </p>
        </div>
      </div>
    </Card>
  );
}
