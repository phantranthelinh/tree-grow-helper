import type { ChatMessage } from '../llm'

export interface PendingAction {
  id: string
  tool: string
  args: Record<string, unknown>
  summary: string
  /**
   * How the action runs once confirmed:
   *  - 'control' (default): a device command executed via executeAction.
   *  - 'read': a user-facing sensor read that runs and is summarized on confirm.
   * Optional for backward compatibility; absent means 'control'.
   */
  kind?: 'control' | 'read'
}

/**
 * In-memory pending wrapper. `createdAt` (epoch ms) drives the TTL and is kept
 * OUT of PendingAction so the public type / client JSON never gain a field.
 */
interface PendingRecord {
  action: PendingAction
  createdAt: number
}

interface Session {
  history: ChatMessage[]
  pending?: PendingRecord
}

export interface SessionStoreOptions {
  /** Max multi-turn turns kept (each turn ≈ 2 messages). Default 20. */
  maxTurns?: number
  /** A pending action older than this (ms) is treated as gone. Default 30 min. */
  pendingTtlMs?: number
  /** Clock injection point for deterministic TTL tests. Default Date.now. */
  now?: () => number
}

/**
 * Multi-turn store keyed by userId+sessionId. In-memory by default; pass a
 * `path` (see the persistence overload) to survive restarts. Sufficient for the
 * 1-5 user internal/demo target.
 */
export class SessionStore {
  private readonly sessions = new Map<string, Session>()
  private readonly maxMessages: number
  private readonly pendingTtlMs: number
  private readonly now: () => number

  constructor(opts?: SessionStoreOptions) {
    this.maxMessages = (opts?.maxTurns ?? 20) * 2
    this.pendingTtlMs = opts?.pendingTtlMs ?? 30 * 60 * 1000
    this.now = opts?.now ?? (() => Date.now())
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
    const s = this.session(userId, sessionId)
    if (!s.pending) return undefined
    if (this.now() - s.pending.createdAt > this.pendingTtlMs) {
      s.pending = undefined
      return undefined
    }
    return s.pending.action
  }

  setPending(userId: string, sessionId: string, pending: PendingAction | undefined): void {
    this.session(userId, sessionId).pending = pending
      ? { action: pending, createdAt: this.now() }
      : undefined
  }

  clearPending(userId: string, sessionId: string): void {
    this.session(userId, sessionId).pending = undefined
  }
}
