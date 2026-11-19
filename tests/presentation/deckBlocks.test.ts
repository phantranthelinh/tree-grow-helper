import { describe, expect, it } from 'vitest'
import { extractScriptBlock, replaceScriptBlock, toJsonBlock } from '../../scripts/deck-blocks'

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
