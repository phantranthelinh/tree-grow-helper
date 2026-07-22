# OpenAI Endpoint Server-Side Session Memory — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `POST /v1/chat/completions` remember a conversation server-side by `session_id` (ChatGPT-style), minting a `uuidv4` when none is supplied and returning it via the `X-Session-Id` header.

**Architecture:** Drop the per-request ephemeral `SessionStore`; run the agent against the orchestrator's persistent store instead. Resolve `userId = body.user ?? 'openai'` and `sessionId = body.session_id?.trim() || randomUUID()`. Server memory is authoritative (only the last user message is the input), with **seed-on-empty**: a brand-new session is seeded from the caller's `messages[]` (keeping legacy full-history OpenAI clients working), while an existing session ignores caller history. Control confirmations live server-side (client just replies "có"/"không").

**Tech Stack:** TypeScript (ESM, run via `tsx`), Fastify, Zod, Vitest, `@fastify/cors`, `node:crypto` `randomUUID`.

## Global Constraints

- **All user-facing text is Vietnamese** — Swagger descriptions, reply copy, examples. (from CLAUDE.md)
- **No external services in tests** — use the existing `FakeLlm` / `FakeMcp` DI fakes. (from CLAUDE.md testing conventions)
- **ESM, extensionless imports**, no build step; verify with `npm run typecheck`.
- **Do not fork the agent core** — reuse `Orchestrator.handleChat` / `handleChatStream`; only add a getter. (from spec Goals)
- **Keep the safety invariant** — control tools never execute inline; confirmation required. (from spec)
- Response format unchanged: `chat.completion` / `chat.completion.chunk`, `finish_reason: 'stop'`, `usage` all-zero, streaming ends with `data: [DONE]`.

---

### Task 1: Enabling seams (DTO fields, orchestrator getter, SSE extra headers, CORS expose)

**Files:**
- Modify: `src/http/openai/dto.ts`
- Modify: `src/agent/orchestrator.ts`
- Modify: `src/http/sse.ts`
- Modify: `src/http/server.ts:26`
- Test: `tests/openai.http.test.ts`

**Interfaces:**
- Produces:
  - `OpenAiChatRequest` gains optional `session_id?: string`, `user?: string`.
  - `Orchestrator.sessions: SessionStore` (read-only getter) returning `this.deps.sessions`.
  - `writeSseHead(raw: ServerResponse, extraHeaders?: Record<string, string>): void` — extra headers merged into the `writeHead` object.
  - CORS responses carry `Access-Control-Expose-Headers: X-Session-Id`.

- [ ] **Step 1: Write the failing tests**

Add to `tests/openai.http.test.ts` (inside the existing `describe('OpenAI-compatible API (buffered)', …)` block, alongside the other `it(...)` cases):

```ts
  it('Orchestrator exposes its session store via a getter', () => {
    const sessions = new SessionStore()
    const orch = new Orchestrator({
      llm,
      mcp,
      store: new InMemoryVectorStore(),
      sessions,
      profile: loadProfile('strawberry'),
      tools: [],
      maxToolSteps: 3,
      ragTopK: 4,
    })
    expect(orch.sessions).toBe(sessions)
  })

  it('exposes X-Session-Id to browsers via CORS', async () => {
    const app = makeApp(llm, mcp)
    const res = await app.inject({
      method: 'GET',
      url: '/v1/models',
      headers: { origin: 'http://example.com' },
    })
    expect(res.headers['access-control-expose-headers']).toContain('X-Session-Id')
    await app.close()
  })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/openai.http.test.ts -t "session store via a getter"` and `npx vitest run tests/openai.http.test.ts -t "exposes X-Session-Id"`
Expected: FAIL — first with a type/`orch.sessions` undefined error, second because `access-control-expose-headers` is absent.

- [ ] **Step 3: Add the `session_id` / `user` fields to the request DTO**

In `src/http/openai/dto.ts`, extend `OpenAiChatRequestSchema`:

```ts
export const OpenAiChatRequestSchema = z
  .object({
    model: z.string().min(1),
    messages: z.array(Message).min(1),
    stream: z.boolean().optional(),
    session_id: z.string().optional(),
    user: z.string().optional(),
  })
  .passthrough()
```

- [ ] **Step 4: Add the `sessions` getter to `Orchestrator`**

In `src/agent/orchestrator.ts`, right after the existing `engine` getter (near line 171):

