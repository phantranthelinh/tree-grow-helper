import { describe, expect, it } from 'vitest'
import { loadProfile } from '../src/domain/profiles'
import { profileToChunks } from '../src/rag/ingest'

describe('strawberry knowledge enrichment', () => {
  const p = loadProfile('strawberry')

  it('has the scientific name and Vietnamese alias filled', () => {
    expect(p.scientific_name).toBe('Fragaria × ananassa')
    expect(p.aliases).toContain('dâu tây')
  })

  it('fills the previously-empty text fields', () => {
    for (const field of ['light_description', 'toxicity', 'care_notes'] as const) {
      expect(typeof p[field]).toBe('string')
      expect((p[field] as string).trim().length).toBeGreaterThan(20)
    }
  })

  it('states the fruit is safe to eat for humans (food-safety framing)', () => {
    expect(p.toxicity?.toLowerCase()).toContain('an toàn')
  })

  it('embeds the new text fields as RAG chunks', () => {
    const fields = new Set(profileToChunks(p).map((c) => c.field))
    expect(fields.has('light_description')).toBe(true)
    expect(fields.has('toxicity')).toBe(true)
    expect(fields.has('care_notes')).toBe(true)
  })

  it('records official Vietnamese sources', () => {
    expect(p.sources.some((s) => s.includes('vaas.vn'))).toBe(true)
    expect(p.sources.some((s) => s.includes('.gov.vn'))).toBe(true)
  })
})
