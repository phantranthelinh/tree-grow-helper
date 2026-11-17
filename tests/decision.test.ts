import { describe, expect, it } from 'vitest'
import { AGENT_DECISION_JSON_SCHEMA, AgentDecisionSchema, MESSAGE_PATTERN } from '../src/agent/decision'

describe('AgentDecisionSchema', () => {
  it('parses a decision without reasoning (back-compat with existing callers)', () => {
    const r = AgentDecisionSchema.safeParse({ type: 'reply', message: 'xin chào' })
    expect(r.success).toBe(true)
  })

  it('parses and preserves an optional reasoning field', () => {
    const r = AgentDecisionSchema.safeParse({ reasoning: 'suy nghĩ ngắn', type: 'reply', message: 'ok' })
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.reasoning).toBe('suy nghĩ ngắn')
  })
})

describe('AGENT_DECISION_JSON_SCHEMA', () => {
  it('lists reasoning FIRST so schema-ordered backends emit CoT before deciding', () => {
    const props = AGENT_DECISION_JSON_SCHEMA.properties as Record<string, unknown>
    expect(Object.keys(props)[0]).toBe('reasoning')
  })

  it('still only requires type (reasoning stays optional)', () => {
    expect(AGENT_DECISION_JSON_SCHEMA.required as string[]).toEqual(['type'])
  })
})

// llama.cpp applies a string `pattern` to the raw JSON string body, escapes included.
const admits = (text: string) => new RegExp(MESSAGE_PATTERN, 'u').test(JSON.stringify(text).slice(1, -1))

describe('MESSAGE_PATTERN', () => {
  it('admits Vietnamese with the units, symbols and escapes replies use', () => {
    expect(admits('Độ ẩm đất 75–80%, nhiệt độ 10-27°C, 100–110 µmol/m²/s, 20 cm × 20 cm, ≤ 50.000₫ → tưới…')).toBe(true)
    expect(admits('Độ ẩm đất'.normalize('NFD'))).toBe(true)
    expect(admits('Theo "Khuyến nông Lâm Đồng":\nnên tưới nhỏ giọt.')).toBe(true)
    expect(admits('pH 5,5–6,5; EC 0.8–2.2 mS/cm; https://ngheandost.gov.vn/x-2490.html#2')).toBe(true)
    expect(admits('')).toBe(true)
  })

  it('rejects Cyrillic, CJK, kana, Hangul, Arabic, emoji and full-width punctuation', () => {
    for (const t of ['mỗi lần tưới 1 минут', 'nước ép giải渴。', 'tưới みず', '물 주기', 'دقائق', 'dâu 🍓', 'xong rồi：'])
      expect(admits(t), t).toBe(false)
  })

  it('rejects \\u escapes, which carried a CJK character past a deny-list', () => {
    expect(new RegExp(MESSAGE_PATTERN, 'u').test(String.raw`sau khi \u6253`)).toBe(false)
  })

  it('constrains message only, without the (?: groups LM Studio rejects', () => {
    const props = AGENT_DECISION_JSON_SCHEMA.properties as Record<string, { pattern?: string }>
    expect(props.message?.pattern).toBe(MESSAGE_PATTERN)
    expect(props.reasoning?.pattern).toBeUndefined()
    expect(MESSAGE_PATTERN).not.toContain('(?:')
  })
})
