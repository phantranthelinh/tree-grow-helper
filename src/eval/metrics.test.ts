import { describe, expect, it } from 'vitest'
import { type CaseResult, chunkRecall, matchesLabel, summarize } from './metrics'

const NA = 'https://ngheandost.gov.vn/x.html'

describe('matchesLabel / chunkRecall', () => {
  it('matches exact ids when the label carries #i', () => {
    expect(matchesLabel(`${NA}#1`, `${NA}#1`)).toBe(true)
    expect(matchesLabel(`${NA}#10`, `${NA}#1`)).toBe(false)
    expect(matchesLabel('strawberry:pests#0', 'strawberry:pests')).toBe(true)
    expect(matchesLabel('disease:aphid', 'disease:aphid')).toBe(true)
  })

  it('scores any-of groups', () => {
    expect(chunkRecall([[`${NA}#5`, `${NA}#6`]], [`${NA}#6`])).toBe(1)
    expect(chunkRecall([[`${NA}#5`], 'strawberry:pests'], ['strawberry:pests#0'])).toBe(0.5)
    expect(chunkRecall([[`${NA}#1`]], [`${NA}#11`, `${NA}#12`])).toBe(0)
  })
})

const base: CaseResult = {
  id: 'x',
  set: 'r0',
  want: 'reply',
  got: 'reply',
  exact: true,
  safety: true,
  reply: 'ok',
  grounding: null,
  expectChunks: null,
  recall: null,
  recallGated: null,
  retrieved: [],
  retrievedUngated: [],
  foreignScript: false,
  ms: 1,
}

describe('summarize', () => {
  it('aggregates exact, grounding, script cleanliness and recall', () => {
    const a: CaseResult = { ...base, id: 'A', want: 'get_latest_sensor', got: 'get_latest_sensor', reply: 'đang đọc' }
    const b: CaseResult = { ...base, id: 'B', grounding: { pass: false, reasons: ['x'] }, foreignScript: true }
    const c: CaseResult = {
      ...base,
      id: 'C',
      exact: false,
      expectChunks: [['disease:aphid']],
      recall: 1,
      recallGated: 0,
      retrievedUngated: [
        { id: 'disease:aphid', score: 0.7 },
        { id: 'strawberry:pests#0', score: 0.5 },
      ],
    }
    const s = summarize([a, b, c])
    expect(s.exact).toEqual({ hits: 2, total: 3, rate: 2 / 3 })
    expect(s.grounding).toEqual({ hits: 0, total: 1, rate: 0 })
    expect(s.scriptClean).toEqual({ hits: 2, total: 3, rate: 2 / 3 })
    expect(s.retrieval.annotated).toBe(1)
    expect(s.retrieval.recallGated).toBe(0)
    expect(s.retrieval.recallUngated).toBe(1)
    expect(s.retrieval.expectedScoreMean).toBeCloseTo(0.7)
    expect(s.retrieval.otherScoreMean).toBeCloseTo(0.5)
  })

  it("counts the model's own grounding apart from the shipped text's", () => {
    // A citation check the sources line satisfies while the model's own words did not.
    const a: CaseResult = { ...base, id: 'A', grounding: { pass: true, reasons: [] }, groundingModel: { pass: false, reasons: ['thiếu trích dẫn nguồn'] } }
    const b: CaseResult = { ...base, id: 'B', grounding: { pass: true, reasons: [] }, groundingModel: { pass: true, reasons: [] } }
    const s = summarize([a, b, base])
    expect(s.grounding).toEqual({ hits: 2, total: 2, rate: 1 })
    expect(s.groundingModel).toEqual({ hits: 1, total: 2, rate: 0.5 })
  })

  it('returns null rates for an empty set', () => {
    expect(summarize([]).grounding.rate).toBeNull()
    expect(summarize([]).retrieval.recallGated).toBeNull()
  })
})
