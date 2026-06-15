import type {
  BotDetectorModule,
  BotDetectionResult,
  BotSignal,
  InteractionContext,
} from '../bulk-emailing/types/bot-detector.ts';

// ---------------------------------------------------------------------------
// Known scanner user-agent patterns
// ---------------------------------------------------------------------------
const KNOWN_SCANNER_PATTERNS: RegExp[] = [
  /barracuda/i,
  /mimecast/i,
  /proofpoint/i,
  /fortiguard/i,
  /forcepoint/i,
  /zscaler/i,
  /symantec/i,
  /fireeye/i,
  /trendmicro/i,
  /sophos/i,
  /ironport/i,
  /messagelabs/i,
  /spamhaus/i,
  /cloudmark/i,
  /Microsoft\.Outlook/i,
  /WindowsLiveReader/i,
];

const BOT_UA_KEYWORDS = /bot|crawler|spider|scan|check|monitor|fetch|prefetch|preview/i;

// ---------------------------------------------------------------------------
// Known proxy CIDR ranges
// ---------------------------------------------------------------------------
interface CidrRange {
  network: number;
  mask: number;
  label: string;
}

const KNOWN_PROXY_CIDRS: Array<{ cidr: string; label: string }> = [
  { cidr: '17.0.0.0/8', label: 'Apple (MPP / iCloud Relay)' },
  { cidr: '66.102.0.0/20', label: 'Google Image Proxy' },
  { cidr: '66.249.64.0/19', label: 'GoogleBot' },
  { cidr: '209.85.128.0/17', label: 'Google infrastructure' },
];

function ipToInt(ip: string): number {
  return ip.split('.').reduce((acc, octet) => (acc << 8) + parseInt(octet, 10), 0) >>> 0;
}

function parseCidr(cidr: string): { network: number; mask: number } {
  const [range, bits] = cidr.split('/');
  const mask = ~(2 ** (32 - parseInt(bits, 10)) - 1) >>> 0;
  return { network: ipToInt(range) & mask, mask };
}

const PARSED_CIDRS: CidrRange[] = KNOWN_PROXY_CIDRS.map(({ cidr, label }) => ({
  ...parseCidr(cidr),
  label,
}));

function matchProxyCidr(ip: string): CidrRange | null {
  // Only handle IPv4 for now
  if (!ip || ip.includes(':')) return null;
  try {
    const ipNum = ipToInt(ip);
    for (const range of PARSED_CIDRS) {
      if ((ipNum & range.mask) === range.network) return range;
    }
  } catch { /* invalid IP format */ }
  return null;
}

// ---------------------------------------------------------------------------
// Signal detection
// ---------------------------------------------------------------------------

