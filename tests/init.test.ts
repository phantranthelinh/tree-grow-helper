import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { config, type Config } from '../src/config'
import type { LlmEngine } from '../src/llm'
import type { McpGateway, McpToolResult } from '../src/mcp/client'
import { applyLlmConfig, type SetupDeps } from '../src/setup/init'
import type { LlmConfig } from '../src/setup/llmConfig'
import type { ProbeResult } from '../src/setup/probe'
import { AppState } from '../src/setup/state'

/** LlmEngine that records how many times it embedded — the tell for whether RAG ran. */
class CountingLlm implements LlmEngine {
  embedCalls = 0
  async complete(): Promise<string> {
    return ''
  }
  async completeJson(): Promise<string> {
    return '{"type":"reply","message":"ok"}'
  }
  async embed(texts: string[]): Promise<number[][]> {
    this.embedCalls++
    return texts.map(() => [0.1, 0.2, 0.3])
  }
}

class FakeMcp implements McpGateway {
  async listTools() {
    return []
  }
  async callTool(): Promise<McpToolResult> {
    return { text: 'ok', isError: false }
  }
}

const LLM_CFG: LlmConfig = {
  provider: 'lmstudio',
  baseURL: 'http://localhost:1234/v1',
  apiKey: 'x',
  model: 'chat-model',
  embedModel: 'embed-model',
}

function makeDeps(llm: LlmEngine): Partial<SetupDeps> {
  return {
    probe: async (): Promise<ProbeResult> => ({ ok: true, models: [] }),
    buildEngine: () => llm,
    buildMcp: () => new FakeMcp(),
  }
}

/** Clone the real config into a throwaway temp dir so tests never touch data/. */
function testConfig(ragDisabled: boolean): Config {
  const dir = mkdtempSync(join(tmpdir(), 'tgh-init-'))
  return {
    ...config,
    setup: { ...config.setup, configPath: join(dir, 'llm-config.json') },
    mcp: { ...config.mcp, configPath: join(dir, 'mcp-config.json') },
    rag: {
      ...config.rag,
      disabled: ragDisabled,
      embedCachePath: join(dir, 'cache.jsonl'),
      docsDir: join(dir, 'docs'),
    },
  } as Config
}

describe('runInitPipeline RAG toggle', () => {
  it('skips RAG ingest and never embeds when RAG is disabled', async () => {
    const llm = new CountingLlm()
    const state = new AppState()

    const res = await applyLlmConfig(LLM_CFG, state, testConfig(true), makeDeps(llm))
    expect(res.ok).toBe(true)
    await state.initPromise

    expect(state.phase).toBe('ready')
    expect(llm.embedCalls).toBe(0)
    const rag = state.getStatus().steps.find((s) => s.id === 'rag')
    expect(rag?.status).toBe('done')
    expect(rag?.detail ?? '').toMatch(/tắt|RAG_DISABLED/i)
  })

  it('runs RAG ingest and embeds when RAG is enabled', async () => {
    const llm = new CountingLlm()
    const state = new AppState()

    await applyLlmConfig(LLM_CFG, state, testConfig(false), makeDeps(llm))
    await state.initPromise

    expect(state.phase).toBe('ready')
    expect(llm.embedCalls).toBeGreaterThan(0)
  })
})
