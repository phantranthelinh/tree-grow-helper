# OpenAI-Compatible Endpoint Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose an OpenAI-compatible `/v1/chat/completions` (+ `/v1/models`) endpoint so another server can drive the full plant-care agent (RAG + IoT control + confirmation) like it calls LM Studio.

**Architecture:** A thin *facade* translates the OpenAI Chat Completions contract to/from the existing `Orchestrator`. It runs **stateless** — the caller's `messages[]` IS the conversation. Per request the route builds a throwaway in-memory `SessionStore`, seeds it with the thread's history (and any pending action recovered from an echoed assistant `tool_calls`), then runs the unchanged orchestrator core via a new `Orchestrator.withSessions()` seam. Control-action confirmation survives across stateless calls because the pending action round-trips as an OpenAI `tool_call` in the assistant message.

**Tech Stack:** TypeScript (ESM, run via `tsx`), Fastify, Zod, Vitest. OpenAI SDK types already vendored (`ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam`).

## Global Constraints

- **All user-facing text is Vietnamese** — replies, prompts, Swagger copy. (Error `message` fields in the OpenAI error envelope may stay short English like real OpenAI; user-facing chat content comes from the agent and is Vietnamese.)
- **ESM, extensionless imports** — no `.ts`/`.js` extension on relative imports; no compiled `dist/`.
- **Tests need NO external services** — use the `FakeLlm`/`FakeMcp` DI fakes and `AppState.ready(orch)`, matching `tests/http.test.ts`.
- **Do NOT modify** `chatEvents`, `src/http/routes.chat.ts`, or `src/memory/sessions.ts`. The only change to agent code is the additive `Orchestrator.withSessions()` method.
- **Safety invariant preserved:** control tools never execute inline; they round-trip as a `tool_call` + a Vietnamese "(Có/Không)" question and only execute when the caller echoes the thread back with an affirmative reply.
- **Streaming policy = S1 (live):** forward `token` deltas live (real TTFT); drop `tool_status`; a mid-stream `reset` is ignored (cannot be retracted over OpenAI SSE — a documented limitation for LLM providers that do not enforce `json_schema`).
- **`finish_reason` is always `"stop"`** (even for turns carrying `tool_calls`) so clients that branch on `finish_reason:"tool_calls"` don't hide the Vietnamese confirmation question.
- **Error envelope** is OpenAI-shaped: `{ error: { message, type, code, param } }` with correct HTTP status.
- **`model`** in requests is accepted and echoed back; `/v1/models` advertises the single synthetic id `plant-assistant`. **`usage`** is reported as zeros (tokens not tracked).

---

## File Structure

- **Modify** `src/agent/orchestrator.ts` — add `withSessions(sessions)` (the only agent change).
- **Create** `src/http/openai/dto.ts` — Zod schema for the OpenAI request body.
- **Create** `src/http/openai/adapter.ts` — pure translation functions (parsing, pending recover/encode, response + SSE builders). No Fastify/IO.
- **Create** `src/http/routes.openai.ts` — Fastify wiring for `/v1/chat/completions` (buffered + streaming) and `/v1/models`.
- **Modify** `src/http/server.ts` — register the OpenAI routes + add the `openai` Swagger tag.
- **Modify** `src/http/routes.chat.ts` — add the `/v1/*` entries to the `GET /` endpoint list (info only).
- **Create** `tests/openai.adapter.test.ts` — unit tests for adapter pure functions.
- **Create** `tests/openai.http.test.ts` — buffered endpoint + `/v1/models` + errors + control/read round-trips.
- **Create** `tests/openai.stream.test.ts` — streaming SSE shape.

---

## Task 1: `Orchestrator.withSessions()` seam

**Files:**
- Modify: `src/agent/orchestrator.ts` (add method to the `Orchestrator` class, after `confirm`)
- Test: `tests/orchestrator.test.ts` (append one test)

**Interfaces:**
- Consumes: existing `OrchestratorDeps`, `SessionStore` (already imported as a type in orchestrator.ts).
- Produces: `Orchestrator.withSessions(sessions: SessionStore): Orchestrator` — returns a new `Orchestrator` sharing all deps except `sessions`.

- [ ] **Step 1: Write the failing test**

Append to `tests/orchestrator.test.ts` inside the first `describe('Orchestrator', …)` block (the fakes/`deps`/`orch` from its `beforeEach` are in scope):

```typescript
  it('withSessions runs against the injected store, not the original', async () => {
    const other = new SessionStore()
    const scoped = orch.withSessions(other)
    llm.jsonQueue = ['{"type":"tool","tool":"send_command","args":{"device_id":"d1","command":"WATER_ON"}}']
    const res = await scoped.handleChat('u1', 's1', 'tưới đi')
    // Pending landed in the injected store…
    expect(other.getPending('u1', 's1')?.id).toBe(res.pendingAction?.id)
    // …and NOT in the orchestrator's original store.
    expect(deps.sessions.getPending('u1', 's1')).toBeUndefined()
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/orchestrator.test.ts -t "withSessions"`
Expected: FAIL — `orch.withSessions is not a function`.

- [ ] **Step 3: Implement the method**

In `src/agent/orchestrator.ts`, add this method to the `Orchestrator` class immediately after the `confirm(...)` method:

