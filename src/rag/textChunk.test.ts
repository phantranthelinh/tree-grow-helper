import { describe, expect, it } from 'vitest'
import { chunkDocument, dropShortChunks } from './textChunk'

describe('chunkDocument', () => {
  it('returns an empty array for blank text', () => {
    expect(chunkDocument('   \n\n  \t ', { size: 100 })).toEqual([])
  })

  it('returns a single normalized chunk when text fits in one window', () => {
    expect(chunkDocument('  hello   world\n', { size: 100 })).toEqual(['hello world'])
  })

  it('splits long text into multiple chunks that each respect the size limit', () => {
    // 30 words of ~5 chars → ~180 chars, size 60 forces several chunks.
    const text = Array.from({ length: 30 }, (_, i) => `word${i}`).join(' ')
    const chunks = chunkDocument(text, { size: 60, overlap: 0 })
    expect(chunks.length).toBeGreaterThan(1)
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(60)
  })

  it('preserves all words in order when overlap is zero', () => {
    const words = Array.from({ length: 20 }, (_, i) => `w${i}`)
    const chunks = chunkDocument(words.join(' '), { size: 25, overlap: 0 })
    expect(chunks.join(' ').split(' ')).toEqual(words)
  })

  it('overlaps consecutive chunks so context carries across the boundary', () => {
    const words = Array.from({ length: 20 }, (_, i) => `t${i}`)
    const chunks = chunkDocument(words.join(' '), { size: 30, overlap: 12 })
    expect(chunks.length).toBeGreaterThan(1)
    // The tail words of chunk N should reappear at the head of chunk N+1.
    const firstTail = chunks[0]!.split(' ').slice(-1)[0]!
    expect(chunks[1]!.split(' ')).toContain(firstTail)
  })

  it('breaks on word boundaries (no word is cut in half)', () => {
    const text = 'alpha bravo charlie delta echo foxtrot golf hotel'
    const chunks = chunkDocument(text, { size: 20, overlap: 6 })
    const original = new Set(text.split(' '))
    for (const c of chunks) for (const w of c.split(' ')) expect(original.has(w)).toBe(true)
  })
})

describe('dropShortChunks', () => {
  it('removes chunks shorter than the minimum length', () => {
    expect(dropShortChunks(['ok this is long enough', 'tiny', '   '], 10)).toEqual([
      'ok this is long enough',
    ])
  })
})
