import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { buildDocChunks, ingestDocs, readReviewedDocs, type SourceDoc } from './ingestDocs'
import { InMemoryVectorStore } from './store'

/** Orthogonal fake embeddings: identical text → identical vector, distinct → orthogonal. */
class FakeLlm {
  private ids = new Map<string, number>()
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => {
      if (!this.ids.has(t)) this.ids.set(t, this.ids.size)
      const v = new Array(64).fill(0) as number[]
      v[this.ids.get(t)! % 64] = 1
      return v
    })
  }
}

describe('buildDocChunks', () => {
  it('attaches source/category/plant metadata to each chunk', () => {
    const docs: SourceDoc[] = [
      { source_url: 'u1', category: 'grow', title: 'Trồng dâu', date: '2026-07-01', text: 'cách trồng dâu tây' },
    ]
    const chunks = buildDocChunks(docs, { plant: 'strawberry', minChunkLen: 1 })
    expect(chunks).toHaveLength(1)
    expect(chunks[0]!.metadata).toMatchObject({
      plant: 'strawberry',
      category: 'grow',
      source_url: 'u1',
      title: 'Trồng dâu',
      date: '2026-07-01',
    })
    expect(chunks[0]!.text).toContain('trồng dâu tây')
  })

  it('drops chunks below the minimum length', () => {
    const chunks = buildDocChunks([{ source_url: 'u', category: 'grow', text: 'x' }], { minChunkLen: 10 })
    expect(chunks).toHaveLength(0)
  })
})

describe('ingestDocs', () => {
  it('adds one record per distinct chunk and returns the count', async () => {
    const store = new InMemoryVectorStore()
    const n = await ingestDocs(store, new FakeLlm(), [
      { source_url: 'u1', category: 'grow', text: 'trồng dâu cần đất tơi xốp thoát nước tốt' },
      { source_url: 'u2', category: 'uses', text: 'dâu tây làm mứt sinh tố và bánh ngọt' },
    ], { minChunkLen: 5 })
    expect(n).toBe(2)
    expect(store.size()).toBe(2)
  })

  it('deduplicates identical passages scraped from different sources', async () => {
    const store = new InMemoryVectorStore()
    const dup = 'nội dung hướng dẫn trồng dâu giống hệt nhau hoàn toàn'
    const n = await ingestDocs(store, new FakeLlm(), [
      { source_url: 'u1', category: 'grow', text: dup },
      { source_url: 'u2', category: 'grow', text: dup },
    ], { minChunkLen: 5 })
    expect(n).toBe(1)
    expect(store.size()).toBe(1)
  })
})

describe('readReviewedDocs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'docs-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('returns an empty array when the directory does not exist', () => {
    expect(readReviewedDocs(join(dir, 'missing'))).toEqual([])
  })

  it('parses .jsonl records and ignores blank lines and non-jsonl files', () => {
    writeFileSync(
      join(dir, 'a.jsonl'),
      [
        JSON.stringify({ source_url: 'u1', category: 'grow', text: 'trồng dâu' }),
        '',
        JSON.stringify({ source_url: 'u2', category: 'uses', text: 'làm mứt' }),
      ].join('\n'),
    )
    writeFileSync(join(dir, 'notes.txt'), 'ignore me')
    const docs = readReviewedDocs(dir)
    expect(docs).toHaveLength(2)
    expect(docs.map((d) => d.category).sort()).toEqual(['grow', 'uses'])
  })
})