```typescript
  /**
   * Return a clone that runs against a different SessionStore, sharing every
   * other dep. Lets the OpenAI facade drive the unchanged agent core with a
   * per-request ephemeral store instead of the persistent one.
   */
  withSessions(sessions: SessionStore): Orchestrator {
    return new Orchestrator({ ...this.deps, sessions })
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/orchestrator.test.ts -t "withSessions"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/agent/orchestrator.ts tests/orchestrator.test.ts
git commit -m "feat(agent): add Orchestrator.withSessions for per-request session injection"
```

---

## Task 2: OpenAI request DTO (Zod)

**Files:**
- Create: `src/http/openai/dto.ts`
- Test: covered indirectly by later HTTP tests; add one focused parse test file section here.
- Test: `tests/openai.adapter.test.ts` (create with the DTO tests; adapter tests append in Tasks 3–4)

**Interfaces:**
- Produces:
  - `OpenAiChatRequestSchema` — Zod schema; `.safeParse(body)` → `{ model: string; messages: OpenAiMessageInput[]; stream?: boolean }` (unknown fields passed through).
  - `type OpenAiChatRequest = z.infer<typeof OpenAiChatRequestSchema>`.

- [ ] **Step 1: Write the failing test**

Create `tests/openai.adapter.test.ts`:

```typescript
import { describe, expect, it } from 'vitest'
import { OpenAiChatRequestSchema } from '../src/http/openai/dto'

describe('OpenAiChatRequestSchema', () => {
  it('accepts a minimal valid body and passes through extra fields', () => {
    const r = OpenAiChatRequestSchema.safeParse({
      model: 'plant-assistant',
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 0.7, // unknown-but-tolerated OpenAI field
    })
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.model).toBe('plant-assistant')
  })

  it('rejects a body with no messages', () => {
    const r = OpenAiChatRequestSchema.safeParse({ model: 'm', messages: [] })
    expect(r.success).toBe(false)
  })

  it('rejects a body missing model', () => {
    const r = OpenAiChatRequestSchema.safeParse({ messages: [{ role: 'user', content: 'hi' }] })
    expect(r.success).toBe(false)
  })

  it('accepts an assistant message carrying tool_calls', () => {
    const r = OpenAiChatRequestSchema.safeParse({
      model: 'm',
      messages: [
        { role: 'user', content: 'tưới đi' },
        {
          role: 'assistant',
          content: 'Xác nhận? (Có/Không)',
          tool_calls: [{ id: 'x', type: 'function', function: { name: 'send_command', arguments: '{}' } }],
        },
        { role: 'user', content: 'có' },
      ],
    })
    expect(r.success).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/openai.adapter.test.ts`
Expected: FAIL — cannot resolve `../src/http/openai/dto`.

- [ ] **Step 3: Implement the DTO**

Create `src/http/openai/dto.ts`:

```typescript
import { z } from 'zod'

const ContentPart = z.object({ type: z.string(), text: z.string().optional() }).passthrough()

const ToolCall = z
  .object({
    id: z.string(),
    type: z.literal('function'),
    function: z.object({ name: z.string(), arguments: z.string() }),
  })
  .passthrough()

const Message = z
  .object({
    role: z.string(),
    content: z.union([z.string(), z.array(ContentPart), z.null()]).optional(),
    tool_calls: z.array(ToolCall).optional(),
  })
  .passthrough()

/** Subset of the OpenAI Chat Completions request we act on; extra fields tolerated. */
export const OpenAiChatRequestSchema = z
  .object({
    model: z.string().min(1),
    messages: z.array(Message).min(1),
    stream: z.boolean().optional(),
  })
  .passthrough()

export type OpenAiChatRequest = z.infer<typeof OpenAiChatRequestSchema>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/openai.adapter.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/http/openai/dto.ts tests/openai.adapter.test.ts
git commit -m "feat(http): add Zod DTO for OpenAI chat-completions request"
```

---

## Task 3: Adapter — thread parsing + pending recovery/encoding

**Files:**
- Create: `src/http/openai/adapter.ts`
- Test: `tests/openai.adapter.test.ts` (append)

**Interfaces:**
- Consumes: `ChatMessage` (`src/llm`), `PendingAction` (`src/memory/sessions`), `PendingActionView` (`src/agent/orchestrator`), `createPendingAction` (`src/agent/confirmation`), `confirmsBeforeRead` (`src/mcp/policy`).
- Produces:
  - `interface OpenAiToolCall { id: string; type: 'function'; function: { name: string; arguments: string } }`
  - `interface OpenAiMessage { role: string; content?: string | Array<{ type: string; text?: string }> | null; tool_calls?: OpenAiToolCall[] }`
  - `class BadRequestError extends Error {}`
  - `extractText(content: OpenAiMessage['content']): string`
  - `interface ParsedThread { history: ChatMessage[]; lastUserMessage: string; priorAssistant: OpenAiMessage | null }`
  - `parseMessages(messages: OpenAiMessage[]): ParsedThread`
  - `recoverPending(priorAssistant: OpenAiMessage | null): PendingAction | null`
  - `encodePending(p: PendingActionView): OpenAiToolCall[]`

- [ ] **Step 1: Write the failing tests**

Append to `tests/openai.adapter.test.ts`:

