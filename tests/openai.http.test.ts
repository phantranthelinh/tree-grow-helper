import { beforeEach, describe, expect, it } from 'vitest'
import { Orchestrator } from '../src/agent/orchestrator'
import { config } from '../src/config'
import { loadProfile } from '../src/domain/profiles'
import { buildServer } from '../src/http/server'
import type { ChatMessage, LlmEngine } from '../src/llm'
import type { McpGateway, McpToolResult } from '../src/mcp/client'
import { SessionStore } from '../src/memory/sessions'
import { InMemoryVectorStore } from '../src/rag/store'
import { AppState } from '../src/setup/state'

class FakeLlm implements LlmEngine {
  jsonQueue: string[] = []
  seen: ChatMessage[][] = []
  async complete() {
    return 'ok'
  }
  async completeJson(messages: ChatMessage[]) {
    this.seen.push(messages)
    return this.jsonQueue.shift() ?? '{"type":"reply","message":"..."}'
  }
  async *completeStream() {
    yield await this.complete()
  }
  async *completeJsonStream() {
    yield await this.completeJson([])
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

  it('Orchestrator exposes its session store via a getter', () => {
    const sessions = new SessionStore()
    const orch = new Orchestrator({
      llm,
      mcp,
      store: new InMemoryVectorStore(),
      sessions,
      profile: loadProfile('strawberry'),
      tools: [],
      maxToolSteps: 3,
      ragTopK: 4,
    })
    expect(orch.sessions).toBe(sessions)
  })

  it('exposes X-Session-Id to browsers via CORS', async () => {
    const app = makeApp(llm, mcp)
    const res = await app.inject({
      method: 'GET',
      url: '/v1/models',
      headers: { origin: 'http://example.com' },
    })
    expect(res.headers['access-control-expose-headers']).toContain('X-Session-Id')
    await app.close()
  })
})

describe('OpenAI-compatible API (session memory)', () => {
  let llm: FakeLlm
  let mcp: FakeMcp
  beforeEach(() => {
    llm = new FakeLlm()
    mcp = new FakeMcp()
  })

  it('remembers earlier turns server-side across requests with the same session_id', async () => {
    const app = makeApp(llm, mcp)
    llm.jsonQueue = [
      '{"type":"reply","message":"Dâu cần đất ẩm."}',
      '{"type":"reply","message":"Tưới 2 lần mỗi ngày."}',
    ]
    await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'm', session_id: 'mem-1', messages: [{ role: 'user', content: 'Trồng dâu thế nào?' }] },
    })
    await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'm', session_id: 'mem-1', messages: [{ role: 'user', content: 'Còn tưới nước thì sao?' }] },
    })
    const seen = llm.seen.at(-1)!.map((m) => m.content).join(' | ')
    expect(seen).toContain('Trồng dâu thế nào?') // turn-1 user, recalled from server memory
    expect(seen).toContain('Dâu cần đất ẩm.') // turn-1 assistant reply, recalled
    expect(seen).toContain('Còn tưới nước thì sao?') // turn-2 input (the only thing the client sent)
    await app.close()
  })

  it('generates a session_id when none is given and returns it (header + body)', async () => {
    llm.jsonQueue = ['{"type":"reply","message":"Chào!"}']
    const app = makeApp(llm, mcp)
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'm', messages: [{ role: 'user', content: 'hi' }] },
    })
    expect(res.statusCode).toBe(200)
    const sid = res.headers['x-session-id']
    expect(sid).toBeTruthy()
    expect(res.json().session_id).toBe(sid)
    await app.close()
  })

  it('mints a distinct session_id per request when none is given', async () => {
    llm.jsonQueue = ['{"type":"reply","message":"a"}', '{"type":"reply","message":"b"}']
    const app = makeApp(llm, mcp)
    const r1 = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'm', messages: [{ role: 'user', content: 'hi' }] },
    })
    const r2 = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'm', messages: [{ role: 'user', content: 'hi' }] },
    })
    expect(r1.headers['x-session-id']).not.toBe(r2.headers['x-session-id'])
    await app.close()
  })

  it('echoes a caller-provided session_id in header + body', async () => {
    llm.jsonQueue = ['{"type":"reply","message":"ok"}']
    const app = makeApp(llm, mcp)
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'm', session_id: 'given-1', messages: [{ role: 'user', content: 'hi' }] },
    })
    expect(res.headers['x-session-id']).toBe('given-1')
    expect(res.json().session_id).toBe('given-1')
    await app.close()
  })

  it('treats a blank session_id as absent and generates one', async () => {
    llm.jsonQueue = ['{"type":"reply","message":"ok"}']
    const app = makeApp(llm, mcp)
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'm', session_id: '   ', messages: [{ role: 'user', content: 'hi' }] },
    })
    const sid = res.headers['x-session-id'] as string | undefined
    expect(sid && sid.trim().length > 0).toBeTruthy()
    expect(sid).not.toBe('   ')
    await app.close()
  })

  it('seeds a brand-new session from the caller thread (legacy full-history clients)', async () => {
    llm.jsonQueue = ['{"type":"reply","message":"ok"}']
    const app = makeApp(llm, mcp)
    await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'm',
        session_id: 'seed-1',
        messages: [
          { role: 'user', content: 'Câu hỏi cũ' },
          { role: 'assistant', content: 'Trả lời cũ' },
          { role: 'user', content: 'Câu hỏi mới' },
        ],
      },
    })
    const seen = llm.seen.at(-1)!.map((m) => m.content).join(' | ')
    expect(seen).toContain('Câu hỏi cũ') // seeded from the thread prefix
    expect(seen).toContain('Trả lời cũ') // seeded assistant turn
    expect(seen).toContain('Câu hỏi mới') // last user message = input
    await app.close()
  })

  it('ignores caller-supplied history once the session already has memory', async () => {
    llm.jsonQueue = ['{"type":"reply","message":"đầu tiên"}', '{"type":"reply","message":"thứ hai"}']
    const app = makeApp(llm, mcp)
    await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'm', session_id: 'ns-1', messages: [{ role: 'user', content: 'THẬT một' }] },
    })
    await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'm',
        session_id: 'ns-1',
        messages: [
          { role: 'user', content: 'RÁC lịch sử' },
          { role: 'assistant', content: 'RÁC assistant' },
          { role: 'user', content: 'THẬT hai' },
        ],
      },
    })
    const seen = llm.seen.at(-1)!.map((m) => m.content).join(' | ')
    expect(seen).toContain('THẬT một') // real memory from turn 1
    expect(seen).toContain('đầu tiên') // real assistant reply from turn 1
    expect(seen).toContain('THẬT hai') // this turn's input
    expect(seen).not.toContain('RÁC') // caller history ignored — no seed on a non-empty session
    await app.close()
  })

  it('confirms a control action server-side: "có" on a later request executes it', async () => {
    const app = makeApp(llm, mcp)
    llm.jsonQueue = ['{"type":"tool","tool":"send_command","args":{"device_id":"d1","command":"WATER_ON"}}']
    const turn1 = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'm', session_id: 'cf-1', messages: [{ role: 'user', content: 'tưới đi' }] },
    })
    expect(turn1.json().choices[0].message.content).toContain('Có/Không')
    expect(mcp.calls).toHaveLength(0)
    // Client sends ONLY "có" — no echoed tool_calls; the server remembers the pending action.
    const turn2 = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'm', session_id: 'cf-1', messages: [{ role: 'user', content: 'có' }] },
    })
    expect(turn2.json().choices[0].message.content).toContain('Đã thực hiện')
    expect(mcp.calls).toEqual(['send_command'])
    await app.close()
  })
})
