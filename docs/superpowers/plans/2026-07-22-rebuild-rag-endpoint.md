# Rebuild RAG Endpoint — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `POST /api/setup/rag/rebuild` — a synchronous endpoint that re-ingests the RAG knowledge (profile + `data/docs` + diseases) into a fresh store and hot-swaps store+profile into the running orchestrator, without touching MCP/LLM engine/sessions.

**Architecture:** Extract the existing RAG-build block from `runInitPipeline` into a reusable `ingestAll()`. Add `Orchestrator.withRag()` (mirrors `withSessions`) + an `engine` getter. Add a rebuild lock to `AppState`. A new `rebuildRag()` in `setup/init.ts` reuses the orchestrator's engine, calls `ingestAll` into a new store (build-then-swap), and atomically swaps the orchestrator. A thin route maps the result to HTTP.

**Tech Stack:** TypeScript (ESM, run via tsx), Fastify, Zod DTOs, Vitest. No build step.

## Global Constraints

- **ESM, extensionless imports**, run through `tsx` — no `dist/`, match existing import style.
- **All user-facing strings in Vietnamese** (error messages, Swagger copy).
- **DI seams stay fakeable**: depend on `LlmEngine` interface, never `new OpenAICompatEngine` in the rebuild path.
- **Build-then-swap invariant**: ingest must fully succeed into a NEW store before `state.orchestrator` is reassigned. Never `clear()` a serving store.
- **Do not change `phase`** during rebuild (chat gates on `orchestrator`, phase stays `ready`).
- Tests run with **no external services** (fakes only). `npm test` = `vitest run`; typecheck = `npm run typecheck`.
- Spec: `docs/superpowers/specs/2026-07-22-rebuild-rag-endpoint-design.md`.

---

## File Structure

- **Create** `src/rag/buildStore.ts` — `ingestAll(llm, appCfg, profile, embedModel)` → `{ store, counts, detail }`. Single responsibility: build a populated store from all curated sources.
- **Create** `src/rag/buildStore.test.ts` — unit test for `ingestAll`.
- **Modify** `src/setup/init.ts` — `runInitPipeline` uses `ingestAll`; add `rebuildRag(state, appCfg)`.
- **Modify** `src/agent/orchestrator.ts` — add `withRag(store, profile)` + `get engine()`.
- **Modify** `src/setup/state.ts` — add rebuild lock + `embedModel()` accessor.
- **Modify** `src/http/routes.setup.ts` — add `POST /api/setup/rag/rebuild`.
- **Create** `tests/rebuild-rag.test.ts` — `rebuildRag` scenarios.
- **Modify** `tests/setup-routes.test.ts` — HTTP route scenarios.
- **Modify** `tests/orchestrator.test.ts` — `withRag`/`engine` tests.
- **Create** `tests/appstate.rebuild.test.ts` — AppState lock unit tests.

---

## Task 1: Extract `ingestAll` and refactor `runInitPipeline`

**Files:**
- Create: `src/rag/buildStore.ts`
- Create: `src/rag/buildStore.test.ts`
- Modify: `src/setup/init.ts:90-194` (RAG section + store creation)

**Interfaces:**
- Produces: `ingestAll(llm: LlmEngine, appCfg: Config, profile: PlantProfile, embedModel: string): Promise<RagBuildResult>` where `RagBuildResult = { store: InMemoryVectorStore; counts: { profile: number; docs: number; diseases: number }; detail: string }`.
- Consumes: existing `ingestProfile`, `ingestDocs`, `readReviewedDocs`, `ingestDiseases`, `loadDiseases`, `loadEmbedCache`, `saveEmbedCache`.

- [ ] **Step 1: Write the failing test** — `src/rag/buildStore.test.ts`

