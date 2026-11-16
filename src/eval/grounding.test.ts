import { describe, expect, it } from 'vitest'
import { gradeGrounding, hasCitation, hasForeignScript } from './grounding'

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

describe('grader normalizations', () => {
  it('treats a Vietnamese decimal comma as a dot', () => {
    expect(gradeGrounding({ mustIncludeAny: ['5.5', '6.5'] }, 'Đất nên có pH từ 5,5 đến 6,5.').pass).toBe(true)
    expect(gradeGrounding({ mustIncludeAny: ['2,5 ngày'] }, 'Thu hoạch sau 2.5 ngày.').pass).toBe(true)
    expect(gradeGrounding({ mustIncludeAny: ['154'] }, 'N khoảng 154–182 mg/L.').pass).toBe(true)
  })

  it('does not let a decimal comma create a false pass', () => {
    expect(gradeGrounding({ mustIncludeAny: ['15'] }, 'Giữ ở 1,5 đến 2,5 lần.').pass).toBe(false)
  })

  it('counts "nguồn" only when it introduces a source', () => {
    expect(hasCitation('Bạn nên chọn nguồn cây giống sạch bệnh.')).toBe(false)
    expect(hasCitation('Dùng nguồn nước sạch để tưới.')).toBe(false)
    expect(hasCitation('Theo nguồn [https://nongnghiepmoitruong.vn/x], nên bón hữu cơ.')).toBe(true)
    expect(hasCitation('Tham khảo tại nguồn: https://www.sggp.org.vn/x')).toBe(true)
  })
})

describe('hasForeignScript', () => {
  it('flags Cyrillic, CJK ideographs and CJK punctuation', () => {
    expect(hasForeignScript('ánh sáng 6-13 часов/ngày')).toBe(true)
    expect(hasForeignScript('cung cấp 24小时/24小时')).toBe(true)
    expect(hasForeignScript('xong rồi。')).toBe(true)
  })
  it('passes Vietnamese text with units and symbols', () => {
    expect(hasForeignScript('Độ ẩm đất 75–80%, nhiệt độ 10-27°C, 100–110 µmol/m²/s, 20 cm × 20 cm.')).toBe(false)
  })
})
