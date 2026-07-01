import { describe, expect, it } from 'vitest'
import { dedupeByEmbedding } from './dedupe'

const item = (id: string, embedding: number[]) => ({ id, embedding })

describe('dedupeByEmbedding', () => {
  it('returns an empty array unchanged', () => {
    expect(dedupeByEmbedding([], 0.95)).toEqual([])
  })

  it('keeps vectors that are not similar enough', () => {
    const items = [item('a', [1, 0]), item('b', [0, 1])] // cosine 0
    expect(dedupeByEmbedding(items, 0.95).map((i) => i.id)).toEqual(['a', 'b'])
  })

  it('drops a near-identical later vector, keeping the first', () => {
    const items = [item('a', [1, 0]), item('dup', [1, 0]), item('c', [0, 1])]
    expect(dedupeByEmbedding(items, 0.95).map((i) => i.id)).toEqual(['a', 'c'])
  })

  it('drops vectors whose similarity exceeds the threshold', () => {
    // cosine([1,0],[0.9,0.1]) ≈ 0.994 > 0.95 → dropped
    const items = [item('a', [1, 0]), item('b', [0.9, 0.1])]
    expect(dedupeByEmbedding(items, 0.95).map((i) => i.id)).toEqual(['a'])
  })

  it('keeps moderately similar vectors below the threshold', () => {
    // cosine([3,1],[1,3]) = 0.6 < 0.95 → both kept
    const items = [item('a', [3, 1]), item('b', [1, 3])]
    expect(dedupeByEmbedding(items, 0.95).map((i) => i.id)).toEqual(['a', 'b'])
  })
})
