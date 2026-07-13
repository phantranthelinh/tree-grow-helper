# Session Persistence + CI Test Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cho `SessionStore` lưu history + pendingAction ra file JSON (sống sót qua restart), thêm TTL cho pendingAction, và bắt CI chạy typecheck+test trước khi publish Docker image.

**Architecture:** `SessionStore` giữ nguyên interface sync 5 method; thêm tuỳ chọn constructor `path` (opt-in persistence, không path → in-memory như cũ) và `pendingTtlMs`/`now`. Trạng thái ghi ra `data/sessions.json` bằng `node:fs` sync (temp+rename atomic) sau mọi mutation. CI dùng một reusable workflow `test.yml` được cả `ci.yml` (PR) lẫn `docker-publish.yml` (gate build) gọi.

**Tech Stack:** TypeScript (ESM, chạy qua `tsx`), Vitest, `node:fs`/`node:path`/`node:os`, GitHub Actions.

## Global Constraints

Mọi task đều phải tuân (giá trị lấy nguyên từ spec):

- **Zero dependency mới.** Chỉ dùng `node:fs` sync (`existsSync`/`readFileSync`/`writeFileSync`/`renameSync`/`mkdirSync`) + `node:path` — mirror `src/rag/embedCache.ts`.
- **Interface public của `SessionStore` không đổi**: 5 method sync `getHistory`/`append`/`getPending`/`setPending`/`clearPending`. `export interface PendingAction` **không thêm field**. JSON trả client (`/chat`, `/chat/confirm`, `/chat/stream`) **không thêm field**.
- **Persistence opt-in**: constructor có `path` → load lúc tạo + ghi sau mọi mutation; **không** `path` → thuần in-memory (hành vi cũ). **Không sửa bất kỳ test hiện có nào.**
- **Mặc định**: `pendingTtlMs = 30 * 60 * 1000`; `sessionsPath = 'data/sessions.json'`; env override `SESSIONS_PATH` / `PENDING_TTL_MS`.
- **Ghi atomic**: `writeFileSync(`${path}.tmp`)` → `renameSync(tmp, path)`. **Load lỗi/thiếu/định dạng lạ → khởi tạo rỗng + `console.warn`, KHÔNG throw.**
- **CI**: Node **22**; chạy `npm ci` → `npm run typecheck` → `npm test`. `npm run eval` **KHÔNG** vào CI. `ci.yml` trigger `pull_request` (main). `docker-publish` job `build-and-push` thêm `needs: test`. Bước test đặt trong reusable `test.yml` (`on: workflow_call`).
- **Ngôn ngữ**: mọi log/copy hướng người dùng bằng **tiếng Việt**.
- **tsconfig `strict` + `noUncheckedIndexedAccess`** đang bật → code parse JSON phải narrow/cast tường minh.

---

### Task 1: pendingAction TTL trong SessionStore (in-memory)

Bọc pending thành `{ action, createdAt }` nội bộ và loại khi quá hạn. Chưa đụng đĩa. Đảm bảo mọi test hiện có vẫn xanh (TTL mặc định 30′, đồng hồ thật → set-rồi-get ngay vẫn trả pending).

**Files:**
- Modify: `src/memory/sessions.ts` (toàn bộ file — xem code Step 3)
- Test: `src/memory/sessions.test.ts` (tạo mới)

**Interfaces:**
- Consumes: `ChatMessage` từ `../llm` (đã có).
- Produces:
  - `export interface SessionStoreOptions { maxTurns?: number; pendingTtlMs?: number; now?: () => number }`
  - `new SessionStore(opts?: SessionStoreOptions)`
  - `getPending(userId: string, sessionId: string): PendingAction | undefined` (áp TTL, tự clear khi hết hạn)
  - `setPending(userId: string, sessionId: string, pending: PendingAction | undefined): void` (đóng dấu `createdAt = now()`)
  - `export interface PendingAction` **không đổi**
  - Nội bộ (không export): `interface PendingRecord { action: PendingAction; createdAt: number }`

