import { describe, expect, it } from 'vitest'
import { sanitizeArgs } from '../src/mcp/args'
import type { McpTool } from '../src/mcp/client'
import { KNOWN_TOOLS } from '../src/mcp/knownTools'

const sendCommand = KNOWN_TOOLS.find((t) => t.name === 'send_command')!
const listDevices = KNOWN_TOOLS.find((t) => t.name === 'list_devices')!

describe('sanitizeArgs', () => {
  it('drops args not declared in the tool schema (the leaked decision message)', () => {
    const out = sanitizeArgs(sendCommand, {
      device_id: 'esp32-01',
      command: 'LIGHT_ON',
      duration: 60000,
      message: 'Mình sẽ bật đèn thiết bị esp32-01 trong 60s.',
    })
    expect(out).toEqual({ device_id: 'esp32-01', command: 'LIGHT_ON', duration: 60000 })
    expect(out).not.toHaveProperty('message')
  })

  it('keeps only declared keys and preserves their values', () => {
    expect(sanitizeArgs(sendCommand, { device_id: 'd1', command: 'WATER_ON', bogus: true })).toEqual({
      device_id: 'd1',
      command: 'WATER_ON',
    })
  })

  it('strips everything for a tool that declares no params', () => {
    expect(sanitizeArgs(listDevices, { device_id: 'd1' })).toEqual({})
  })

  it('passes args through unchanged when the tool is unknown (graceful degradation)', () => {
    expect(sanitizeArgs(undefined, { anything: 1, foo: 'bar' })).toEqual({ anything: 1, foo: 'bar' })
  })

  it('passes args through unchanged when the schema declares no properties', () => {
    const noProps = { name: 'mystery', inputSchema: { type: 'object' } } as unknown as McpTool
    expect(sanitizeArgs(noProps, { x: 1 })).toEqual({ x: 1 })
  })
})
