import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { config, type Config } from '../config'
import type { LlmEngine } from '../llm'
import { loadProfile } from '../domain/profiles'
import { ingestAll } from './buildStore'

class FakeLlm implements LlmEngine {
  async complete() {
    return ''
  }
  async completeJson() {
    return '{}'
  }
  async *completeStream() {
    yield ''
  }
  async *completeJsonStream() {
    yield '{}'
  }
  async embed(texts: string[]) {
    return texts.map(() => [0.1, 0.2, 0.3])
  }
}

function testConfig(): Config {
  const dir = mkdtempSync(join(tmpdir(), 'tgh-buildstore-'))
  return {
    ...config,
    rag: { ...config.rag, disabled: false, embedCachePath: join(dir, 'cache.jsonl'), docsDir: join(dir, 'docs') },
  } as Config
}

describe('ingestAll', () => {
  it('builds a populated store with per-source counts and a detail string', async () => {
    const profile = loadProfile('strawberry')
    const res = await ingestAll(new FakeLlm(), testConfig(), profile, 'embed-model')

    expect(res.counts.profile).toBeGreaterThan(0)
    expect(res.counts.docs).toBe(0) // empty docs dir
    expect(res.store.size()).toBe(res.counts.profile + res.counts.docs + res.counts.diseases)
    expect(res.detail).toMatch(/profile.*doc.*disease.*store=/)
  })
})
