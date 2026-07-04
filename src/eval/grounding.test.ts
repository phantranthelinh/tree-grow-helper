import { describe, expect, it } from 'vitest'
import { gradeGrounding, hasCitation } from './grounding'

describe('hasCitation', () => {
  it('is true when a known KB source is named', () => {
    expect(hasCitation('Bón đạm cân đối (theo Khuyến nông Lâm Đồng).')).toBe(true)
    expect(hasCitation('Nguồn: VAAS.')).toBe(true)
    expect(hasCitation('theo tạp chí VAAS')).toBe(true)
  })

  it('does NOT treat a bare "theo" as a citation', () => {
    expect(hasCitation('Bạn nên theo dõi độ ẩm đất hằng ngày.')).toBe(false)
    expect(hasCitation('Tưới theo nhu cầu của cây, tránh úng.')).toBe(false)
    expect(hasCitation('Bón phân theo mùa.')).toBe(false)
  })
})

describe('gradeGrounding', () => {
  it('passes when all expectations are met', () => {
    const g = { mustIncludeAny: ['75', '80'], forbid: ['30%'] }
    expect(gradeGrounding(g, 'Độ ẩm đất tối ưu cho dâu khoảng 75-80%.').pass).toBe(true)
  })

  it('fails and explains when a required token is missing', () => {
    const res = gradeGrounding({ mustIncludeAny: ['75', '80'] }, 'Giữ đất ẩm vừa phải.')
    expect(res.pass).toBe(false)
    expect(res.reasons.join(' ')).toContain('75')
  })

  it('requireCitation fails without a source', () => {
    expect(gradeGrounding({ requireCitation: true }, 'Bón phân cân đối.').pass).toBe(false)
    expect(gradeGrounding({ requireCitation: true }, 'Bón phân cân đối (theo VAAS).').pass).toBe(true)
  })

  it('forbids fabricated numbers even when spaced differently', () => {
    // Model writes "30 %" but the blacklist has "30%" — must still catch it.
    const res = gradeGrounding({ forbid: ['30%'] }, 'Giữ độ ẩm đất khoảng 30 % là đủ.')
    expect(res.pass).toBe(false)
    expect(res.reasons.join(' ')).toContain('30%')
  })

  it('mustInclude matches across arbitrary whitespace', () => {
    expect(gradeGrounding({ mustInclude: ['mốc xám'] }, 'Đây là bệnh mốc  xám (Botrytis).').pass).toBe(true)
  })

  it('empty expectations pass', () => {
    expect(gradeGrounding({}, 'bất kỳ câu nào').pass).toBe(true)
  })
})
