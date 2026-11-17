import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { OpenAICompatEngine, type TokenLogprob } from '../src/llm'

let server: Server | undefined

afterEach(() => {
  server?.close()
  server = undefined
})

const DECISION = '{"type":"reply"}'
const LOGPROBS = {
  content: [
    { token: '{"', logprob: 0, bytes: null, top_logprobs: [] },
    { token: 'type', logprob: 0, bytes: null, top_logprobs: [] },
    { token: '":"', logprob: 0, bytes: null, top_logprobs: [] },
    {
      token: 'reply',
      logprob: -0.1,
      bytes: null,
      top_logprobs: [
        { token: 'reply', logprob: -0.1, bytes: null },
        { token: 'tool', logprob: -2.4, bytes: null },
      ],
    },
  ],
}

/** Fake OpenAI-compatible chat server: records every request body, answers JSON or SSE like LM Studio. */
async function chatServer(seen: Array<Record<string, unknown>>): Promise<string> {
  server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      const parsed = JSON.parse(body) as Record<string, unknown>
      seen.push(parsed)
      if (parsed.stream) {
        res.setHeader('content-type', 'text/event-stream')
        const chunk = {
          id: 'c',
          object: 'chat.completion.chunk',
          created: 0,
          model: 'chat',
          choices: [{ index: 0, delta: { content: DECISION }, finish_reason: null }],
        }
        res.end(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`)
        return
      }
      res.setHeader('content-type', 'application/json')
      res.end(
        JSON.stringify({
          id: 'c',
          object: 'chat.completion',
          created: 0,
          model: 'chat',
          choices: [
            {
              index: 0,
              finish_reason: 'stop',
              message: { role: 'assistant', content: DECISION },
              logprobs: parsed.logprobs ? LOGPROBS : null,
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      )
    })
  })
  await new Promise<void>((ok) => server!.listen(0, '127.0.0.1', ok))
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}/v1`
}

const engine = (baseURL: string) => new OpenAICompatEngine({ baseURL, apiKey: 'x', model: 'chat', embedModel: 'embed' })
const msgs = [{ role: 'user' as const, content: 'hi' }]

async function drain(gen: AsyncGenerator<string>): Promise<string> {
  let out = ''
  for await (const d of gen) out += d
  return out
}

describe('OpenAICompatEngine request options', () => {
  it('sends neither a token cap nor log-probabilities unless asked', async () => {
    const seen: Array<Record<string, unknown>> = []
    const e = engine(await chatServer(seen))
    expect(await e.completeJson(msgs, {}, 'd')).toBe(DECISION)
    expect(seen[0]).not.toHaveProperty('max_tokens')
    expect(seen[0]).not.toHaveProperty('logprobs')
  })

  it('caps every call kind when maxTokens is set, and ignores a zero cap', async () => {
    const seen: Array<Record<string, unknown>> = []
    const e = engine(await chatServer(seen))
    await e.complete(msgs, { maxTokens: 400 })
    await e.completeJson(msgs, {}, 'd', { maxTokens: 400 })
    expect(await drain(e.completeStream(msgs, { maxTokens: 400 }))).toBe(DECISION)
    expect(await drain(e.completeJsonStream(msgs, {}, 'd', { maxTokens: 400 }))).toBe(DECISION)
    await e.completeJson(msgs, {}, 'd', { maxTokens: 0 })
    expect(seen.map((b) => b.max_tokens)).toEqual([400, 400, 400, 400, undefined])
  })

  it('asks for log-probabilities only with onLogprobs, and hands them over', async () => {
    const seen: Array<Record<string, unknown>> = []
    const e = engine(await chatServer(seen))
    let got: TokenLogprob[] = []
    await e.completeJson(msgs, {}, 'd', { onLogprobs: (t) => (got = t) })
    expect(seen[0]).toMatchObject({ logprobs: true, top_logprobs: 5 })
    expect(got.map((t) => t.token).join('')).toBe('{"type":"reply')
    expect(got[3]).toEqual({
      token: 'reply',
      logprob: -0.1,
      top: [
        { token: 'reply', logprob: -0.1 },
        { token: 'tool', logprob: -2.4 },
      ],
    })
  })
})
