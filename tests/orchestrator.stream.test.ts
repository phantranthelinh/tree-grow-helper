import { beforeEach, describe, expect, it } from 'vitest'
import { Orchestrator, type ChatStreamEvent, type OrchestratorDeps } from '../src/agent/orchestrator'
import { loadProfile } from '../src/domain/profiles'
import type { LlmEngine } from '../src/llm'
import type { McpGateway, McpToolResult } from '../src/mcp/client'
import { SessionStore } from '../src/memory/sessions'
import { InMemoryVectorStore } from '../src/rag/store'

const FALLBACK = 'Xin lỗi, mình chưa xử lý được yêu cầu. Bạn nói rõ hơn giúp mình nhé.'

/**
 * Streaming fake: each completeJsonStream/completeStream call plays the next
 * scripted delta array. The buffered twins return the same scripts joined, so
 * one fake can drive handleChat and handleChatStream for equivalence tests.
 */
class FakeStreamLlm implements LlmEngine {
  jsonScripts: string[][] = []
  streamScripts: string[][] = []
  fallbackJson = '{"type":"reply","message":"hết kịch bản"}'
  private jsonCall = 0
  private streamCall = 0

  async complete(): Promise<string> {
    const s = this.streamScripts[this.streamCall++]
    return s ? s.join('') : 'Trả lời cuối cùng.'
  }

  async completeJson(): Promise<string> {
    const s = this.jsonScripts[this.jsonCall++]
    return s ? s.join('') : this.fallbackJson
  }

  async *completeStream(): AsyncGenerator<string, void, unknown> {
    const s = this.streamScripts[this.streamCall++]
    if (!s) {
      yield 'Trả lời cuối cùng.'
      return
    }
    yield* s
  }

  async *completeJsonStream(): AsyncGenerator<string, void, unknown> {
    const s = this.jsonScripts[this.jsonCall++]
    if (!s) {
      yield this.fallbackJson
      return
    }
    yield* s
  }

  async embed(t: string[]): Promise<number[][]> {
    return t.map(() => [0, 0, 0])
  }

  rewind(): void {
    this.jsonCall = 0
    this.streamCall = 0
  }
}

class FakeMcp implements McpGateway {
  calls: Array<{ name: string; args: Record<string, unknown> }> = []
  result: McpToolResult = { text: 'ok', isError: false }

  async listTools() {
    return []
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
    this.calls.push({ name, args })
    return this.result
  }
}

function makeDeps(overrides?: Partial<OrchestratorDeps>): OrchestratorDeps {
  return {
    llm: new FakeStreamLlm(),
    mcp: new FakeMcp(),
    store: new InMemoryVectorStore(),
    sessions: new SessionStore(),
    profile: loadProfile('strawberry'),
    tools: [],
    maxToolSteps: 3,
    ragTopK: 4,
    ...overrides,
  }
}

async function collect(gen: AsyncGenerator<ChatStreamEvent>): Promise<ChatStreamEvent[]> {
  const events: ChatStreamEvent[] = []
  for await (const e of gen) events.push(e)
  return events
}

function tokens(events: ChatStreamEvent[]): string {
  return events
    .filter((e): e is Extract<ChatStreamEvent, { type: 'token' }> => e.type === 'token')
    .map((e) => e.text)
    .join('')
}

function doneOf(events: ChatStreamEvent[]): Extract<ChatStreamEvent, { type: 'done' }> {
  const last = events[events.length - 1]
  if (!last || last.type !== 'done') throw new Error(`last event is not done: ${JSON.stringify(last)}`)
  return last
}