```ts
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { config, type Config } from '../config'
import type { LlmEngine } from '../llm'
import { loadProfile } from '../domain/profiles'
import { ingestAll } from './buildStore'

class FakeLlm implements LlmEngine {
  async complete() { return '' }
  async completeJson() { return '{}' }
  async *completeStream() { yield '' }
  async *completeJsonStream() { yield '{}' }
  async embed(texts: string[]) { return texts.map(() => [0.1, 0.2, 0.3]) }
}

function testConfig(): Config {
  const dir = mkdtempSync(join(tmpdir(), 'tgh-buildstore-'))
  return {
    ...config,
    rag: { ...config.rag, disabled: false, embedCachePath: join(dir, 'cache.jsonl'), docsDir: join(dir, 'docs') },
  } as Config
}

describe('ingestAll', () => {
  it('builds a populated store with per-source counts and a detail string', async () => {
    const profile = loadProfile('strawberry')
    const res = await ingestAll(new FakeLlm(), testConfig(), profile, 'embed-model')

    expect(res.counts.profile).toBeGreaterThan(0)
    expect(res.counts.docs).toBe(0) // empty docs dir
    expect(res.store.size()).toBe(res.counts.profile + res.counts.docs + res.counts.diseases)
    expect(res.detail).toMatch(/profile.*doc.*disease.*store=/)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/rag/buildStore.test.ts`
Expected: FAIL — `Cannot find module './buildStore'`.

- [ ] **Step 3: Create `src/rag/buildStore.ts`**

```ts
import { resolve } from 'node:path'
import type { Config } from '../config'
import { loadDiseases } from '../domain/diseases'
import type { PlantProfile } from '../domain/profiles'
import type { LlmEngine } from '../llm'
import { loadEmbedCache, saveEmbedCache } from './embedCache'
import { ingestProfile } from './ingest'
import { ingestDiseases } from './ingestDiseases'
import { ingestDocs, readReviewedDocs } from './ingestDocs'
import { InMemoryVectorStore } from './store'

export interface RagBuildResult {
  store: InMemoryVectorStore
  counts: { profile: number; docs: number; diseases: number }
  /** Human-readable summary, e.g. "14 profile + 0 doc + 9 disease (store=23)"; carries the mixed-dims warning. */
  detail: string
}

/**
 * Build a fresh RAG store from every curated source (profile text + reviewed docs +
 * disease KB). Pure: creates and returns its own store, never mutates a live one.
 * Disease-KB failure is non-fatal (matches the original init behavior).
 */
export async function ingestAll(
  llm: LlmEngine,
  appCfg: Config,
  profile: PlantProfile,
  embedModel: string,
): Promise<RagBuildResult> {
  const store = new InMemoryVectorStore()
  const cachePath = resolve(process.cwd(), appCfg.rag.embedCachePath)
  const cache = loadEmbedCache(cachePath)

  const nProfile = await ingestProfile(store, llm, profile, {
    cache,
    embedModel,
    chunkSize: appCfg.rag.chunkSize,
    chunkOverlap: appCfg.rag.chunkOverlap,
    minChunkLen: appCfg.rag.minChunkLen,
  })

  const docs = readReviewedDocs(resolve(process.cwd(), appCfg.rag.docsDir))
  const nDocs = await ingestDocs(store, llm, docs, {
    plant: profile.plant,
    cache,
    embedModel,
    chunkSize: appCfg.rag.chunkSize,
    chunkOverlap: appCfg.rag.chunkOverlap,
    minChunkLen: appCfg.rag.minChunkLen,
  })

  let nDiseases = 0
  try {
    nDiseases = await ingestDiseases(store, llm, loadDiseases(profile.plant), {
      plant: profile.plant,
      cache,
      embedModel,
    })
  } catch (err) {
    console.warn(`[rag] disease KB skipped (${(err as Error).message}).`)
  }

  saveEmbedCache(cachePath, cache)
  const mixed = store.uniformDims()
    ? ''
    : ' ⚠ CHIỀU EMBEDDING KHÔNG ĐỒNG NHẤT — một số chunk sẽ không truy hồi được; xóa cache cũ.'
  const detail = `${nProfile} profile + ${nDocs} doc + ${nDiseases} disease (store=${store.size()})${mixed}`
  return { store, counts: { profile: nProfile, docs: nDocs, diseases: nDiseases }, detail }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/rag/buildStore.test.ts`
