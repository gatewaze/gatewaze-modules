/**
 * Flag a mailbox provider whose open rate on one send is far below the other
 * providers' combined open rate.
 *
 * Gmail accepting mail and then filing it as spam looks like this: Gmail opens
 * near 2% while everyone else is near 30%. Apple opens are excluded from the
 * comparison because Apple Mail Privacy Protection opens messages
 * automatically, and 'unknown' is excluded because it mixes providers.
 */

import type { Provider } from './providers';

export interface ProviderStats {
  provider: Provider | string;
  delivered: number;
  opened: number;
}

export interface DetectorThresholds {
  /** A provider needs at least this many delivered messages to be judged. */
  minDelivered: number;
  /** The other providers must open at least this often, or the send is just unopened everywhere. */
  minBaselineRate: number;
  /** Alert when the provider's rate is below this fraction of the others' rate. */
  maxRatio: number;
}

export const DEFAULT_THRESHOLDS: DetectorThresholds = {
  minDelivered: 500,
  minBaselineRate: 0.1,
  maxRatio: 1 / 3,
};

export interface ProviderAlert {
  provider: string;
  delivered: number;
  providerOpenRate: number;
  baselineOpenRate: number;
}

const EXCLUDED_FROM_BASELINE = new Set(['apple', 'unknown']);

export function detect(stats: ReadonlyArray<ProviderStats>, t: DetectorThresholds = DEFAULT_THRESHOLDS): ProviderAlert[] {
  const alerts: ProviderAlert[] = [];
  for (const s of stats) {
    if (EXCLUDED_FROM_BASELINE.has(s.provider)) continue;
    if (s.delivered < t.minDelivered) continue;

    let baseDelivered = 0;
    let baseOpened = 0;
    for (const o of stats) {
      if (o.provider === s.provider || EXCLUDED_FROM_BASELINE.has(o.provider)) continue;
      baseDelivered += o.delivered;
      baseOpened += o.opened;
    }
    if (baseDelivered < t.minDelivered) continue;

    const baseline = baseOpened / baseDelivered;
    const rate = s.opened / s.delivered;
    if (baseline >= t.minBaselineRate && rate < baseline * t.maxRatio) {
      alerts.push({ provider: String(s.provider), delivered: s.delivered, providerOpenRate: rate, baselineOpenRate: baseline });
    }
  }
  return alerts;
}
