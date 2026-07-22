import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { config } from '../src/config'
import { buildServer } from '../src/http/server'
import type { LlmEngine } from '../src/llm'
import type { McpGateway, McpTool, McpToolResult } from '../src/mcp/client'
import type { SetupDeps } from '../src/setup/init'
import { loadLlmConfig } from '../src/setup/llmConfig'
import { loadMcpConfig } from '../src/setup/mcpConfig'
import type { ProbeResult } from '../src/setup/probe'
import { AppState } from '../src/setup/state'

class FakeLlm implements LlmEngine {
  async complete() {
    return 'ok'
  }
  async completeJson() {
    return '{"type":"reply","message":"Chào bạn!"}'
  }
  async *completeStream() {
    yield await this.complete()
  }
  async *completeJsonStream() {
    yield await this.completeJson()
  }
  async embed(t: string[]) {
    return t.map(() => [0, 0, 0])
  }
}

class FakeMcp implements McpGateway {
  async listTools() {
    return []
  }
  async callTool(): Promise<McpToolResult> {
    return { text: 'done', isError: false }
  }
}

function tool(name: string): McpTool {
  return { name, inputSchema: { type: 'object' } } as McpTool
}

/** Fake with tools + a close() spy, mirroring PlantMcpClient's optional close. */
class FakeMcpWithTools implements McpGateway {
  closed = false
  constructor(private readonly tools: McpTool[]) {}
  async listTools() {
    return this.tools
  }
  async callTool(): Promise<McpToolResult> {
    return { text: 'done', isError: false }
  }
  async close() {
    this.closed = true
  }
}