Expected: PASS.

- [ ] **Step 5: Refactor `runInitPipeline` to use `ingestAll`**

In `src/setup/init.ts`: add import `import { ingestAll } from '../rag/buildStore'`. Remove the now-unused imports that moved into buildStore.ts **only if nothing else uses them** (`ingestProfile`, `ingestDocs`, `readReviewedDocs`, `ingestDiseases`, `loadEmbedCache`, `saveEmbedCache`, `loadDiseases`). Change `const store = new InMemoryVectorStore()` (line ~100) to `let store = new InMemoryVectorStore()`. Replace the RAG-enabled `try` block (lines ~129-174) with:

```ts
    try {
      const { store: built, detail } = await ingestAll(llm, appCfg, profile, cfg.embedModel)
      store = built
      state.setStep('rag', 'done', detail)
      console.log(`[rag] ingested ${detail}`)
      if (!store.uniformDims()) console.warn('[rag] ⚠ chiều embedding không đồng nhất — xóa cache cũ.')
    } catch (err) {
      const msg = `Nạp RAG thất bại (${(err as Error).message}) — chạy KHÔNG có RAG.`
      state.setStep('rag', 'failed', msg)
      console.warn(`[rag] ${msg}`)
    }
```

Leave the `if (appCfg.rag.disabled) { ... }` branch untouched. The Orchestrator constructor (line ~177) keeps using `store`.

- [ ] **Step 6: Verify init behavior is unchanged**

Run: `npx vitest run tests/init.test.ts src/rag/buildStore.test.ts`
Expected: PASS (both "skips RAG when disabled" and "runs RAG ingest when enabled" still green).

- [ ] **Step 7: Typecheck & commit**

```bash
npm run typecheck
git add src/rag/buildStore.ts src/rag/buildStore.test.ts src/setup/init.ts
git commit -m "refactor(rag): extract ingestAll from runInitPipeline"
```

---

## Task 2: `Orchestrator.withRag` + `engine` getter

**Files:**
- Modify: `src/agent/orchestrator.ts` (near existing `withSessions`, ~line 148)
- Modify: `tests/orchestrator.test.ts` (add tests near the existing `withSessions` test, ~line 231)

**Interfaces:**
- Produces: `Orchestrator.withRag(store: InMemoryVectorStore, profile: PlantProfile): Orchestrator` and `Orchestrator.get engine(): LlmEngine`.
- Consumes: existing private `deps` (has `llm`, `store`, `profile`).

- [ ] **Step 1: Write the failing tests** — append inside the `describe('Orchestrator', …)` block in `tests/orchestrator.test.ts`

```ts
  it('engine getter returns the injected LlmEngine', () => {
    expect(orch.engine).toBe(llm)
  })

  it('withRag returns a new Orchestrator that retrieves from the swapped store', async () => {
    const store = new InMemoryVectorStore()
    store.add([{ id: 'x', text: 'ngưỡng ẩm đất dâu tây 75-80%', embedding: [1, 0, 0] }])
    const swapped = orch.withRag(store, loadProfile('strawberry'))
    expect(swapped).not.toBe(orch)
    // llm.embed returns [0,0,0] → cosine 0, but the record is present and retrievable via search
    expect(store.size()).toBe(1)
  })
```