```ts
  /** The session store this orchestrator persists to — used by the OpenAI facade to seed/read server-side memory. */
  get sessions(): SessionStore {
    return this.deps.sessions
  }
```

(`SessionStore` is already imported as a type at the top of the file — no new import.)

- [ ] **Step 5: Let `writeSseHead` accept extra headers**

Replace the body of `writeSseHead` in `src/http/sse.ts`:

```ts
export function writeSseHead(raw: ServerResponse, extraHeaders?: Record<string, string>): void {
  raw.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
    ...extraHeaders,
  })
  // light-my-request's mock response has no flushHeaders.
  if (typeof raw.flushHeaders === 'function') raw.flushHeaders()
}
```

(The existing `/chat/stream` caller passes no second argument — unchanged.)

- [ ] **Step 6: Expose `X-Session-Id` in CORS**

In `src/http/server.ts:26`, add `exposedHeaders`:

```ts
  app.register(fastifyCors, {
    origin: true,
    methods: ['GET', 'POST', 'OPTIONS'],
    exposedHeaders: ['X-Session-Id'],
  })
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run tests/openai.http.test.ts` then `npm run typecheck`
Expected: PASS for the two new tests and every existing test; typecheck clean.

- [ ] **Step 8: Commit**

```bash
git add src/http/openai/dto.ts src/agent/orchestrator.ts src/http/sse.ts src/http/server.ts tests/openai.http.test.ts
git commit -m "feat(openai): add seams for server-side session memory (dto, getter, sse header, cors)"
```

---

### Task 2: Rewrite `/v1/chat/completions` to stateful server-side memory

**Files:**
- Modify: `src/http/routes.openai.ts`
- Test: `tests/openai.http.test.ts`
- Test: `tests/openai.stream.test.ts`

**Interfaces:**
- Consumes (from Task 1): `OpenAiChatRequest.session_id`/`user`, `Orchestrator.sessions`, `writeSseHead(raw, extraHeaders)`.
- Consumes (unchanged): `parseMessages`, `recoverPending`, `toCompletion`, `roleChunk`, `contentChunk`, `finalChunk`, `sseData`, `SSE_DONE`, `Orchestrator.handleChat`, `Orchestrator.handleChatStream`.
- Produces: buffered responses gain a `session_id` string field + `X-Session-Id` header; streaming responses gain the `X-Session-Id` header. Behavior: server-authoritative memory keyed by `(userId, sessionId)`.

- [ ] **Step 1: Capture assembled messages in the test `FakeLlm` (both test files)**

At the top of `tests/openai.http.test.ts`, add the `ChatMessage` type import:

```ts
import type { ChatMessage } from '../src/llm'
```

Then in that file's `FakeLlm`, add a `seen` capture so tests can prove which history the agent saw:

```ts
class FakeLlm implements LlmEngine {
  jsonQueue: string[] = []
  seen: ChatMessage[][] = []
  async complete() {
    return 'ok'
  }
  async completeJson(messages: ChatMessage[]) {
    this.seen.push(messages)
    return this.jsonQueue.shift() ?? '{"type":"reply","message":"..."}'
  }
  async *completeStream() {
    yield await this.complete()
  }
  async *completeJsonStream() {
    yield await this.completeJson([])
  }
  async embed(t: string[]) {
    return t.map(() => [0, 0, 0])
  }
}
```

- [ ] **Step 2: Write the failing buffered tests**

Add a new block to `tests/openai.http.test.ts`:

