import { describe, expect, it } from 'vitest'
import {
  bigramDocFreq,
  generalRangeFields,
  rangeStatement,
  sourceNames,
  sourcesLine,
  withReplyNotes,
} from '../src/agent/replyNotes'
import { loadProfile } from '../src/domain/profiles'
import { BEAN_SPROUT_EVAL_CASES, EVAL_CASES } from '../src/eval/dataset'
import { hasCitation } from '../src/eval/grounding'

const strawberry = loadProfile('strawberry')
const bean = loadProfile('bean-sprout')
const STRAWBERRY_TEMP = 'Khoảng tối ưu chung hệ thống áp dụng cho cây dâu tây: nhiệt độ 10-27°C.'

describe('generalRangeFields', () => {
  it('fires on exactly the three general range questions of the eval sets', () => {
    const fired = [...EVAL_CASES, ...BEAN_SPROUT_EVAL_CASES]
      .filter((c) => generalRangeFields(c.message).length > 0)
      .map((c) => c.id)
    // r1-container-night, doc-container-temp and doc-lowland-climate ask about a setting, a time or a region
    // and want a document's figure; the sensor and configuration cases ask about the device.
    expect(fired).toEqual(['kb-temp', 'kb-moisture', 'bs-kb-temp'])
  })

  it.each([
    ['Nhiệt độ thích hợp cho dâu tây là bao nhiêu?', 'temperature_range'],
    ['Dâu tây sống tốt ở nhiệt độ khoảng nào?', 'temperature_range'],
    ['Trồng dâu cần nhiệt độ bao nhiêu độ?', 'temperature_range'],
    ['Nhiệt độ tối ưu cho cây dâu là mấy độ?', 'temperature_range'],
    ['Nhiệt độ lý tưởng để trồng dâu tây khoảng bao nhiêu?', 'temperature_range'],
    ['Độ ẩm không khí phù hợp cho dâu là bao nhiêu?', 'humidity_range'],
    ['Dâu tây cần độ ẩm đất khoảng bao nhiêu?', 'soil_moisture_range'],
    ['Cây dâu cần ánh sáng bao nhiêu lux?', 'light_range'],
    ['Cường độ ánh sáng thích hợp cho dâu là bao nhiêu?', 'light_range'],
    ['Giá đỗ cần nhiệt độ bao nhiêu?', 'temperature_range'],
    ['Độ ẩm không khí cho giá đỗ nên là bao nhiêu?', 'humidity_range'],
  ])('reads %s as a general question about %s', (question, field) => {
    expect(generalRangeFields(question)).toEqual([field])
  })

  it.each([
    'Cây dâu cần bao nhiêu giờ ánh sáng mỗi ngày?',
    'Dâu cần ánh sáng bao nhiêu giờ mỗi ngày?',
    'Bao lâu thì tưới, độ ẩm đất bao nhiêu ngày một lần?',
  ])('leaves the duration question %s alone', (question) => {
    expect(generalRangeFields(question)).toEqual([])
  })

  it.each([
    'Ban đêm nên giữ nhiệt độ cho dâu tây bao nhiêu?',
    'Nhà kính trồng dâu nên để nhiệt độ bao nhiêu?',
    'Dâu tây chịu được nhiệt độ cao nhất bao nhiêu?',
    'Giai đoạn ra hoa dâu cần nhiệt độ bao nhiêu?',
    'Trồng dâu ở Mộc Châu thì nhiệt độ thế nào, bao nhiêu độ?',
    'Nhiệt độ nước tưới cho dâu bao nhiêu là được?',
    'Nhiệt độ esp32-01 đang đo được bao nhiêu?',
    'Nhiệt độ bây giờ là bao nhiêu?',
    'Mùa đông nhiệt độ bao nhiêu thì dâu bị hại?',
    'Dâu trồng chậu ngoài ban công thì nên giữ độ ẩm đất bao nhiêu?',
    'Nhiệt độ quá cao là bao nhiêu thì dâu bị gì?',
    'Cây con dâu tây cần nhiệt độ bao nhiêu?',
    'Ánh sáng đèn LED cho dâu cần bao nhiêu?',
    'Bảo quản dâu tây ở nhiệt độ bao nhiêu?',
    'Nhiệt độ ảnh hưởng đến dâu tây bao nhiêu?',
    'Dâu tây có cần nhiều ánh sáng không?',
    'Độ ẩm bao nhiêu thì dâu tốt?',
  ])('leaves %s alone', (question) => {
    expect(generalRangeFields(question)).toEqual([])
  })
})

