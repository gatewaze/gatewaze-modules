/** Schedule-source registry (spec §5.5). The enum grows as parsers are added. */
import { schedSource } from './sched.js';
import { sessionizeSource } from './sessionize.js';
import type { ScheduleSource } from './types.js';

export const SCHEDULE_SOURCES: ScheduleSource[] = [schedSource, sessionizeSource];

/** First source that claims the page, or null. */
export function detectSource(
  pageUrl: string,
  pageHtml?: string,
): { source: ScheduleSource; resolvedUrl: string } | null {
  for (const source of SCHEDULE_SOURCES) {
    const hit = source.detect(pageUrl, pageHtml);
    if (hit) return { source, resolvedUrl: hit.resolvedUrl };
  }
  return null;
}

export { schedSource, sessionizeSource };
