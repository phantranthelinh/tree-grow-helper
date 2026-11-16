import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { OpenAICompatEngine } from '../src/llm'

let server: Server | undefined

afterEach(() => {
  server?.close()
  server = undefined
})

/** Fake OpenAI-compatible server that, like LM Studio, always answers with float arrays. */
async function floatServer(vectors: number[][], seen: Array<Record<string, unknown>>): Promise<string> {
  server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      seen.push(JSON.parse(body) as Record<string, unknown>)
      res.setHeader('content-type', 'application/json')
      res.end(
        JSON.stringify({
          object: 'list',
          data: vectors.map((embedding, index) => ({ object: 'embedding', index, embedding })),
          model: 'm',
          usage: { prompt_tokens: 0, total_tokens: 0 },
        }),
      )
    })
  })
  await new Promise<void>((ok) => server!.listen(0, '127.0.0.1', ok))
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}/v1`
}

const engine = (baseURL: string) =>
  new OpenAICompatEngine({ baseURL, apiKey: 'x', model: 'chat', embedModel: 'embed' })

describe('OpenAICompatEngine.embed', () => {
  it('asks for float vectors and returns them unchanged', async () => {
    const seen: Array<Record<string, unknown>> = []
    const url = await floatServer([[0.1, -0.2, 0.3], [0.4, 0.5, -0.6]], seen)
    const out = await engine(url).embed(['a', 'b'])
    expect(seen[0]?.encoding_format).toBe('float')
    expect(out).toEqual([[0.1, -0.2, 0.3], [0.4, 0.5, -0.6]])
  })

  it('rejects an all-zero vector instead of letting it poison the store and cache', async () => {
    const url = await floatServer([[0.1, 0.2], [0, 0]], [])
    await expect(engine(url).embed(['a', 'b'])).rejects.toThrow(/toàn số 0/)
  })
})
