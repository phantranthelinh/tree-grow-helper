import { describe, expect, it } from 'vitest'
import { AppState } from '../src/setup/state'

describe('AppState rebuild lock', () => {
  it('begin/end toggles isRebuilding and marks the rag step running', () => {
    const s = new AppState()
    expect(s.isRebuilding()).toBe(false)
    s.beginRebuild()
    expect(s.isRebuilding()).toBe(true)
    expect(s.getStatus().steps.find((x) => x.id === 'rag')?.status).toBe('running')
    s.endRebuild()
    expect(s.isRebuilding()).toBe(false)
  })

  it('embedModel returns empty string before config and the configured model after', () => {
    const s = new AppState()
    expect(s.embedModel()).toBe('')
    s.beginConnecting()
    s.beginInitializing(
      { provider: 'lmstudio', baseURL: 'x', apiKey: 'k', model: 'chat', embedModel: 'bge-m3' },
      'http://mcp',
    )
    expect(s.embedModel()).toBe('bge-m3')
  })
})
