import { describe, expect, it } from 'vitest'
import { sanitizeArgs } from '../src/mcp/args'
import type { McpTool } from '../src/mcp/client'
import { KNOWN_TOOLS } from '../src/mcp/knownTools'

const setLight = KNOWN_TOOLS.find((t) => t.name === 'set_light')!
const setPump = KNOWN_TOOLS.find((t) => t.name === 'set_pump')!
const listDevices = KNOWN_TOOLS.find((t) => t.name === 'list_devices')!

describe('sanitizeArgs', () => {
  it('drops args not declared in the tool schema (the leaked decision message)', () => {
    const out = sanitizeArgs(setLight, {
      device_id: 'esp32-01',
      on: true,
      pwm: 200,
      message: 'Mình sẽ bật đèn thiết bị esp32-01.',
    })
    expect(out).toEqual({ device_id: 'esp32-01', on: true, pwm: 200 })
    expect(out).not.toHaveProperty('message')
  })

  it('keeps only declared keys and preserves their values', () => {
    expect(sanitizeArgs(setPump, { device_id: 'd1', on: true, bogus: true })).toEqual({
      device_id: 'd1',
      on: true,
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