function detectSignals(ctx: InteractionContext): BotSignal[] {
  const signals: BotSignal[] = [];

  // --- Timing signals ---
  if (ctx.deliveredAt) {
    const secondsSinceDelivery =
      (ctx.eventTimestamp.getTime() - ctx.deliveredAt.getTime()) / 1000;

    if (ctx.eventType === 'open') {
      if (secondsSinceDelivery >= 0 && secondsSinceDelivery < 2) {
        signals.push({
          id: 'timing_instant_open',
          adjustment: -0.70,
          detail: `Open ${secondsSinceDelivery.toFixed(1)}s after delivery`,
        });
      } else if (secondsSinceDelivery >= 2 && secondsSinceDelivery < 5) {
        signals.push({
          id: 'timing_fast_open',
          adjustment: -0.40,
          detail: `Open ${secondsSinceDelivery.toFixed(1)}s after delivery`,
        });
      }
    }

    if (ctx.eventType === 'click' && secondsSinceDelivery < 0) {
      signals.push({
        id: 'timing_click_before_open',
        adjustment: -0.60,
        detail: 'Click timestamp precedes delivery',
      });
    }
  }

  // --- Bulk click detection ---
  if (ctx.eventType === 'click' && ctx.recentInteractions.length > 0) {
    const recentClicks = ctx.recentInteractions.filter(
      (i) =>
        i.event_type === 'click' &&
        Math.abs(ctx.eventTimestamp.getTime() - new Date(i.event_timestamp).getTime()) < 5000
    );
    if (recentClicks.length >= 2) {
      // 3+ clicks counting this one
      signals.push({
        id: 'timing_bulk_clicks',
        adjustment: -0.80,
        detail: `${recentClicks.length + 1} clicks within 5 seconds`,
      });
    }

    // Check if all links in the email were clicked
    const allUrls = ctx.recentInteractions
      .filter((i) => i.event_type === 'click' && i.clicked_url)
      .map((i) => i.clicked_url);
    if (ctx.clickedUrl) allUrls.push(ctx.clickedUrl);
    const uniqueUrls = new Set(allUrls);
    if (uniqueUrls.size >= 5) {
      signals.push({
        id: 'pattern_all_links',
        adjustment: -0.70,
        detail: `${uniqueUrls.size} unique links clicked`,
      });
    }

    // Check for perfectly sequential click pattern
    const clickTimestamps = ctx.recentInteractions
      .filter((i) => i.event_type === 'click')
      .map((i) => new Date(i.event_timestamp).getTime())
      .sort();
    if (clickTimestamps.length >= 3) {
      const intervals = [];
      for (let i = 1; i < clickTimestamps.length; i++) {
        intervals.push(clickTimestamps[i] - clickTimestamps[i - 1]);
      }
      const avgInterval = intervals.reduce((a, b) => a + b, 0) / intervals.length;
      const variance = intervals.reduce((acc, v) => acc + Math.pow(v - avgInterval, 2), 0) / intervals.length;
      // Very low variance = suspiciously regular intervals
      if (avgInterval < 2000 && variance < 500) {
        signals.push({
          id: 'pattern_sequential',
          adjustment: -0.40,
          detail: `Sequential clicks with ${avgInterval.toFixed(0)}ms avg interval, ${variance.toFixed(0)} variance`,
        });
      }
    }
  }

  // --- User-agent signals ---
  if (!ctx.userAgent) {
    signals.push({
      id: 'ua_missing',
      adjustment: -0.20,
      detail: 'No user-agent provided',
    });
  } else {
    for (const pattern of KNOWN_SCANNER_PATTERNS) {
      if (pattern.test(ctx.userAgent)) {
        signals.push({
          id: 'ua_known_scanner',
          adjustment: -0.90,
          detail: `Matched scanner pattern: ${pattern.source}`,
        });
        break;
      }
    }
    if (BOT_UA_KEYWORDS.test(ctx.userAgent)) {
      signals.push({
        id: 'ua_bot_generic',
        adjustment: -0.90,
        detail: `User-agent contains bot keyword`,
      });
    }
  }

  // --- IP signals ---
  if (ctx.ip) {
    const proxyMatch = matchProxyCidr(ctx.ip);
    if (proxyMatch) {
      signals.push({
        id: 'ip_known_proxy',
        adjustment: -0.60,
        detail: proxyMatch.label,
      });
      // Apple MPP detection (IP-based, not UA-based)
      if (proxyMatch.label.includes('Apple')) {
        signals.push({
          id: 'ua_apple_mpp',
          adjustment: -0.50,
          detail: 'Apple Mail Privacy Protection proxy IP',
        });
      }
    }
  }

  // --- Provider MPP/prefetch signals ---
  // ESP-reported flags (Customer.io's proxied/prefetched/email_client) catch
  // Apple MPP where IP-range matching can't — notably IPv6 proxy opens, which
  // the IPv4-only CIDR check above silently misses. These are machine-leaning
  // but still recoverable by positive corroboration (clicks, repeat opens).
  const ps = ctx.providerSignals;
  if (ps) {
    const isApple = /apple|protected/i.test(ps.emailClient ?? '');
    if ((ps.proxied || isApple) && !signals.some((s) => s.id === 'ua_apple_mpp')) {
      signals.push({
        id: 'ua_apple_mpp',
        adjustment: -0.50,
        detail: 'Apple Mail Privacy Protection (provider flag)',
      });
    }
    if (ps.proxied && !signals.some((s) => s.id === 'ip_known_proxy')) {
      signals.push({ id: 'ip_known_proxy', adjustment: -0.60, detail: 'Proxied open (provider flag)' });
    }
    if (ps.prefetched) {
      signals.push({ id: 'mpp_prefetch', adjustment: -0.60, detail: 'Prefetched open (provider flag)' });
    }
  }

  // --- Positive corroboration signals ---
  if (ctx.eventType === 'click' && ctx.deliveredAt) {
    const secondsSinceDelivery =
      (ctx.eventTimestamp.getTime() - ctx.deliveredAt.getTime()) / 1000;

    // An open followed by a specific click 30s+ later is strong human behavior
    const hasRecentOpen = ctx.recentInteractions.some(
      (i) =>
        i.event_type === 'open' &&
        ctx.eventTimestamp.getTime() - new Date(i.event_timestamp).getTime() > 30000
    );
    if (hasRecentOpen && secondsSinceDelivery > 30) {
      signals.push({
        id: 'corroboration_open_then_click',
        adjustment: 0.30,
        detail: 'Click follows open by 30s+',
      });
    }
  }

  if (ctx.recipientHistory.humanOpenCount >= 3) {
    signals.push({
      id: 'corroboration_repeat_opener',
      adjustment: 0.20,
      detail: `${ctx.recipientHistory.humanOpenCount} previous human opens`,
    });
  }

  // NOTE: we deliberately do NOT rescue an open just because the recipient
  // clicked in some other edition. The question is per-edition — "was THIS open
  // a genuine human action" — and an Apple-MPP prefetch is a machine open even
  // for a person who is demonstrably human elsewhere. Cross-edition identity is
  // the wrong signal for per-edition open classification.

  return signals;
}

// ---------------------------------------------------------------------------
// Detector implementation
// ---------------------------------------------------------------------------

const detector: BotDetectorModule = {
  scorerId: 'signals-v1',

  async score(context: InteractionContext): Promise<BotDetectionResult> {
    const signals = detectSignals(context);
    let score = 1.0;
    for (const signal of signals) {
      score += signal.adjustment;
    }
    const humanConfidence = Math.max(0, Math.min(score, 1.0));

    return {
      humanConfidence,
      signals,
      scorerId: this.scorerId,
    };
  },

  async batchRescore(
    interactions: Array<{ id: string; context: InteractionContext }>
  ): Promise<Array<{ id: string; result: BotDetectionResult }>> {
    const results: Array<{ id: string; result: BotDetectionResult }> = [];
    for (const { id, context } of interactions) {
      const result = await this.score(context);
      results.push({ id, result });
    }
    return results;
  },
};

export default detector;
