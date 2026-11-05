/**
 * Which categories the collection sidebar lists.
 *
 * A category is shown only when at least one of the items the viewer can see
 * belongs to it. A visitor sees published items; an admin previewing also
 * sees drafts. So a category whose items are all draft disappears for
 * visitors (it would read "(0)") and stays for the admin, who can still open
 * it. Counts come from the same item list the page renders, so the number
 * beside a name always matches what clicking it shows.
 */
export interface CountedCategory<C> {
  category: C
  count: number
}

export function countCategories<C extends { id: string }, I extends { category_id: string | null }>(
  categories: readonly C[],
  items: readonly I[],
): CountedCategory<C>[] {
  const counts = new Map<string, number>()
  for (const item of items) {
    if (item.category_id) counts.set(item.category_id, (counts.get(item.category_id) ?? 0) + 1)
  }
  return categories
    .map((category) => ({ category, count: counts.get(category.id) ?? 0 }))
    .filter((c) => c.count > 0)
}
