import { describe, expect, it } from 'vitest'
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
