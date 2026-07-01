import { describe, expect, it } from 'vitest'
import { cosineSimilarity, InMemoryVectorStore } from '../src/rag/store'

describe('cosineSimilarity', () => {
  it('is 1 for identical vectors', () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1)
  })
  it('is 0 for orthogonal vectors', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0)
  })
  it('is 0 for mismatched lengths or zero vectors', () => {
    expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0)
    expect(cosineSimilarity([0, 0], [0, 0])).toBe(0)
  })
})

describe('InMemoryVectorStore', () => {
  it('returns nearest records first, limited to topK', () => {
    const store = new InMemoryVectorStore()
    store.add([
      { id: 'a', text: 'a', embedding: [1, 0, 0] },
      { id: 'b', text: 'b', embedding: [0, 1, 0] },
      { id: 'c', text: 'c', embedding: [0.9, 0.1, 0] },
    ])
    expect(store.size()).toBe(3)
    const hits = store.search([1, 0, 0], 2)
    expect(hits).toHaveLength(2)
    expect(hits[0]?.id).toBe('a')
    expect(hits[1]?.id).toBe('c')
  })
})