describe('Orchestrator — handleChatStream', () => {
  let llm: FakeStreamLlm
  let mcp: FakeMcp
  let deps: OrchestratorDeps
  let orch: Orchestrator

  beforeEach(() => {
    llm = new FakeStreamLlm()
    mcp = new FakeMcp()
    deps = makeDeps({ llm, mcp })
    orch = new Orchestrator(deps)
  })

  it('streams a plain reply token-by-token and finishes with done', async () => {
    llm.jsonScripts = [['{"type":"reply","mess', 'age":"Chào bạn \\ud83c', '\\udf53!"}']]
    const events = await collect(orch.handleChatStream('u1', 's1', 'xin chào'))
    expect(tokens(events)).toBe('Chào bạn 🍓!')
    expect(doneOf(events)).toEqual({ type: 'done', reply: 'Chào bạn 🍓!', pendingAction: null })
    expect(mcp.calls).toHaveLength(0)
    expect(deps.sessions.getHistory('u1', 's1')).toHaveLength(2)
  })

  it('holds message tokens until type is known when message arrives first', async () => {
    llm.jsonScripts = [['{"message":"xin chào"', ',"type":"reply"}']]
    const events = await collect(orch.handleChatStream('u1', 's1', 'hi'))
    // Nothing may leak before the gate opens: the held text flushes as one token.
    expect(events.filter((e) => e.type === 'token')).toHaveLength(1)
    expect(tokens(events)).toBe('xin chào')
    expect(doneOf(events).reply).toBe('xin chào')
  })

  it('never streams the message of a tool decision', async () => {
    mcp.result = { text: 'threshold=75', isError: false }
    llm.jsonScripts = [
      ['{"type":"tool","tool":"get_moisture_rule","args":{"device_id":"d1"},"message":"leak?"}'],
      ['{"type":"reply","message":"Ngưỡng là 75%."}'],
    ]
    const events = await collect(orch.handleChatStream('u1', 's1', 'ngưỡng tưới?'))
    expect(tokens(events)).toBe('Ngưỡng là 75%.')
    expect(events).toContainEqual({
      type: 'tool_status',
      tool: 'get_moisture_rule',
      note: 'Đang đọc dữ liệu (get_moisture_rule)…',
    })
    expect(mcp.calls).toHaveLength(1)
    expect(doneOf(events).reply).toBe('Ngưỡng là 75%.')
  })

  it('emits a control confirmation as a single composed token without calling MCP', async () => {
    llm.jsonScripts = [
      ['{"type":"tool","tool":"send_command","args":{"device_id":"d1","command":"WATER_ON"},"message":"Mình sẽ bật bơm."}'],
    ]
    const events = await collect(orch.handleChatStream('u1', 's1', 'tưới đi'))
    const tokenEvents = events.filter((e) => e.type === 'token')
    expect(tokenEvents).toHaveLength(1)
    expect(tokens(events)).toBe(doneOf(events).reply)
    expect(doneOf(events).reply).toContain('Bạn xác nhận thực hiện')
    expect(doneOf(events).reply).toContain('Mình sẽ bật bơm.')
    expect(doneOf(events).pendingAction?.tool).toBe('send_command')
    expect(mcp.calls).toHaveLength(0)
  })

  it('streams the advice then appends the sensor-read offer as a suffix token', async () => {
    llm.jsonScripts = [
      [
        '{"type":"reply","message":"Lá vàng có thể do úng nước.",',
        '"tool":"get_latest_sensor","args":{"device_id":"esp32-01"}}',
      ],
    ]
    const events = await collect(orch.handleChatStream('u1', 's1', 'cây vàng lá'))
    const done = doneOf(events)
    expect(tokens(events)).toBe(done.reply)
    expect(done.reply).toContain('Lá vàng có thể do úng nước.')
    expect(done.reply).toContain('Có/Không')
    expect(done.pendingAction?.tool).toBe('get_latest_sensor')
    expect(mcp.calls).toHaveLength(0)
  })

  it('resets after a parse failure that already emitted tokens, then streams the retry', async () => {
    // Attempt 1 opens the gate and emits text but the JSON never closes -> parse fails.
    llm.jsonScripts = [['{"type":"reply","message":"nửa chừng'], ['{"type":"reply","message":"ok"}']]
    const events = await collect(orch.handleChatStream('u1', 's1', 'hi'))
    const kinds = events.map((e) => e.type)
    expect(kinds.indexOf('reset')).toBeGreaterThan(kinds.indexOf('token'))
    expect(tokens(events)).toBe('nửa chừngok')
    expect(doneOf(events).reply).toBe('ok')
  })

  it('does not reset when the failed attempt emitted nothing', async () => {
    llm.jsonScripts = [['hoàn toàn không phải json'], ['{"type":"reply","message":"ok"}']]
    const events = await collect(orch.handleChatStream('u1', 's1', 'hi'))
    expect(events.some((e) => e.type === 'reset')).toBe(false)
    expect(doneOf(events).reply).toBe('ok')
  })

  it('falls back after two failed parse attempts', async () => {
    llm.jsonScripts = [['xxx'], ['{hỏng']]
    const events = await collect(orch.handleChatStream('u1', 's1', 'hi'))
    expect(tokens(events)).toBe(FALLBACK)
    expect(doneOf(events).reply).toBe(FALLBACK)
  })

  it('recovers with reset when duplicate message keys make streamed text diverge', async () => {
    llm.jsonScripts = [['{"message":"x","type":"reply","message":"xy"}']]
    const events = await collect(orch.handleChatStream('u1', 's1', 'hi'))
    expect(events.some((e) => e.type === 'reset')).toBe(true)
    expect(doneOf(events).reply).toBe('xy')
    const lastToken = events.filter((e) => e.type === 'token').pop()
    expect(lastToken).toEqual({ type: 'token', text: 'xy' })
  })

  it('streams the forced text answer when tool steps run out', async () => {
    const toolScript = '{"type":"tool","tool":"get_moisture_rule","args":{"device_id":"d1"}}'
    llm.jsonScripts = [[toolScript], [toolScript], [toolScript]]
    llm.streamScripts = [['Trả lời ', 'cuối.']]
    const events = await collect(orch.handleChatStream('u1', 's1', 'kiểm tra liên tục'))
    expect(mcp.calls).toHaveLength(3)
    expect(tokens(events)).toBe('Trả lời cuối.')
    expect(doneOf(events).reply).toBe('Trả lời cuối.')
  })

  it('streams the summary after a free-text "có" on a pending sensor read', async () => {
    mcp.result = { text: 'soil_moisture=70', isError: false }
    llm.jsonScripts = [['{"type":"tool","tool":"get_latest_sensor","args":{"device_id":"esp32-01"}}']]
    await collect(orch.handleChatStream('u1', 's1', 'độ ẩm bao nhiêu?'))
    expect(mcp.calls).toHaveLength(0)

    llm.streamScripts = [['Độ ẩm đất ', '70% — ổn.']]
    const events = await collect(orch.handleChatStream('u1', 's1', 'có'))
    expect(events).toContainEqual({
      type: 'tool_status',
      tool: 'get_latest_sensor',
      note: 'Đang đọc cảm biến (get_latest_sensor)…',
    })
    expect(mcp.calls).toHaveLength(1)
    expect(tokens(events)).toBe('Độ ẩm đất 70% — ổn.')
    expect(doneOf(events).reply).toBe('Độ ẩm đất 70% — ổn.')
    expect(deps.sessions.getPending('u1', 's1')).toBeUndefined()
  })

  it('executes a confirmed control action as a single token', async () => {
    llm.jsonScripts = [['{"type":"tool","tool":"send_command","args":{"device_id":"d1","command":"WATER_ON"}}']]
    await collect(orch.handleChatStream('u1', 's1', 'tưới đi'))
    const events = await collect(orch.handleChatStream('u1', 's1', 'có'))
    expect(mcp.calls).toHaveLength(1)
    expect(events.filter((e) => e.type === 'token')).toHaveLength(1)
    expect(doneOf(events).reply).toContain('Đã thực hiện')
  })

  it('cancels a pending action on "không" with a single token', async () => {
    llm.jsonScripts = [['{"type":"tool","tool":"send_command","args":{"device_id":"d1","command":"WATER_ON"}}']]
    await collect(orch.handleChatStream('u1', 's1', 'tưới đi'))
    const events = await collect(orch.handleChatStream('u1', 's1', 'không'))
    expect(mcp.calls).toHaveLength(0)
    expect(events.filter((e) => e.type === 'token')).toHaveLength(1)
    expect(doneOf(events).reply).toContain('Đã hủy')
  })

  it('propagates a mid-stream failure without remembering the turn', async () => {
    class AbortingLlm extends FakeStreamLlm {
      override async *completeJsonStream(): AsyncGenerator<string, void, unknown> {
        yield '{"type":"reply","message":"nửa'
        throw new Error('aborted')
      }
    }
    const aborting = new AbortingLlm()
    deps = makeDeps({ llm: aborting, mcp })
    orch = new Orchestrator(deps)
    await expect(collect(orch.handleChatStream('u1', 's1', 'hi'))).rejects.toThrow('aborted')
    expect(deps.sessions.getHistory('u1', 's1')).toHaveLength(0)
  })
})

