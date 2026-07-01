import { describe, expect, it } from 'vitest'
import { DiseaseSchema, loadDiseases } from '../domain/diseases'
import { buildDiseaseChunks, ingestDiseases } from './ingestDiseases'
import { InMemoryVectorStore } from './store'

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

const disease = DiseaseSchema.parse({
  id: 'botrytis',
  name_vi: 'Mốc xám',
  name_sci: 'Botrytis cinerea',
  type: 'nấm',
  symptoms: ['quả thối mềm màu nâu', 'lớp mốc xám phủ trên quả'],
  affected_parts: ['quả'],
  favorable_conditions: { humidity: 85, note: 'ẩm cao' },
  treatment: 'Ngắt bỏ quả bệnh.',
  prevention: 'Trồng thưa.',
  severity: 'cao',
})

describe('buildDiseaseChunks', () => {
  it('tags each chunk with disease metadata and symptom-focused text', () => {
    const chunks = buildDiseaseChunks([disease], { plant: 'strawberry' })
    expect(chunks).toHaveLength(1)
    expect(chunks[0]!.metadata).toMatchObject({
      plant: 'strawberry',
      category: 'disease',
      disease_id: 'botrytis',
      name_vi: 'Mốc xám',
      severity: 'cao',
    })
    expect(chunks[0]!.text).toContain('quả thối mềm màu nâu')
  })
})

describe('ingestDiseases', () => {
  it('adds one record per disease and returns the count', async () => {
    const store = new InMemoryVectorStore()
    const n = await ingestDiseases(store, new FakeLlm(), [disease], { plant: 'strawberry' })
    expect(n).toBe(1)
    expect(store.size()).toBe(1)
  })

  it('ingests the full seed strawberry disease KB end-to-end', async () => {
    const store = new InMemoryVectorStore()
    const diseases = loadDiseases('strawberry')
    const n = await ingestDiseases(store, new FakeLlm(), diseases, { plant: 'strawberry' })
    expect(n).toBe(diseases.length)
    expect(store.size()).toBeGreaterThanOrEqual(5)
  })
})
