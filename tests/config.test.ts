import { afterEach, describe, expect, it, vi } from 'vitest'
import { boolEnv } from '../src/config'

describe('boolEnv', () => {
  it('reads "1"/"0" and falls back for anything else', () => {
    expect(boolEnv('1', false)).toBe(true)
    expect(boolEnv('0', true)).toBe(false)
    expect(boolEnv(undefined, true)).toBe(true)
    expect(boolEnv(undefined, false)).toBe(false)
    expect(boolEnv('', true)).toBe(true)
  })
})

describe('config.rag.hybrid', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('is off only when RAG_HYBRID=0', async () => {
    vi.stubEnv('RAG_HYBRID', '0')
    vi.resetModules()
    expect((await import('../src/config')).config.rag.hybrid).toBe(false)
    vi.stubEnv('RAG_HYBRID', '1')
    vi.resetModules()
    expect((await import('../src/config')).config.rag.hybrid).toBe(true)
  })
})

describe('config.llm.decisionMaxTokens', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('reads LLM_DECISION_MAX_TOKENS, 0 meaning no cap', async () => {
    vi.stubEnv('LLM_DECISION_MAX_TOKENS', '250')
    vi.resetModules()
    expect((await import('../src/config')).config.llm.decisionMaxTokens).toBe(250)
    vi.stubEnv('LLM_DECISION_MAX_TOKENS', '0')
    vi.resetModules()
    expect((await import('../src/config')).config.llm.decisionMaxTokens).toBe(0)
  })
})