const dir = mkdtempSync(join(tmpdir(), 'setup-routes-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const configPath = join(dir, 'llm-config.json')

// Test config: isolate all disk writes (config + embed cache + session store)
// inside the temp dir, and point docs at an empty dir so RAG ingest stays hermetic.
const testConfig = {
  ...config,
  setup: { ...config.setup, configPath, probeTimeoutMs: 2000 },
  mcp: { ...config.mcp, configPath: join(dir, 'mcp-config.json') },
  rag: { ...config.rag, embedCachePath: join(dir, 'cache', 'emb.jsonl'), docsDir: join(dir, 'docs') },
  memory: { ...config.memory, sessionsPath: join(dir, 'sessions.json') },
} as unknown as typeof config

const okProbe = async (): Promise<ProbeResult> => ({ ok: true, models: ['m1'] })

function baseDeps(probe: SetupDeps['probe']): Partial<SetupDeps> {
  return {
    probe,
    buildEngine: () => new FakeLlm(),
    buildMcp: () => new FakeMcp(),
  }
}

const connectBody = {
  provider: 'lmstudio',
  baseURL: 'http://localhost:1234/v1',
  model: 'chat-a',
  embedModel: 'embed-b',
}

function waitFor(pred: () => boolean, tries = 200): Promise<void> {
  return new Promise((resolve, reject) => {
    let n = 0
    const tick = () => {
      if (pred()) return resolve()
      if (++n > tries) return reject(new Error('waitFor timed out'))
      setTimeout(tick, 5)
    }
    tick()
  })
}

describe('setup routes', () => {
  let state: AppState
  beforeEach(() => {
    state = new AppState()
  })

  it('POST /chat before ready returns 503 not_configured', async () => {
    const app = buildServer({ state, config: testConfig, setupDeps: baseDeps(okProbe) })
    const res = await app.inject({
      method: 'POST',
      url: '/chat',
      payload: { userId: 'u1', sessionId: 's1', message: 'hi' },
    })
    expect(res.statusCode).toBe(503)
    expect(res.json().error).toBe('not_configured')
    await app.close()
  })

  it('GET /api/setup/status returns waiting_config with defaults', async () => {
    const app = buildServer({ state, config: testConfig, setupDeps: baseDeps(okProbe) })
    const res = await app.inject({ method: 'GET', url: '/api/setup/status' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.phase).toBe('waiting_config')
    expect(body.defaults).toMatchObject({ provider: config.llmDefaults.provider })
    expect(body.defaults.mcpUrl).toBe(testConfig.mcp.url)
    await app.close()
  })

  it('connect happy path: saves config, reaches ready, then /chat works', async () => {
    const app = buildServer({ state, config: testConfig, setupDeps: baseDeps(okProbe) })
    const res = await app.inject({ method: 'POST', url: '/api/setup/connect', payload: connectBody })
    expect(res.statusCode).toBe(200)
    expect(res.json().ok).toBe(true)

    await state.initPromise
    expect(state.phase).toBe('ready')
    expect(existsSync(configPath)).toBe(true)
    expect(loadLlmConfig(configPath)).toMatchObject({ provider: 'lmstudio', model: 'chat-a' })

    const chat = await app.inject({
      method: 'POST',
      url: '/chat',
      payload: { userId: 'u1', sessionId: 's1', message: 'hi' },
    })
    expect(chat.statusCode).toBe(200)
    expect(chat.json().reply).toBe('Chào bạn!')
    await app.close()
  })

  it('connect probe failure returns 502 and does not write config', async () => {
    const failPath = join(dir, 'never.json')
    const failConfig = { ...testConfig, setup: { ...testConfig.setup, configPath: failPath } } as unknown as typeof config
    const probe: SetupDeps['probe'] = async () => ({
      ok: false,
      stage: 'chat',
      code: 'auth_failed',
      message: 'bad key',
    })
    const app = buildServer({ state, config: failConfig, setupDeps: baseDeps(probe) })
    const res = await app.inject({ method: 'POST', url: '/api/setup/connect', payload: connectBody })
    expect(res.statusCode).toBe(502)
    expect(res.json().error).toBe('auth_failed')
    expect(state.phase).toBe('waiting_config')
    expect(existsSync(failPath)).toBe(false)
    await app.close()
  })

  it('connect while busy returns 409', async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>((r) => {
      release = r
    })
    const blockingProbe: SetupDeps['probe'] = async () => {
      await gate
      return { ok: true, models: [] }
    }
    const app = buildServer({ state, config: testConfig, setupDeps: baseDeps(blockingProbe) })
    await app.ready() // finish async plugin registration so the handler runs promptly

    const first = app.inject({ method: 'POST', url: '/api/setup/connect', payload: connectBody })
    await waitFor(() => state.isBusy())

    const second = await app.inject({ method: 'POST', url: '/api/setup/connect', payload: connectBody })
    expect(second.statusCode).toBe(409)
    expect(second.json().error).toBe('busy')

    release?.()
    await first
    await state.initPromise
    await app.close()
  })

  it('connect with missing model returns 400 invalid_request', async () => {
    const app = buildServer({ state, config: testConfig, setupDeps: baseDeps(okProbe) })
    const res = await app.inject({
      method: 'POST',
      url: '/api/setup/connect',
      payload: { provider: 'lmstudio', baseURL: 'http://localhost:1234/v1', embedModel: 'e' },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe('invalid_request')
    await app.close()
  })

  it('POST /api/setup/mcp/test returns the tool count and closes the probe client', async () => {
    const fake = new FakeMcpWithTools([tool('read_soil'), tool('water_on')])
    const deps: Partial<SetupDeps> = { ...baseDeps(okProbe), buildMcp: () => fake }
    const app = buildServer({ state, config: testConfig, setupDeps: deps })
    const res = await app.inject({
      method: 'POST',
      url: '/api/setup/mcp/test',
      payload: { url: 'http://localhost:9999/mcp' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ ok: true, toolCount: 2, tools: ['read_soil', 'water_on'] })
    expect(fake.closed).toBe(true)
    await app.close()
  })

  it('POST /api/setup/mcp/test returns 502 unreachable when listTools throws', async () => {
    const broken: McpGateway = {
      listTools: async () => {
        throw new Error('ECONNREFUSED')
      },
      callTool: async () => ({ text: '', isError: true }),
    }
    const deps: Partial<SetupDeps> = { ...baseDeps(okProbe), buildMcp: () => broken }
    const app = buildServer({ state, config: testConfig, setupDeps: deps })
    const res = await app.inject({
      method: 'POST',
      url: '/api/setup/mcp/test',
      payload: { url: 'http://localhost:9999/mcp' },
    })
    expect(res.statusCode).toBe(502)
    expect(res.json().error).toBe('unreachable')
    await app.close()
  })

  it('POST /api/setup/mcp/test with a non-URL returns 400 invalid_request', async () => {
    const app = buildServer({ state, config: testConfig, setupDeps: baseDeps(okProbe) })
    const res = await app.inject({
      method: 'POST',
      url: '/api/setup/mcp/test',
      payload: { url: 'not-a-url' },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe('invalid_request')
    await app.close()
  })

  it('connect with mcpUrl saves mcp-config.json and pipes the URL into the pipeline', async () => {
    const mcpPath = join(dir, 'saved-mcp.json')
    const cfg = { ...testConfig, mcp: { ...testConfig.mcp, configPath: mcpPath } } as unknown as typeof config
    let captured: string | undefined
    const deps: Partial<SetupDeps> = {
      ...baseDeps(okProbe),
      buildMcp: (url: string) => {
        captured = url
        return new FakeMcp()
      },
    }
    const app = buildServer({ state, config: cfg, setupDeps: deps })
    const res = await app.inject({
      method: 'POST',
      url: '/api/setup/connect',
      payload: { ...connectBody, mcpUrl: 'http://localhost:9001/mcp' },
    })
    expect(res.statusCode).toBe(200)

    await state.initPromise
    expect(state.phase).toBe('ready')
    expect(captured).toBe('http://localhost:9001/mcp')
    expect(loadMcpConfig(mcpPath)).toEqual({ url: 'http://localhost:9001/mcp' })

    const status = await app.inject({ method: 'GET', url: '/api/setup/status' })
    expect(status.json().config.mcpUrl).toBe('http://localhost:9001/mcp')
    await app.close()
  })

  it('connect without mcpUrl falls back to env and writes no mcp config file', async () => {
    const mcpPath = join(dir, 'compat-mcp.json')
    const cfg = { ...testConfig, mcp: { ...testConfig.mcp, configPath: mcpPath } } as unknown as typeof config
    let captured: string | undefined
    const deps: Partial<SetupDeps> = {
      ...baseDeps(okProbe),
      buildMcp: (url: string) => {
        captured = url
        return new FakeMcp()
      },
    }
    const app = buildServer({ state, config: cfg, setupDeps: deps })
    const res = await app.inject({ method: 'POST', url: '/api/setup/connect', payload: connectBody })
    expect(res.statusCode).toBe(200)

    await state.initPromise
    expect(state.phase).toBe('ready')
    expect(captured).toBe(testConfig.mcp.url)
    expect(existsSync(mcpPath)).toBe(false)
    await app.close()
  })

  it('POST /api/setup/rag/rebuild before ready returns 503 not_configured', async () => {
    const app = buildServer({ state, config: testConfig, setupDeps: baseDeps(okProbe) })
    const res = await app.inject({ method: 'POST', url: '/api/setup/rag/rebuild' })
    expect(res.statusCode).toBe(503)
    expect(res.json().error).toBe('not_configured')
    await app.close()
  })

  it('POST /api/setup/rag/rebuild after ready returns 200 with counts', async () => {
    const app = buildServer({ state, config: testConfig, setupDeps: baseDeps(okProbe) })
    await app.inject({ method: 'POST', url: '/api/setup/connect', payload: connectBody })
    await state.initPromise
    expect(state.phase).toBe('ready')

    const res = await app.inject({ method: 'POST', url: '/api/setup/rag/rebuild' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.ok).toBe(true)
    expect(body).toHaveProperty('storeSize')
    expect(body).toHaveProperty('ms')
    await app.close()
  })
})
