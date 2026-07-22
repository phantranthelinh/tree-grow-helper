import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { config, type Config } from '../src/config'
import type { LlmEngine } from '../src/llm'
import type { McpGateway, McpToolResult } from '../src/mcp/client'
import { applyLlmConfig, rebuildRag, type SetupDeps } from '../src/setup/init'
import type { LlmConfig } from '../src/setup/llmConfig'
import type { ProbeResult } from '../src/setup/probe'
import { AppState } from '../src/setup/state'

class TogglingLlm implements LlmEngine {
  failEmbed = false
  embedCalls = 0
  async complete() {
    return ''
  }
  async completeJson() {
    return '{"type":"reply","message":"ok"}'
  }
  async *completeStream() {
    yield ''
  }
  async *completeJsonStream() {
    yield '{}'
  }
  async embed(texts: string[]) {
    if (this.failEmbed) throw new Error('embed down')
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
  model: 'chat',
  embedModel: 'embed',
}

function makeDeps(llm: LlmEngine): Partial<SetupDeps> {
  return {
    probe: async (): Promise<ProbeResult> => ({ ok: true, models: [] }),
    buildEngine: () => llm,
    buildMcp: () => new FakeMcp(),
  }
}

function testConfig(ragDisabled = false): Config {
  const dir = mkdtempSync(join(tmpdir(), 'tgh-rebuild-'))
  return {
    ...config,
    setup: { ...config.setup, configPath: join(dir, 'llm-config.json') },
    mcp: { ...config.mcp, configPath: join(dir, 'mcp-config.json') },
    rag: { ...config.rag, disabled: ragDisabled, embedCachePath: join(dir, 'cache.jsonl'), docsDir: join(dir, 'docs') },
    memory: { ...config.memory, sessionsPath: join(dir, 'sessions.json') },
  } as Config
}

async function ready(llm: LlmEngine, cfg: Config): Promise<AppState> {
  const state = new AppState()
  await applyLlmConfig(LLM_CFG, state, cfg, makeDeps(llm))
  await state.initPromise
  return state
}

describe('rebuildRag', () => {
  it('rebuilds and swaps the orchestrator on success', async () => {
    const llm = new TogglingLlm()
    const cfg = testConfig(false)
    const state = await ready(llm, cfg)
    const before = state.orchestrator

    const res = await rebuildRag(state, cfg)

    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.profile).toBeGreaterThan(0)
      expect(res.storeSize).toBeGreaterThan(0)
      expect(typeof res.ms).toBe('number')
    }
    expect(state.orchestrator).not.toBe(before) // swapped
    expect(state.isRebuilding()).toBe(false)
  })

  it('returns not_configured when there is no orchestrator', async () => {
    const res = await rebuildRag(new AppState(), testConfig(false))
    expect(res).toMatchObject({ ok: false, code: 'not_configured' })
  })

  it('returns rag_disabled when RAG is off', async () => {
    const cfg = testConfig(true)
    const state = await ready(new TogglingLlm(), cfg)
    const res = await rebuildRag(state, cfg)
    expect(res).toMatchObject({ ok: false, code: 'rag_disabled' })
  })

  it('returns busy when a config change is in flight', async () => {
    const cfg = testConfig(false)
    const state = await ready(new TogglingLlm(), cfg)
    state.beginConnecting() // isBusy() → true, orchestrator stays set
    const res = await rebuildRag(state, cfg)
    expect(res).toMatchObject({ ok: false, code: 'busy' })
  })

  it('keeps the old orchestrator when embedding fails (build-then-swap)', async () => {
    const llm = new TogglingLlm()
    const cfg = testConfig(false)
    const state = await ready(llm, cfg)
    const before = state.orchestrator

    // Force a cold cache so the rebuild actually calls embed() (which now fails);
    // with the warm cache from ready() nothing would be re-embedded.
    const coldCfg: Config = {
      ...cfg,
      rag: { ...cfg.rag, embedCachePath: join(mkdtempSync(join(tmpdir(), 'tgh-cold-')), 'cold.jsonl') },
    }
    llm.failEmbed = true
    const res = await rebuildRag(state, coldCfg)

    expect(res).toMatchObject({ ok: false, code: 'embed_failed' })
    expect(state.orchestrator).toBe(before) // unchanged
    expect(state.isRebuilding()).toBe(false)
  })
})
