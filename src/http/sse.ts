import type { ServerResponse } from 'node:http'

/**
 * Minimal Server-Sent Events plumbing for the hijacked /chat/stream response.
 * `no-transform` and `X-Accel-Buffering: no` keep reverse proxies (nginx…)
 * from buffering the stream.
 */
export function writeSseHead(raw: ServerResponse): void {
  raw.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  })
  // light-my-request's mock response has no flushHeaders.
  if (typeof raw.flushHeaders === 'function') raw.flushHeaders()
}

/** One `event: <name>` + single-line JSON `data:` frame. */
export function writeSseEvent(raw: ServerResponse, event: string, data: unknown): void {
  raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
}

/** Comment-line heartbeat so idle connections stay open; returns a stop function. */
export function startHeartbeat(raw: ServerResponse, intervalMs: number): () => void {
  const timer = setInterval(() => {
    raw.write(': ping\n\n')
  }, intervalMs)
  timer.unref?.()
  return () => clearInterval(timer)
}
