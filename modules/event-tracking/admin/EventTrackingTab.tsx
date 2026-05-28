import { AdPlatformSettings } from './components/AdPlatformSettings';
import { CventSettings } from './components/CventSettings';
import { ConversionLog } from './components/ConversionLog';

interface EventTrackingTabProps {
  eventId: string;
  event?: any;
}

export function EventTrackingTab({ eventId, event }: EventTrackingTabProps) {
  return (
    <div className="space-y-6">
      <AdPlatformSettings
        eventId={eventId}
        accountId={event?.accountId || undefined}
        eventSlug={event?.eventSlug}
      />
      <CventSettings eventId={eventId} />
      <ConversionLog eventId={eventId} />
    </div>
  );
}

export default EventTrackingTab;
