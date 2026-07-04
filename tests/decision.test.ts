import { describe, expect, it } from 'vitest'
import { AGENT_DECISION_JSON_SCHEMA, AgentDecisionSchema } from '../src/agent/decision'

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
