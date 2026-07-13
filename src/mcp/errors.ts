import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js'

/**
 * Classification of an error raised while talking to the MCP server.
 *
 * `route` marks a *transport/routing* failure — the MCP URL is wrong, the
 * server is unreachable, or the requested tool/method does not exist. These are
 * configuration problems (not device problems), so we surface them verbatim to
 * the user instead of letting the LLM paraphrase them into a generic answer.
 */
export interface McpErrorInfo {
  route: boolean
  message: string
}

/** JSON-RPC error codes that mean "wrong route / not found" rather than a device fault. */
const ROUTE_CODES = new Set<number>([
  ErrorCode.MethodNotFound,
  ErrorCode.ConnectionClosed,
  ErrorCode.InvalidRequest,
])

/** Text patterns that indicate a not-found / wrong-route / unreachable MCP endpoint. */
const ROUTE_ERROR_PATTERNS: RegExp[] = [
  /not\s*found/i,
  /unknown (tool|method|command|route|endpoint)/i,
  /no such (tool|method|command)/i,
  /\bhttp\s*[45]\d\d\b/i,
  /\b(400|401|403|404|405|502|503|504)\b/,
  /econnrefused/i,
  /enotfound/i,
  /getaddrinfo/i,
  /fetch failed/i,
  /failed to fetch/i,
  /connection (refused|closed|reset)/i,
  /socket hang up/i,
  /unable to connect/i,
]

/** True when an error message looks like a not-found / wrong-route / unreachable failure. */
export function isRouteErrorText(text: string): boolean {
  return ROUTE_ERROR_PATTERNS.some((re) => re.test(text))
}

/** Classify a thrown MCP error and produce a concise, user-facing message. */
export function describeMcpError(err: unknown): McpErrorInfo {
  if (err instanceof McpError) {
    return {
      route: ROUTE_CODES.has(err.code) || isRouteErrorText(err.message),
      message: `MCP báo lỗi (code ${err.code}): ${err.message}`,
    }
  }
  const message = err instanceof Error ? err.message : String(err)
  return { route: isRouteErrorText(message), message }
}
