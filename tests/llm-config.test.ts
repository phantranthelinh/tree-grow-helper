import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { loadLlmConfig, saveLlmConfig, type LlmConfig } from '../src/setup/llmConfig'

const dir = mkdtempSync(join(tmpdir(), 'llmcfg-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const cfg: LlmConfig = {
  provider: 'ollama',
  baseURL: 'http://localhost:11434/v1',
  apiKey: 'ollama',
  model: 'qwen2.5:3b',
  embedModel: 'nomic-embed-text',
}

describe('saveLlmConfig / loadLlmConfig', () => {
  it('round-trips a config and creates parent dirs', () => {
    const path = join(dir, 'nested', 'llm-config.json')
    saveLlmConfig(path, cfg)
    expect(existsSync(path)).toBe(true)
    expect(loadLlmConfig(path)).toEqual(cfg)
  })

  it('returns null when the file is missing', () => {
    expect(loadLlmConfig(join(dir, 'nope.json'))).toBeNull()
  })

  it('returns null on invalid JSON', () => {
    const path = join(dir, 'garbage.json')
    writeFileSync(path, '{ not json', 'utf8')
    expect(loadLlmConfig(path)).toBeNull()
  })

  it('returns null on schema mismatch', () => {
    const path = join(dir, 'wrong.json')
    writeFileSync(path, JSON.stringify({ provider: 'lmstudio', baseURL: 'http://x/v1' }), 'utf8')
    expect(loadLlmConfig(path)).toBeNull()
  })
})
