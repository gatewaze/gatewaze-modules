/**
 * URL-friendly folder slug for a published edition, shared by the publish
 * pipeline (publish-to-git) and the send-time "View Online" link so the two
 * always agree on the path.
 *
 * Shape: `<edition_date>-<subject-slug>` (e.g. 2026-04-16-your-agent-works-can-
 * you-prove-it). The leading date keeps editions sorted and avoids same-day
 * collisions between different subjects; the subject makes the URL readable.
 * Falls back to the bare date when there's no usable subject.
 *
 * Each edition publishes to `<slug>/index.html` (+ `<slug>/edition.json`) at the
 * publish-branch root, so a static host serves it at `<base>/<slug>/` with no
 * `.html` suffix.
 */
export function editionFolderSlug(editionDate: string | Date, subject?: string | null): string {
  const date =
    typeof editionDate === 'string' ? editionDate.slice(0, 10) : editionDate.toISOString().slice(0, 10);

  const subjectSlug = String(subject ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // strip combining accent marks (NFKD splits "é" into "e" + accent)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-') // any run of non-alphanumerics -> single hyphen
    .replace(/^-+|-+$/g, '') // trim leading/trailing hyphens
    .slice(0, 60)
    .replace(/-+$/g, ''); // re-trim if the length cap landed on a hyphen

  return subjectSlug ? `${date}-${subjectSlug}` : date;
}
