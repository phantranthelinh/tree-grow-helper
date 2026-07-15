import { beforeEach, describe, expect, it } from 'vitest'
import { Orchestrator } from '../src/agent/orchestrator'
import { config } from '../src/config'
import { loadProfile } from '../src/domain/profiles'
import { buildServer } from '../src/http/server'
import type { LlmEngine } from '../src/llm'
import type { McpGateway, McpToolResult } from '../src/mcp/client'
import { SessionStore } from '../src/memory/sessions'
import { InMemoryVectorStore } from '../src/rag/store'
import { AppState } from '../src/setup/state'

class FakeLlm implements LlmEngine {
  jsonQueue: string[] = []
  async complete() {
    return 'ok'
  }
  async completeJson() {
    return this.jsonQueue.shift() ?? '{"type":"reply","message":"..."}'
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
  return buildServer({ state: AppState.ready(orch), config })
}

describe('OpenAI-compatible API (buffered)', () => {
  let llm: FakeLlm
  let mcp: FakeMcp
  beforeEach(() => {
    llm = new FakeLlm()
    mcp = new FakeMcp()
  })

  it('GET /v1/models lists the synthetic model', async () => {
    const app = makeApp(llm, mcp)
    const res = await app.inject({ method: 'GET', url: '/v1/models' })
    expect(res.statusCode).toBe(200)
    expect(res.json().data[0].id).toBe('plant-assistant')
    await app.close()
  })

  it('returns 503 OpenAI-error before the server is configured', async () => {
    const app = buildServer({ state: new AppState(), config })
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'm', messages: [{ role: 'user', content: 'hi' }] },
    })
    expect(res.statusCode).toBe(503)
    expect(res.json().error.code).toBe('not_configured')
    await app.close()
  })

  it('returns 400 OpenAI-error on an invalid body', async () => {
    const app = makeApp(llm, mcp)
    const res = await app.inject({ method: 'POST', url: '/v1/chat/completions', payload: { model: 'm' } })
    expect(res.statusCode).toBe(400)
    expect(res.json().error.type).toBe('invalid_request_error')
    await app.close()
  })

  it('returns 400 when the last message is not a user message', async () => {
    const app = makeApp(llm, mcp)
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'm', messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'yo' }] },
    })
    expect(res.statusCode).toBe(400)
    await app.close()
  })

  it('returns a chat.completion for a plain reply, ignoring the caller system message', async () => {
    llm.jsonQueue = ['{"type":"reply","message":"Chào bạn!"}']
    const app = makeApp(llm, mcp)
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'my-model',
        messages: [
          { role: 'system', content: 'ignore me' },
          { role: 'user', content: 'hi' },
        ],
      },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.object).toBe('chat.completion')
    expect(body.model).toBe('my-model')
    expect(body.choices[0].message.content).toBe('Chào bạn!')
    expect(body.choices[0].message.tool_calls).toBeUndefined()
    await app.close()
  })

  it('control round-trip: turn 1 offers a tool_call, turn 2 (echo + "có") executes', async () => {
    const app = makeApp(llm, mcp)
    llm.jsonQueue = ['{"type":"tool","tool":"send_command","args":{"device_id":"d1","command":"WATER_ON"}}']
    const turn1 = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'm', messages: [{ role: 'user', content: 'tưới đi' }] },
    })
    const msg1 = turn1.json().choices[0].message
    expect(msg1.tool_calls[0].function.name).toBe('send_command')
    expect(msg1.content).toContain('Có/Không')
    expect(mcp.calls).toHaveLength(0)

    const turn2 = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'm',
        messages: [
          { role: 'user', content: 'tưới đi' },
          { role: 'assistant', content: msg1.content, tool_calls: msg1.tool_calls },
          { role: 'user', content: 'có' },
        ],
      },
    })
    expect(turn2.json().choices[0].message.content).toContain('Đã thực hiện')
    expect(mcp.calls).toEqual(['send_command'])
    await app.close()
  })

  it('read-offer round-trip: reply-carried sensor read → "có" runs and summarizes', async () => {
    const app = makeApp(llm, mcp)
    mcp.result = { text: 'soil_moisture=70', isError: false }
    llm.jsonQueue = [
      '{"type":"reply","message":"Lá vàng có thể do úng nước.","tool":"get_latest_sensor","args":{"device_id":"d1"}}',
    ]
    const turn1 = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'm', messages: [{ role: 'user', content: 'vàng lá thì sao?' }] },
    })
    const msg1 = turn1.json().choices[0].message
    expect(msg1.tool_calls[0].function.name).toBe('get_latest_sensor')

    const turn2 = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'm',
        messages: [
          { role: 'user', content: 'vàng lá thì sao?' },
          { role: 'assistant', content: msg1.content, tool_calls: msg1.tool_calls },
          { role: 'user', content: 'có' },
        ],
      },
    })
    expect(turn2.statusCode).toBe(200)
    expect(mcp.calls).toEqual(['get_latest_sensor'])
    await app.close()
  })
})
