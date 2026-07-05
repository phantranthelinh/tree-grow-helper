import { describe, expect, it } from 'vitest'
import { loadProfile } from '../src/domain/profiles'
import { getFewshot } from '../src/domain/fewshot'
import { buildSystemPrompt } from '../src/llm/prompt'
import { KNOWN_TOOLS } from '../src/mcp/knownTools'

describe('system prompt', () => {
  // Regression for the "cụt/đứt đoạn" reply bug: the 3B model, forced to put its
  // whole answer inside the decision JSON's "message" string, kept writing a
  // lead-in ending in ":" then closing the JSON — the promised list never came
  // (finish_reason=stop, not a max_tokens cutoff). It handles prose-in-JSON fine
  // but chokes on lists-in-JSON, so the prompt forces flowing prose and forbids
  // the dangling colon. This instruction must land LAST (after the few-shot),
  // where the small model actually honors it.
  it('forces a prose reply and forbids the dangling colon', () => {
    const system = buildSystemPrompt({ profile: loadProfile('strawberry'), tools: KNOWN_TOOLS })
    expect(system).toMatch(/ĐOẠN VĂN/)
    expect(system).toMatch(/dấu hai chấm/)
  })

  it('places the prose rule after the few-shot examples (recency matters for the 3B)', () => {
    const system = buildSystemPrompt({ profile: loadProfile('strawberry'), tools: KNOWN_TOOLS, fewshot: 'VÍ_DỤ_MẪU' })
    expect(system.indexOf('VÍ_DỤ_MẪU')).toBeLessThan(system.indexOf('ĐOẠN VĂN'))
  })

  // A tool decision's "message" is the lead-in shown before the confirmation
  // prompt; it should carry purpose + expected effect (đủ ý), not a terse
  // filler, and must not fabricate current sensor readings.
  it('asks the tool message to state purpose + effect without inventing data', () => {
    const system = buildSystemPrompt({ profile: loadProfile('strawberry'), tools: KNOWN_TOOLS })
    expect(system).toMatch(/ĐỦ Ý/)
    expect(system).toMatch(/mục đích/)
    expect(system).toMatch(/KHÔNG bịa số liệu/)
  })

  // Field order is what actually makes the 3B emit a tool "message": it closes
  // the JSON right after "args", so "message" MUST come before "tool"/"args" in
  // the few-shot, or tool decisions arrive with no lead-in. Guard both the
  // few-shot and the schema template line against a message-last regression.
  it('puts "message" before "tool" in every type="tool" few-shot example', () => {
    const fewshot = getFewshot()
    // Few-shot examples are the real driver: message-first, never message-last.
    expect(fewshot).toMatch(/"type":"tool","message"/)
    expect(fewshot).not.toMatch(/"type":"tool","tool"/)
    // The schema template in rule 2 also shows the message-first shape.
    const system = buildSystemPrompt({ profile: loadProfile('strawberry'), tools: KNOWN_TOOLS })
    expect(system).toMatch(/\{"type":"tool","message":/)
  })
})