```ts
describe('OpenAI-compatible API (session memory)', () => {
  let llm: FakeLlm
  let mcp: FakeMcp
  beforeEach(() => {
    llm = new FakeLlm()
    mcp = new FakeMcp()
  })

  it('remembers earlier turns server-side across requests with the same session_id', async () => {
    const app = makeApp(llm, mcp)
    llm.jsonQueue = [
      '{"type":"reply","message":"Dâu cần đất ẩm."}',
      '{"type":"reply","message":"Tưới 2 lần mỗi ngày."}',
    ]
    await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'm', session_id: 'mem-1', messages: [{ role: 'user', content: 'Trồng dâu thế nào?' }] },
    })
    await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'm', session_id: 'mem-1', messages: [{ role: 'user', content: 'Còn tưới nước thì sao?' }] },
    })
    const seen = llm.seen.at(-1)!.map((m) => m.content).join(' | ')
    expect(seen).toContain('Trồng dâu thế nào?') // turn-1 user, recalled from server memory
    expect(seen).toContain('Dâu cần đất ẩm.') // turn-1 assistant reply, recalled
    expect(seen).toContain('Còn tưới nước thì sao?') // turn-2 input (the only thing the client sent)
    await app.close()
  })

  it('generates a session_id when none is given and returns it (header + body)', async () => {
    llm.jsonQueue = ['{"type":"reply","message":"Chào!"}']
    const app = makeApp(llm, mcp)
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'm', messages: [{ role: 'user', content: 'hi' }] },
    })
    expect(res.statusCode).toBe(200)
    const sid = res.headers['x-session-id']
    expect(sid).toBeTruthy()
    expect(res.json().session_id).toBe(sid)
    await app.close()
  })

  it('mints a distinct session_id per request when none is given', async () => {
    llm.jsonQueue = ['{"type":"reply","message":"a"}', '{"type":"reply","message":"b"}']
    const app = makeApp(llm, mcp)
    const r1 = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'm', messages: [{ role: 'user', content: 'hi' }] },
    })
    const r2 = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'm', messages: [{ role: 'user', content: 'hi' }] },
    })
    expect(r1.headers['x-session-id']).not.toBe(r2.headers['x-session-id'])
    await app.close()
  })

  it('echoes a caller-provided session_id in header + body', async () => {
    llm.jsonQueue = ['{"type":"reply","message":"ok"}']
    const app = makeApp(llm, mcp)
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'm', session_id: 'given-1', messages: [{ role: 'user', content: 'hi' }] },
    })
    expect(res.headers['x-session-id']).toBe('given-1')
    expect(res.json().session_id).toBe('given-1')
    await app.close()
  })

  it('treats a blank session_id as absent and generates one', async () => {
    llm.jsonQueue = ['{"type":"reply","message":"ok"}']
    const app = makeApp(llm, mcp)
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'm', session_id: '   ', messages: [{ role: 'user', content: 'hi' }] },
    })
    const sid = res.headers['x-session-id']
    expect(sid?.trim()).toBeTruthy()
    expect(sid).not.toBe('   ')
    await app.close()
  })

  it('seeds a brand-new session from the caller thread (legacy full-history clients)', async () => {
    llm.jsonQueue = ['{"type":"reply","message":"ok"}']
    const app = makeApp(llm, mcp)
    await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'm',
        session_id: 'seed-1',
        messages: [
          { role: 'user', content: 'Câu hỏi cũ' },
          { role: 'assistant', content: 'Trả lời cũ' },
          { role: 'user', content: 'Câu hỏi mới' },
        ],
      },
    })
    const seen = llm.seen.at(-1)!.map((m) => m.content).join(' | ')
    expect(seen).toContain('Câu hỏi cũ') // seeded from the thread prefix
    expect(seen).toContain('Trả lời cũ') // seeded assistant turn
    expect(seen).toContain('Câu hỏi mới') // last user message = input
    await app.close()
  })

  it('ignores caller-supplied history once the session already has memory', async () => {
    llm.jsonQueue = ['{"type":"reply","message":"đầu tiên"}', '{"type":"reply","message":"thứ hai"}']
    const app = makeApp(llm, mcp)
    await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'm', session_id: 'ns-1', messages: [{ role: 'user', content: 'THẬT một' }] },
    })
    await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'm',
        session_id: 'ns-1',
        messages: [
          { role: 'user', content: 'RÁC lịch sử' },
          { role: 'assistant', content: 'RÁC assistant' },
          { role: 'user', content: 'THẬT hai' },
        ],
      },
    })
    const seen = llm.seen.at(-1)!.map((m) => m.content).join(' | ')
    expect(seen).toContain('THẬT một') // real memory from turn 1
    expect(seen).toContain('đầu tiên') // real assistant reply from turn 1
    expect(seen).toContain('THẬT hai') // this turn's input
    expect(seen).not.toContain('RÁC') // caller history ignored — no seed on a non-empty session
    await app.close()
  })

  it('confirms a control action server-side: "có" on a later request executes it', async () => {
    const app = makeApp(llm, mcp)
    llm.jsonQueue = ['{"type":"tool","tool":"send_command","args":{"device_id":"d1","command":"WATER_ON"}}']
    const turn1 = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'm', session_id: 'cf-1', messages: [{ role: 'user', content: 'tưới đi' }] },
    })
    expect(turn1.json().choices[0].message.content).toContain('Có/Không')
    expect(mcp.calls).toHaveLength(0)
    // Client sends ONLY "có" — no echoed tool_calls; the server remembers the pending action.
    const turn2 = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'm', session_id: 'cf-1', messages: [{ role: 'user', content: 'có' }] },
    })
    expect(turn2.json().choices[0].message.content).toContain('Đã thực hiện')
    expect(mcp.calls).toEqual(['send_command'])
    await app.close()
  })
})
```