- [ ] **Step 1: Viết test thất bại**

Tạo `src/memory/sessions.test.ts`:

```ts
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
```

- [ ] **Step 2: Chạy test để xác nhận fail**

Run: `npx vitest run src/memory/sessions.test.ts`
Expected: FAIL — `SessionStore` constructor chưa nhận `pendingTtlMs`/`now`, TTL chưa tồn tại (test "loại pending" fail vì pending vẫn được trả).

- [ ] **Step 3: Ghi implementation tối thiểu**

Thay toàn bộ `src/memory/sessions.ts` bằng:

```ts
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
```

- [ ] **Step 4: Chạy test để xác nhận pass + không vỡ test cũ**

Run: `npx vitest run src/memory/sessions.test.ts`
Expected: PASS (2 test).

Run: `npm test`
Expected: PASS toàn bộ (các test hiện có ở `tests/orchestrator*.test.ts`, `tests/http*.test.ts` dựng `new SessionStore()` không path → không ảnh hưởng).

Run: `npm run typecheck`
Expected: không lỗi.

- [ ] **Step 5: Commit**

```bash
git add src/memory/sessions.ts src/memory/sessions.test.ts
git commit -m "feat(memory): add pendingAction TTL to SessionStore"
```

---

### Task 2: File persistence cho SessionStore (opt-in, atomic, an toàn khi hỏng)

Thêm tuỳ chọn `path`: load lúc tạo, ghi atomic sau mọi mutation. Không path → không đụng đĩa.

**Files:**
- Modify: `src/memory/sessions.ts` (toàn bộ file — xem code Step 3)
- Test: `src/memory/sessions.test.ts` (thêm describe block)

**Interfaces:**
- Consumes: `SessionStoreOptions`, `PendingRecord`, `PendingAction` từ Task 1.
- Produces:
  - `SessionStoreOptions` thêm field `path?: string`.
  - `new SessionStore({ path })` load `data/sessions.json` lúc tạo và ghi lại sau mỗi mutation.
  - Định dạng file: `{ version: 1, sessions: Record<string, { history: ChatMessage[]; pending?: PendingRecord }> }`.

- [ ] **Step 1: Viết test thất bại**

Thêm vào đầu `src/memory/sessions.test.ts` các import:

```ts
import { afterEach, beforeEach } from 'vitest'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
```

Thêm describe block mới (dùng lại helper `action` đã có ở đầu file):

```ts
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
```

- [ ] **Step 2: Chạy test để xác nhận fail**

Run: `npx vitest run src/memory/sessions.test.ts`
Expected: FAIL — constructor chưa nhận `path`, không load/ghi gì; test "restart" fail (store `b` rỗng).

- [ ] **Step 3: Ghi implementation**

Thay toàn bộ `src/memory/sessions.ts` bằng (thêm import `node:fs`/`node:path`, field `path`, `load()`, `persist()`, và chèn `this.persist()` vào các mutation):

```ts
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
```

- [ ] **Step 4: Chạy test để xác nhận pass**

Run: `npx vitest run src/memory/sessions.test.ts`
Expected: PASS (6 test: 2 của Task 1 + 4 persistence).

Run: `npm test`
Expected: PASS toàn bộ.

Run: `npm run typecheck`
Expected: không lỗi (chú ý `strict` + `noUncheckedIndexedAccess` — code load đã narrow tường minh).

- [ ] **Step 5: Commit**

```bash
git add src/memory/sessions.ts src/memory/sessions.test.ts
git commit -m "feat(memory): persist sessions to disk (opt-in, atomic, TTL-safe)"
```

---

### Task 3: Wiring config + init + .env.example + README

Bật persistence ở production qua config; ghi chú env; sửa dòng README nói "mất khi restart".

**Files:**
- Modify: `src/config.ts:56-57` (thêm khối `memory` trước dòng `defaultPlant`)
- Modify: `src/setup/init.ts:101`
- Modify: `.env.example` (chèn sau dòng 27)
- Modify: `README.md:188` (dòng "Session memory hiện in-memory…")

