import { beforeEach, describe, expect, it } from 'vitest'
import { Orchestrator } from '../src/agent/orchestrator'
import { loadProfile } from '../src/domain/profiles'
import { buildServer } from '../src/http/server'
import type { LlmEngine } from '../src/llm'
import type { McpGateway, McpToolResult } from '../src/mcp/client'
import { SessionStore } from '../src/memory/sessions'
import { InMemoryVectorStore } from '../src/rag/store'

class FakeLlm implements LlmEngine {
  jsonQueue: string[] = []
  async complete() {
    return 'ok'
  }
  async completeJson() {
    return this.jsonQueue.shift() ?? '{"type":"reply","message":"..."}'
  }
  async embed(t: string[]) {
    return t.map(() => [0, 0, 0])
  }
}

class FakeMcp implements McpGateway {
  calls: string[] = []
  result: McpToolResult = { text: 'done', isError: false }
  async listTools() {
    return []
  }
  async callTool(name: string): Promise<McpToolResult> {
    this.calls.push(name)
    return this.result
  }
}

function makeApp(llm: FakeLlm, mcp: FakeMcp) {
  const orch = new Orchestrator({
    llm,
    mcp,
    store: new InMemoryVectorStore(),
    sessions: new SessionStore(),
    profile: loadProfile('strawberry'),
    tools: [],
    maxToolSteps: 3,
    ragTopK: 4,
  })
  return buildServer(orch)
}

describe('HTTP API', () => {
  let llm: FakeLlm
  let mcp: FakeMcp

  beforeEach(() => {
    llm = new FakeLlm()
    mcp = new FakeMcp()
  })

  it('GET /health returns ok', async () => {
    const app = makeApp(llm, mcp)
    const res = await app.inject({ method: 'GET', url: '/health' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ status: 'ok' })
    await app.close()
  })

  it('POST /chat validates the body', async () => {
    const app = makeApp(llm, mcp)
    const res = await app.inject({ method: 'POST', url: '/chat', payload: { userId: 'u1' } })
    expect(res.statusCode).toBe(400)
    await app.close()
  })

  it('POST /chat returns a reply', async () => {
    llm.jsonQueue = ['{"type":"reply","message":"Chào bạn!"}']
    const app = makeApp(llm, mcp)
    const res = await app.inject({
      method: 'POST',
      url: '/chat',
      payload: { userId: 'u1', sessionId: 's1', message: 'hi' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().reply).toBe('Chào bạn!')
    expect(res.json().pendingAction).toBeNull()
    await app.close()
  })

  it('POST /chat -> pendingAction, then /chat/confirm executes', async () => {
    llm.jsonQueue = ['{"type":"tool","tool":"send_command","args":{"device_id":"d1","command":"WATER_ON"}}']
    const app = makeApp(llm, mcp)
    const chat = await app.inject({
      method: 'POST',
      url: '/chat',
      payload: { userId: 'u1', sessionId: 's1', message: 'tưới đi' },
    })
    const pending = chat.json().pendingAction
    expect(pending).not.toBeNull()
    expect(mcp.calls).toHaveLength(0)

    const confirm = await app.inject({
      method: 'POST',
      url: '/chat/confirm',
      payload: { userId: 'u1', sessionId: 's1', actionId: pending.id, approved: true },
    })
    expect(confirm.statusCode).toBe(200)
    expect(confirm.json().reply).toContain('Đã thực hiện')
    expect(mcp.calls).toEqual(['send_command'])
    await app.close()
  })
})
