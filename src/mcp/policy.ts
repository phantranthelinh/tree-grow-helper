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

/**
 * User-facing sensor reads that are OFFERED before running. These stay `read`
 * for safety/eval purposes (see classifyTool) but the orchestrator anchors them
 * as a pending action and only runs them after the user confirms — a UX layer,
 * not a safety reclassification. Internal reads (list_devices, get_*_rule…) still
 * run automatically so the model can resolve device_id etc. mid-reasoning.
 */
const CONFIRM_BEFORE_READ = new Set<string>(['get_latest_sensor', 'get_sensor_history'])

export function classifyTool(name: string): ToolSafety {
  if (READ_ONLY.has(name)) return 'read'
  if (CONTROL.has(name)) return 'control'
  if (READ_PREFIXES.some((p) => name.startsWith(p))) return 'read'
  return 'control'
}

/** True for read tools that should be confirmed with the user before running. */
export function confirmsBeforeRead(name: string): boolean {
  return CONFIRM_BEFORE_READ.has(name)
}

export function isReadOnly(name: string): boolean {
  return classifyTool(name) === 'read'
}

export function requiresConfirmation(name: string): boolean {
  return classifyTool(name) === 'control'
}
