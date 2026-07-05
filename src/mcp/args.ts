import type { McpTool } from './client'

/**
 * Keep only the args a tool actually declares in its `inputSchema.properties`.
 *
 * The small (3B) model routinely hallucinates extra fields — echoing the
 * decision-level `message` into `args`, or adding a `duration` to a non-WATER
 * command. Those get forwarded verbatim to the MCP (executeAction passes
 * `action.args` straight through), and a strict server can reject the whole
 * call for unknown properties — so a command the user already confirmed fails.
 *
 * Fail-safe like the rest of policy.ts: when the tool or its `properties` are
 * unknown (e.g. a live MCP tool with a bare `{type:'object'}` schema), pass the
 * args through unchanged rather than guessing. A tool that declares an empty
 * `properties` (no params) correctly strips everything.
 */
export function sanitizeArgs(tool: McpTool | undefined, args: Record<string, unknown>): Record<string, unknown> {
  const props = tool?.inputSchema?.properties
  if (!props || typeof props !== 'object') return { ...args }
  const allowed = new Set(Object.keys(props))
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(args)) {
    if (allowed.has(key)) out[key] = value
  }
  return out
}
