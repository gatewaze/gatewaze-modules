import { Th } from '@/components/ui';
import { eventKey } from './api';
import { useEventLedger } from './useEventLedger';

/**
 * Header cell for the Cvent column on the registrations table (slot
 * `event-registrations:column-header`). Paired with CventRegistrationCell;
 * both render nothing until the event has a Cvent event id, so the table
 * gains the column only where it means something.
 */
interface Props {
  eventId: string;
  eventUuid?: string;
}

export function CventRegistrationColumnHeader({ eventId, eventUuid }: Props) {
  const { ledger } = useEventLedger(eventKey(eventId, eventUuid));
  if (!ledger?.configured) return null;
  return <Th>Cvent</Th>;
}

export default CventRegistrationColumnHeader;
