import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { embedWithCache, hashText, loadEmbedCache, saveEmbedCache } from './embedCache'

/** Fake engine: embeds a text as [length, 0] and records every batch it receives. */
class FakeLlm {
  calls: string[][] = []
  async embed(texts: string[]): Promise<number[][]> {
    this.calls.push(texts)
    return texts.map((t) => [t.length, 0])
  }
}

describe('hashText', () => {
  it('is deterministic and distinguishes different inputs', () => {
    expect(hashText('xin chào')).toBe(hashText('xin chào'))
    expect(hashText('xin chào')).not.toBe(hashText('tạm biệt'))
  })
})

describe('embedWithCache', () => {
  it('embeds every text on a cold cache and populates it', async () => {
    const llm = new FakeLlm()
    const cache = new Map<string, number[]>()
    const out = await embedWithCache(llm, ['aa', 'bbb'], cache)
    expect(out).toEqual([[2, 0], [3, 0]])
    expect(llm.calls).toEqual([['aa', 'bbb']])
    expect(cache.size).toBe(2)
  })

  it('serves a fully warm cache without calling the engine', async () => {
    const llm = new FakeLlm()
    const cache = new Map<string, number[]>()
    await embedWithCache(llm, ['aa', 'bbb'], cache)
    llm.calls = []
    const out = await embedWithCache(llm, ['aa', 'bbb'], cache)
    expect(out).toEqual([[2, 0], [3, 0]])
    expect(llm.calls).toEqual([])
  })

  it('only embeds cache-misses and keeps result order aligned to input', async () => {
    const llm = new FakeLlm()
    const cache = new Map<string, number[]>()
    await embedWithCache(llm, ['aa'], cache)
    llm.calls = []
    const out = await embedWithCache(llm, ['aa', 'cccc'], cache)
    expect(llm.calls).toEqual([['cccc']])
    expect(out).toEqual([[2, 0], [4, 0]])
  })

  it('reuses the cache for the same model prefix', async () => {
    const llm = new FakeLlm()
    const cache = new Map<string, number[]>()
    await embedWithCache(llm, ['aa'], cache, 'model-x')
    llm.calls = []
    const out = await embedWithCache(llm, ['aa'], cache, 'model-x')
    expect(llm.calls).toEqual([])
    expect(out).toEqual([[2, 0]])
  })

  it('misses (re-embeds) when the model prefix changes — no cross-model reuse', async () => {
    const llm = new FakeLlm()
    const cache = new Map<string, number[]>()
    await embedWithCache(llm, ['aa'], cache, 'model-x')
    llm.calls = []
    await embedWithCache(llm, ['aa'], cache, 'model-y')
    expect(llm.calls).toEqual([['aa']])
    // A bare-prefix lookup also misses model-namespaced entries (legacy stale cache).
    llm.calls = []
    await embedWithCache(llm, ['aa'], cache, '')
    expect(llm.calls).toEqual([['aa']])
  })
})

describe('saveEmbedCache / loadEmbedCache', () => {
  const dir = mkdtempSync(join(tmpdir(), 'embcache-'))
  const path = join(dir, 'embeddings.jsonl')
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('returns an empty cache when the file does not exist', () => {
    expect(loadEmbedCache(join(dir, 'nope.jsonl')).size).toBe(0)
  })

  it('round-trips a cache through disk', () => {
    const cache = new Map<string, number[]>([
      ['h1', [0.1, 0.2]],
      ['h2', [0.3, 0.4]],
    ])
    saveEmbedCache(path, cache)
    expect(existsSync(path)).toBe(true)
    const loaded = loadEmbedCache(path)
    expect(loaded.get('h1')).toEqual([0.1, 0.2])
    expect(loaded.get('h2')).toEqual([0.3, 0.4])
  })
})
