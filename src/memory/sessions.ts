import type { ChatMessage } from '../llm'

export interface PendingAction {
  id: string
  tool: string
  args: Record<string, unknown>
  summary: string
}

interface Session {
  history: ChatMessage[]
  pending?: PendingAction
}

/**
 * In-memory multi-turn store keyed by userId+sessionId. Sufficient for the
 * 1-5 user internal/demo target; swap for SQLite if persistence is needed.
 */
export class SessionStore {
  private readonly sessions = new Map<string, Session>()
  private readonly maxMessages: number

  constructor(opts?: { maxTurns?: number }) {
    this.maxMessages = (opts?.maxTurns ?? 20) * 2
  }

  private key(userId: string, sessionId: string): string {
    return `${userId}::${sessionId}`
  }

  private session(userId: string, sessionId: string): Session {
    const k = this.key(userId, sessionId)
    let s = this.sessions.get(k)
    if (!s) {
      s = { history: [] }
      this.sessions.set(k, s)
    }
    return s
  }

  getHistory(userId: string, sessionId: string): ChatMessage[] {
    return [...this.session(userId, sessionId).history]
  }

  append(userId: string, sessionId: string, ...messages: ChatMessage[]): void {
    const s = this.session(userId, sessionId)
    s.history.push(...messages)
    if (s.history.length > this.maxMessages) {
      s.history = s.history.slice(-this.maxMessages)
    }
  }

  getPending(userId: string, sessionId: string): PendingAction | undefined {
    return this.session(userId, sessionId).pending
  }

  setPending(userId: string, sessionId: string, pending: PendingAction | undefined): void {
    this.session(userId, sessionId).pending = pending
  }

  clearPending(userId: string, sessionId: string): void {
    this.session(userId, sessionId).pending = undefined
  }
}
