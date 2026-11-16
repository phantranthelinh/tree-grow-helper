import { describe, expect, it } from 'vitest'
import { formatContextText, retrieve } from './retrieve'
import { InMemoryVectorStore } from './store'

describe('formatContextText', () => {
  it('labels each chunk with its category and source url', () => {
    const text = formatContextText([
      { text: 'dâu ưa khí hậu mát', score: 0.9, category: 'grow', source: 'example.edu.vn' },
      { text: 'triệu chứng mốc xám', score: 0.8, category: 'disease' },
    ])
    expect(text).toContain('[kỹ thuật trồng · nguồn: example.edu.vn] dâu ưa khí hậu mát')
    expect(text).toContain('[bệnh] triệu chứng mốc xám')
    expect(text.split('\n\n')).toHaveLength(2)
  })

  it('falls back to the field label for curated profile chunks', () => {
    expect(formatContextText([{ text: 'tưới ở 75%', score: 1, field: 'watering' }])).toContain(
      '[tưới nước] tưới ở 75%',
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
    expect(res.contextText).toContain('[công dụng · nguồn: src.vn]')
  })
})

/** Embeds each known text to a fixed vector; anything else maps to the zero-ish fallback. */
class TableLlm {
  constructor(private readonly table: Record<string, number[]>) {}
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => this.table[t] ?? [0, 0, 0.01])
  }
}

function storeOf(table: Record<string, number[]>, texts: string[]): InMemoryVectorStore {
  const store = new InMemoryVectorStore()
  store.add(texts.map((text, i) => ({ id: `c${i}`, text, embedding: table[text]! })))
  return store
}

describe('retrieve gating and ranking', () => {
  const table: Record<string, number[]> = {
    q: [1, 0, 0],
    near: [0.99, 0.14, 0],
    nearDup: [0.98, 0.2, 0],
    far: [0.6, 0, 0.8],
    other: [0, 0, 1],
  }

  it('drops hits trailing the best one by more than relMargin', async () => {
    const store = storeOf(table, ['near', 'far'])
    const res = await retrieve(store, new TableLlm(table) as never, 'q', 5, 0, { relMargin: 0.15 })
    expect(res.chunks.map((c) => c.text)).toEqual(['near'])
  })

  it('drops hits below minScore', async () => {
    const store = storeOf(table, ['near', 'far', 'other'])
    const res = await retrieve(store, new TableLlm(table) as never, 'q', 5, 0.5)
    expect(res.chunks.map((c) => c.text)).toEqual(['near', 'far'])
  })

  it('MMR prefers a different chunk over a near-duplicate of the first pick', async () => {
    const store = storeOf(table, ['near', 'nearDup', 'far'])
    const plain = await retrieve(store, new TableLlm(table) as never, 'q', 2)
    expect(plain.chunks.map((c) => c.text)).toEqual(['near', 'nearDup'])
    const diverse = await retrieve(store, new TableLlm(table) as never, 'q', 2, 0, { mmrLambda: 0.5 })
    expect(diverse.chunks.map((c) => c.text)).toEqual(['near', 'far'])
  })

  it('searches previous + current message as a second query variant', async () => {
    const t: Record<string, number[]> = { ...table, 'prev q': [0, 0, 1] }
    const store = storeOf(t, ['near', 'other'])
    const alone = await retrieve(store, new TableLlm(t) as never, 'q', 2, 0.5)
    expect(alone.chunks.map((c) => c.text)).toEqual(['near'])
    const withPrev = await retrieve(store, new TableLlm(t) as never, 'q', 2, 0.5, { prevQuery: 'prev' })
    expect(withPrev.chunks.map((c) => c.text).sort()).toEqual(['near', 'other'])
  })

  it('hybrid lifts a chunk that matches the query words above a denser but unrelated one', async () => {
    const t: Record<string, number[]> = {
      'bệnh botrytis': [1, 0, 0],
      'dâu ưa khí hậu mát': [0.95, 0.31, 0],
      'trị bệnh botrytis bằng cách cắt bỏ quả thối': [0.9, 0.44, 0],
    }
    const store = storeOf(t, ['dâu ưa khí hậu mát', 'trị bệnh botrytis bằng cách cắt bỏ quả thối'])
    const dense = await retrieve(store, new TableLlm(t) as never, 'bệnh botrytis', 1)
    expect(dense.chunks[0]?.text).toBe('dâu ưa khí hậu mát')
    const hybrid = await retrieve(store, new TableLlm(t) as never, 'bệnh botrytis', 1, 0, { hybrid: true })
    expect(hybrid.chunks[0]?.text).toBe('trị bệnh botrytis bằng cách cắt bỏ quả thối')
  })

  it('hybrid keeps an exact-term match that the cosine margin alone would drop', async () => {
    const t: Record<string, number[]> = {
      'EC dung dịch': [1, 0, 0],
      'dâu ưa khí hậu mát': [0.95, 0.31, 0],
      'EC dung dịch giai đoạn ra hoa 1,5-1,8': [0.6, 0, 0.8],
    }
    const store = storeOf(t, ['dâu ưa khí hậu mát', 'EC dung dịch giai đoạn ra hoa 1,5-1,8'])
    const dense = await retrieve(store, new TableLlm(t) as never, 'EC dung dịch', 2, 0, { relMargin: 0.15 })
    expect(dense.chunks.map((c) => c.text)).toEqual(['dâu ưa khí hậu mát'])
    const hybrid = await retrieve(store, new TableLlm(t) as never, 'EC dung dịch', 2, 0, {
      relMargin: 0.15,
      hybrid: true,
    })
    expect(hybrid.chunks.map((c) => c.text)).toContain('EC dung dịch giai đoạn ra hoa 1,5-1,8')
  })

  it('minScore still drops a lexical match below the absolute floor', async () => {
    const t: Record<string, number[]> = {
      'EC dung dịch': [1, 0, 0],
      'dâu ưa khí hậu mát': [0.95, 0.31, 0],
      'EC dung dịch giai đoạn ra hoa': [0.2, 0, 0.98],
    }
    const store = storeOf(t, ['dâu ưa khí hậu mát', 'EC dung dịch giai đoạn ra hoa'])
    const res = await retrieve(store, new TableLlm(t) as never, 'EC dung dịch', 2, 0.5, { hybrid: true })
    expect(res.chunks.map((c) => c.text)).toEqual(['dâu ưa khí hậu mát'])
  })
})
