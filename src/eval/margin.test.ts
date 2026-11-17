import { describe, expect, it } from 'vitest'
import type { TokenLogprob } from '../llm'
import { typeMargin } from './margin'

const tok = (token: string, top: Array<[string, number]> = []): TokenLogprob => ({
  token,
  logprob: top[0]?.[1] ?? 0,
  top: top.map(([t, logprob]) => ({ token: t, logprob })),
})

describe('typeMargin', () => {
  it('reads log p(reply) − log p(tool) at the type token', () => {
    const tokens = [tok('{"'), tok('type'), tok('":"'), tok('reply', [['reply', 0], ['tool', -12.11], [' reply', -16.8]]), tok('","')]
    expect(typeMargin(tokens)).toBeCloseTo(12.11)
  })

  it('is negative for a tool decision and tolerates spaced JSON', () => {
    const tokens = [tok('{\n  "'), tok('type'), tok('": "'), tok('tool', [['tool', -0.2], ['reply', -1.7]])]
    expect(typeMargin(tokens)).toBeCloseTo(-1.5)
  })

  it('bounds the margin by the lowest listed alternative when a choice is missing', () => {
    const tokens = [tok('{"'), tok('type'), tok('":"'), tok('tool', [['tool', 0], ['tools', -18.1], ['工具', -18.7]])]
    expect(typeMargin(tokens)).toBeCloseTo(-18.7)
  })

  it('is null without a type token or without alternatives', () => {
    expect(typeMargin([tok('{"'), tok('message')])).toBeNull()
    expect(typeMargin([tok('{"'), tok('type'), tok('":"'), tok('reply')])).toBeNull()
  })
})
