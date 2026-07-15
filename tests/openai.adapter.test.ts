import { describe, expect, it } from 'vitest'
import {
  BadRequestError,
  contentChunk,
  encodePending,
  extractText,
  finalChunk,
  modelsList,
  parseMessages,
  recoverPending,
  roleChunk,
  SSE_DONE,
  sseData,
  toCompletion,
} from '../src/http/openai/adapter'
import { OpenAiChatRequestSchema } from '../src/http/openai/dto'

describe('OpenAiChatRequestSchema', () => {
  it('accepts a minimal valid body and passes through extra fields', () => {
    const r = OpenAiChatRequestSchema.safeParse({
      model: 'plant-assistant',
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 0.7, // unknown-but-tolerated OpenAI field
    })
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.model).toBe('plant-assistant')
  })

  it('rejects a body with no messages', () => {
    const r = OpenAiChatRequestSchema.safeParse({ model: 'm', messages: [] })
    expect(r.success).toBe(false)
  })

  it('rejects a body missing model', () => {
    const r = OpenAiChatRequestSchema.safeParse({ messages: [{ role: 'user', content: 'hi' }] })
    expect(r.success).toBe(false)
  })

  it('accepts an assistant message carrying tool_calls', () => {
    const r = OpenAiChatRequestSchema.safeParse({
      model: 'm',
      messages: [
        { role: 'user', content: 'tưới đi' },
        {
          role: 'assistant',
          content: 'Xác nhận? (Có/Không)',
          tool_calls: [{ id: 'x', type: 'function', function: { name: 'send_command', arguments: '{}' } }],
        },
        { role: 'user', content: 'có' },
      ],
    })
    expect(r.success).toBe(true)
  })
})

describe('extractText', () => {
  it('returns a string as-is', () => {
    expect(extractText('hi')).toBe('hi')
  })
  it('joins text parts and ignores non-text', () => {
    expect(extractText([{ type: 'text', text: 'a' }, { type: 'image_url' }, { type: 'text', text: 'b' }])).toBe('ab')
  })
  it('maps null/undefined to empty string', () => {
    expect(extractText(null)).toBe('')
    expect(extractText(undefined)).toBe('')
  })
})

describe('parseMessages', () => {
  it('throws on an empty array', () => {
    expect(() => parseMessages([])).toThrow(BadRequestError)
  })
  it('throws when the last message is not a user message', () => {
    expect(() => parseMessages([{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'yo' }])).toThrow(
      BadRequestError,
    )
  })
  it('drops system messages, strips tool_calls to content-only history, and splits off the last user turn', () => {
    const { history, lastUserMessage, priorAssistant } = parseMessages([
      { role: 'system', content: 'you are X' },
      { role: 'user', content: 'tưới đi' },
      {
        role: 'assistant',
        content: 'Xác nhận? (Có/Không)',
        tool_calls: [{ id: 'x', type: 'function', function: { name: 'send_command', arguments: '{}' } }],
      },
      { role: 'user', content: 'có' },
    ])
    expect(lastUserMessage).toBe('có')
    expect(priorAssistant?.role).toBe('assistant')
    expect(history).toEqual([
      { role: 'user', content: 'tưới đi' },
      { role: 'assistant', content: 'Xác nhận? (Có/Không)' },
    ])
  })
})

