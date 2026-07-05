import { describe, expect, it } from 'vitest'
import { JsonStringFieldStreamer, type ScanEvent } from './streamParser'

/** Push each chunk through a fresh scanner and gather everything it emits. */
function collect(chunks: string[]): { events: ScanEvent[]; raw: string } {
  const scanner = new JsonStringFieldStreamer()
  const events: ScanEvent[] = []
  for (const chunk of chunks) events.push(...scanner.push(chunk))
  return { events, raw: scanner.raw() }
}

function joinedMessage(events: ScanEvent[]): string {
  return events
    .filter((e): e is Extract<ScanEvent, { kind: 'message' }> => e.kind === 'message')
    .map((e) => e.text)
    .join('')
}

describe('JsonStringFieldStreamer', () => {
  it('decodes the message field correctly at every possible chunk split point', () => {
    const s =
      '{"reasoning":"vì \\"độ ẩm\\" thấp","type":"reply","message":"Nên tưới 2 lần\\nsáng và chiều \\u2014 khoảng 75%","tool":null,"args":{"message":"decoy"}}'
    const expected = JSON.parse(s) as { message: string }
    for (let i = 0; i <= s.length; i++) {
      const { events } = collect([s.slice(0, i), s.slice(i)])
      expect(joinedMessage(events)).toBe(expected.message)
      expect(events).toContainEqual({ kind: 'field', key: 'type', value: 'reply' })
      expect(events.filter((e) => e.kind === 'end')).toHaveLength(1)
    }
  })

  it('decodes a surrogate-pair escape split mid-hex across chunks', () => {
    // 🍓 = 🍓, cut inside both hex runs
    const { events } = collect(['{"type":"reply","message":"Dâu \\ud', '83c\\udf5', '3 ngon"}'])
    expect(joinedMessage(events)).toBe('Dâu 🍓 ngon')
  })

  it('emits message deltas even when message arrives before type (no gating here)', () => {
    const { events } = collect(['{"message":"xin ', 'chào","type":"reply"}'])
    expect(joinedMessage(events)).toBe('xin chào')
    const firstMessage = events.findIndex((e) => e.kind === 'message')
    const typeField = events.findIndex((e) => e.kind === 'field' && e.key === 'type')
    expect(firstMessage).toBeGreaterThanOrEqual(0)
    expect(typeField).toBeGreaterThan(firstMessage)
  })

  it('ignores a "message" key nested inside args', () => {
    const { events } = collect(['{"args":{"message":"decoy"},"type":"tool","tool":"send_command","message":"thật"}'])
    expect(joinedMessage(events)).toBe('thật')
    expect(events).toContainEqual({ kind: 'field', key: 'tool', value: 'send_command' })
  })

  it('ignores "message" appearing as another field\'s string value', () => {
    const { events } = collect(['{"reasoning":"message","type":"reply","message":"ok"}'])
    expect(joinedMessage(events)).toBe('ok')
  })

  it('skips garbage before the first { and after the closing }', () => {
    const input = '```json\n{"type":"reply","message":"ok"}\n``` xong'
    const { events, raw } = collect([input.slice(0, 12), input.slice(12)])
    expect(joinedMessage(events)).toBe('ok')
    expect(events.filter((e) => e.kind === 'end')).toHaveLength(1)
    expect(raw).toBe(input)
  })

  it('survives a stream truncated mid-string without throwing', () => {
    const { events, raw } = collect(['{"type":"reply","message":"dở da'])
    expect(joinedMessage(events)).toBe('dở da')
    expect(events.some((e) => e.kind === 'end')).toBe(false)
    expect(raw).toBe('{"type":"reply","message":"dở da')
  })

  it('reports a type value split across chunks as a single complete field event', () => {
    const { events } = collect(['{"ty', 'pe":"re', 'ply","message":"a"}'])
    const typeFields = events.filter((e) => e.kind === 'field' && e.key === 'type')
    expect(typeFields).toEqual([{ kind: 'field', key: 'type', value: 'reply' }])
  })

  it('emits nothing for non-string type/tool values', () => {
    const { events } = collect(['{"type":"reply","tool":null,"message":"a"}'])
    expect(events.some((e) => e.kind === 'field' && e.key === 'tool')).toBe(false)
  })

  it('closes cleanly when a bare primitive is the last field before }', () => {
    const { events } = collect(['{"type":"reply","tool":null}'])
    expect(events).toContainEqual({ kind: 'field', key: 'type', value: 'reply' })
    expect(events.filter((e) => e.kind === 'end')).toHaveLength(1)
  })

  it('does not end a key early on an escaped quote inside the key name', () => {
    const { events } = collect(['{"me\\"ssage":"decoy","message":"ok"}'])
    expect(joinedMessage(events)).toBe('ok')
  })
})
