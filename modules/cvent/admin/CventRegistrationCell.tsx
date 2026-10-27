import { Badge, Td } from '@/components/ui';
import { eventKey } from './api';
import { useEventLedger } from './useEventLedger';

/**
 * One cell per registration row on the registrations table (slot
 * `event-registrations:column-cell`): whether this registrant is in Cvent,
 * so a badge can be printed, or why not.
 */

const ACTIVE = new Set(['confirmed', 'pending', 'waitlist', 'waitlisted', 'attended']);

interface Props {
  eventId: string;
  eventUuid?: string;
  registration: { id: string; status?: string | null };
}

export function CventRegistrationCell({ eventId, eventUuid, registration }: Props) {
  const { ledger } = useEventLedger(eventKey(eventId, eventUuid));
  if (!ledger?.configured) return null;

  const row = ledger.rows.get(registration.id);
  const active = !registration.status || ACTIVE.has(registration.status);

  let body: React.ReactNode;
  if (row?.status === 'synced') {
    // Shown even for a cancelled registration: they are in Cvent, which is
    // worth knowing since cancellations are not propagated.
    const when = row.synced_at ? new Date(row.synced_at).toLocaleString() : '';
    body = (
      <Badge color="green" variant="soft" title={when ? `In Cvent since ${when}` : 'In Cvent'}>
        In Cvent
      </Badge>
    );
  } else if (!active) {
    // Cancelled and not in Cvent: nothing will be pushed, old failures included.
    body = <span className="text-xs text-[var(--gray-a9)]">—</span>;
  } else if (row?.status === 'failed') {
    body = (
      <Badge color="red" variant="soft" title={row.last_error ?? 'Cvent rejected this registration'}>
        Failed{row.attempts > 1 ? ` ×${row.attempts}` : ''}
      </Badge>
    );
  } else if (ledger.truncated) {
    body = (
      <Badge color="gray" variant="soft" title="Too many registrations to show each one's state; see the status line">
        Unknown
      </Badge>
    );
  } else if (ledger.syncEnabled) {
    body = (
      <Badge color="gray" variant="soft" title="Will be pushed by the next sync run">
        Pending
      </Badge>
    );
  } else {
    body = (
      <Badge color="gray" variant="soft" title="Live sync is off; use Sync now or turn it on in the Cvent tab">
        Not synced
      </Badge>
    );
  }

  return <Td>{body}</Td>;
}

export default CventRegistrationCell;
