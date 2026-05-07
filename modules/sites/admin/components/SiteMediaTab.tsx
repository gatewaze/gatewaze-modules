/**
 * Sites' media tab — thin wrapper around the shared
 * @gatewaze-modules/host-media `<HostMediaTab>`.
 *
 * Sites was historically the source of the per-host media library code;
 * Phase 2 of spec-host-media-module migrated it into the shared module.
 * This file remains as a backwards-compatibility shim for the existing
 * `<SiteMediaTab site={site}/>` callsite in `admin/pages/detail.tsx` so
 * we don't have to update consumer trees in lockstep with the module
 * rollout.
 */

import { HostMediaTab } from '@gatewaze-modules/host-media/admin';
import type { SiteRow } from '../../types';

interface MediaTabProps {
  site?: SiteRow;
  hostKind?: 'site' | 'list';
  hostId?: string;
}

export function SiteMediaTab(props: MediaTabProps) {
  const hostKind = props.hostKind ?? 'site';
  const hostId = props.hostId ?? props.site?.id;
  if (!hostId) throw new Error('SiteMediaTab requires site or {hostKind, hostId}');
  return (
    <HostMediaTab
      hostId={hostId}
      consumer={{
        hostKind,
        enableAlbums: false,
        enableSponsorTagging: false,
        enableYouTube: false,
        enableZipUnpack: false,
      }}
    />
  );
}
