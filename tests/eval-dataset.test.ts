import { describe, expect, it } from 'vitest'
import { EVAL_CASES } from '../src/eval/dataset'
import { KNOWN_TOOLS } from '../src/mcp/knownTools'
import { classifyTool } from '../src/mcp/policy'

describe('eval dataset', () => {
  it('has at least 32 cases', () => {
    expect(EVAL_CASES.length).toBeGreaterThanOrEqual(32)
  })

  it('has unique ids', () => {
    const ids = EVAL_CASES.map((c) => c.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('covers every known MCP tool at least once', () => {
    const expected = new Set(
      EVAL_CASES.filter((c) => c.expect.type === 'tool').map((c) => c.expect.tool),
    )
    for (const tool of KNOWN_TOOLS) {
      expect(expected.has(tool.name), `missing eval case for tool ${tool.name}`).toBe(true)
    }
  })

  it('has at least 8 knowledge (reply) cases', () => {
    const replies = EVAL_CASES.filter((c) => c.expect.type === 'reply')
    expect(replies.length).toBeGreaterThanOrEqual(8)
  })

  it('labels each tool case with the correct safety class', () => {
    for (const c of EVAL_CASES) {
      if (c.expect.type === 'tool' && c.expect.tool && c.expect.safety) {
        expect(classifyTool(c.expect.tool), `bad safety for ${c.id}`).toBe(c.expect.safety)
      }
    }
  })

  it('only attaches grounding expectations to reply cases', () => {
    for (const c of EVAL_CASES) {
      if (c.grounding) {
        expect(c.expect.type, `grounding on non-reply case ${c.id}`).toBe('reply')
      }
    }
  })

  it('keeps the grounding metric meaningful: >=6 cases, >=2 requiring a citation', () => {
    const grounded = EVAL_CASES.filter((c) => c.grounding)
    expect(grounded.length).toBeGreaterThanOrEqual(6)
    const citing = grounded.filter((c) => c.grounding?.requireCitation)
    expect(citing.length).toBeGreaterThanOrEqual(2)
  })
})
