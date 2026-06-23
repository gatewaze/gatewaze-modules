/**
 * Geography & timezone engagement tab for an edition (spec §9). Composes the
 * single-edition geo reports. Poll/vote results live on the Blocks tab (overall,
 * not per-region), so they're not shown here.
 */

import { GeoEngagementMap } from './GeoEngagementMap.js';
import { LocalTimeHeatmap } from './LocalTimeHeatmap.js';
import { BlockRegionMatrix } from './BlockRegionMatrix.js';
import { FollowTheSun } from './FollowTheSun.js';

export function EditionGeographyTab({ editionId }: { editionId: string }) {
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
      <FollowTheSun editionId={editionId} />
    </div>
  );
}

export default EditionGeographyTab;
