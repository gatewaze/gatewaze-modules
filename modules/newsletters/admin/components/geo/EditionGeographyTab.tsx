/**
 * Geography & timezone engagement tab for an edition (spec §9). Composes the
 * five reports. Feature-gating is done by the host page; this component assumes
 * it should render. Lazy-loaded from the edition detail page.
 */

import { useMemo } from 'react';
import { useGeoRpc } from './useGeoRpc.js';
import type { BlockGeoRow } from './geo-types.js';
import { GeoEngagementMap } from './GeoEngagementMap.js';
import { LocalTimeHeatmap } from './LocalTimeHeatmap.js';
import { BlockRegionMatrix } from './BlockRegionMatrix.js';
import { OptionRegionalSplit, pollBlocksFrom } from './OptionRegionalSplit.js';
import { FollowTheSun } from './FollowTheSun.js';

export function EditionGeographyTab({ editionId }: { editionId: string }) {
  // One block_geo fetch drives poll-block detection for R4 (R3 fetches its own).
  const { env } = useGeoRpc<BlockGeoRow>('newsletter_block_geo', { p_edition_id: editionId, p_level: 'country' }, [editionId]);
  const pollBlocks = useMemo(() => pollBlocksFrom(env?.data ?? []), [env]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">Geography &amp; timing</h2>
          <p className="text-sm text-gray-500">Where and when this edition was read and clicked, and how it landed per block.</p>
        </div>
      </div>

      <GeoEngagementMap editionId={editionId} />
      <LocalTimeHeatmap editionId={editionId} />
      <BlockRegionMatrix editionId={editionId} />
      {pollBlocks.length > 0 && <OptionRegionalSplit editionId={editionId} pollBlockIds={pollBlocks} />}
      <FollowTheSun editionId={editionId} />
    </div>
  );
}

export default EditionGeographyTab;
