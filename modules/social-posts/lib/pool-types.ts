/** The content types a post can be written from (content-platform type keys). */
export const POOL_TYPES = ['blog_post', 'video', 'event', 'sr_item'] as const;
export type PoolType = (typeof POOL_TYPES)[number];

export function isPoolType(v: unknown): v is PoolType {
  return typeof v === 'string' && (POOL_TYPES as readonly string[]).includes(v);
}

/** One curated item, the same shape whichever module owns it. */
export interface PoolItem {
  contentType: PoolType;
  contentId: string;
  /** e.g. "Blog post", "Video", "Event", or the resource collection's name ("Conference Recap"). */
  typeLabel: string;
  title: string;
  /** Public link, http(s) only; null when the item has none. */
  url: string | null;
  /** ISO date (YYYY-MM-DD): published, recorded, or the event's start. */
  date: string | null;
  location: string | null;
  /** One or two sentences: excerpt, description, subtitle. */
  summary: string | null;
  /** Longer plain text for the prompt. Only loaded for generation, never listed. */
  body: string | null;
  thumbnailUrl: string | null;
  /** Member companies the content-keywords rules matched this item to. */
  members: string[];
}
