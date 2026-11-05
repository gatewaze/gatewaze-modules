import { describe, expect, it } from 'vitest'
import { countCategories } from '../lib/category-counts'

const cats = [
  { id: 'a', name: 'MCP Dev Summit' },
  { id: 'b', name: 'MLOps Community' },
  { id: 'c', name: 'FinOps X' },
]

describe('countCategories', () => {
  it('drops categories with no visible items and keeps the order of the rest', () => {
    const items = [
      { category_id: 'b' }, { category_id: 'b' }, { category_id: 'b' },
      { category_id: null },
    ]
    expect(countCategories(cats, items)).toEqual([{ category: cats[1], count: 3 }])
  })

  it('counts every category that has at least one item', () => {
    const items = [{ category_id: 'c' }, { category_id: 'a' }, { category_id: 'c' }]
    expect(countCategories(cats, items).map((c) => [c.category.id, c.count])).toEqual([['a', 1], ['c', 2]])
  })

  it('returns nothing for an empty collection', () => {
    expect(countCategories(cats, [])).toEqual([])
  })
})
