import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
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

/** On-disk shape written to `path`. `version` guards against format drift. */
interface PersistedShape {
  version: 1
  sessions: Record<string, { history: ChatMessage[]; pending?: PendingRecord }>
}

export interface SessionStoreOptions {
  /** Max multi-turn turns kept (each turn ≈ 2 messages). Default 20. */
  maxTurns?: number
  /** A pending action older than this (ms) is treated as gone. Default 30 min. */
  pendingTtlMs?: number
  /** Clock injection point for deterministic TTL tests. Default Date.now. */
  now?: () => number
  /** File to persist to. Set → load on construct + write after every mutation. Absent → pure in-memory. */
  path?: string
}

/**
 * Multi-turn store keyed by userId+sessionId. In-memory by default; pass `path`
 * to survive restarts (writes JSON atomically after every mutation). Sufficient
 * for the 1-5 user internal/demo target — NOT multi-process/multi-instance safe.
 */
export class SessionStore {
  private readonly sessions = new Map<string, Session>()
  private readonly maxMessages: number
  private readonly pendingTtlMs: number
  private readonly now: () => number
  private readonly path?: string

  constructor(opts?: SessionStoreOptions) {
    this.maxMessages = (opts?.maxTurns ?? 20) * 2
    this.pendingTtlMs = opts?.pendingTtlMs ?? 30 * 60 * 1000
    this.now = opts?.now ?? (() => Date.now())
    this.path = opts?.path
    if (this.path) {
      mkdirSync(dirname(this.path), { recursive: true })
      this.load()
    }
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

  /** Load from disk. Missing/corrupt/unknown-format → start empty (warn, never throw). */
  private load(): void {
    if (!this.path || !existsSync(this.path)) return
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(this.path, 'utf8'))
    } catch (err) {
      console.warn(`[sessions] không parse được ${this.path} (${(err as Error).message}) — khởi tạo rỗng.`)
      return
    }
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      (parsed as { version?: unknown }).version !== 1 ||
      typeof (parsed as { sessions?: unknown }).sessions !== 'object' ||
      (parsed as { sessions?: unknown }).sessions === null
    ) {
      console.warn(`[sessions] định dạng ${this.path} không nhận diện được — khởi tạo rỗng.`)
      return
    }
    const sessions = (parsed as { sessions: Record<string, unknown> }).sessions
    const now = this.now()
    for (const [k, v] of Object.entries(sessions)) {
      const rec = v as { history?: unknown; pending?: PendingRecord }
      const history = Array.isArray(rec.history) ? (rec.history as ChatMessage[]) : []
      let pending = rec.pending
      if (pending && now - pending.createdAt > this.pendingTtlMs) pending = undefined
      this.sessions.set(k, { history, pending })
    }
  }

  /** Write the whole store atomically (temp + rename). No-op when in-memory. */
  private persist(): void {
    if (!this.path) return
    const out: PersistedShape = { version: 1, sessions: {} }
    for (const [k, s] of this.sessions) {
      out.sessions[k] = { history: s.history, pending: s.pending }
    }
    const tmp = `${this.path}.tmp`
    writeFileSync(tmp, JSON.stringify(out))
    renameSync(tmp, this.path)
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
    this.persist()
  }

  getPending(userId: string, sessionId: string): PendingAction | undefined {
    const s = this.session(userId, sessionId)
    if (!s.pending) return undefined
    if (this.now() - s.pending.createdAt > this.pendingTtlMs) {
      s.pending = undefined
      this.persist()
      return undefined
    }
    return s.pending.action
  }

  setPending(userId: string, sessionId: string, pending: PendingAction | undefined): void {
    this.session(userId, sessionId).pending = pending
      ? { action: pending, createdAt: this.now() }
      : undefined
    this.persist()
  }

  clearPending(userId: string, sessionId: string): void {
    this.session(userId, sessionId).pending = undefined
    this.persist()
  }
}
