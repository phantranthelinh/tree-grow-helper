import { afterEach, beforeEach, describe, it, expect } from 'vitest'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionStore } from './sessions'
import type { PendingAction } from './sessions'

const action = (id: string): PendingAction => ({ id, tool: 'set_pump', args: {}, summary: 's' })

describe('SessionStore pendingAction TTL', () => {
  it('trả pending khi còn trong hạn', () => {
    let t = 1000
    const s = new SessionStore({ pendingTtlMs: 5000, now: () => t })
    s.setPending('u1', 's1', action('a'))
    t = 1000 + 4999
    expect(s.getPending('u1', 's1')?.id).toBe('a')
  })

  it('loại pending khi quá hạn và clear hẳn', () => {
    let t = 1000
    const s = new SessionStore({ pendingTtlMs: 5000, now: () => t })
    s.setPending('u1', 's1', action('a'))
    t = 1000 + 5001
    expect(s.getPending('u1', 's1')).toBeUndefined()
    // đã clear, không chỉ ẩn: lùi đồng hồ về trong hạn vẫn không còn
    t = 1000
    expect(s.getPending('u1', 's1')).toBeUndefined()
  })
})

describe('SessionStore persistence (opt-in)', () => {
  let dir: string
  let path: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sessions-'))
    path = join(dir, 'sessions.json')
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('history + pending sống sót qua "restart"', () => {
    const a = new SessionStore({ path })
    a.append('u1', 's1', { role: 'user', content: 'chào' })
    a.setPending('u1', 's1', action('x'))

    const b = new SessionStore({ path })
    expect(b.getHistory('u1', 's1')).toEqual([{ role: 'user', content: 'chào' }])
    expect(b.getPending('u1', 's1')?.id).toBe('x')
    expect(existsSync(`${path}.tmp`)).toBe(false) // rename đã dọn temp
  })

  it('pending quá hạn bị loại ngay khi load', () => {
    const a = new SessionStore({ path, pendingTtlMs: 5000, now: () => 1000 })
    a.setPending('u1', 's1', action('x'))

    const b = new SessionStore({ path, pendingTtlMs: 5000, now: () => 1000 + 6000 })
    expect(b.getPending('u1', 's1')).toBeUndefined()
  })

  it('file hỏng khi load → khởi tạo rỗng, không throw', () => {
    writeFileSync(path, '{ hỏng json')
    let s: SessionStore | undefined
    expect(() => {
      s = new SessionStore({ path })
    }).not.toThrow()
    expect(s!.getHistory('u1', 's1')).toEqual([])
  })

  it('không path → in-memory, không chia sẻ trạng thái', () => {
    const a = new SessionStore()
    a.append('u1', 's1', { role: 'user', content: 'chào' })
    const b = new SessionStore()
    expect(b.getHistory('u1', 's1')).toEqual([])
  })
})
