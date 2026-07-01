import { describe, expect, it } from 'vitest'
import { DiseaseSchema, diseaseToText, loadDiseases } from './diseases'

const valid = {
  id: 'botrytis',
  name_vi: 'Mốc xám',
  name_sci: 'Botrytis cinerea',
  type: 'nấm',
  symptoms: ['quả thối mềm màu nâu', 'lớp mốc xám phủ trên quả'],
  affected_parts: ['quả', 'hoa'],
  favorable_conditions: { humidity: 85, note: 'ẩm cao, thông gió kém' },
  treatment: 'Ngắt bỏ quả bệnh, giảm ẩm, phun thuốc gốc đồng.',
  prevention: 'Trồng thưa, tưới gốc, thu quả chín kịp thời.',
  severity: 'cao',
  sources: ['https://example.edu.vn/botrytis'],
}

describe('DiseaseSchema', () => {
  it('parses a valid disease entry', () => {
    expect(() => DiseaseSchema.parse(valid)).not.toThrow()
  })

  it('rejects an unknown disease type', () => {
    expect(() => DiseaseSchema.parse({ ...valid, type: 'ngoài hành tinh' })).toThrow()
  })

  it('rejects an entry missing required symptoms', () => {
    const { symptoms, ...noSymptoms } = valid
    expect(() => DiseaseSchema.parse(noSymptoms)).toThrow()
  })
})

describe('diseaseToText', () => {
  it('builds a symptom-focused blob containing the name and every symptom', () => {
    const text = diseaseToText(DiseaseSchema.parse(valid))
    expect(text).toContain('Mốc xám')
    for (const s of valid.symptoms) expect(text).toContain(s)
    expect(text.startsWith('[bệnh]')).toBe(true)
  })
})

describe('loadDiseases', () => {
  it('loads and validates the seed strawberry disease KB', () => {
    const diseases = loadDiseases('strawberry')
    expect(diseases.length).toBeGreaterThan(0)
    for (const d of diseases) {
      expect(d.id.length).toBeGreaterThan(0)
      expect(d.symptoms.length).toBeGreaterThan(0)
    }
  })
})