```typescript
import {
  BadRequestError,
  encodePending,
  extractText,
  parseMessages,
  recoverPending,
} from '../src/http/openai/adapter'

describe('extractText', () => {
  it('returns a string as-is', () => {
    expect(extractText('hi')).toBe('hi')
  })
  it('joins text parts and ignores non-text', () => {
    expect(extractText([{ type: 'text', text: 'a' }, { type: 'image_url' }, { type: 'text', text: 'b' }])).toBe('ab')
  })
  it('maps null/undefined to empty string', () => {
    expect(extractText(null)).toBe('')
    expect(extractText(undefined)).toBe('')
  })
})

describe('parseMessages', () => {
  it('throws on an empty array', () => {
    expect(() => parseMessages([])).toThrow(BadRequestError)
  })
  it('throws when the last message is not a user message', () => {
    expect(() => parseMessages([{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'yo' }])).toThrow(
      BadRequestError,
    )
  })
  it('drops system messages, strips tool_calls to content-only history, and splits off the last user turn', () => {
    const { history, lastUserMessage, priorAssistant } = parseMessages([
      { role: 'system', content: 'you are X' },
      { role: 'user', content: 'tưới đi' },
      {
        role: 'assistant',
        content: 'Xác nhận? (Có/Không)',
        tool_calls: [{ id: 'x', type: 'function', function: { name: 'send_command', arguments: '{}' } }],
      },
      { role: 'user', content: 'có' },
    ])
    expect(lastUserMessage).toBe('có')
    expect(priorAssistant?.role).toBe('assistant')
    expect(history).toEqual([
      { role: 'user', content: 'tưới đi' },
      { role: 'assistant', content: 'Xác nhận? (Có/Không)' },
    ])
  })
})

describe('recoverPending', () => {
  it('returns null when there is no prior assistant tool_call', () => {
    expect(recoverPending(null)).toBeNull()
    expect(recoverPending({ role: 'assistant', content: 'hi' })).toBeNull()
  })
  it('rebuilds a control pending from a send_command tool_call', () => {
    const p = recoverPending({
      role: 'assistant',
      content: 'q',
      tool_calls: [
        { id: 'x', type: 'function', function: { name: 'send_command', arguments: '{"device_id":"d1","command":"WATER_ON"}' } },
      ],
    })
    expect(p?.tool).toBe('send_command')
    expect(p?.kind).toBe('control')
    expect(p?.args).toEqual({ device_id: 'd1', command: 'WATER_ON' })
    expect(p?.summary).toContain('Bật bơm nước')
  })
  it('derives kind="read" for a confirm-before-read sensor tool', () => {
    const p = recoverPending({
      role: 'assistant',
      content: 'q',
      tool_calls: [{ id: 'x', type: 'function', function: { name: 'get_latest_sensor', arguments: '{"device_id":"d1"}' } }],
    })
    expect(p?.kind).toBe('read')
  })
  it('returns null when the tool_call arguments are not valid JSON', () => {
    const p = recoverPending({
      role: 'assistant',
      content: 'q',
      tool_calls: [{ id: 'x', type: 'function', function: { name: 'send_command', arguments: '{not json' } }],
    })
    expect(p).toBeNull()
  })
})

describe('encodePending', () => {
  it('encodes a pending view as a single OpenAI tool_call', () => {
    const calls = encodePending({ id: 'abc', summary: 's', tool: 'send_command', args: { device_id: 'd1' } })
    expect(calls).toEqual([
      { id: 'abc', type: 'function', function: { name: 'send_command', arguments: '{"device_id":"d1"}' } },
    ])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/openai.adapter.test.ts`
Expected: FAIL — cannot resolve `../src/http/openai/adapter`.

- [ ] **Step 3: Implement the adapter (parsing half)**

Create `src/http/openai/adapter.ts`:

```typescript
import { createPendingAction } from '../../agent/confirmation'
import type { PendingActionView } from '../../agent/orchestrator'
import type { ChatMessage } from '../../llm'
import type { PendingAction } from '../../memory/sessions'
import { confirmsBeforeRead } from '../../mcp/policy'

export interface OpenAiToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export interface OpenAiMessage {
  role: string
  content?: string | Array<{ type: string; text?: string }> | null
  tool_calls?: OpenAiToolCall[]
}

/** Signals a client mistake the route maps to HTTP 400 with the OpenAI error shape. */
export class BadRequestError extends Error {}

/** Flatten OpenAI message content (string or content-parts array) to plain text. */
export function extractText(content: OpenAiMessage['content']): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter((p) => p.type === 'text' && typeof p.text === 'string')
      .map((p) => p.text as string)
      .join('')
  }
  return ''
}

export interface ParsedThread {
  history: ChatMessage[]
  lastUserMessage: string
  priorAssistant: OpenAiMessage | null
}

/**
 * Translate an OpenAI messages[] into the agent's view: prior user/assistant
 * turns become history (system dropped — the agent's own system prompt wins;
 * tool_calls stripped to content-only), the trailing user turn is the input,
 * and the assistant turn right before it is exposed for pending recovery.
 * Throws BadRequestError when empty or not terminated by a user message.
 */
export function parseMessages(messages: OpenAiMessage[]): ParsedThread {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new BadRequestError('messages must be a non-empty array')
  }
  const last = messages[messages.length - 1]
  if (last.role !== 'user') {
    throw new BadRequestError('the last message must have role "user"')
  }
  const prev = messages[messages.length - 2]
  const priorAssistant = prev && prev.role === 'assistant' ? prev : null
  const history: ChatMessage[] = messages
    .slice(0, -1)
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({ role: m.role as 'user' | 'assistant', content: extractText(m.content) }))
  return { history, lastUserMessage: extractText(last.content), priorAssistant }
}

/**
 * Rebuild a pending action from an echoed assistant tool_call. Lossless: only
 * (tool, args) need to survive — `summary` is recomputed and `kind` is derived
 * (confirm-before-read sensor tools → 'read', everything else → 'control').
 */
export function recoverPending(priorAssistant: OpenAiMessage | null): PendingAction | null {
  const call = priorAssistant?.tool_calls?.[0]
  if (!call?.function?.name) return null
  let args: Record<string, unknown>
  try {
    args = call.function.arguments ? JSON.parse(call.function.arguments) : {}
  } catch {
    return null
  }
  const kind = confirmsBeforeRead(call.function.name) ? 'read' : 'control'
  return createPendingAction(call.function.name, args, kind)
}

/** Encode a pending action as an OpenAI tool_call so it round-trips in the thread. */
export function encodePending(p: PendingActionView): OpenAiToolCall[] {
  return [{ id: p.id, type: 'function', function: { name: p.tool, arguments: JSON.stringify(p.args) } }]
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/openai.adapter.test.ts`
Expected: PASS (all DTO + parsing tests).

