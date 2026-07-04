import { beforeEach, describe, expect, it } from 'vitest'
import { Orchestrator, type OrchestratorDeps } from '../src/agent/orchestrator'
import { loadProfile } from '../src/domain/profiles'
import type { ChatMessage, CompleteOptions, LlmEngine } from '../src/llm'
import type { McpGateway, McpToolResult } from '../src/mcp/client'
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

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map(() => [0, 0, 0])
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
    // Uses an internal read (get_moisture_rule) that stays auto-run; the
    // user-facing sensor reads are confirm-before-read (covered separately below).
    mcp.result = { text: 'threshold=75', isError: false }
    llm.jsonQueue = [
      '{"type":"tool","tool":"get_moisture_rule","args":{"device_id":"esp32-01"}}',
      '{"type":"reply","message":"Ngưỡng tưới hiện tại là 75%."}',
    ]
    const res = await orch.handleChat('u1', 's1', 'ngưỡng tưới đang đặt bao nhiêu?')
    expect(mcp.calls).toHaveLength(1)
    expect(mcp.calls[0]?.name).toBe('get_moisture_rule')
    expect(res.reply).toContain('75%')
    expect(res.pendingAction).toBeNull()
  })

  it('does NOT execute a control tool; returns a pending action for confirmation', async () => {
    llm.jsonQueue = [
      '{"type":"tool","tool":"send_command","args":{"device_id":"esp32-01","command":"WATER_ON","duration":10000}}',
    ]
    const res = await orch.handleChat('u1', 's1', 'tưới nước cho cây đi')
    expect(mcp.calls).toHaveLength(0)
    expect(res.pendingAction).not.toBeNull()
    expect(res.pendingAction?.tool).toBe('send_command')
    expect(res.pendingAction?.summary).toContain('Bật bơm nước')
    expect(res.reply).toContain('Có/Không')
    expect(deps.sessions.getPending('u1', 's1')?.id).toBe(res.pendingAction?.id)
  })

  it('executes the pending action after explicit confirm', async () => {
    llm.jsonQueue = [
      '{"type":"tool","tool":"send_command","args":{"device_id":"esp32-01","command":"WATER_ON","duration":10000}}',
    ]
    const pending = await orch.handleChat('u1', 's1', 'tưới nước đi')
    const id = pending.pendingAction!.id
    mcp.result = { text: 'command queued', isError: false }
    const res = await orch.confirm('u1', 's1', id, true)
    expect(mcp.calls).toHaveLength(1)
    expect(mcp.calls[0]?.name).toBe('send_command')
    expect(res.reply).toContain('Đã thực hiện')
    expect(deps.sessions.getPending('u1', 's1')).toBeUndefined()
  })

  it('executes the pending action after a free-text "có"', async () => {
    llm.jsonQueue = [
      '{"type":"tool","tool":"auto_water","args":{"device_id":"esp32-01","threshold":75}}',
    ]
    await orch.handleChat('u1', 's1', 'bật tưới tự động')
    const res = await orch.handleChat('u1', 's1', 'có')
    expect(mcp.calls).toHaveLength(1)
    expect(mcp.calls[0]?.name).toBe('auto_water')
    expect(res.reply).toContain('Đã thực hiện')
  })

  it('cancels the pending action after a free-text "không"', async () => {
    llm.jsonQueue = ['{"type":"tool","tool":"send_command","args":{"device_id":"d1","command":"WATER_ON"}}']
    await orch.handleChat('u1', 's1', 'tưới đi')
    const res = await orch.handleChat('u1', 's1', 'không')
    expect(mcp.calls).toHaveLength(0)
    expect(res.reply).toContain('Đã hủy')
  })

  it('bounds read-tool loops to maxToolSteps then forces a text reply', async () => {
    llm.jsonQueue = [
      '{"type":"tool","tool":"get_moisture_rule","args":{"device_id":"d1"}}',
      '{"type":"tool","tool":"get_moisture_rule","args":{"device_id":"d1"}}',
      '{"type":"tool","tool":"get_moisture_rule","args":{"device_id":"d1"}}',
      '{"type":"tool","tool":"get_moisture_rule","args":{"device_id":"d1"}}',
    ]
    const res = await orch.handleChat('u1', 's1', 'kiểm tra liên tục')
    expect(mcp.calls).toHaveLength(3) // capped
    expect(res.reply).toBe('Trả lời cuối cùng.') // from llm.complete fallback
    expect(llm.completeCalls).toBe(1)
  })
})

describe('Orchestrator — confirm-before-read for user-facing sensor tools', () => {
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

  /** Drive the offer turn: model emits get_latest_sensor; orchestrator should anchor it as a pending. */
  async function makeOffer() {
    llm.jsonQueue = [
      '{"type":"tool","tool":"get_latest_sensor","args":{"device_id":"esp32-01"},"message":"Mình có thể kiểm tra số liệu hiện tại của cây giúp bạn."}',
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

  it('treats get_sensor_history as confirm-before-read as well', async () => {
    llm.jsonQueue = ['{"type":"tool","tool":"get_sensor_history","args":{"device_id":"esp32-01","hours":24}}']
    const res = await orch.handleChat('u1', 's1', 'cho mình xem lịch sử cảm biến 24h')
    expect(res.pendingAction?.tool).toBe('get_sensor_history')
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
      '{"type":"reply","message":"Mình gợi ý tưới thêm cho cây.","tool":"send_command","args":{"device_id":"d1","command":"WATER_ON"}}',
    ]
    const res = await orch.handleChat('u1', 's1', 'cây khô quá')

    expect(res.pendingAction).toBeNull()
    expect(mcp.calls).toHaveLength(0)
    expect(res.reply).toContain('Mình gợi ý tưới thêm')
  })
})