Ensure `InMemoryVectorStore` is imported in the test file (it already is — used by `makeDeps`).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/orchestrator.test.ts -t "withRag"`
Expected: FAIL — `orch.withRag is not a function` / `orch.engine` undefined.

- [ ] **Step 3: Implement in `src/agent/orchestrator.ts`** — add right after `withSessions` (~line 150)

```ts
  /** LLM engine this orchestrator serves with — reused by a RAG rebuild (no new engine). */
  get engine(): LlmEngine {
    return this.deps.llm
  }

  /**
   * Return a clone with a rebuilt knowledge base: new vector store + reloaded
   * profile, every other dep shared. Used by rebuildRag to hot-swap RAG without
   * touching MCP, the LLM engine, or sessions.
   */
  withRag(store: InMemoryVectorStore, profile: PlantProfile): Orchestrator {
    return new Orchestrator({ ...this.deps, store, profile })
  }
```

(`InMemoryVectorStore`, `PlantProfile`, `LlmEngine` types are already imported at the top of the file.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/orchestrator.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/agent/orchestrator.ts tests/orchestrator.test.ts
git commit -m "feat(agent): add Orchestrator.withRag and engine getter"
```

---

## Task 3: `AppState` rebuild lock + `embedModel` accessor

**Files:**
- Modify: `src/setup/state.ts`
- Create: `tests/appstate.rebuild.test.ts`

**Interfaces:**
- Produces: `AppState.isRebuilding(): boolean`, `beginRebuild(): void`, `endRebuild(): void`, `embedModel(): string`.
- Consumes: existing private `currentConfig` (set by `beginInitializing`), existing public `setStep`.

