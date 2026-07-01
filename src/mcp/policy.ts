/**
 * Tool safety policy for the plant-tree MCP.
 *
 * Read-only tools run automatically; control tools ALWAYS require explicit user
 * confirmation before execution. Unknown tools default to `control` (fail safe),
 * except obvious read-style prefixes.
 */
export type ToolSafety = 'read' | 'control'

const READ_ONLY = new Set<string>([
  'list_devices',
  'get_device_info',
  'get_latest_sensor',
  'get_sensor_history',
  'get_pending_commands',
  'get_moisture_rule',
  'get_light_rule',
])

const CONTROL = new Set<string>([
  'send_command',
  'auto_water',
  'auto_light',
  'set_moisture_rule',
  'set_light_rule',
])

const READ_PREFIXES = ['get_', 'list_', 'read_', 'fetch_', 'query_']

export function classifyTool(name: string): ToolSafety {
  if (READ_ONLY.has(name)) return 'read'
  if (CONTROL.has(name)) return 'control'
  if (READ_PREFIXES.some((p) => name.startsWith(p))) return 'read'
  return 'control'
}

export function isReadOnly(name: string): boolean {
  return classifyTool(name) === 'read'
}

export function requiresConfirmation(name: string): boolean {
  return classifyTool(name) === 'control'
}
