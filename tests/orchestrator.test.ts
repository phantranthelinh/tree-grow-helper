import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js'
import { beforeEach, describe, expect, it } from 'vitest'
import { Orchestrator, isTruncatedReply, type OrchestratorDeps } from '../src/agent/orchestrator'
import { loadProfile } from '../src/domain/profiles'
import type { ChatMessage, CompleteOptions, LlmEngine, StreamOptions } from '../src/llm'
import type { McpGateway, McpToolResult } from '../src/mcp/client'
import { KNOWN_TOOLS } from '../src/mcp/knownTools'
import { SessionStore } from '../src/memory/sessions'
import { InMemoryVectorStore } from '../src/rag/store'

class FakeLlm implements LlmEngine {
  jsonQueue: string[] = []
  completeReturn = 'Trả lời cuối cùng.'
  jsonCalls = 0
  completeCalls = 0
  lastJsonOpts?: CompleteOptions
  lastCompleteOpts?: CompleteOptions

  async complete(_messages: ChatMessage[], opts?: CompleteOptions): Promise<string> {
    this.completeCalls++
    this.lastCompleteOpts = opts
    return this.completeReturn
  }

  async completeJson(
    _messages: ChatMessage[],
    _schema: Record<string, unknown>,
    _name: string,
    opts?: CompleteOptions,
  ): Promise<string> {
    this.jsonCalls++
    this.lastJsonOpts = opts
    return this.jsonQueue.shift() ?? '{"type":"reply","message":"hết kịch bản"}'
  }

  async *completeStream(messages: ChatMessage[], opts?: StreamOptions): AsyncGenerator<string, void, unknown> {
    yield await this.complete(messages, opts)
  }

  async *completeJsonStream(
    messages: ChatMessage[],
    jsonSchema: Record<string, unknown>,
    schemaName: string,
    opts?: StreamOptions,
  ): AsyncGenerator<string, void, unknown> {
    yield await this.completeJson(messages, jsonSchema, schemaName, opts)
  }

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map(() => [0, 0, 0])
  }
}

class FakeMcp implements McpGateway {
  calls: Array<{ name: string; args: Record<string, unknown> }> = []
  result: McpToolResult = { text: 'ok', isError: false }
  error?: Error

  async listTools() {
    return []
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
    this.calls.push({ name, args })
    if (this.error) throw this.error
    return this.result
  }
}

