import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { loadMcpConfig, saveMcpConfig, type McpConfig } from '../src/setup/mcpConfig'

const dir = mkdtempSync(join(tmpdir(), 'mcpcfg-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const cfg: McpConfig = { url: 'http://localhost:8000/mcp' }

describe('saveMcpConfig / loadMcpConfig', () => {
  it('round-trips a config and creates parent dirs', () => {
    const path = join(dir, 'nested', 'mcp-config.json')
    saveMcpConfig(path, cfg)
    expect(existsSync(path)).toBe(true)
    expect(loadMcpConfig(path)).toEqual(cfg)
  })

  it('returns null when the file is missing', () => {
    expect(loadMcpConfig(join(dir, 'nope.json'))).toBeNull()
  })

  it('returns null on invalid JSON', () => {
    const path = join(dir, 'garbage.json')
    writeFileSync(path, '{ not json', 'utf8')
    expect(loadMcpConfig(path)).toBeNull()
  })

  it('returns null on schema mismatch', () => {
    const path = join(dir, 'wrong.json')
    writeFileSync(path, JSON.stringify({ url: 'not-a-url' }), 'utf8')
    expect(loadMcpConfig(path)).toBeNull()
  })

  it('returns null on an empty object', () => {
    const path = join(dir, 'empty.json')
    writeFileSync(path, '{}', 'utf8')
    expect(loadMcpConfig(path)).toBeNull()
  })
})