describe('rangeStatement', () => {
  it("states the profile's range when the reply gives another one", () => {
    expect(rangeStatement('Cây dâu tây thích hợp nhiệt độ khoảng bao nhiêu?', 'Dâu tây thích hợp ở 15 - 26°C.', strawberry)).toBe(
      STRAWBERRY_TEMP,
    )
  })

  it('says nothing when the reply already gives both bounds, in any spelling', () => {
    const asked = 'Nhiệt độ thích hợp cho dâu tây là bao nhiêu?'
    expect(rangeStatement('Độ ẩm đất tối ưu cho dâu là bao nhiêu phần trăm?', 'Khoảng 75-80%.', strawberry)).toBeNull()
    expect(rangeStatement(asked, 'Khoảng 10°C đến 27°C.', strawberry)).toBeNull()
  })

  it('counts a bound only as a number of its own, and needs both', () => {
    const asked = 'Nhiệt độ thích hợp cho dâu tây là bao nhiêu?'
    expect(rangeStatement(asked, 'Khoảng 100 đến 270 độ.', strawberry)).toBe(STRAWBERRY_TEMP)
    expect(rangeStatement(asked, 'Khoảng 10°C.', strawberry)).toBe(STRAWBERRY_TEMP)
  })

  it('says nothing for a setting-specific question or a range the profile does not have', () => {
    expect(rangeStatement('Ban đêm nên giữ nhiệt độ cho dâu tây bao nhiêu?', 'Khoảng 17°C.', strawberry)).toBeNull()
    expect(rangeStatement('Giá đỗ cần ánh sáng bao nhiêu lux?', 'Giá đỗ cần ủ trong tối.', bean)).toBeNull()
  })

  it("uses each plant's own profile", () => {
    expect(rangeStatement('Ủ giá đỗ cần nhiệt độ bao nhiêu?', 'Nên giữ 25°C.', bean)).toBe(
      'Khoảng tối ưu chung hệ thống áp dụng cho cây giá đỗ: nhiệt độ 27-30°C.',
    )
  })
})

describe('sourceNames', () => {
  it('names a document or disease entry by its host', () => {
    expect(sourceNames({ text: 'x', source: 'https://www.sggp.org.vn/a-b.html' })).toEqual(['sggp.org.vn'])
  })

  it('names a profile chunk by the institutions it cites, not by other parentheses', () => {
    const text =
      '[ánh sáng] Dâu cần nắng (Khuyến nông Lâm Đồng). LED trong container của Trung tâm Nghiên cứu Khoai tây (Đà Lạt). ' +
      'Ngó (thân bò/stolon) (Cổng KHCN VISTA; VAAS).'
    expect(sourceNames({ text, field: 'light_description' })).toEqual(['Khuyến nông Lâm Đồng', 'Cổng KHCN VISTA', 'VAAS'])
  })

  it('gives a disease entry without a source no name', () => {
    expect(sourceNames({ id: 'disease:aphid', text: '[bệnh] Rệp (Aphididae) — loại: sâu hại.' })).toEqual([])
  })
})