- [ ] **Step 3: Write the failing streaming tests**

In `tests/openai.stream.test.ts`, add to the existing `describe('OpenAI-compatible API (streaming)', …)` block:

```ts
  it('returns a generated session_id in the X-Session-Id header', async () => {
    llm.jsonQueue = ['{"type":"reply","message":"Chào!"}']
    const app = makeApp(llm, mcp)
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'm', stream: true, messages: [{ role: 'user', content: 'hi' }] },
    })
    expect(res.statusCode).toBe(200)
    expect(res.headers['x-session-id']).toBeTruthy()
    await app.close()
  })

  it('echoes a provided session_id in the streaming X-Session-Id header', async () => {
    llm.jsonQueue = ['{"type":"reply","message":"Chào!"}']
    const app = makeApp(llm, mcp)
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'm', stream: true, session_id: 'st-1', messages: [{ role: 'user', content: 'hi' }] },
    })
    expect(res.headers['x-session-id']).toBe('st-1')
    await app.close()
  })
```

- [ ] **Step 4: Run the new tests to verify they fail**

Run: `npx vitest run tests/openai.http.test.ts tests/openai.stream.test.ts -t "session"`
Expected: FAIL — no `X-Session-Id` header, no `session_id` body field, and the memory/confirm cases fail because the route still uses a per-request ephemeral store.

- [ ] **Step 5: Rewrite the route handler**

Replace the whole contents of `src/http/routes.openai.ts` with:

