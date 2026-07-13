import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js'
import { describe, expect, it } from 'vitest'
import { describeMcpError, isRouteErrorText } from '../src/mcp/errors'

describe('describeMcpError', () => {
  it('flags an HTTP 404 / Not Found transport error as a route error', () => {
    const info = describeMcpError(new Error('Error POSTing to endpoint (HTTP 404): Not Found'))
    expect(info.route).toBe(true)
    expect(info.message).toContain('404')
  })

  it('flags an MCP MethodNotFound as a route error and keeps the code', () => {
    const info = describeMcpError(new McpError(ErrorCode.MethodNotFound, 'Tool not found: foo'))
    expect(info.route).toBe(true)
    expect(info.message).toContain('code -32601')
  })

  it('flags a connection-refused error as a route error', () => {
    expect(describeMcpError(new Error('connect ECONNREFUSED 127.0.0.1:8080')).route).toBe(true)
  })

  it('does NOT flag a normal device fault as a route error', () => {
    const info = describeMcpError(new Error('device offline: sensor read timed out'))
    expect(info.route).toBe(false)
    expect(info.message).toContain('device offline')
  })

  it('stringifies non-Error throwables', () => {
    expect(describeMcpError('kaboom').message).toBe('kaboom')
  })
})

describe('isRouteErrorText', () => {
  it('matches not-found text, ignores normal readings', () => {
    expect(isRouteErrorText('Not Found')).toBe(true)
    expect(isRouteErrorText('độ ẩm đất 60%')).toBe(false)
  })
})