describe('sourcesLine', () => {
  const boric = {
    id: 'https://ngheandost.gov.vn/quy-trinh#6',
    text: 'Bổ sung acid Boric vào dung dịch dinh dưỡng từ 0,7 - 0,9 ppm khi cây bắt đầu ra hoa, nhắc lại sau một tuần.',
    source: 'https://ngheandost.gov.vn/quy-trinh',
  }
  const hanging = {
    id: 'https://www.sggp.org.vn/treo#0',
    text: 'Nông dân Đà Lạt trồng dâu tây treo, tưới 5-7 lần mỗi ngày.',
    source: 'https://www.sggp.org.vn/treo',
  }
  const df = bigramDocFreq([boric.text, hanging.text])
  const asked = 'Nên bón phân gì cho dâu khi cây ra hoa?'

  it('names the chunk the reply drew on, and the grader accepts it because it names a known source', () => {
    const line = sourcesLine('Khi dâu ra hoa, bổ sung acid Boric vào dung dịch dinh dưỡng từ 0,7 - 0,9 ppm.', asked, [hanging, boric], df)
    expect(line).toBe('Nguồn tham khảo: ngheandost.gov.vn.')
    expect(hasCitation(line ?? '')).toBe(true)
  })

  it('does not pass the grader on the prefix alone', () => {
    // sggp.org.vn is a real source outside the grader's marker list: the line names it and stays uncited.
    const line = sourcesLine('Trồng dâu tây treo thì tưới 5-7 lần mỗi ngày.', 'Dâu treo tưới mấy lần?', [hanging], df)
    expect(line).toBe('Nguồn tham khảo: sggp.org.vn.')
    expect(hasCitation(line ?? '')).toBe(false)
  })

  it('gives a greeting no sources, and does not count pairs the question already holds', () => {
    expect(sourcesLine('Chào bạn! Mình có thể giúp gì cho bạn?', 'Xin chào!', [hanging, boric], df)).toBeNull()
    expect(sourcesLine('Bổ sung acid Boric nhé.', 'Có nên bổ sung acid Boric không?', [boric], df)).toBeNull()
  })

  it('does not repeat a source the reply already names', () => {
    const reply = 'Theo ngheandost.gov.vn, bổ sung acid Boric vào dung dịch dinh dưỡng từ 0,7 - 0,9 ppm.'
    expect(sourcesLine(reply, asked, [boric], df)).toBeNull()
  })

  it('lists at most three names and drops a name contained in another', () => {
    const pests = {
      id: 'strawberry:pests#0',
      field: 'pests',
      text: '[sâu hại] Nhện đỏ, bọ trĩ, rệp hại dâu (Chi cục BVTV Lâm Đồng; Tạp chí VAAS; VAAS; Khuyến nông Lâm Đồng; Cổng KHCN VISTA).',
    }
    expect(sourcesLine('Dâu thường bị nhện đỏ, bọ trĩ, rệp hại dâu.', 'Dâu hay bị gì?', [pests], bigramDocFreq([pests.text]))).toBe(
      'Nguồn tham khảo: Chi cục BVTV Lâm Đồng; Tạp chí VAAS; Khuyến nông Lâm Đồng.',
    )
  })
})

describe('withReplyNotes', () => {
  it('puts the range statement, then the sources line, after the reply', () => {
    const study = {
      id: 'https://techport.vn/x#0',
      text: 'ngưỡng nhiệt độ thích hợp cho cây dâu tây là từ 15 - 26°C theo nghiên cứu',
      source: 'https://techport.vn/x',
    }
    const out = withReplyNotes('Dâu tây thích hợp ở 15 - 26°C theo nghiên cứu.', {
      question: 'Cây dâu tây thích hợp nhiệt độ khoảng bao nhiêu?',
      chunks: [study],
      docFreq: bigramDocFreq([study.text]),
      profile: strawberry,
    })
    expect(out).toBe(`Dâu tây thích hợp ở 15 - 26°C theo nghiên cứu.\n\n${STRAWBERRY_TEMP}\n\nNguồn tham khảo: techport.vn.`)
  })

  it('returns the reply unchanged when no note applies', () => {
    expect(withReplyNotes('Chào bạn!', { question: 'Xin chào!', chunks: [], docFreq: new Map(), profile: strawberry })).toBe('Chào bạn!')
  })
})
