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
  /** When set, completeJsonStream plays these deltas instead of the queue. */
  deltas: string[] | null = null
  failStream = false
  async complete() {
    return 'ok'
  }
  async completeJson() {
    return this.jsonQueue.shift() ?? '{"type":"reply","message":"..."}'
  }
  async *completeStream() {
    yield await this.complete()
  }
  async *completeJsonStream(): AsyncGenerator<string, void, unknown> {
    if (this.failStream) throw new Error('nổ giữa chừng')
    if (this.deltas) {
      yield* this.deltas
      return
    }
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

interface SseFrame {
  event: string | undefined
  data: any
}

/** Split an SSE payload into frames, dropping heartbeat comments. */
function parseSse(body: string): SseFrame[] {
  return body
    .split('\n\n')
    .map((f) => f.trim())
    .filter((f) => f.length > 0 && !f.startsWith(':'))
    .map((frame) => {
      const lines = frame.split('\n')
      const event = lines.find((l) => l.startsWith('event: '))?.slice('event: '.length)
      const data = lines.find((l) => l.startsWith('data: '))?.slice('data: '.length)
      return { event, data: data === undefined ? undefined : JSON.parse(data) }
    })
}

function tokensOf(frames: SseFrame[]): string {
  return frames
    .filter((f) => f.event === 'token')
    .map((f) => f.data.text as string)
    .join('')
}

describe('POST /chat/stream', () => {
  let llm: FakeLlm
  let mcp: FakeMcp

  beforeEach(() => {
    llm = new FakeLlm()
    mcp = new FakeMcp()
  })

  it('returns plain JSON 503 before the server is configured', async () => {
    const app = buildServer({ state: new AppState(), config })
    const res = await app.inject({
      method: 'POST',
      url: '/chat/stream',
      payload: { userId: 'u1', sessionId: 's1', message: 'hi' },
    })
    expect(res.statusCode).toBe(503)
    expect(res.headers['content-type']).toContain('application/json')
    expect(res.json()).toMatchObject({ error: 'not_configured' })
    await app.close()
  })

  it('returns plain JSON 400 on an invalid body', async () => {
    const app = makeApp(llm, mcp)
    const res = await app.inject({ method: 'POST', url: '/chat/stream', payload: { userId: 'u1' } })
    expect(res.statusCode).toBe(400)
    expect(res.headers['content-type']).toContain('application/json')
    expect(res.json()).toMatchObject({ error: 'invalid_request' })
    await app.close()
  })

  it('streams token frames and finishes with a done frame', async () => {
    llm.jsonQueue = ['{"type":"reply","message":"Chào bạn!"}']
    const app = makeApp(llm, mcp)
    const res = await app.inject({
      method: 'POST',
      url: '/chat/stream',
      payload: { userId: 'u1', sessionId: 's1', message: 'hi' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('text/event-stream')
    const frames = parseSse(res.body)
    expect(tokensOf(frames)).toBe('Chào bạn!')
    const last = frames[frames.length - 1]
    expect(last?.event).toBe('done')
    expect(last?.data).toEqual({ reply: 'Chào bạn!', pendingAction: null })
    await app.close()
  })

  it('carries the pendingAction of a control tool through the done frame', async () => {
    llm.jsonQueue = ['{"type":"tool","tool":"set_pump","args":{"device_id":"d1","on":true}}']
    const app = makeApp(llm, mcp)
    const res = await app.inject({
      method: 'POST',
      url: '/chat/stream',
      payload: { userId: 'u1', sessionId: 's1', message: 'tưới đi' },
    })
    const frames = parseSse(res.body)
    const done = frames[frames.length - 1]
    expect(done?.event).toBe('done')
    expect(done?.data.pendingAction.tool).toBe('set_pump')
    expect(done?.data.reply).toContain('Có/Không')
    expect(mcp.calls).toHaveLength(0)
    await app.close()
  })

  it('keeps a surrogate pair intact on the wire when a token splits it', async () => {
    // The scanner may emit a token ending in a lone high surrogate; well-formed
    // JSON.stringify must escape it so no U+FFFD ever reaches the client.
    llm.deltas = ['{"type":"reply","message":"Dâu \\ud83c', '\\udf53!"}']
    const app = makeApp(llm, mcp)
    const res = await app.inject({
      method: 'POST',
      url: '/chat/stream',
      payload: { userId: 'u1', sessionId: 's1', message: 'hi' },
    })
    expect(res.body).not.toContain('�')
    const frames = parseSse(res.body)
    expect(tokensOf(frames)).toBe('Dâu 🍓!')
    expect(frames[frames.length - 1]?.data.reply).toBe('Dâu 🍓!')
    await app.close()
  })

  it('ends with a terminal error frame when the stream blows up mid-flight', async () => {
    llm.failStream = true
    const app = makeApp(llm, mcp)
    const res = await app.inject({
      method: 'POST',
      url: '/chat/stream',
      payload: { userId: 'u1', sessionId: 's1', message: 'hi' },
    })
    expect(res.statusCode).toBe(200) // headers were already sent
    const frames = parseSse(res.body)
    const last = frames[frames.length - 1]
    expect(last?.event).toBe('error')
    expect(last?.data.message).toBe('Có lỗi xảy ra, bạn thử lại giúp mình nhé.')
    await app.close()
  })

  it('answers a CORS preflight for a browser chat app on another origin', async () => {
    const app = makeApp(llm, mcp)
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/chat/stream',
      headers: {
        origin: 'http://localhost:5173',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type',
      },
    })
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173')
    await app.close()
  })
})