- [ ] **Step 5: Commit**

```bash
git add src/http/openai/adapter.ts tests/openai.adapter.test.ts
git commit -m "feat(http): add OpenAI thread parsing and pending round-trip helpers"
```

---

## Task 4: Adapter — response + streaming builders

**Files:**
- Modify: `src/http/openai/adapter.ts` (append builders)
- Test: `tests/openai.adapter.test.ts` (append)

**Interfaces:**
- Consumes: `ChatResult`, `PendingActionView` (`src/agent/orchestrator`); `encodePending` (Task 3).
- Produces:
  - `toCompletion(result: ChatResult, model: string, id: string, created: number)` → a `chat.completion` object (`object:'chat.completion'`, one choice, `finish_reason:'stop'`, zero `usage`; `message.tool_calls` present only when `result.pendingAction` is set).
  - `modelsList(created: number)` → `{ object:'list', data:[{ id:'plant-assistant', object:'model', created, owned_by:'ai-server' }] }`.
  - `roleChunk(model, id, created)` → chunk with `delta:{ role:'assistant' }`, `finish_reason:null`.
  - `contentChunk(text: string, model, id, created)` → chunk with `delta:{ content:text }`, `finish_reason:null`.
  - `finalChunk(pending: PendingActionView | null, model, id, created)` → chunk with `delta:{ tool_calls?:[...] }`, `finish_reason:'stop'`.
  - `sseData(obj: unknown): string` → `` `data: ${JSON.stringify(obj)}\n\n` ``.
  - `const SSE_DONE = 'data: [DONE]\n\n'`.
  - `MODEL_ID = 'plant-assistant'`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/openai.adapter.test.ts`:

```typescript
import { contentChunk, finalChunk, modelsList, roleChunk, SSE_DONE, sseData, toCompletion } from '../src/http/openai/adapter'

describe('toCompletion', () => {
  it('maps a plain reply to a chat.completion with no tool_calls', () => {
    const c = toCompletion({ reply: 'Chào bạn!', pendingAction: null }, 'm', 'id1', 100) as any
    expect(c.object).toBe('chat.completion')
    expect(c.model).toBe('m')
    expect(c.choices[0].message).toEqual({ role: 'assistant', content: 'Chào bạn!' })
    expect(c.choices[0].finish_reason).toBe('stop')
    expect(c.usage).toEqual({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 })
  })
  it('attaches tool_calls when a pending action is present', () => {
    const c = toCompletion(
      { reply: 'Xác nhận? (Có/Không)', pendingAction: { id: 'p', summary: 's', tool: 'send_command', args: { device_id: 'd1' } } },
      'm',
      'id1',
      100,
    ) as any
    expect(c.choices[0].message.tool_calls[0].function.name).toBe('send_command')
    expect(c.choices[0].finish_reason).toBe('stop')
  })
})

describe('modelsList', () => {
  it('advertises the single synthetic model', () => {
    const l = modelsList(100) as any
    expect(l.object).toBe('list')
    expect(l.data[0].id).toBe('plant-assistant')
  })
})

