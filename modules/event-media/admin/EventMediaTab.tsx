/**
 * Event-media tab — thin wrapper around the shared
 * `<HostMediaTab>` from @gatewaze-modules/host-media.
 *
 * Phase 2.2 of spec-host-media-module migrated event-media into a
 * thin host-media consumer. The historical EventMediaTab (which
 * directly drove the events_media table + bespoke upload pipeline)
 * is preserved in git history; this file delegates to the shared
 * polymorphic tab. Album manager, sponsor tagging, YouTube
 * delegation, and ZIP unpack are all retained because the consumer
 * registry block declares them enabled for host_kind='event'.
 */

import { HostMediaTab } from '@gatewaze-modules/host-media/admin';

interface EventMediaTabProps {
  eventId: string; // host_id — events.id (uuid)
}

export function EventMediaTab({ eventId }: EventMediaTabProps) {
  return (
    <HostMediaTab
      hostId={eventId}
      consumer={{
        hostKind: 'event',
        enableAlbums: true,
        enableSponsorTagging: true,
        enableYouTube: true,
        enableZipUnpack: true,
      }}
    />
  );
}

export default EventMediaTab;
