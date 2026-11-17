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

  it('opens the toxicity entry with the missing pet data and the vet referral', () => {
    expect(p.toxicity).toMatch(
      /^Chưa có thông tin về độc tính của cây dâu với vật nuôi; nếu vật nuôi có dấu hiệu bất thường hãy hỏi bác sĩ thú y\. Dâu tây/,
    )
  })

  it('keeps the sentence that limits the food-safety claim to people', () => {
    // Without it the 3B read "chưa có thông tin về độc tính" as "không chứa chất độc" for pets in 25 of 36 samples.
    expect(p.toxicity).toContain('chỉ khẳng định quả dâu tây an toàn để ăn cho người')
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