describe('streaming builders', () => {
  it('contentChunk carries a content delta and no finish_reason', () => {
    const c = contentChunk('hi', 'm', 'id1', 100) as any
    expect(c.object).toBe('chat.completion.chunk')
    expect(c.choices[0].delta).toEqual({ content: 'hi' })
    expect(c.choices[0].finish_reason).toBeNull()
  })
  it('roleChunk opens the stream with an assistant role delta', () => {
    const c = roleChunk('m', 'id1', 100) as any
    expect(c.choices[0].delta).toEqual({ role: 'assistant' })
  })
  it('finalChunk with a pending action emits an indexed tool_call and finish_reason stop', () => {
    const c = finalChunk({ id: 'p', summary: 's', tool: 'send_command', args: { device_id: 'd1' } }, 'm', 'id1', 100) as any
    expect(c.choices[0].delta.tool_calls[0]).toMatchObject({
      index: 0,
      function: { name: 'send_command', arguments: '{"device_id":"d1"}' },
    })
    expect(c.choices[0].finish_reason).toBe('stop')
  })
  it('finalChunk with no pending action emits an empty delta and finish_reason stop', () => {
    const c = finalChunk(null, 'm', 'id1', 100) as any
    expect(c.choices[0].delta).toEqual({})
    expect(c.choices[0].finish_reason).toBe('stop')
  })
  it('sseData / SSE_DONE serialize in OpenAI SSE format', () => {
    expect(sseData({ a: 1 })).toBe('data: {"a":1}\n\n')
    expect(SSE_DONE).toBe('data: [DONE]\n\n')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/openai.adapter.test.ts`
Expected: FAIL — `toCompletion` / builders not exported.

- [ ] **Step 3: Implement the builders**

Append to `src/http/openai/adapter.ts` (add `ChatResult` to the existing `import type { PendingActionView } from '../../agent/orchestrator'` line → `import type { ChatResult, PendingActionView } from '../../agent/orchestrator'`):

```typescript
export const MODEL_ID = 'plant-assistant'

function chunk(delta: Record<string, unknown>, finishReason: string | null, model: string, id: string, created: number) {
  return {
    id,
    object: 'chat.completion.chunk' as const,
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  }
}

/** Build the buffered `chat.completion` response from a finished agent turn. */
export function toCompletion(result: ChatResult, model: string, id: string, created: number) {
  const message: { role: 'assistant'; content: string; tool_calls?: OpenAiToolCall[] } = {
    role: 'assistant',
    content: result.reply,
  }
  if (result.pendingAction) message.tool_calls = encodePending(result.pendingAction)
  return {
    id,
    object: 'chat.completion' as const,
    created,
    model,
    choices: [{ index: 0, message, finish_reason: 'stop' as const }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  }
}

/** `GET /v1/models` payload — one synthetic model representing the whole agent. */
export function modelsList(created: number) {
  return { object: 'list' as const, data: [{ id: MODEL_ID, object: 'model' as const, created, owned_by: 'ai-server' }] }
}

export function roleChunk(model: string, id: string, created: number) {
  return chunk({ role: 'assistant' }, null, model, id, created)
}

export function contentChunk(text: string, model: string, id: string, created: number) {
  return chunk({ content: text }, null, model, id, created)
}

/** Terminal streaming chunk: carries the pending tool_call (if any) and finish_reason. */
export function finalChunk(pending: PendingActionView | null, model: string, id: string, created: number) {
  const delta = pending ? { tool_calls: [{ index: 0, ...encodePending(pending)[0] }] } : {}
  return chunk(delta, 'stop', model, id, created)
}

/** Serialize an object as one OpenAI-style SSE data frame. */
export function sseData(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`
}

export const SSE_DONE = 'data: [DONE]\n\n'
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/openai.adapter.test.ts`
Expected: PASS (all adapter tests).

- [ ] **Step 5: Commit**

```bash
git add src/http/openai/adapter.ts tests/openai.adapter.test.ts
git commit -m "feat(http): add OpenAI response and SSE chunk builders"
```

---

## Task 5: Routes — `/v1/chat/completions` (buffered + streaming) + `/v1/models`

**Files:**
- Create: `src/http/routes.openai.ts`
- Modify: `src/http/server.ts` (register routes + `openai` Swagger tag)
- Modify: `src/http/routes.chat.ts` (add `/v1/*` to the `GET /` endpoint list)
- Test: `tests/openai.http.test.ts` (buffered + models + errors + round-trips)
- Test: `tests/openai.stream.test.ts` (streaming SSE)

**Interfaces:**
- Consumes: `AppState` (`state.orchestrator`, `Orchestrator.withSessions`, `handleChat`, `handleChatStream`); `SessionStore`; `writeSseHead` (`src/http/sse`); all adapter exports; `OpenAiChatRequestSchema`.
- Produces: `registerOpenAiRoutes(app: FastifyInstance, state: AppState): void`.

- [ ] **Step 1: Write the failing buffered/models/error tests**

Create `tests/openai.http.test.ts`:

```typescript
import { beforeEach, describe, expect, it } from 'vitest'
import { Orchestrator } from '../src/agent/orchestrator'
import { config } from '../src/config'
import { loadProfile } from '../src/domain/profiles'
import { buildServer } from '../src/http/server'
import type { LlmEngine } from '../src/llm'
import type { McpGateway, McpToolResult } from '../src/mcp/client'
import { SessionStore } from '../src/memory/sessions'
import { InMemoryVectorStore } from '../src/rag/store'
import { AppState } from '../src/setup/state'

class FakeLlm implements LlmEngine {
  jsonQueue: string[] = []
  async complete() {
    return 'ok'
  }
  async completeJson() {
    return this.jsonQueue.shift() ?? '{"type":"reply","message":"..."}'
  }
  async *completeStream() {
    yield await this.complete()
  }
  async *completeJsonStream() {
    yield await this.completeJson()
  }
  async embed(t: string[]) {
    return t.map(() => [0, 0, 0])
  }
}

class FakeMcp implements McpGateway {
  calls: string[] = []
  result: McpToolResult = { text: 'done', isError: false }
  async listTools() {
    return []
  }
  async callTool(name: string): Promise<McpToolResult> {
    this.calls.push(name)
    return this.result
  }
}

function makeApp(llm: FakeLlm, mcp: FakeMcp) {
  const orch = new Orchestrator({
    llm,
    mcp,
    store: new InMemoryVectorStore(),
    sessions: new SessionStore(),
    profile: loadProfile('strawberry'),
    tools: [],
    maxToolSteps: 3,
    ragTopK: 4,
  })
  return buildServer({ state: AppState.ready(orch), config })
}

describe('OpenAI-compatible API (buffered)', () => {
  let llm: FakeLlm
  let mcp: FakeMcp
  beforeEach(() => {
    llm = new FakeLlm()
    mcp = new FakeMcp()
  })

  it('GET /v1/models lists the synthetic model', async () => {
    const app = makeApp(llm, mcp)
    const res = await app.inject({ method: 'GET', url: '/v1/models' })
    expect(res.statusCode).toBe(200)
    expect(res.json().data[0].id).toBe('plant-assistant')
    await app.close()
  })

  it('returns 503 OpenAI-error before the server is configured', async () => {
    const app = buildServer({ state: new AppState(), config })
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'm', messages: [{ role: 'user', content: 'hi' }] },
    })
    expect(res.statusCode).toBe(503)
    expect(res.json().error.code).toBe('not_configured')
    await app.close()
  })

  it('returns 400 OpenAI-error on an invalid body', async () => {
    const app = makeApp(llm, mcp)
    const res = await app.inject({ method: 'POST', url: '/v1/chat/completions', payload: { model: 'm' } })
    expect(res.statusCode).toBe(400)
    expect(res.json().error.type).toBe('invalid_request_error')
    await app.close()
  })

  it('returns 400 when the last message is not a user message', async () => {
    const app = makeApp(llm, mcp)
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'm', messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'yo' }] },
    })
    expect(res.statusCode).toBe(400)
    await app.close()
  })

  it('returns a chat.completion for a plain reply, ignoring the caller system message', async () => {
    llm.jsonQueue = ['{"type":"reply","message":"Chào bạn!"}']
    const app = makeApp(llm, mcp)
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'my-model',
        messages: [
          { role: 'system', content: 'ignore me' },
          { role: 'user', content: 'hi' },
        ],
      },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.object).toBe('chat.completion')
    expect(body.model).toBe('my-model')
    expect(body.choices[0].message.content).toBe('Chào bạn!')
    expect(body.choices[0].message.tool_calls).toBeUndefined()
    await app.close()
  })

  it('control round-trip: turn 1 offers a tool_call, turn 2 (echo + "có") executes', async () => {
    const app = makeApp(llm, mcp)
    llm.jsonQueue = ['{"type":"tool","tool":"send_command","args":{"device_id":"d1","command":"WATER_ON"}}']
    const turn1 = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'm', messages: [{ role: 'user', content: 'tưới đi' }] },
    })
    const msg1 = turn1.json().choices[0].message
    expect(msg1.tool_calls[0].function.name).toBe('send_command')
    expect(msg1.content).toContain('Có/Không')
    expect(mcp.calls).toHaveLength(0)

    const turn2 = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'm',
        messages: [
          { role: 'user', content: 'tưới đi' },
          { role: 'assistant', content: msg1.content, tool_calls: msg1.tool_calls },
          { role: 'user', content: 'có' },
        ],
      },
    })
    expect(turn2.json().choices[0].message.content).toContain('Đã thực hiện')
    expect(mcp.calls).toEqual(['send_command'])
    await app.close()
  })

  it('read-offer round-trip: reply-carried sensor read → "có" runs and summarizes', async () => {
    const app = makeApp(llm, mcp)
    mcp.result = { text: 'soil_moisture=70', isError: false }
    llm.jsonQueue = [
      '{"type":"reply","message":"Lá vàng có thể do úng nước.","tool":"get_latest_sensor","args":{"device_id":"d1"}}',
    ]
    const turn1 = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'm', messages: [{ role: 'user', content: 'vàng lá thì sao?' }] },
    })
    const msg1 = turn1.json().choices[0].message
    expect(msg1.tool_calls[0].function.name).toBe('get_latest_sensor')

    const turn2 = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'm',
        messages: [
          { role: 'user', content: 'vàng lá thì sao?' },
          { role: 'assistant', content: msg1.content, tool_calls: msg1.tool_calls },
          { role: 'user', content: 'có' },
        ],
      },
    })
    expect(turn2.statusCode).toBe(200)
    expect(mcp.calls).toEqual(['get_latest_sensor'])
    await app.close()
  })
})
```

- [ ] **Step 2: Run buffered tests to verify they fail**

Run: `npx vitest run tests/openai.http.test.ts`
Expected: FAIL — `/v1/...` routes 404 (not registered yet).

- [ ] **Step 3: Implement the routes**

Create `src/http/routes.openai.ts`:

```typescript
import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { SessionStore } from '../memory/sessions'
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

// The ephemeral store is per-request, so a constant key is safe (no cross-talk).
const UID = 'openai'
const SID = 'openai'

function oaiError(message: string, type: string, code: string) {
  return { error: { message, type, code, param: null } }
}

const chatBodySchema = {
  type: 'object',
  required: ['model', 'messages'],
  additionalProperties: true,
  properties: {
    model: { type: 'string', description: 'Chấp nhận mọi giá trị; server echo lại. `/v1/models` liệt kê `plant-assistant`.' },
    messages: { type: 'array', items: { type: 'object', additionalProperties: true } },
    stream: { type: 'boolean' },
  },
  example: { model: 'plant-assistant', messages: [{ role: 'user', content: 'Cây dâu của mình bị vàng lá, nên làm gì?' }] },
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
        summary: 'Chat completions tương thích OpenAI (chạy toàn bộ agent)',
        description:
          'Endpoint OpenAI-compatible, **stateless**: gửi cả `messages[]` mỗi lần. Chạy qua toàn bộ agent ' +
          '(RAG + điều khiển IoT + xác nhận).\n\n' +
          '**Điều khiển thiết bị (turnkey):** khi cần xác nhận, response trả `content` là câu hỏi "(Có/Không)" ' +
          '**và** một `tool_calls` mã hoá hành động. Ở lượt sau, **giữ nguyên object assistant (kèm `tool_calls`)** ' +
          'trong `messages[]` rồi thêm câu trả lời của người dùng ("có"/"không") — server sẽ thực thi hoặc huỷ. ' +
          'Nếu không giữ `tool_calls`, "có" sẽ bị coi là yêu cầu mới (an toàn: không thực thi nhầm).\n\n' +
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

      // Stateless: rebuild a throwaway session from the thread, then run the
      // unchanged agent core against it.
      const ephemeral = new SessionStore()
      if (thread.history.length) ephemeral.append(UID, SID, ...thread.history)
      const pending = recoverPending(thread.priorAssistant)
      if (pending) ephemeral.setPending(UID, SID, pending)
      const scoped = orch.withSessions(ephemeral)

      const id = `chatcmpl-${randomUUID()}`
      const created = Math.floor(Date.now() / 1000)

      if (!body.stream) {
        try {
          const result = await scoped.handleChat(UID, SID, thread.lastUserMessage)
          return toCompletion(result, body.model, id, created)
        } catch (err) {
          req.log.error(err)
          reply.code(500)
          return oaiError((err as Error).message, 'server_error', 'internal_error')
        }
      }

      // Streaming (OpenAI SSE). From here Fastify hands off the raw socket.
      reply.hijack()
      const raw = reply.raw
      writeSseHead(raw)
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
        for await (const event of scoped.handleChatStream(UID, SID, thread.lastUserMessage, { signal: abort.signal })) {
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

- [ ] **Step 4: Register the routes and Swagger tag**

In `src/http/server.ts`, add the import near the other route imports:

```typescript
import { registerOpenAiRoutes } from './routes.openai'
```

Add the tag to the `tags` array in the `fastifySwagger` registration:

```typescript
        { name: 'openai', description: 'API tương thích OpenAI (/v1) — server khác gọi như LM Studio' },
```

Register inside the child plugin (after `registerChatRoutes`):

```typescript
  app.register(async (instance) => {
    registerSetupRoutes(instance, ctx.state, ctx.config, ctx.setupDeps)
    registerChatRoutes(instance, ctx.state)
    registerOpenAiRoutes(instance, ctx.state)
  })
```

- [ ] **Step 5: Run buffered tests to verify they pass**

Run: `npx vitest run tests/openai.http.test.ts`
Expected: PASS (all buffered/models/error/round-trip tests).

- [ ] **Step 6: Write the failing streaming tests**

Create `tests/openai.stream.test.ts`:

```typescript
import { beforeEach, describe, expect, it } from 'vitest'
import { Orchestrator } from '../src/agent/orchestrator'
import { config } from '../src/config'
import { loadProfile } from '../src/domain/profiles'
import { buildServer } from '../src/http/server'
import type { LlmEngine } from '../src/llm'
import type { McpGateway, McpToolResult } from '../src/mcp/client'
import { SessionStore } from '../src/memory/sessions'
import { InMemoryVectorStore } from '../src/rag/store'
import { AppState } from '../src/setup/state'

class FakeLlm implements LlmEngine {
  jsonQueue: string[] = []
  async complete() {
    return 'ok'
  }
  async completeJson() {
    return this.jsonQueue.shift() ?? '{"type":"reply","message":"..."}'
  }
  async *completeStream() {
    yield await this.complete()
  }
  async *completeJsonStream() {
    yield await this.completeJson()
  }
  async embed(t: string[]) {
    return t.map(() => [0, 0, 0])
  }
}

class FakeMcp implements McpGateway {
  calls: string[] = []
  result: McpToolResult = { text: 'done', isError: false }
  async listTools() {
    return []
  }
  async callTool(name: string): Promise<McpToolResult> {
    this.calls.push(name)
    return this.result
  }
}

function makeApp(llm: FakeLlm, mcp: FakeMcp) {
  const orch = new Orchestrator({
    llm,
    mcp,
    store: new InMemoryVectorStore(),
    sessions: new SessionStore(),
    profile: loadProfile('strawberry'),
    tools: [],
    maxToolSteps: 3,
    ragTopK: 4,
  })
  return buildServer({ state: AppState.ready(orch), config })
}

/** Parse OpenAI SSE (data-only frames); returns parsed JSON objects, [DONE] as the string. */
function parseOpenAiSse(body: string): Array<any | '[DONE]'> {
  return body
    .split('\n\n')
    .map((f) => f.trim())
    .filter((f) => f.startsWith('data: '))
    .map((f) => f.slice('data: '.length))
    .map((d) => (d === '[DONE]' ? '[DONE]' : JSON.parse(d)))
}

function contentOf(frames: Array<any>): string {
  return frames
    .filter((f) => f !== '[DONE]' && f.choices?.[0]?.delta?.content)
    .map((f) => f.choices[0].delta.content as string)
    .join('')
}

describe('OpenAI-compatible API (streaming)', () => {
  let llm: FakeLlm
  let mcp: FakeMcp
  beforeEach(() => {
    llm = new FakeLlm()
    mcp = new FakeMcp()
  })

  it('streams content chunks and terminates with finish_reason stop then [DONE]', async () => {
    llm.jsonQueue = ['{"type":"reply","message":"Chào bạn!"}']
    const app = makeApp(llm, mcp)
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'm', stream: true, messages: [{ role: 'user', content: 'hi' }] },
    })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('text/event-stream')
    const frames = parseOpenAiSse(res.body)
    expect(contentOf(frames)).toBe('Chào bạn!')
    expect(frames[frames.length - 1]).toBe('[DONE]')
    const finalChunk = frames[frames.length - 2]
    expect(finalChunk.object).toBe('chat.completion.chunk')
    expect(finalChunk.choices[0].finish_reason).toBe('stop')
    await app.close()
  })

  it('carries a control pending action as a tool_call in the terminal chunk', async () => {
    llm.jsonQueue = ['{"type":"tool","tool":"send_command","args":{"device_id":"d1","command":"WATER_ON"}}']
    const app = makeApp(llm, mcp)
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'm', stream: true, messages: [{ role: 'user', content: 'tưới đi' }] },
    })
    const frames = parseOpenAiSse(res.body)
    const toolChunk = frames.find((f) => f !== '[DONE]' && f.choices?.[0]?.delta?.tool_calls)
    expect(toolChunk.choices[0].delta.tool_calls[0].function.name).toBe('send_command')
    expect(contentOf(frames)).toContain('Có/Không')
    expect(mcp.calls).toHaveLength(0)
    await app.close()
  })

  it('returns plain JSON 503 (not SSE) before the server is configured', async () => {
    const app = buildServer({ state: new AppState(), config })
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'm', stream: true, messages: [{ role: 'user', content: 'hi' }] },
    })
    expect(res.statusCode).toBe(503)
    expect(res.headers['content-type']).toContain('application/json')
    expect(res.json().error.code).toBe('not_configured')
    await app.close()
  })
})
```

- [ ] **Step 7: Run streaming tests to verify they pass**

Run: `npx vitest run tests/openai.stream.test.ts`
Expected: PASS (3 tests). (The route implemented in Step 3 already covers streaming.)

- [ ] **Step 8: Add the `/v1/*` entries to the `GET /` info list**

In `src/http/routes.chat.ts`, inside the `endpoints` array returned by the `GET /` handler, add after the `/chat/confirm` entry:

```typescript
        { method: 'POST', path: '/v1/chat/completions' },
        { method: 'GET', path: '/v1/models' },
```

- [ ] **Step 9: Commit**

```bash
git add src/http/routes.openai.ts src/http/server.ts src/http/routes.chat.ts tests/openai.http.test.ts tests/openai.stream.test.ts
git commit -m "feat(http): add OpenAI-compatible /v1/chat/completions and /v1/models"
```

---

## Task 6: Full-suite verification

**Files:** none (verification gate).

- [ ] **Step 1: Run the whole test suite**

Run: `npm test`
Expected: PASS — all existing tests plus the new `openai.*` tests. If any pre-existing test broke, the change violated a Global Constraint (likely touched a frozen file) — fix before proceeding.

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: no errors. (Watch for the `body.messages as unknown as OpenAiMessage[]` boundary cast in `routes.openai.ts` — it is intentional; the Zod-inferred message type and the adapter's `OpenAiMessage` are structurally compatible.)

- [ ] **Step 3: Manual smoke (optional, needs a configured live LLM)**

Buffered:
```bash
curl -s -X POST localhost:8787/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"plant-assistant","messages":[{"role":"user","content":"Cây dâu của mình bị vàng lá, nên làm gì?"}]}'
```
Streaming:
```bash
curl -N -X POST localhost:8787/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"plant-assistant","stream":true,"messages":[{"role":"user","content":"chào bạn"}]}'
```
Expected: a valid `chat.completion` object (buffered) / `chat.completion.chunk` frames ending in `data: [DONE]` (streaming).

- [ ] **Step 4: Final commit (if Step 3 produced any doc tweak; otherwise skip)**

```bash
git add -A
git commit -m "docs: note OpenAI-compatible endpoint smoke commands"
```

---

## Self-Review

**1. Spec coverage:**
- FR1 buffered completion → Task 5 (route) + Task 4 (`toCompletion`). ✓
- FR2 streaming → Task 5 (stream branch) + Task 4 (chunk builders). ✓
- FR3 `/v1/models` → Task 4 (`modelsList`) + Task 5 (route). ✓
- FR4 full agent behind it → Task 1 (`withSessions`) + Task 5 (runs `handleChat`/`handleChatStream`). ✓
- FR5 stateless → Task 5 (ephemeral `SessionStore`). ✓
- FR6 turnkey control → Task 3 (`recoverPending`/`encodePending`) + Task 5 round-trip test. ✓
- FR7 read-offer parity → Task 5 read-offer round-trip test (no special-casing; same mechanism). ✓
- FR8 OpenAI error shape → Task 5 (`oaiError`, 503/400/500). ✓
- Edge cases (empty messages, last-not-user, content parts, system dropped, bad-JSON args, kind derivation) → Tasks 3 & 5 tests. ✓

**2. Placeholder scan:** No TBD/TODO; every code step shows complete code; every test step shows assertions. ✓

**3. Type consistency:** `withSessions(sessions: SessionStore)` (Task 1) matches its call in Task 5. Adapter names (`parseMessages`, `recoverPending`, `encodePending`, `toCompletion`, `modelsList`, `roleChunk`, `contentChunk`, `finalChunk`, `sseData`, `SSE_DONE`, `BadRequestError`, `OpenAiMessage`) defined in Tasks 3–4 match their imports/usages in Task 5. `ChatResult`/`PendingActionView` consumed from `orchestrator.ts` match existing exports. ✓
