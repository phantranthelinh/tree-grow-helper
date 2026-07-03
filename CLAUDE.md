# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An **AI Server** that sits between a chat app and the `plant-tree-iot/mcp-server`. It takes
Vietnamese chat about plants, reasons with a **local OpenAI-compatible LLM**, and either answers
from a RAG knowledge base or **controls IoT devices via MCP** (always confirming control actions
first). Phase 1 supports **strawberry only**; a new plant = a new JSON profile, no code change.

**All user-facing text is Vietnamese** — replies, prompts, the `/setup` UI, log lines. Keep it that
way when editing prompts, summaries, or UI copy.

## Commands

```bash
npm start                 # run the server (tsx, no build step) → http://localhost:8787
npm run dev               # same, watch mode
npm test                  # vitest run — unit + integration, needs NO external services
npm run test:watch        # vitest watch
npm run typecheck         # tsc --noEmit (the only "build" check; start/dev never compile)
npm run eval              # measure the small model's tool-selection accuracy — needs a live LLM
npm run scrape            # scrape allowlisted sources → data/staging (RAG pipeline, step 1)
npm run mcp:catalog       # print the live MCP tool list — needs the MCP running
```

Run a single test: `npx vitest run tests/orchestrator.test.ts` or filter by name with
`npx vitest run -t "confirmation"`. Tests live both in [tests/](tests/) and colocated as
`src/**/*.test.ts` (both globs are in [vitest.config.ts](vitest.config.ts)).

This is an **ESM** project (`"type": "module"`) run directly through `tsx` — there is no compiled
`dist/`. Import paths are extensionless and resolved by the bundler-style moduleResolution.

## Architecture

### Two-phase startup (config is runtime, not boot-time)

[src/index.ts](src/index.ts) starts Fastify **immediately** in `waiting_config` phase, then tries to
auto-connect from a saved `data/llm-config.json`. The LLM is chosen at runtime via the `/setup` UI,
not from env. [src/setup/init.ts](src/setup/init.ts) `applyLlmConfig` probes the connection, persists
the config, then runs `runInitPipeline` in the background: build LLM engine → connect MCP → build RAG
index → assemble the `Orchestrator` → mark ready.

- [src/setup/state.ts](src/setup/state.ts) `AppState` is the lifecycle state machine
  (`waiting_config → connecting → initializing → ready`/`error`). Chat routes gate on
  `state.orchestrator` being set, **not** on `phase` — so a runtime re-configure keeps serving the
  old orchestrator until the new one is ready.
- **Graceful degradation is intentional**: if MCP won't connect, init falls back to the static
  [src/mcp/knownTools.ts](src/mcp/knownTools.ts) catalog (control commands then error until MCP is up);
  if embeddings fail, it runs with no RAG. Only an unexpected throw reaches the `error` phase.
- [config.ts](src/config.ts) `llmDefaults` **only prefill the setup form** — they never auto-connect.
  The saved `data/llm-config.json` is what auto-connects.
- The MCP URL is likewise runtime-configured: the `/setup` form has an MCP URL field (+ a
  "Kiểm tra MCP" probe via `POST /api/setup/mcp/test`), saved to `data/mcp-config.json`
  ([src/setup/mcpConfig.ts](src/setup/mcpConfig.ts)). Env `MCP_URL` only prefills/falls back;
  the saved file wins once written.

### The agent loop and tool-safety policy (the core safety invariant)

[src/agent/orchestrator.ts](src/agent/orchestrator.ts) `runAgentLoop` runs up to `MAX_TOOL_STEPS`
(default 3) turns. Each turn the LLM returns a JSON decision (schema in
[src/agent/decision.ts](src/agent/decision.ts)): either `{type:"reply"}` or `{type:"tool"}`.

- **READ tools run automatically** and their result is fed back into the message loop.
- **CONTROL tools never execute inline** — they create a `pendingAction` and the loop returns,
  asking the user to confirm. Execution happens only on `/chat/confirm` (or a free-text "có"/"không",
  detected by `detectConfirmation` in [src/agent/confirmation.ts](src/agent/confirmation.ts)).