```ts
import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import type { AppState } from '../setup/state'
import {
  BadRequestError,
  contentChunk,
  finalChunk,
  modelsList,
  type OpenAiMessage,
  parseMessages,
  recoverPending,
  roleChunk,
  SSE_DONE,
  sseData,
  toCompletion,
} from './openai/adapter'
import { OpenAiChatRequestSchema } from './openai/dto'
import { writeSseHead } from './sse'

// User namespace when the OpenAI `user` field is omitted. Sessions key on (user, session_id).
const DEFAULT_USER = 'openai'

function oaiError(message: string, type: string, code: string) {
  return { error: { message, type, code, param: null } }
}

const chatBodySchema = {
  type: 'object',
  required: ['model', 'messages'],
  additionalProperties: true,
  properties: {
    model: {
      type: 'string',
      description: 'Chấp nhận mọi giá trị; server echo lại. `/v1/models` liệt kê `plant-assistant`.',
    },
    messages: { type: 'array', items: { type: 'object', additionalProperties: true } },
    stream: { type: 'boolean' },
    session_id: {
      type: 'string',
      description:
        'Định danh phiên để server NHỚ hội thoại (như ChatGPT). Trống/thiếu → server tự sinh uuid ' +
        'và trả về ở header `X-Session-Id` (và field `session_id` khi không streaming) để dùng cho lượt sau.',
    },
    user: { type: 'string', description: 'Định danh người dùng (chuẩn OpenAI); mặc định "openai".' },
  },
  example: {
    model: 'plant-assistant',
    session_id: 's1',
    messages: [{ role: 'user', content: 'Cây dâu của mình bị vàng lá, nên làm gì?' }],
  },
} as const

export function registerOpenAiRoutes(app: FastifyInstance, state: AppState): void {
  app.get(
    '/v1/models',
    { schema: { tags: ['openai'], summary: 'Danh sách model (tương thích OpenAI)' } },
    async () => modelsList(Math.floor(Date.now() / 1000)),
  )

  app.post(
    '/v1/chat/completions',
    {
      attachValidation: true,
      schema: {
        tags: ['openai'],
        summary: 'Chat completions tương thích OpenAI (chạy toàn bộ agent, nhớ theo session_id)',
        description:
          'Endpoint OpenAI-compatible chạy qua toàn bộ agent (RAG + điều khiển IoT + xác nhận).\n\n' +
          '**Trí nhớ server-side (như ChatGPT):** đính `session_id` và chỉ gửi **message mới** mỗi lượt — ' +
          'server tự nhớ phần còn lại. Thiếu/trống `session_id` → server sinh uuid và trả về ở header ' +
          '`X-Session-Id` (kèm field `session_id` trong body khi không streaming); dùng lại giá trị đó cho lượt sau. ' +
          '`user` (chuẩn OpenAI) là namespace người dùng, mặc định "openai".\n\n' +
          '**Tương thích ngược:** với một session MỚI (chưa có lịch sử), nếu client gửi cả `messages[]` ' +
          '(kiểu OpenAI cũ) thì toàn bộ thread được nạp làm lịch sử ban đầu; từ lượt sau chỉ message cuối được dùng.\n\n' +
          '**Điều khiển thiết bị:** khi cần xác nhận, response hỏi "(Có/Không)". Ở lượt sau chỉ cần gửi ' +
          '"có"/"không" cùng `session_id` — server nhớ hành động đang chờ (không cần giữ `tool_calls`).\n\n' +
          '**Streaming:** đặt `stream:true` để nhận `chat.completion.chunk` (SSE, kết `data: [DONE]`). ' +
          '`finish_reason` luôn là `stop`. `usage` báo 0 (không đếm token).',
        body: chatBodySchema,
      },
    },
    async (req, reply) => {
      const orch = state.orchestrator
      if (!orch) {
        reply.code(503)
        return oaiError('server not configured; visit /setup', 'server_error', 'not_configured')
      }
      const parsed = OpenAiChatRequestSchema.safeParse(req.body)
      if (!parsed.success) {
        reply.code(400)
        return oaiError('invalid request body', 'invalid_request_error', 'invalid_body')
      }
      const body = parsed.data
      let thread
      try {
        thread = parseMessages(body.messages as unknown as OpenAiMessage[])
      } catch (err) {
        if (err instanceof BadRequestError) {
          reply.code(400)
          return oaiError(err.message, 'invalid_request_error', 'invalid_messages')
        }
        throw err
      }

      // Server-authoritative memory. Resolve identity, minting a session when absent.
      const userId = body.user ?? DEFAULT_USER
      const sessionId = body.session_id?.trim() || randomUUID()

      // Seed ONLY a brand-new session from the caller's thread — this keeps legacy
      // full-history OpenAI clients working (and recovers an echoed pending action).
      // Once the session has history, the caller's prior turns are ignored and only
      // the last user message runs against server memory.
      const sessions = orch.sessions
      if (sessions.getHistory(userId, sessionId).length === 0) {
        if (thread.history.length) sessions.append(userId, sessionId, ...thread.history)
        const pending = recoverPending(thread.priorAssistant)
        if (pending) sessions.setPending(userId, sessionId, pending)
      }

      const id = `chatcmpl-${randomUUID()}`
      const created = Math.floor(Date.now() / 1000)

      if (!body.stream) {
        try {
          reply.header('X-Session-Id', sessionId)
          const result = await orch.handleChat(userId, sessionId, thread.lastUserMessage)
          return { ...toCompletion(result, body.model, id, created), session_id: sessionId }
        } catch (err) {
          req.log.error(err)
          reply.code(500)
          return oaiError((err as Error).message, 'server_error', 'internal_error')
        }
      }

      // Streaming (OpenAI SSE). From here Fastify hands off the raw socket.
      reply.hijack()
      const raw = reply.raw
      writeSseHead(raw, { 'X-Session-Id': sessionId })
      const abort = new AbortController()
      let finished = false
      req.raw.on('close', () => {
        if (!finished) abort.abort()
      })
      raw.on('error', () => {
        if (!finished) abort.abort()
      })
      try {
        raw.write(sseData(roleChunk(body.model, id, created)))
        let pendingView = null
        for await (const event of orch.handleChatStream(userId, sessionId, thread.lastUserMessage, {
          signal: abort.signal,
        })) {
          if (event.type === 'token') {
            raw.write(sseData(contentChunk(event.text, body.model, id, created)))
          } else if (event.type === 'done') {
            pendingView = event.pendingAction
          }
          // 'tool_status' and 'reset' are intentionally dropped (S1 streaming policy).
        }
        raw.write(sseData(finalChunk(pendingView, body.model, id, created)))
        raw.write(SSE_DONE)
      } catch (err) {
        if (!abort.signal.aborted) {
          req.log.error(err)
          raw.write(sseData(oaiError('internal error', 'server_error', 'internal_error')))
        }
      } finally {
        finished = true
        if (!raw.writableEnded) raw.end()
      }
    },
  )
}
```

