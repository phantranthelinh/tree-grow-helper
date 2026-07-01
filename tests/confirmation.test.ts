import { describe, expect, it } from 'vitest'
import {
  createPendingAction,
  detectConfirmation,
  executeAction,
  summarizeAction,
} from '../src/agent/confirmation'
import type { McpGateway, McpToolResult } from '../src/mcp/client'

describe('summarizeAction', () => {
  it('describes a water command in Vietnamese', () => {
    expect(summarizeAction('send_command', { device_id: 'esp32-01', command: 'WATER_ON', duration: 10000 })).toBe(
      'Bật bơm nước thiết bị esp32-01 trong 10s',
    )
  })
  it('describes auto_water with threshold', () => {
    expect(summarizeAction('auto_water', { device_id: 'esp32-01', threshold: 75 })).toContain('ngưỡng độ ẩm đất 75%')
  })
})

describe('createPendingAction', () => {
  it('creates unique ids and attaches a summary', () => {
    const a = createPendingAction('send_command', { device_id: 'd1', command: 'LIGHT_ON' })
    const b = createPendingAction('send_command', { device_id: 'd1', command: 'LIGHT_ON' })
    expect(a.id).not.toBe(b.id)
    expect(a.summary).toBe('Bật đèn thiết bị d1')
  })
})

describe('detectConfirmation', () => {
  it('detects affirmations', () => {
    for (const t of ['có', 'Có, tưới đi', 'đồng ý', 'ok', 'xác nhận', 'ừ']) {
      expect(detectConfirmation(t)).toBe('affirm')
    }
  })
  it('detects negations', () => {
    for (const t of ['không', 'Không, đừng', 'hủy', 'thôi']) {
      expect(detectConfirmation(t)).toBe('negate')
    }
  })
  it('returns unknown otherwise', () => {
    expect(detectConfirmation('độ ẩm đất bao nhiêu?')).toBe('unknown')
  })
})

describe('executeAction', () => {
  const fakeMcp = (result: McpToolResult): McpGateway => ({
    listTools: async () => [],
    callTool: async () => result,
  })

  it('reports success', async () => {
    const action = createPendingAction('send_command', { device_id: 'd1', command: 'WATER_ON' })
    const res = await executeAction(fakeMcp({ text: 'queued', isError: false }), action)
    expect(res.ok).toBe(true)
    expect(res.text).toContain('Đã thực hiện')
  })

  it('reports MCP errors without claiming success', async () => {
    const action = createPendingAction('send_command', { device_id: 'd1', command: 'WATER_ON' })
    const res = await executeAction(fakeMcp({ text: 'device offline', isError: true }), action)
    expect(res.ok).toBe(false)
    expect(res.text).toContain('Không thực hiện được')
  })
})
