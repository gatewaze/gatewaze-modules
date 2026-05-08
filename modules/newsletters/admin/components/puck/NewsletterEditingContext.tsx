/**
 * Context exposed by NewsletterPuckCanvas down to inline custom Puck
 * fields (e.g. the Helix AI field on the HelixAiContent block).
 *
 * Why context: Puck's custom-field render function receives only
 * `{ value, onChange, name, id }` — it has no direct access to the
 * parent canvas' newsletter-collection metadata or its save callback.
 * Both are needed by `AiContentField` to:
 *
 *   - read the per-newsletter `helix_project_id` override (so different
 *     newsletters can target different Helix projects without code
 *     changes),
 *   - flush the edition to the database before kicking off a Helix
 *     research task (the edge function needs the block row to exist
 *     so it can stamp the task_id back into block.content).
 *
 * Mounted once at the canvas root; every inline field renderer that
 * needs these values reads them via `useNewsletterEditing()`.
 */
import { createContext, useContext, type ReactNode } from 'react';

export interface NewsletterEditingValue {
  /** Per-newsletter overrides — `helix_project_id` etc. */
  collectionMetadata: Record<string, unknown>;
  /** Persists the current edition. AI field calls this before starting
   *  a Helix task so the edge function can find the block row. */
  onSaveEdition: (() => Promise<void> | void) | undefined;
}

const NewsletterEditingContext = createContext<NewsletterEditingValue | undefined>(undefined);

export function NewsletterEditingProvider({
  value,
  children,
}: {
  value: NewsletterEditingValue;
  children: ReactNode;
}) {
  return <NewsletterEditingContext.Provider value={value}>{children}</NewsletterEditingContext.Provider>;
}

export function useNewsletterEditing(): NewsletterEditingValue {
  const v = useContext(NewsletterEditingContext);
  if (!v) {
    return { collectionMetadata: {}, onSaveEdition: undefined };
  }
  return v;
}