**Interfaces:**
- Consumes: `new SessionStore({ path, pendingTtlMs })` từ Task 2; helper `num()` có sẵn trong `config.ts`.
- Produces: `config.memory.sessionsPath: string`, `config.memory.pendingTtlMs: number`.

- [ ] **Step 1: Thêm config**

Trong `src/config.ts`, chèn khối `memory` ngay trước dòng `defaultPlant: process.env.DEFAULT_PLANT ?? 'strawberry',`:

```ts
  memory: {
    // Session history + pendingAction được ghi ra file này để sống sót qua restart
    // (mount làm volume trong Docker). Mục tiêu 1–5 user; không hỗ trợ đa-instance.
    sessionsPath: process.env.SESSIONS_PATH ?? 'data/sessions.json',
    // pendingAction quá hạn (ms) coi như không còn → tránh confirm nhầm lệnh cũ sau restart.
    pendingTtlMs: num(process.env.PENDING_TTL_MS, 30 * 60 * 1000),
  },
```

- [ ] **Step 2: Wire vào init**

Trong `src/setup/init.ts`, đổi dòng 101:

```ts
  const sessions = new SessionStore()
```

thành:

```ts
  const sessions = new SessionStore({
    path: appCfg.memory.sessionsPath,
    pendingTtlMs: appCfg.memory.pendingTtlMs,
  })
```

(`appCfg: Config` đã là tham số của `runInitPipeline` — không cần import thêm.)

- [ ] **Step 3: Ghi chú env**

Trong `.env.example`, chèn sau dòng 27 (`MCP_CONFIG_PATH=data/mcp-config.json`):

```bash

# --- Session memory (persistence) ---
# History + pendingAction được ghi ra đây để sống sót qua restart (mount volume trong Docker).
SESSIONS_PATH=data/sessions.json
# pendingAction quá hạn (ms) thì bỏ qua — mặc định 30 phút (1800000).
PENDING_TTL_MS=1800000
```

- [ ] **Step 4: Sửa README**

Trong `README.md`, thay dòng 188:

```markdown
- Session memory hiện in-memory (mất khi restart) — đủ cho demo 1–5 người; thay bằng SQLite nếu cần.
```

thành:

```markdown
- Session memory được ghi ra `data/sessions.json` (sống sót qua restart; `SESSIONS_PATH` để đổi chỗ).
  pendingAction quá `PENDING_TTL_MS` (mặc định 30 phút) thì bỏ qua. Đủ cho 1–5 user; không hỗ trợ đa-instance.
```

- [ ] **Step 5: Verify**

Run: `npm run typecheck`
Expected: không lỗi (config mới + init dùng đúng kiểu).

Run: `npm test`
Expected: PASS toàn bộ (không test nào phụ thuộc `config.memory`; init tests — nếu có — vẫn xanh vì SessionStore path chỉ ghi vào `data/sessions.json` thật khi chạy init thực, không trong unit test).

Verify thủ công (tuỳ chọn, cần LLM đã cấu hình): `npm start`, gửi 1 câu `/chat`, kiểm tra file `data/sessions.json` xuất hiện và chứa history.

- [ ] **Step 6: Commit**

```bash
git add src/config.ts src/setup/init.ts .env.example README.md
git commit -m "feat(config): enable session persistence (path + TTL) + docs"
```

---

### Task 4: CI test gate (reusable workflow + gate publish)

Chạy typecheck+test trên PR; chặn publish image khi test đỏ.

**Files:**
- Create: `.github/workflows/test.yml`
- Create: `.github/workflows/ci.yml`
- Modify: `.github/workflows/docker-publish.yml` (thêm job `test`, `build-and-push` thêm `needs: test`)

**Interfaces:**
- Produces: reusable workflow `./.github/workflows/test.yml` (`on: workflow_call`) gọi được từ `ci.yml` và `docker-publish.yml`.

- [ ] **Step 1: Tạo reusable test workflow**

Tạo `.github/workflows/test.yml`:

```yaml
name: Test

on:
  workflow_call:

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Set up Node
        uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm

      - name: Install deps
        run: npm ci

      - name: Typecheck
        run: npm run typecheck

      - name: Test
        run: npm test
```

- [ ] **Step 2: Tạo CI workflow cho PR**

Tạo `.github/workflows/ci.yml`:

```yaml
name: CI

on:
  pull_request:
    branches: [main]

jobs:
  test:
    uses: ./.github/workflows/test.yml
```

- [ ] **Step 3: Gate publish trên test**

Trong `.github/workflows/docker-publish.yml`, sửa khối `jobs:` — thêm job `test` và cho `build-and-push` phụ thuộc nó. Đổi:

```yaml
jobs:
  build-and-push:
    runs-on: ubuntu-latest
    permissions:
```

thành:

```yaml
jobs:
  test:
    uses: ./.github/workflows/test.yml

  build-and-push:
    needs: test
    runs-on: ubuntu-latest
    permissions:
```

(Phần còn lại của `build-and-push` giữ nguyên.)

- [ ] **Step 4: Verify**

Kiểm tra YAML hợp lệ (không cần công cụ ngoài):

Run: `node -e "const y=require('fs').readFileSync;['.github/workflows/test.yml','.github/workflows/ci.yml','.github/workflows/docker-publish.yml'].forEach(f=>console.log(f, y(f,'utf8').length,'bytes'))"`
Expected: in ra 3 dòng, không lỗi đọc file.

Chạy đúng các lệnh CI sẽ chạy, tại local, để chắc chúng xanh:

Run: `npm run typecheck && npm test`
Expected: cả hai PASS (đây chính là bước `test.yml` thực thi).

> Lưu ý: GitHub Actions không chạy được offline; xác thực đầy đủ đồ thị `needs`/`uses` chỉ thấy khi mở PR / push. Đồ thị đã đúng theo cấu trúc ở trên.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/test.yml .github/workflows/ci.yml .github/workflows/docker-publish.yml
git commit -m "ci: run typecheck+test on PR and gate image publish on it"
```

---

## Self-Review

**1. Spec coverage:**
- FR1 (opt-in constructor, 5 method sync giữ nguyên) → Task 1 + Task 2. ✔
- FR2 (định dạng file, wrapper createdAt, flush mọi mutation, atomic temp+rename) → Task 2 Step 3. ✔
- FR3 (load; thiếu/hỏng/version lạ → rỗng, không throw) → Task 2 `load()` + test "file hỏng". ✔
- FR4 (TTL trong getPending + set createdAt) → Task 1 + Task 2. ✔
- FR5 (config.memory + init wiring + .env.example) → Task 3. ✔
- FR6 (test.yml reusable, ci.yml PR, docker-publish needs test, Node 22, eval loại) → Task 4. ✔
- Edge cases (crash-giữa-ghi via atomic, isolation in-memory, pending-quá-hạn-qua-restart) → tests Task 2. ✔
- README "mất khi restart" outdated → Task 3 Step 4. ✔

**2. Placeholder scan:** không có "TBD/TODO/xử lý phù hợp/tương tự Task N". Mọi step có code/lệnh cụ thể. ✔

**3. Type consistency:** `SessionStoreOptions` (Task 1: `maxTurns/pendingTtlMs/now`; Task 2 thêm `path`) nhất quán; `PendingRecord { action, createdAt }`, `PersistedShape { version:1, sessions }` dùng đồng nhất; `getPending` trả `PendingAction | undefined` xuyên suốt; `now: () => number` khớp giữa test và impl; `new SessionStore({ path, pendingTtlMs })` ở init khớp constructor Task 2. ✔

## Notes
- Thứ tự phụ thuộc: Task 1 → Task 2 → Task 3. Task 4 độc lập (có thể làm song song/bất kỳ lúc nào).
- Mọi commit trên nhánh `feat/session-persistence-and-ci` (đã tạo, spec đã commit ở `b9d44ce`).
