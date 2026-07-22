import { describe, expect, it } from 'vitest'
import { classifyTool, confirmsBeforeRead, isReadOnly, requiresConfirmation } from '../src/mcp/policy'

const READ = [
  'list_devices',
  'get_device_info',
  'get_latest_sensor',
  'get_sensor_history',
  'get_recent_commands',
  'get_device_config',
]

const CONTROL = ['set_pump', 'set_light', 'set_mode', 'show_message', 'set_device_config', 'refresh_device_config']

describe('tool policy', () => {
  it('classifies the read-only tools', () => {
    for (const n of READ) {
      expect(classifyTool(n)).toBe('read')
      expect(isReadOnly(n)).toBe(true)
      expect(requiresConfirmation(n)).toBe(false)
    }
  })

  it('classifies the control tools as requiring confirmation', () => {
    for (const n of CONTROL) {
      expect(classifyTool(n)).toBe('control')
      expect(requiresConfirmation(n)).toBe(true)
    }
  })

  it('fails safe: unknown tool defaults to control, but read prefixes are read', () => {
    expect(classifyTool('reboot_everything')).toBe('control')
    expect(classifyTool('get_future_sensor')).toBe('read')
    expect(classifyTool('list_zones')).toBe('read')
  })
})

describe('confirmsBeforeRead', () => {
  it('flags user-facing sensor reads as confirm-before-read', () => {
    expect(confirmsBeforeRead('get_latest_sensor')).toBe(true)
    expect(confirmsBeforeRead('get_sensor_history')).toBe(true)
  })

  it('does not flag internal reads or control tools', () => {
    for (const n of ['list_devices', 'get_device_info', 'get_recent_commands', 'get_device_config']) {
      expect(confirmsBeforeRead(n)).toBe(false)
    }
    expect(confirmsBeforeRead('set_pump')).toBe(false)
  })

  it('keeps sensor reads classified as read (over-confirm is a UX layer, not a safety reclassification)', () => {
    expect(classifyTool('get_latest_sensor')).toBe('read')
    expect(isReadOnly('get_latest_sensor')).toBe(true)
  })
})
