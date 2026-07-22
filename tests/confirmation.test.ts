import { describe, expect, it } from 'vitest'
import {
  createPendingAction,
  detectConfirmation,
  executeAction,
  summarizeAction,
} from '../src/agent/confirmation'
import type { McpGateway, McpToolResult } from '../src/mcp/client'

describe('summarizeAction', () => {
  it('describes a pump command in Vietnamese', () => {
    expect(summarizeAction('set_pump', { device_id: 'esp32-01', on: true })).toBe('Bật bơm nước thiết bị esp32-01')
  })
  it('describes set_mode auto', () => {
    expect(summarizeAction('set_mode', { device_id: 'esp32-01', auto: true })).toContain('auto')
  })
  it('describes a latest-sensor read in Vietnamese', () => {
    expect(summarizeAction('get_latest_sensor', { device_id: 'esp32-01' })).toContain('cảm biến')
  })
})

describe('createPendingAction', () => {
  it('creates unique ids and attaches a summary', () => {
    const a = createPendingAction('set_light', { device_id: 'd1', on: true })
    const b = createPendingAction('set_light', { device_id: 'd1', on: true })
    expect(a.id).not.toBe(b.id)
    expect(a.summary).toBe('Bật đèn thiết bị d1')
  })

  it('defaults kind to control', () => {
    const a = createPendingAction('set_pump', { device_id: 'd1', on: true })
    expect(a.kind).toBe('control')
  })

  it('marks a sensor read pending as kind read with a read-flavored summary', () => {
    const a = createPendingAction('get_latest_sensor', { device_id: 'd1' }, 'read')
    expect(a.kind).toBe('read')
    expect(a.summary).toContain('cảm biến')
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
    const action = createPendingAction('set_pump', { device_id: 'd1', on: true })
    const res = await executeAction(fakeMcp({ text: 'queued', isError: false }), action)
    expect(res.ok).toBe(true)
    expect(res.text).toContain('Đã thực hiện')
  })

  it('reports MCP errors without claiming success', async () => {
    const action = createPendingAction('set_pump', { device_id: 'd1', on: true })
    const res = await executeAction(fakeMcp({ text: 'device offline', isError: true }), action)
    expect(res.ok).toBe(false)
    expect(res.text).toContain('Không thực hiện được')
  })
})
