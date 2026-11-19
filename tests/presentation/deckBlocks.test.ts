import { describe, expect, it } from 'vitest'
import { extractScriptBlock, replaceScriptBlock, toJsonBlock } from '../../scripts/deck-blocks'
import { buildRecordings, missingRecordings, type DemoConfig } from '../../scripts/record-deck-demo'

describe('demo recordings', () => {
  it('buildRecordings asks each preset only on its sides and skips failures', async () => {
    const cfg = {
      model: 'm',
      presets: [
        { id: 'a', question: 'q', sides: ['left', 'right'] },
        { id: 'w', question: 'q2', sides: ['right'] },
      ],
    } as unknown as DemoConfig
    const asked: string[] = []
    const rec = await buildRecordings(cfg, async (side, p) => {
      asked.push(`${side}:${p.id}`)
      if (side === 'right' && p.id === 'a') throw new Error('down')
      return `${side}-${p.id}`
    }, '2026-11-19')
    expect(asked.sort()).toEqual(['left:a', 'right:a', 'right:w'])
    expect(rec).toEqual({ recordedAt: '2026-11-19', model: 'm', left: { a: 'left-a' }, right: { w: 'right-w' }, rightSource: 'live' })
  })

  it('missingRecordings lists every preset side that got no answer', () => {
    const cfg = {
      model: 'm',
      presets: [
        { id: 'a', question: 'q', sides: ['left', 'right'] },
        { id: 'w', question: 'q2', sides: ['right'] },
      ],
    } as unknown as DemoConfig
    const rec = { recordedAt: 'd', model: 'm', left: { a: 'x' }, right: {}, rightSource: 'live' as const }
    expect(missingRecordings(cfg, rec)).toEqual(['right · a', 'right · w'])
    expect(missingRecordings(cfg, { ...rec, right: { a: 'y', w: 'z' } })).toEqual([])
  })

  it('buildRecordings never stores an empty answer', async () => {
    const cfg = { model: 'm', presets: [{ id: 'a', question: 'q', sides: ['left'] }] } as unknown as DemoConfig
    const rec = await buildRecordings(cfg, async () => '   ', '2026-11-19')
    expect(rec.left).toEqual({})
  })
})

describe('deck script blocks', () => {
  it('extracts and replaces a block by id', () => {
    const html = '<p></p><script id="a" type="application/json">{"x":1}</script>'
    expect(extractScriptBlock(html, 'a')).toBe('{"x":1}')
    expect(replaceScriptBlock(html, 'a', '{}')).toBe('<p></p><script id="a" type="application/json">{}</script>')
  })

  it('throws on a missing or duplicated id', () => {
    expect(() => extractScriptBlock('<p></p>', 'b')).toThrow()
    expect(() => extractScriptBlock('<script id="a"></script><script id="a"></script>', 'a')).toThrow()
    expect(() => replaceScriptBlock('<p></p>', 'b', '{}')).toThrow()
  })

  it('escapes < so a value cannot close the script tag', () => {
    expect(toJsonBlock({ t: '</script>' })).not.toContain('</')
    expect(JSON.parse(toJsonBlock({ t: '</script>' })).t).toBe('</script>')
  })
})
