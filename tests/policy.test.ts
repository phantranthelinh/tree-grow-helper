import { describe, expect, it } from 'vitest'
import { classifyTool, isReadOnly, requiresConfirmation } from '../src/mcp/policy'

const READ = [
  'list_devices',
  'get_device_info',
  'get_latest_sensor',
  'get_sensor_history',
  'get_pending_commands',
  'get_moisture_rule',
  'get_light_rule',
]

const CONTROL = ['send_command', 'auto_water', 'auto_light', 'set_moisture_rule', 'set_light_rule']

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
