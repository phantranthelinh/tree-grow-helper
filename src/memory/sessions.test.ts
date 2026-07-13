import { describe, it, expect } from 'vitest'
import { SessionStore } from './sessions'
import type { PendingAction } from './sessions'

const action = (id: string): PendingAction => ({ id, tool: 'send_command', args: {}, summary: 's' })

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
