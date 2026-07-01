import { describe, expect, it } from 'vitest'
import { formatContextText, retrieve } from './retrieve'
import { InMemoryVectorStore } from './store'

describe('formatContextText', () => {
  it('labels each chunk with its category and source url', () => {
    const text = formatContextText([
      { text: 'dâu ưa khí hậu mát', score: 0.9, category: 'grow', source: 'example.edu.vn' },
      { text: 'triệu chứng mốc xám', score: 0.8, category: 'disease' },
    ])
    expect(text).toContain('[grow · nguồn: example.edu.vn] dâu ưa khí hậu mát')
    expect(text).toContain('[disease] triệu chứng mốc xám')
    expect(text.split('\n\n')).toHaveLength(2)
  })

  it('falls back to the field label for curated profile chunks', () => {
    expect(formatContextText([{ text: 'tưới ở 75%', score: 1, field: 'watering' }])).toContain(
      '[watering] tưới ở 75%',
    )
  })
})

class FakeLlm {
  async embed(texts: string[]): Promise<number[][]> {
    // one-hot on first char code so a query matches the record sharing that char
    return texts.map((t) => {
      const v = new Array(8).fill(0) as number[]
      v[(t.charCodeAt(0) || 0) % 8] = 1
      return v
    })
  }
}

describe('retrieve', () => {
  it('surfaces category and source from record metadata', async () => {
    const store = new InMemoryVectorStore()
    store.add([
      {
        id: 'd1',
        text: 'aaaa nội dung',
        embedding: (await new FakeLlm().embed(['aaaa nội dung']))[0]!,
        metadata: { category: 'uses', source_url: 'src.vn' },
      },
    ])
    const res = await retrieve(store, new FakeLlm() as never, 'aaaa gì đó', 1)
    expect(res.chunks[0]).toMatchObject({ category: 'uses', source: 'src.vn' })
    expect(res.contextText).toContain('[uses · nguồn: src.vn]')
  })
})