Key removals vs. the old file: the `SessionStore` import, the `UID`/`SID` constants, the per-request `new SessionStore()` + `orch.withSessions(...)`. The route now drives `orch` directly against its persistent store.

- [ ] **Step 6: Run the full OpenAI test suites to verify they pass**

Run: `npx vitest run tests/openai.http.test.ts tests/openai.stream.test.ts`
Expected: PASS — new session-memory + streaming-header tests, AND the pre-existing `control round-trip` / `read-offer round-trip` tests (they now exercise the legacy full-history path through seed-on-empty).

- [ ] **Step 7: Run the whole suite + typecheck (no regressions)**

Run: `npm test && npm run typecheck`
Expected: all green.

- [ ] **Step 8: Commit**

```bash
git add src/http/routes.openai.ts tests/openai.http.test.ts tests/openai.stream.test.ts
git commit -m "feat(openai): server-side session memory for /v1/chat/completions"
```

---

### Task 3: Document the new behavior in CLAUDE.md

**Files:**
- Modify: `src/http/server.ts` — nothing (already done Task 1); doc only here.
- Modify: `CLAUDE.md:132-134` (HTTP surface section)

**Interfaces:**
- Consumes: final behavior from Task 2. Produces: nothing code-facing.

- [ ] **Step 1: Update the HTTP-surface note**

In `CLAUDE.md`, the HTTP surface paragraph currently reads (around lines 132-134):

```
Endpoints: `POST /chat/stream` (SSE) ([routes.chat.ts](src/http/routes.chat.ts)), the
OpenAI-compatible `POST /v1/chat/completions` + `GET /v1/models`
([routes.openai.ts](src/http/routes.openai.ts)), the `/setup` UI + `/api/setup/*`
```

Append one sentence describing the session memory right after the `routes.openai.ts` reference:

```
Endpoints: `POST /chat/stream` (SSE) ([routes.chat.ts](src/http/routes.chat.ts)), the
OpenAI-compatible `POST /v1/chat/completions` + `GET /v1/models`
([routes.openai.ts](src/http/routes.openai.ts)) — **stateful**: keys the persistent `SessionStore` on
`(body.user ?? 'openai', body.session_id)`, minting a `uuidv4` when `session_id` is absent and returning
it via the `X-Session-Id` response header (a brand-new session is seeded from the caller's `messages[]`
so legacy full-history clients still work). The `/setup` UI + `/api/setup/*`
```

(Keep the rest of the paragraph unchanged; ensure the sentence flows and the `GET /health` / rag-rebuild text still follows.)

- [ ] **Step 2: Verify the doc reads correctly**

Run: `npx vitest run` (sanity — docs don't affect tests) and re-read the edited paragraph to confirm it's coherent Vietnamese/English matching the surrounding style.
Expected: tests still green; paragraph reads cleanly.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: note server-side session memory on /v1/chat/completions in CLAUDE.md"
```

---

## Self-Review

**1. Spec coverage:**
- FR1 (identity `user`/`session_id`, uuid fallback) → Task 2 Step 5 (`userId`/`sessionId` resolution) + tests Step 2 (generate/echo/blank).
- FR2 (server-authoritative, last message only) → Task 2 Step 5 + memory test + no-seed test.
- FR3 (seed-on-empty + recoverPending) → Task 2 Step 5 + seed test; existing round-trip tests validate pending recovery.
- FR4 (server-side confirm) → Task 2 confirm test.
- FR5 (return session_id: header both modes + body buffered) → Task 1 (sse/cors) + Task 2 (`reply.header`, body spread, `writeSseHead` extra) + header tests (http + stream).
- FR6 (CORS expose) → Task 1 Step 6 + CORS test.
- FR7 (unchanged formats) → existing tests remain green (Task 2 Step 6/7).
- Non-goals (session cleanup, API key, token count) → not implemented, as intended.

**2. Placeholder scan:** No TBD/TODO; every code + test step shows complete content.

**3. Type consistency:** `Orchestrator.sessions` getter returns `SessionStore`; used as `orch.sessions.getHistory/append/setPending` (all real `SessionStore` methods). `writeSseHead(raw, extraHeaders?)` matches the streaming call `writeSseHead(raw, { 'X-Session-Id': sessionId })` and the unchanged `/chat/stream` call `writeSseHead(raw)`. DTO `session_id?`/`user?` are read as `body.session_id`/`body.user`. `toCompletion(result, body.model, id, created)` signature unchanged; the `session_id` field is added by spread in the route, not inside the adapter.