function makeDeps(overrides?: Partial<OrchestratorDeps>): OrchestratorDeps {
  return {
    llm: new FakeLlm(),
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

describe('Orchestrator', () => {
  let llm: FakeLlm
  let mcp: FakeMcp
  let deps: OrchestratorDeps
  let orch: Orchestrator

  beforeEach(() => {
    llm = new FakeLlm()
    mcp = new FakeMcp()
    deps = makeDeps({ llm, mcp })
    orch = new Orchestrator(deps)
  })

  it('returns a plain reply without touching the MCP', async () => {
    llm.jsonQueue = ['{"type":"reply","message":"Chào bạn!"}']
    const res = await orch.handleChat('u1', 's1', 'xin chào')
    expect(res.reply).toBe('Chào bạn!')
    expect(res.pendingAction).toBeNull()
    expect(mcp.calls).toHaveLength(0)
  })

  it('uses message as the reply and never leaks the internal reasoning field', async () => {
    llm.jsonQueue = [
      '{"reasoning":"triệu chứng khớp bệnh thán thư","type":"reply","message":"Nhiều khả năng là thán thư (theo VAAS)."}',
    ]
    const res = await orch.handleChat('u1', 's1', 'thân cây có đốm đen')
    expect(res.reply).toBe('Nhiều khả năng là thán thư (theo VAAS).')
    expect(res.reply).not.toContain('triệu chứng khớp')
    expect(res.pendingAction).toBeNull()
  })

  it('forwards the configured decision temperature to completeJson', async () => {
    deps = makeDeps({ llm, mcp, decisionTemp: 0.05 })
    orch = new Orchestrator(deps)
    llm.jsonQueue = ['{"type":"reply","message":"ok"}']
    await orch.handleChat('u1', 's1', 'câu hỏi')
    expect(llm.lastJsonOpts?.temperature).toBe(0.05)
  })

  it('runs a read-only tool automatically then replies', async () => {
    // Uses an internal read (get_device_config) that stays auto-run; the
    // user-facing sensor reads are confirm-before-read (covered separately below).
    mcp.result = { text: 'threshold=75', isError: false }
    llm.jsonQueue = [
      '{"type":"tool","tool":"get_device_config","args":{"device_id":"esp32-01"}}',
      '{"type":"reply","message":"Ngưỡng tưới hiện tại là 75%."}',
    ]
    const res = await orch.handleChat('u1', 's1', 'ngưỡng tưới đang đặt bao nhiêu?')
    expect(mcp.calls).toHaveLength(1)
    expect(mcp.calls[0]?.name).toBe('get_device_config')
    expect(res.reply).toContain('75%')
    expect(res.pendingAction).toBeNull()
  })

  it('does NOT execute a control tool; returns a pending action for confirmation', async () => {
    llm.jsonQueue = [
      '{"type":"tool","tool":"set_pump","args":{"device_id":"esp32-01","on":true}}',
    ]
    const res = await orch.handleChat('u1', 's1', 'tưới nước cho cây đi')
    expect(mcp.calls).toHaveLength(0)
    expect(res.pendingAction).not.toBeNull()
    expect(res.pendingAction?.tool).toBe('set_pump')
    expect(res.pendingAction?.summary).toContain('Bật bơm nước')
    expect(res.reply).toContain('Có/Không')
    expect(deps.sessions.getPending('u1', 's1')?.id).toBe(res.pendingAction?.id)
  })

  it('executes the pending action after explicit confirm', async () => {
    llm.jsonQueue = [
      '{"type":"tool","tool":"set_pump","args":{"device_id":"esp32-01","on":true}}',
    ]
    const pending = await orch.handleChat('u1', 's1', 'tưới nước đi')
    const id = pending.pendingAction!.id
    mcp.result = { text: 'command queued', isError: false }
    const res = await orch.confirm('u1', 's1', id, true)
    expect(mcp.calls).toHaveLength(1)
    expect(mcp.calls[0]?.name).toBe('set_pump')
    expect(res.reply).toContain('Đã thực hiện')
    expect(deps.sessions.getPending('u1', 's1')).toBeUndefined()
  })

  it('executes the pending action after a free-text "có"', async () => {
    llm.jsonQueue = [
      '{"type":"tool","tool":"set_mode","args":{"device_id":"esp32-01","auto":true}}',
    ]
    await orch.handleChat('u1', 's1', 'bật tưới tự động')
    const res = await orch.handleChat('u1', 's1', 'có')
    expect(mcp.calls).toHaveLength(1)
    expect(mcp.calls[0]?.name).toBe('set_mode')
    expect(res.reply).toContain('Đã thực hiện')
  })

  it('cancels the pending action after a free-text "không"', async () => {
    llm.jsonQueue = ['{"type":"tool","tool":"set_pump","args":{"device_id":"d1","on":true}}']
    await orch.handleChat('u1', 's1', 'tưới đi')
    const res = await orch.handleChat('u1', 's1', 'không')
    expect(mcp.calls).toHaveLength(0)
    expect(res.reply).toContain('Đã hủy')
  })

  it('surfaces an MCP route error directly instead of feeding it back to the LLM', async () => {
    // get_device_config is an internal auto-run read, so it reaches the MCP in the loop.
    mcp.error = new Error('Error POSTing to endpoint (HTTP 404): Not Found')
    llm.jsonQueue = [
      '{"type":"tool","tool":"get_device_config","args":{"device_id":"d1"}}',
      // A second decision would only be reached if the loop kept going — it must NOT.
      '{"type":"reply","message":"che lỗi"}',
    ]
    const res = await orch.handleChat('u1', 's1', 'ngưỡng tưới bao nhiêu?')
    expect(mcp.calls).toHaveLength(1)
    expect(res.reply).toContain('404')
    expect(res.reply).toMatch(/MCP/)
    expect(llm.jsonCalls).toBe(1) // short-circuited, did not loop again
  })

  it('surfaces a not-found tool error reported via isError', async () => {
    mcp.result = { text: 'Unknown tool: get_device_config', isError: true }
    llm.jsonQueue = ['{"type":"tool","tool":"get_device_config","args":{"device_id":"d1"}}']
    const res = await orch.handleChat('u1', 's1', 'ngưỡng tưới bao nhiêu?')
    expect(res.reply).toContain('Unknown tool')
    expect(res.reply).toMatch(/route sai|không tìm thấy/)
    expect(llm.jsonCalls).toBe(1)
  })

  it('surfaces a route error when executing a confirmed control action', async () => {
    llm.jsonQueue = ['{"type":"tool","tool":"set_pump","args":{"device_id":"d1","on":true}}']
    const pending = await orch.handleChat('u1', 's1', 'tưới đi')
    const id = pending.pendingAction!.id
    mcp.error = new McpError(ErrorCode.MethodNotFound, 'Unknown tool: set_pump')
    const res = await orch.confirm('u1', 's1', id, true)
    expect(res.reply).toContain('-32601')
    expect(res.reply).toMatch(/route/)
  })

  it('bounds read-tool loops to maxToolSteps then forces a text reply', async () => {
    llm.jsonQueue = [
      '{"type":"tool","tool":"get_device_config","args":{"device_id":"d1"}}',
      '{"type":"tool","tool":"get_device_config","args":{"device_id":"d1"}}',
      '{"type":"tool","tool":"get_device_config","args":{"device_id":"d1"}}',
      '{"type":"tool","tool":"get_device_config","args":{"device_id":"d1"}}',
    ]
    const res = await orch.handleChat('u1', 's1', 'kiểm tra liên tục')
    expect(mcp.calls).toHaveLength(3) // capped
    expect(res.reply).toBe('Trả lời cuối cùng.') // from llm.complete fallback
    expect(llm.completeCalls).toBe(1)
  })

  it('withSessions runs against the injected store, not the original', async () => {
    const other = new SessionStore()
    const scoped = orch.withSessions(other)
    llm.jsonQueue = ['{"type":"tool","tool":"set_pump","args":{"device_id":"d1","on":true}}']
    const res = await scoped.handleChat('u1', 's1', 'tưới đi')
    // Pending landed in the injected store…
    expect(other.getPending('u1', 's1')?.id).toBe(res.pendingAction?.id)
    // …and NOT in the orchestrator's original store.
    expect(deps.sessions.getPending('u1', 's1')).toBeUndefined()
  })

  it('engine getter returns the injected LlmEngine', () => {
    expect(orch.engine).toBe(llm)
  })

  it('withRag returns a new Orchestrator that carries the swapped store', () => {
    const store = new InMemoryVectorStore()
    store.add([{ id: 'x', text: 'ngưỡng ẩm đất dâu tây 75-80%', embedding: [1, 0, 0] }])
    const swapped = orch.withRag(store, loadProfile('strawberry'))
    expect(swapped).not.toBe(orch)
    expect(store.size()).toBe(1)
  })
})

describe('Orchestrator — arg sanitization against the tool schema', () => {
  let llm: FakeLlm
  let mcp: FakeMcp
  let deps: OrchestratorDeps
  let orch: Orchestrator

  beforeEach(() => {
    llm = new FakeLlm()
    mcp = new FakeMcp()
    deps = makeDeps({ llm, mcp, tools: KNOWN_TOOLS })
    orch = new Orchestrator(deps)
  })

  it('drops undeclared args (leaked decision message) from a control pending action', async () => {
    llm.jsonQueue = [
      '{"type":"tool","tool":"set_light","args":{"device_id":"esp32-01","on":true,"pwm":200,"message":"Mình sẽ bật đèn thiết bị esp32-01."},"message":"Bật đèn nhé."}',
    ]
    const res = await orch.handleChat('u1', 's1', 'bật đèn cho cây thiết bị esp32-01')
    expect(res.pendingAction?.tool).toBe('set_light')
    expect(res.pendingAction?.args).toEqual({ device_id: 'esp32-01', on: true, pwm: 200 })
    expect(res.pendingAction?.args).not.toHaveProperty('message')
  })

  it('sends only schema-declared args to the MCP when the control action is confirmed', async () => {
    llm.jsonQueue = ['{"type":"tool","tool":"set_light","args":{"device_id":"esp32-01","on":true,"message":"x"}}']
    const offer = await orch.handleChat('u1', 's1', 'bật đèn esp32-01')
    await orch.confirm('u1', 's1', offer.pendingAction!.id, true)
    expect(mcp.calls).toHaveLength(1)
    expect(mcp.calls[0]?.args).toEqual({ device_id: 'esp32-01', on: true })
  })

  it('sanitizes args on a directly-requested sensor read before running it', async () => {
    mcp.result = { text: 'soil_moisture=62', isError: false }
    llm.jsonQueue = [
      '{"type":"tool","tool":"get_latest_sensor","args":{"device_id":"esp32-01","message":"để mình xem"}}',
      '{"type":"reply","message":"Độ ẩm đất 62%."}',
    ]
    const res = await orch.handleChat('u1', 's1', 'độ ẩm đất bao nhiêu?')
    // Direct sensor read now runs inline; the hallucinated "message" arg is stripped.
    expect(mcp.calls).toHaveLength(1)
    expect(mcp.calls[0]?.name).toBe('get_latest_sensor')
    expect(mcp.calls[0]?.args).toEqual({ device_id: 'esp32-01' })
    expect(res.pendingAction).toBeNull()
  })
})

describe('Orchestrator — user-facing sensor reads (run direct, offer on reply)', () => {
  let llm: FakeLlm
  let mcp: FakeMcp
  let deps: OrchestratorDeps
  let orch: Orchestrator

  beforeEach(() => {
    llm = new FakeLlm()
    mcp = new FakeMcp()
    deps = makeDeps({ llm, mcp })
    orch = new Orchestrator(deps)
  })

  /**
   * Drive the offer turn: the model carries get_latest_sensor on a REPLY decision
   * (advice + an offer to check sensors). That is the only path that anchors a
   * sensor read as a pending offer — a direct {type:"tool"} request runs inline.
   */
  async function makeOffer() {
    llm.jsonQueue = [
      '{"type":"reply","message":"Lá vàng có thể do úng nước hoặc thiếu đạm; bạn kiểm tra thoát nước và bón cân đối.","tool":"get_latest_sensor","args":{"device_id":"esp32-01"}}',
    ]
    return orch.handleChat('u1', 's1', 'Cây dâu của mình bị vàng lá và rụng lá, nên làm gì?')
  }

  it('offers a sensor read as a pending action instead of running it immediately', async () => {
    const res = await makeOffer()
    expect(res.pendingAction).not.toBeNull()
    expect(res.pendingAction?.tool).toBe('get_latest_sensor')
    expect(res.pendingAction?.args).toEqual({ device_id: 'esp32-01' })
    // The whole point: the read must NOT have executed yet.
    expect(mcp.calls).toHaveLength(0)
    expect(res.reply).toContain('Có/Không')
    expect(deps.sessions.getPending('u1', 's1')?.id).toBe(res.pendingAction?.id)
  })

  it('runs the pending sensor read on a free-text "có" and summarizes the result', async () => {
    mcp.result = { text: 'soil_moisture=70, temp=25', isError: false }
    await makeOffer()
    llm.completeReturn = 'Hiện tại độ ẩm đất 70%, nhiệt độ 25°C — trong khoảng tốt cho dâu.'

    const res = await orch.handleChat('u1', 's1', 'có')

    expect(mcp.calls).toHaveLength(1)
    expect(mcp.calls[0]?.name).toBe('get_latest_sensor')
    expect(mcp.calls[0]?.args).toEqual({ device_id: 'esp32-01' })
    expect(res.reply).toBe('Hiện tại độ ẩm đất 70%, nhiệt độ 25°C — trong khoảng tốt cho dâu.')
    expect(res.pendingAction).toBeNull()
    expect(deps.sessions.getPending('u1', 's1')).toBeUndefined()
  })

  it('cancels the pending sensor read on "không" without calling MCP', async () => {
    await makeOffer()
    const res = await orch.handleChat('u1', 's1', 'không')
    expect(mcp.calls).toHaveLength(0)
    expect(res.reply).toContain('Đã hủy')
    expect(deps.sessions.getPending('u1', 's1')).toBeUndefined()
  })

  it('runs the pending sensor read via the confirm() endpoint when approved', async () => {
    const offer = await makeOffer()
    const id = offer.pendingAction!.id
    llm.completeReturn = 'Độ ẩm đất hiện tại 70%.'

    const res = await orch.confirm('u1', 's1', id, true)

    expect(mcp.calls).toHaveLength(1)
    expect(mcp.calls[0]?.name).toBe('get_latest_sensor')
    expect(res.reply).toBe('Độ ẩm đất hiện tại 70%.')
    expect(deps.sessions.getPending('u1', 's1')).toBeUndefined()
  })

  it('surfaces a route error on a confirmed sensor read instead of summarizing it', async () => {
    const offer = await makeOffer()
    const id = offer.pendingAction!.id
    mcp.error = new Error('Error POSTing to endpoint (HTTP 404): Not Found')

    const res = await orch.confirm('u1', 's1', id, true)

    expect(mcp.calls).toHaveLength(1)
    expect(res.reply).toContain('404')
    expect(llm.completeCalls).toBe(0) // did not ask the LLM to summarize a failed read
    expect(deps.sessions.getPending('u1', 's1')).toBeUndefined()
  })

  it('offers get_sensor_history too when carried on a reply decision', async () => {
    llm.jsonQueue = [
      '{"type":"reply","message":"Để đánh giá xu hướng, mình có thể xem lịch sử cảm biến.","tool":"get_sensor_history","args":{"device_id":"esp32-01","limit":24}}',
    ]
    const res = await orch.handleChat('u1', 's1', 'cây dạo này thế nào?')
    expect(res.pendingAction?.tool).toBe('get_sensor_history')
    expect(res.reply).toContain('Có/Không')
    expect(mcp.calls).toHaveLength(0)
  })

  it('anchors a sensor-read offer carried on a reply decision (symptom stays a reply)', async () => {
    llm.jsonQueue = [
      '{"type":"reply","message":"Lá dâu vàng thường do úng nước hoặc thiếu đạm; bạn kiểm tra thoát nước và bón cân đối.","tool":"get_latest_sensor","args":{"device_id":"esp32-01"}}',
    ]
    const res = await orch.handleChat('u1', 's1', 'Cây dâu của mình bị vàng lá, nên làm gì?')

    expect(res.pendingAction?.tool).toBe('get_latest_sensor')
    expect(mcp.calls).toHaveLength(0) // offer only, not run
    expect(res.reply).toContain('Lá dâu vàng') // advice preserved
    expect(res.reply).toContain('Có/Không') // offer appended
    expect(deps.sessions.getPending('u1', 's1')?.tool).toBe('get_latest_sensor')
  })

  it('runs the reply-carried offer deterministically on a follow-up "có"', async () => {
    llm.jsonQueue = [
      '{"type":"reply","message":"Lá vàng có thể do úng nước.","tool":"get_latest_sensor","args":{"device_id":"esp32-01"}}',
    ]
    await orch.handleChat('u1', 's1', 'vàng lá thì sao?')
    llm.completeReturn = 'Độ ẩm đất hiện tại 82% — hơi cao, bạn giảm tưới nhé.'

    const res = await orch.handleChat('u1', 's1', 'có')

    expect(mcp.calls).toHaveLength(1)
    expect(mcp.calls[0]?.name).toBe('get_latest_sensor')
    expect(res.reply).toBe('Độ ẩm đất hiện tại 82% — hơi cao, bạn giảm tưới nhé.')
  })

  it('never anchors a control tool named on a reply decision', async () => {
    llm.jsonQueue = [
      '{"type":"reply","message":"Mình gợi ý tưới thêm cho cây.","tool":"set_pump","args":{"device_id":"d1","on":true}}',
    ]
    const res = await orch.handleChat('u1', 's1', 'cây khô quá')

    expect(res.pendingAction).toBeNull()
    expect(mcp.calls).toHaveLength(0)
    expect(res.reply).toContain('Mình gợi ý tưới thêm')
  })

  it('runs a directly-requested get_latest_sensor inline instead of offering it', async () => {
    mcp.result = { text: 'soil_moisture=62, temp=25', isError: false }
    llm.jsonQueue = [
      '{"type":"tool","tool":"get_latest_sensor","args":{"device_id":"esp32-01"}}',
      '{"type":"reply","message":"Độ ẩm đất 62%, nhiệt độ 25°C."}',
    ]
    const res = await orch.handleChat('u1', 's1', 'đọc thông số cảm biến mới nhất')
    expect(mcp.calls).toHaveLength(1)
    expect(mcp.calls[0]?.name).toBe('get_latest_sensor')
    expect(mcp.calls[0]?.args).toEqual({ device_id: 'esp32-01' })
    expect(res.pendingAction).toBeNull() // no Có/Không offer for a direct request
    expect(res.reply).toContain('62%')
  })

  it('runs a directly-requested get_sensor_history inline too', async () => {
    mcp.result = { text: 'history 24h', isError: false }
    llm.jsonQueue = [
      '{"type":"tool","tool":"get_sensor_history","args":{"device_id":"esp32-01","limit":24}}',
      '{"type":"reply","message":"Trong 24h qua độ ẩm ổn định."}',
    ]
    const res = await orch.handleChat('u1', 's1', 'cho mình xem lịch sử cảm biến 24h')
    expect(mcp.calls).toHaveLength(1)
    expect(mcp.calls[0]?.name).toBe('get_sensor_history')
    expect(res.pendingAction).toBeNull()
  })
})

// The "cụt/đứt đoạn" reply bug is model-agnostic: any small model, forced to put
// the whole answer inside the decision JSON's "message" string, can abandon it —
// empty, or a dangling-colon lead-in with no body. The prose rule in the prompt
// asks the model not to; this is the structural safety net for when it does anyway.
describe('isTruncatedReply', () => {
  it('flags empty / whitespace / dangling-colon messages', () => {
    expect(isTruncatedReply('')).toBe(true)
    expect(isTruncatedReply('   \n ')).toBe(true)
    expect(isTruncatedReply('Các nguyên nhân gồm:')).toBe(true)
    expect(isTruncatedReply('Dưới đây là các bước ：')).toBe(true) // full-width colon
  })

  it('passes a normal flowing-prose answer', () => {
    expect(isTruncatedReply('Lá dâu vàng thường do úng nước hoặc thiếu đạm; bạn kiểm tra thoát nước.')).toBe(false)
    expect(isTruncatedReply('Độ ẩm đất 62%.')).toBe(false)
  })
})

describe('Orchestrator — truncated reply repair', () => {
  let llm: FakeLlm
  let mcp: FakeMcp
  let orch: Orchestrator

  beforeEach(() => {
    llm = new FakeLlm()
    mcp = new FakeMcp()
    llm.completeReturn = 'Câu trả lời hoàn chỉnh bằng văn xuôi.'
    orch = new Orchestrator(makeDeps({ llm, mcp, replyTemp: 0.3 }))
  })

  it('regenerates a dangling-colon reply as unconstrained prose at replyTemp', async () => {
    llm.jsonQueue = ['{"type":"reply","message":"Các nguyên nhân khiến lá dâu vàng gồm:"}']
    const res = await orch.handleChat('u1', 's1', 'vì sao lá dâu vàng?')
    expect(res.reply).toBe('Câu trả lời hoàn chỉnh bằng văn xuôi.')
    expect(llm.completeCalls).toBe(1) // fell back to plain-text generation
    expect(llm.lastCompleteOpts?.temperature).toBe(0.3) // uses replyTemp, not decisionTemp
    expect(res.pendingAction).toBeNull()
  })

  it('regenerates an empty reply message rather than shipping the fallback fragment', async () => {
    llm.jsonQueue = ['{"type":"reply","message":""}']
    const res = await orch.handleChat('u1', 's1', 'tư vấn giúp mình')
    expect(res.reply).toBe('Câu trả lời hoàn chỉnh bằng văn xuôi.')
    expect(llm.completeCalls).toBe(1)
  })

  it('does NOT regenerate a well-formed reply (no extra LLM call)', async () => {
    llm.jsonQueue = ['{"type":"reply","message":"Lá vàng thường do úng nước; bạn kiểm tra thoát nước."}']
    const res = await orch.handleChat('u1', 's1', 'vì sao lá vàng?')
    expect(res.reply).toBe('Lá vàng thường do úng nước; bạn kiểm tra thoát nước.')
    expect(llm.completeCalls).toBe(0)
  })
})