- Classification lives in [src/mcp/policy.ts](src/mcp/policy.ts) and is **fail-safe**: unknown tools
  default to `control` (require confirmation) unless they start with a read-style prefix. When adding
  MCP tools, update the `READ_ONLY`/`CONTROL` sets there.

### Profile drives both thresholds and RAG

[src/domain/profiles.ts](src/domain/profiles.ts): a plant profile JSON in
[src/domain/knowledge/](src/domain/knowledge/) has two roles. **Numeric ranges** (`soil_moisture_range`
etc.) → `deriveControlThresholds` + `summarizeRanges` → injected into the system prompt, and are the
reason a strawberry gets 75–80% target moisture instead of the MCP's generic 30% default. **Text
fields** (`care_notes`, `watering`, `diseases`…) are chunked + embedded for RAG. The prompt rule is:
if sources conflict with the numeric optimal ranges, the ranges win.

**Adding a plant**: drop `src/domain/knowledge/<plant>.json` (validated by `PlantProfileSchema`) and
set `DEFAULT_PLANT=<plant>`. No code change.

### RAG pipeline (human-review gate)

Retrieval is a brute-force in-memory cosine store ([src/rag/store.ts](src/rag/store.ts)) — fine for a
few hundred curated chunks, zero native deps. Data gets in three ways, all ingested at init:
1. The plant profile ([src/rag/ingest.ts](src/rag/ingest.ts)) and disease KB
   ([src/rag/ingestDiseases.ts](src/rag/ingestDiseases.ts)) — curated JSON, always loaded.
2. Reviewed source docs from `data/docs/*.jsonl` ([src/rag/ingestDocs.ts](src/rag/ingestDocs.ts)).

The scrape → review → ingest flow is deliberate: `npm run scrape` writes **raw** records to
`data/staging/`, a **human trims/reviews** them, then copies good records into `data/docs/`. Nothing
scraped touches the store automatically. Embeddings are cached on disk
([src/rag/embedCache.ts](src/rag/embedCache.ts)) and near-duplicates are dropped
([src/rag/dedupe.ts](src/rag/dedupe.ts)). Cross-lingual retrieval (Vietnamese query, English docs)
relies on the `bge-m3` embedding model.

### LLM provider abstraction

[src/llm/index.ts](src/llm/index.ts) `OpenAICompatEngine` is a single OpenAI-SDK-backed engine that
serves LM Studio, Ollama, Gemini (OpenAI-compat layer), and any OpenAI-compatible server.
[src/llm/providers.ts](src/llm/providers.ts) `PROVIDERS` only carries per-provider presets (default
base URL, whether an API key is required, display copy). It relies on `response_format: json_schema`
for structured decisions — providers must support it.

### HTTP surface

[src/http/server.ts](src/http/server.ts) wires Swagger UI at `/docs`, then registers setup + chat
routes. Endpoints: `POST /chat`, `POST /chat/confirm` ([routes.chat.ts](src/http/routes.chat.ts)),
the `/setup` UI + `/api/setup/*` ([routes.setup.ts](src/http/routes.setup.ts)), `GET /health`.
Before config completes, `/chat` returns **503 `{error:"not_configured"}`**. Validation uses Zod DTOs
([src/http/dto.ts](src/http/dto.ts)) with `attachValidation: true` so failures return the
`{error:"invalid_request", details}` envelope rather than Fastify's default.

## Testing conventions

Tests run with **no external services** because the app is built around DI seams: `LlmEngine`,
`McpGateway` ([src/mcp/client.ts](src/mcp/client.ts)), and `SetupDeps`
([src/setup/init.ts](src/setup/init.ts)) are all interfaces with production impls and test fakes.
When adding a feature that touches the LLM, MCP, or the init pipeline, thread it through the existing
interface rather than newing up a concrete class, so it stays fakeable. `npm run eval` (needs a live
LLM) is a separate accuracy measurement, not part of `npm test`.