describe('Orchestrator — buffered/stream equivalence', () => {
  const scenarios: Array<{ name: string; jsonScripts: string[][]; mcpText?: string }> = [
    {
      name: 'plain reply',
      jsonScripts: [['{"type":"reply","message":"Chào bạn!"}']],
    },
    {
      name: 'read tool then reply',
      jsonScripts: [
        ['{"type":"tool","tool":"get_moisture_rule","args":{"device_id":"d1"}}'],
        ['{"type":"reply","message":"Ngưỡng là 75%."}'],
      ],
      mcpText: 'threshold=75',
    },
    {
      name: 'control tool confirmation',
      jsonScripts: [
        ['{"type":"tool","tool":"send_command","args":{"device_id":"d1","command":"WATER_ON"},"message":"Mình sẽ bật bơm."}'],
      ],
    },
    {
      name: 'reply carrying a sensor-read offer',
      jsonScripts: [
        ['{"type":"reply","message":"Lá vàng có thể do úng nước.","tool":"get_latest_sensor","args":{"device_id":"esp32-01"}}'],
      ],
    },
  ]

  for (const scenario of scenarios) {
    it(`produces identical results via both paths: ${scenario.name}`, async () => {
      const llm = new FakeStreamLlm()
      llm.jsonScripts = scenario.jsonScripts

      const mcpA = new FakeMcp()
      if (scenario.mcpText) mcpA.result = { text: scenario.mcpText, isError: false }
      const streamOrch = new Orchestrator(makeDeps({ llm, mcp: mcpA }))
      const events = await collect(streamOrch.handleChatStream('u1', 's1', 'câu hỏi'))
      const streamed = doneOf(events)

      llm.rewind()
      const mcpB = new FakeMcp()
      if (scenario.mcpText) mcpB.result = { text: scenario.mcpText, isError: false }
      const bufferedOrch = new Orchestrator(makeDeps({ llm, mcp: mcpB }))
      const buffered = await bufferedOrch.handleChat('u1', 's1', 'câu hỏi')

      expect(streamed.reply).toBe(buffered.reply)
      // Pending ids are random UUIDs; compare everything else.
      expect(streamed.pendingAction?.tool).toBe(buffered.pendingAction?.tool)
      expect(streamed.pendingAction?.summary).toBe(buffered.pendingAction?.summary)
      expect(streamed.pendingAction?.args).toEqual(buffered.pendingAction?.args)
      expect(tokens(events)).toBe(streamed.reply)
    })
  }
})
