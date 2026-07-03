import { describe, expect, it } from 'vitest'
import { AppState } from '../src/setup/state'
import type { LlmConfig } from '../src/setup/llmConfig'

const cfg: LlmConfig = {
  provider: 'lmstudio',
  baseURL: 'http://localhost:1234/v1',
  apiKey: 'secret-key',
  model: 'chat-model',
  embedModel: 'embed-model',
}

// A minimal stand-in — AppState only stores/returns the reference.
const fakeOrch = {} as never

describe('AppState', () => {
  it('starts in waiting_config with no orchestrator', () => {
    const s = new AppState()
    expect(s.phase).toBe('waiting_config')
    expect(s.orchestrator).toBeNull()
    expect(s.isBusy()).toBe(false)
    expect(s.getStatus().config).toBeNull()
  })

  it('connecting -> fail returns to waiting_config and keeps the error', () => {
    const s = new AppState()
    s.beginConnecting()
    expect(s.phase).toBe('connecting')
    expect(s.isBusy()).toBe(true)
    s.fail('chat', 'auth_failed', 'API key không hợp lệ')
    expect(s.phase).toBe('waiting_config')
    const status = s.getStatus()
    expect(status.error).toEqual({ stage: 'chat', code: 'auth_failed', message: 'API key không hợp lệ' })
    expect(status.steps.find((x) => x.id === 'llm')?.status).toBe('failed')
  })

  it('setReady swaps in the orchestrator and marks ready', () => {
    const s = new AppState()
    s.beginConnecting()
    s.beginInitializing(cfg)
    expect(s.phase).toBe('initializing')
    s.setReady(fakeOrch)
    expect(s.phase).toBe('ready')
    expect(s.orchestrator).toBe(fakeOrch)
    expect(s.getStatus().error).toBeNull()
  })

  it('getStatus never leaks the API key', () => {
    const s = new AppState()
    s.beginConnecting()
    s.beginInitializing(cfg)
    const serialized = JSON.stringify(s.getStatus())
    expect(serialized).not.toContain('secret-key')
    expect(s.getStatus().config).toMatchObject({ provider: 'lmstudio', model: 'chat-model' })
  })

  it('AppState.ready() builds a ready state with an orchestrator', () => {
    const s = AppState.ready(fakeOrch)
    expect(s.phase).toBe('ready')
    expect(s.orchestrator).toBe(fakeOrch)
    expect(s.getStatus().steps.every((x) => x.status === 'done')).toBe(true)
  })
})
