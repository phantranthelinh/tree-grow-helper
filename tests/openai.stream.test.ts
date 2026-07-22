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

/** Parse OpenAI SSE (data-only frames); returns parsed JSON objects, [DONE] as the string. */
function parseOpenAiSse(body: string): Array<any | '[DONE]'> {
  return body
    .split('\n\n')
    .map((f) => f.trim())
    .filter((f) => f.startsWith('data: '))
    .map((f) => f.slice('data: '.length))
    .map((d) => (d === '[DONE]' ? '[DONE]' : JSON.parse(d)))
}

function contentOf(frames: Array<any>): string {
  return frames
    .filter((f) => f !== '[DONE]' && f.choices?.[0]?.delta?.content)
    .map((f) => f.choices[0].delta.content as string)
    .join('')
}

describe('OpenAI-compatible API (streaming)', () => {
  let llm: FakeLlm
  let mcp: FakeMcp
  beforeEach(() => {
    llm = new FakeLlm()
    mcp = new FakeMcp()
  })

  it('streams content chunks and terminates with finish_reason stop then [DONE]', async () => {
    llm.jsonQueue = ['{"type":"reply","message":"Chào bạn!"}']
    const app = makeApp(llm, mcp)
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'm', stream: true, messages: [{ role: 'user', content: 'hi' }] },
    })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('text/event-stream')
    const frames = parseOpenAiSse(res.body)
    expect(contentOf(frames)).toBe('Chào bạn!')
    expect(frames[frames.length - 1]).toBe('[DONE]')
    const finalChunk = frames[frames.length - 2]
    expect(finalChunk.object).toBe('chat.completion.chunk')
    expect(finalChunk.choices[0].finish_reason).toBe('stop')
    await app.close()
  })

  it('carries a control pending action as a tool_call in the terminal chunk', async () => {
    llm.jsonQueue = ['{"type":"tool","tool":"send_command","args":{"device_id":"d1","command":"WATER_ON"}}']
    const app = makeApp(llm, mcp)
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'm', stream: true, messages: [{ role: 'user', content: 'tưới đi' }] },
    })
    const frames = parseOpenAiSse(res.body)
    const toolChunk = frames.find((f) => f !== '[DONE]' && f.choices?.[0]?.delta?.tool_calls)
    expect(toolChunk.choices[0].delta.tool_calls[0].function.name).toBe('send_command')
    expect(contentOf(frames)).toContain('Có/Không')
    expect(mcp.calls).toHaveLength(0)
    await app.close()
  })

  it('returns a generated session_id in the X-Session-Id header', async () => {
    llm.jsonQueue = ['{"type":"reply","message":"Chào!"}']
    const app = makeApp(llm, mcp)
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'm', stream: true, messages: [{ role: 'user', content: 'hi' }] },
    })
    expect(res.statusCode).toBe(200)
    expect(res.headers['x-session-id']).toBeTruthy()
    await app.close()
  })

  it('echoes a provided session_id in the streaming X-Session-Id header', async () => {
    llm.jsonQueue = ['{"type":"reply","message":"Chào!"}']
    const app = makeApp(llm, mcp)
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'm', stream: true, session_id: 'st-1', messages: [{ role: 'user', content: 'hi' }] },
    })
    expect(res.headers['x-session-id']).toBe('st-1')
    await app.close()
  })

  it('returns plain JSON 503 (not SSE) before the server is configured', async () => {
    const app = buildServer({ state: new AppState(), config })
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'm', stream: true, messages: [{ role: 'user', content: 'hi' }] },
    })
    expect(res.statusCode).toBe(503)
    expect(res.headers['content-type']).toContain('application/json')
    expect(res.json().error.code).toBe('not_configured')
    await app.close()
  })
})