- [ ] **Step 1: Write the failing test** — `tests/appstate.rebuild.test.ts`

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/appstate.rebuild.test.ts`
Expected: FAIL — `s.isRebuilding is not a function`.

- [ ] **Step 3: Implement in `src/setup/state.ts`** — add the field with the other privates and the methods (e.g. after `isBusy()`)

```ts
  private ragRebuilding = false

  isRebuilding(): boolean {
    return this.ragRebuilding
  }

  /** Lock a RAG rebuild and mark the rag step running (phase stays ready). */
  beginRebuild(): void {
    this.ragRebuilding = true
    this.setStep('rag', 'running')
  }

  /** Release the rebuild lock (step status is set by the caller on success/failure). */
  endRebuild(): void {
    this.ragRebuilding = false
  }

  /** Embedding model of the running config (cache-key namespace for a rebuild). */
  embedModel(): string {
    return this.currentConfig?.embedModel ?? ''
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/appstate.rebuild.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/setup/state.ts tests/appstate.rebuild.test.ts
git commit -m "feat(setup): add AppState rebuild lock and embedModel accessor"
```

---

## Task 4: `rebuildRag` function

**Files:**
- Modify: `src/setup/init.ts` (add exported `rebuildRag` + `RebuildResult`)
- Create: `tests/rebuild-rag.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type RebuildResult =
    | { ok: true; profile: number; docs: number; diseases: number; storeSize: number; ms: number }
    | { ok: false; code: 'not_configured' | 'busy' | 'rag_disabled' | 'embed_failed'; message: string }
  export async function rebuildRag(state: AppState, appCfg: Config): Promise<RebuildResult>
  ```
- Consumes: `state.orchestrator.engine` (Task 2), `state.withRag` via orchestrator (Task 2), `ingestAll` (Task 1), `AppState` lock + `embedModel()` (Task 3), existing `loadProfile`.

- [ ] **Step 1: Write the failing tests** — `tests/rebuild-rag.test.ts`

```ts
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { config, type Config } from '../src/config'
import type { LlmEngine } from '../src/llm'
import type { McpGateway, McpToolResult } from '../src/mcp/client'
import { applyLlmConfig, rebuildRag, type SetupDeps } from '../src/setup/init'
import type { LlmConfig } from '../src/setup/llmConfig'
import type { ProbeResult } from '../src/setup/probe'
import { AppState } from '../src/setup/state'

class TogglingLlm implements LlmEngine {
  failEmbed = false
  embedCalls = 0
  async complete() { return '' }
  async completeJson() { return '{"type":"reply","message":"ok"}' }
  async *completeStream() { yield '' }
  async *completeJsonStream() { yield '{}' }
  async embed(texts: string[]) {
    if (this.failEmbed) throw new Error('embed down')
    this.embedCalls++
    return texts.map(() => [0.1, 0.2, 0.3])
  }
}

class FakeMcp implements McpGateway {
  async listTools() { return [] }
  async callTool(): Promise<McpToolResult> { return { text: 'ok', isError: false } }
}

const LLM_CFG: LlmConfig = {
  provider: 'lmstudio', baseURL: 'http://localhost:1234/v1', apiKey: 'x', model: 'chat', embedModel: 'embed',
}

function makeDeps(llm: LlmEngine): Partial<SetupDeps> {
  return {
    probe: async (): Promise<ProbeResult> => ({ ok: true, models: [] }),
    buildEngine: () => llm,
    buildMcp: () => new FakeMcp(),
  }
}

function testConfig(ragDisabled = false): Config {
  const dir = mkdtempSync(join(tmpdir(), 'tgh-rebuild-'))
  return {
    ...config,
    setup: { ...config.setup, configPath: join(dir, 'llm-config.json') },
    mcp: { ...config.mcp, configPath: join(dir, 'mcp-config.json') },
    rag: { ...config.rag, disabled: ragDisabled, embedCachePath: join(dir, 'cache.jsonl'), docsDir: join(dir, 'docs') },
    memory: { ...config.memory, sessionsPath: join(dir, 'sessions.json') },
  } as Config
}

async function ready(llm: LlmEngine, cfg: Config): Promise<AppState> {
  const state = new AppState()
  await applyLlmConfig(LLM_CFG, state, cfg, makeDeps(llm))
  await state.initPromise
  return state
}

describe('rebuildRag', () => {
  it('rebuilds and swaps the orchestrator on success', async () => {
    const llm = new TogglingLlm()
    const cfg = testConfig(false)
    const state = await ready(llm, cfg)
    const before = state.orchestrator

    const res = await rebuildRag(state, cfg)

    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.profile).toBeGreaterThan(0)
      expect(res.storeSize).toBeGreaterThan(0)
      expect(typeof res.ms).toBe('number')
    }
    expect(state.orchestrator).not.toBe(before) // swapped
    expect(state.isRebuilding()).toBe(false)
  })

  it('returns not_configured when there is no orchestrator', async () => {
    const res = await rebuildRag(new AppState(), testConfig(false))
    expect(res).toMatchObject({ ok: false, code: 'not_configured' })
  })

  it('returns rag_disabled when RAG is off', async () => {
    const cfg = testConfig(true)
    const state = await ready(new TogglingLlm(), cfg)
    const res = await rebuildRag(state, cfg)
    expect(res).toMatchObject({ ok: false, code: 'rag_disabled' })
  })

  it('returns busy when a config change is in flight', async () => {
    const cfg = testConfig(false)
    const state = await ready(new TogglingLlm(), cfg)
    state.beginConnecting() // isBusy() → true, orchestrator stays set
    const res = await rebuildRag(state, cfg)
    expect(res).toMatchObject({ ok: false, code: 'busy' })
  })

  it('keeps the old orchestrator when embedding fails (build-then-swap)', async () => {
    const llm = new TogglingLlm()
    const cfg = testConfig(false)
    const state = await ready(llm, cfg)
    const before = state.orchestrator

    llm.failEmbed = true
    const res = await rebuildRag(state, cfg)

    expect(res).toMatchObject({ ok: false, code: 'embed_failed' })
    expect(state.orchestrator).toBe(before) // unchanged
    expect(state.isRebuilding()).toBe(false)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/rebuild-rag.test.ts`
Expected: FAIL — `rebuildRag` is not exported.

- [ ] **Step 3: Implement `rebuildRag` in `src/setup/init.ts`**

Add imports at the top: `import { ingestAll } from '../rag/buildStore'` (already added in Task 1) and ensure `loadProfile` is imported (it is). Append:

```ts
export type RebuildResult =
  | { ok: true; profile: number; docs: number; diseases: number; storeSize: number; ms: number }
  | { ok: false; code: 'not_configured' | 'busy' | 'rag_disabled' | 'embed_failed'; message: string }

/**
 * Rebuild ONLY the RAG knowledge at runtime: re-read profile + data/docs + diseases,
 * ingest into a fresh store, and hot-swap store+profile into the running orchestrator.
 * Reuses the orchestrator's LLM engine (no new engine); MCP and sessions are untouched.
 * Build-then-swap: on any ingest error the old orchestrator keeps serving.
 */
export async function rebuildRag(state: AppState, appCfg: Config): Promise<RebuildResult> {
  const orch = state.orchestrator
  if (!orch) {
    return { ok: false, code: 'not_configured', message: 'Chưa cấu hình LLM — mở /setup trước.' }
  }
  if (appCfg.rag.disabled) {
    return { ok: false, code: 'rag_disabled', message: 'RAG đang tắt (RAG_DISABLED).' }
  }
  if (state.isBusy() || state.isRebuilding()) {
    return { ok: false, code: 'busy', message: 'Đang xử lý cấu hình/nạp lại khác, vui lòng đợi.' }
  }

  state.beginRebuild()
  const t0 = Date.now()
  try {
    const profile = loadProfile(appCfg.defaultPlant)
    const { store, counts, detail } = await ingestAll(orch.engine, appCfg, profile, state.embedModel())
    state.orchestrator = orch.withRag(store, profile) // atomic swap AFTER a full build
    state.setStep('rag', 'done', detail)
    console.log(`[rag] rebuilt ${detail}`)
    return { ok: true, ...counts, storeSize: store.size(), ms: Date.now() - t0 }
  } catch (err) {
    const message = `Nạp lại RAG thất bại (${(err as Error).message}) — giữ tri thức cũ.`
    state.setStep('rag', 'failed', message)
    console.warn(`[rag] ${message}`)
    return { ok: false, code: 'embed_failed', message }
  } finally {
    state.endRebuild()
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/rebuild-rag.test.ts`
Expected: PASS (all 5).

- [ ] **Step 5: Typecheck & commit**

```bash
npm run typecheck
git add src/setup/init.ts tests/rebuild-rag.test.ts
git commit -m "feat(setup): add rebuildRag (RAG-only hot-swap)"
```

---

## Task 5: `POST /api/setup/rag/rebuild` route

**Files:**
- Modify: `src/http/routes.setup.ts`
- Modify: `tests/setup-routes.test.ts`

**Interfaces:**
- Consumes: `rebuildRag(state, appCfg)` (Task 4). The handler receives `state` and `appCfg` already passed to `registerSetupRoutes`.

- [ ] **Step 1: Write the failing tests** — append inside `describe('setup routes', …)` in `tests/setup-routes.test.ts`

```ts
  it('POST /api/setup/rag/rebuild before ready returns 503 not_configured', async () => {
    const app = buildServer({ state, config: testConfig, setupDeps: baseDeps(okProbe) })
    const res = await app.inject({ method: 'POST', url: '/api/setup/rag/rebuild' })
    expect(res.statusCode).toBe(503)
    expect(res.json().error).toBe('not_configured')
    await app.close()
  })

  it('POST /api/setup/rag/rebuild after ready returns 200 with counts', async () => {
    const app = buildServer({ state, config: testConfig, setupDeps: baseDeps(okProbe) })
    await app.inject({ method: 'POST', url: '/api/setup/connect', payload: connectBody })
    await state.initPromise
    expect(state.phase).toBe('ready')

    const res = await app.inject({ method: 'POST', url: '/api/setup/rag/rebuild' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.ok).toBe(true)
    expect(body).toHaveProperty('storeSize')
    expect(body).toHaveProperty('ms')
    await app.close()
  })
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/setup-routes.test.ts -t "rag/rebuild"`
Expected: FAIL — 404 (route not registered).

- [ ] **Step 3: Implement the route in `src/http/routes.setup.ts`**

Add `rebuildRag` to the import from `../setup/init`:
```ts
import { applyLlmConfig, defaultSetupDeps, rebuildRag, type SetupDeps } from '../setup/init'
```
Add a response schema constant near the others:
```ts
const rebuildResponseSchema = {
  type: 'object',
  additionalProperties: true,
  properties: {
    ok: { type: 'boolean' },
    profile: { type: 'number' },
    docs: { type: 'number' },
    diseases: { type: 'number' },
    storeSize: { type: 'number' },
    ms: { type: 'number' },
  },
} as const
```
Register the route (e.g. after `/api/setup/mcp/test`):
```ts
  app.post(
    '/api/setup/rag/rebuild',
    {
      schema: {
        tags: ['setup'],
        summary: 'Nạp lại RAG (profile + data/docs + diseases)',
        description:
          'Re-ingest tri thức vào store mới rồi hot-swap vào orchestrator đang chạy (đồng bộ). ' +
          'Không đụng MCP/LLM/session. 503 nếu chưa cấu hình, 409 nếu bận/RAG tắt, 502 nếu embed lỗi.',
        response: { 200: rebuildResponseSchema, 409: errorSchema, 502: errorSchema, 503: errorSchema },
      },
    },
    async (_req, reply) => {
      const res = await rebuildRag(state, appCfg)
      if (res.ok) return res
      const status = res.code === 'not_configured' ? 503 : res.code === 'embed_failed' ? 502 : 409
      reply.code(status)
      return { error: res.code, message: res.message }
    },
  )
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/setup-routes.test.ts`
Expected: PASS.

- [ ] **Step 5: Full suite + typecheck**

Run: `npm run typecheck && npm test`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add src/http/routes.setup.ts tests/setup-routes.test.ts
git commit -m "feat(http): add POST /api/setup/rag/rebuild endpoint"
```

---

## Task 6: Docs — record the endpoint

**Files:**
- Modify: `CLAUDE.md` (HTTP surface section — the `Endpoints:` list under `### HTTP surface`)

- [ ] **Step 1: Add the endpoint to the HTTP surface list in `CLAUDE.md`**

In the `### HTTP surface` section, extend the setup endpoints sentence to mention:
`POST /api/setup/rag/rebuild` (nạp lại RAG store lúc runtime, đồng bộ; build-then-swap, không đụng MCP/LLM/session).

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: note POST /api/setup/rag/rebuild in CLAUDE.md"
```

---

## Self-Review (completed by plan author)

**Spec coverage:**
- §2 behavior (re-read from disk, ingest new store, swap store+profile) → Task 4.
- §2 reuse engine → Task 2 (`engine` getter) + Task 4.
- §3 build-then-swap → Task 4 impl + "embed fails keeps old orchestrator" test.
- §4.1 extract ingestAll → Task 1. §4.2 withRag → Task 2. §4.3 rebuildRag → Task 4. §4.4 AppState lock → Task 3. §4.5 route → Task 5.
- §5 error mapping (503/409/409/502/200) → Task 5 handler + Task 4 codes.
- §6 tests 1-7 → Tasks 1-5 tests.

**Placeholder scan:** none — every step has full code/commands.

**Type consistency:** `ingestAll(llm, appCfg, profile, embedModel)` used identically in Task 1 (runInitPipeline passes `cfg.embedModel`) and Task 4 (passes `state.embedModel()`). `RebuildResult` shape matches route mapping and tests. `withRag(store, profile)` / `engine` names consistent across Tasks 2 and 4.