describe('recoverPending', () => {
  it('returns null when there is no prior assistant tool_call', () => {
    expect(recoverPending(null)).toBeNull()
    expect(recoverPending({ role: 'assistant', content: 'hi' })).toBeNull()
  })
  it('rebuilds a control pending from a send_command tool_call', () => {
    const p = recoverPending({
      role: 'assistant',
      content: 'q',
      tool_calls: [
        {
          id: 'x',
          type: 'function',
          function: { name: 'send_command', arguments: '{"device_id":"d1","command":"WATER_ON"}' },
        },
      ],
    })
    expect(p?.tool).toBe('send_command')
    expect(p?.kind).toBe('control')
    expect(p?.args).toEqual({ device_id: 'd1', command: 'WATER_ON' })
    expect(p?.summary).toContain('Bật bơm nước')
  })
  it('derives kind="read" for a confirm-before-read sensor tool', () => {
    const p = recoverPending({
      role: 'assistant',
      content: 'q',
      tool_calls: [
        { id: 'x', type: 'function', function: { name: 'get_latest_sensor', arguments: '{"device_id":"d1"}' } },
      ],
    })
    expect(p?.kind).toBe('read')
  })
  it('returns null when the tool_call arguments are not valid JSON', () => {
    const p = recoverPending({
      role: 'assistant',
      content: 'q',
      tool_calls: [{ id: 'x', type: 'function', function: { name: 'send_command', arguments: '{not json' } }],
    })
    expect(p).toBeNull()
  })
})

describe('encodePending', () => {
  it('encodes a pending view as a single OpenAI tool_call', () => {
    const calls = encodePending({ id: 'abc', summary: 's', tool: 'send_command', args: { device_id: 'd1' } })
    expect(calls).toEqual([
      { id: 'abc', type: 'function', function: { name: 'send_command', arguments: '{"device_id":"d1"}' } },
    ])
  })
})

describe('toCompletion', () => {
  it('maps a plain reply to a chat.completion with no tool_calls', () => {
    const c = toCompletion({ reply: 'Chào bạn!', pendingAction: null }, 'm', 'id1', 100) as any
    expect(c.object).toBe('chat.completion')
    expect(c.model).toBe('m')
    expect(c.choices[0].message).toEqual({ role: 'assistant', content: 'Chào bạn!' })
    expect(c.choices[0].finish_reason).toBe('stop')
    expect(c.usage).toEqual({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 })
  })
  it('attaches tool_calls when a pending action is present', () => {
    const c = toCompletion(
      {
        reply: 'Xác nhận? (Có/Không)',
        pendingAction: { id: 'p', summary: 's', tool: 'send_command', args: { device_id: 'd1' } },
      },
      'm',
      'id1',
      100,
    ) as any
    expect(c.choices[0].message.tool_calls[0].function.name).toBe('send_command')
    expect(c.choices[0].finish_reason).toBe('stop')
  })
})

describe('modelsList', () => {
  it('advertises the single synthetic model', () => {
    const l = modelsList(100) as any
    expect(l.object).toBe('list')
    expect(l.data[0].id).toBe('plant-assistant')
  })
})

describe('streaming builders', () => {
  it('contentChunk carries a content delta and no finish_reason', () => {
    const c = contentChunk('hi', 'm', 'id1', 100) as any
    expect(c.object).toBe('chat.completion.chunk')
    expect(c.choices[0].delta).toEqual({ content: 'hi' })
    expect(c.choices[0].finish_reason).toBeNull()
  })
  it('roleChunk opens the stream with an assistant role delta', () => {
    const c = roleChunk('m', 'id1', 100) as any
    expect(c.choices[0].delta).toEqual({ role: 'assistant' })
  })
  it('finalChunk with a pending action emits an indexed tool_call and finish_reason stop', () => {
    const c = finalChunk({ id: 'p', summary: 's', tool: 'send_command', args: { device_id: 'd1' } }, 'm', 'id1', 100) as any
    expect(c.choices[0].delta.tool_calls[0]).toMatchObject({
      index: 0,
      function: { name: 'send_command', arguments: '{"device_id":"d1"}' },
    })
    expect(c.choices[0].finish_reason).toBe('stop')
  })
  it('finalChunk with no pending action emits an empty delta and finish_reason stop', () => {
    const c = finalChunk(null, 'm', 'id1', 100) as any
    expect(c.choices[0].delta).toEqual({})
    expect(c.choices[0].finish_reason).toBe('stop')
  })
  it('sseData / SSE_DONE serialize in OpenAI SSE format', () => {
    expect(sseData({ a: 1 })).toBe('data: {"a":1}\n\n')
    expect(SSE_DONE).toBe('data: [DONE]\n\n')
  })
})
