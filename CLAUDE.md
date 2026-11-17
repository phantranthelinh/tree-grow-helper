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
npm run scrape [plant]    # Crawl4AI + PDFs → data/staging/<plant>-docs.raw.jsonl (needs Crawl4AI container + Java)
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
  asking the user to confirm. Execution happens only on the next turn, when the user confirms with a
  free-text "có"/"không" (detected by `detectConfirmation` in
  [src/agent/confirmation.ts](src/agent/confirmation.ts)).
- Classification lives in [src/mcp/policy.ts](src/mcp/policy.ts) and is **fail-safe**: unknown tools
  default to `control` (require confirmation) unless they start with a read-style prefix. When adding
  MCP tools, update the `READ_ONLY`/`CONTROL` sets there.

### Small-model prompt constraints (qwen2.5-3b)

The decision prompt is tuned around quirks of the 3B model, and regressions are silent — so
[tests/prompt.test.ts](tests/prompt.test.ts) guards them. Two rules that look arbitrary but aren't:

- **`type:"reply"` messages must be flowing prose, no lists.** The model crams the whole answer into
  the JSON `message` string; when it starts a bulleted/numbered list it writes a "here's a list:"
  lead-in, then closes the JSON — the list never appears (truncated reply, `finish_reason=stop`, not
  a token cutoff). The prose rule sits at the very **end** of the system prompt
  ([src/llm/prompt.ts](src/llm/prompt.ts)); the same rule placed mid-prompt was ignored (recency).
- **`type:"tool"` few-shot examples put `message` before `tool`/`args`.** The 3B closes the JSON
  right after `args`, so a `message` placed last is almost never emitted. Keep the field order
  `type → message → tool → args` in [src/domain/fewshot.ts](src/domain/fewshot.ts); do not reorder.
- **Hour quantities are written "giờ", never "h".** At "4 h", "24h", "6-13h" the 3B switches into
  Russian or Chinese ("часов", "小时"); `normalizeHourUnits` rewrites the knowledge block and
  `summarizeRanges` renders "giờ". The switch is not only an "h" problem: quantities such as "1 phút"
  drift into "1 минут", and Sino-Vietnamese words do the same. The decision schema therefore
  constrains `message` with the allow-list `MESSAGE_PATTERN` ([decision.ts](src/agent/decision.ts)),
  which LM Studio compiles into its sampling grammar. A deny-list was bypassed with `\u` escapes, and
  `(?:` groups make LM Studio reject the schema. The orchestrator's regenerate net stays for providers
  that ignore `pattern`; its answer is unwrapped because the regeneration shares the JSON-demanding
  system prompt. Replies that still code-switch are regenerated by the orchestrator.
- **The automation-config routing bullet in rule 3 needs its HỎI / YÊU CẦU contrast.** Without it the
  model sends "luật/ngưỡng" questions to `get_latest_sensor`, and a draft that only named the tools
  sent a read question ("ngưỡng … đang là bao nhiêu?") to `set_device_config`.
- **The routing bullet keeps its "Hỏi kiến thức trồng trọt … → reply" clause.** The `get_device_config`
  example pulled "giữ nhiệt độ bao nhiêu?" questions onto the tool. Keep that clause in
  [prompt.ts](src/llm/prompt.ts) when the routing bullet is edited.
- **No few-shot example may answer a diagnosis.** The 3B reused Ví dụ 6's "thán thư (Colletotrichum
  spp.)" for gray mold, powdery mildew and bacterial leaf spot, with the right `[bệnh]` entry ranked
  first. Keep diagnosis examples out of every set in [fewshot.ts](src/domain/fewshot.ts).

### Profile drives both thresholds and RAG

[src/domain/profiles.ts](src/domain/profiles.ts): a plant profile JSON in
[src/domain/knowledge/](src/domain/knowledge/) has two roles. **Numeric ranges** (`soil_moisture_range`
etc.) → `deriveControlThresholds` + `summarizeRanges` → injected into the system prompt, and are the
reason a strawberry gets 75–80% target moisture instead of the MCP's generic 30% default. **Text
fields** (`care_notes`, `watering`, `diseases`…) are chunked + embedded for RAG. The prompt rule is:
if sources conflict with the numeric optimal ranges, the ranges win.

**Adding a plant**: drop `src/domain/knowledge/<plant>.json` (validated by `PlantProfileSchema`) and
set `DEFAULT_PLANT=<plant>`. That runs with no code change, but on a format-only neutral few-shot set
(init logs a warning). For real use also add a per-plant set to `BY_PLANT` in
[src/domain/fewshot.ts](src/domain/fewshot.ts): the 3B copies the examples' advice and actions, so
another plant's set teaches the wrong care (strawberry's "bật đèn" would ruin bean sprouts, which
grow in the dark). Keep the message-before-tool field order in every set.

### RAG pipeline (human-review gate)

Retrieval is a brute-force in-memory cosine store ([src/rag/store.ts](src/rag/store.ts)) — fine for a
few hundred curated chunks, zero native deps. Data gets in three ways, all ingested at init:
1. The plant profile ([src/rag/ingest.ts](src/rag/ingest.ts)) and disease KB
   ([src/rag/ingestDiseases.ts](src/rag/ingestDiseases.ts)) — curated JSON, always loaded.
2. Reviewed source docs from `data/docs/*.jsonl` ([src/rag/ingestDocs.ts](src/rag/ingestDocs.ts)).

The scrape → review → ingest flow is deliberate: `npm run scrape [plant]` writes **raw** records to
`data/staging/<plant>-docs.raw.jsonl`, a **human trims/reviews** them, then copies good records into
`data/docs/`. Nothing scraped touches the store automatically. HTML goes through a self-hosted
Crawl4AI (`docker compose --profile scrape up -d crawl4ai`, needs `CRAWL4AI_API_TOKEN`; falls back to
cheerio when it is down). Sources marked `pdf` in [sources.ts](src/rag/scrape/sources.ts) are
downloaded once into `data/pdf/<plant>/` (committed) and read with opendataloader-pdf, which needs
Java 11+. Both paths fix the degree sign (`30oC`, and the PDF `300C` artifact for `30⁰C`) before staging. Embeddings are cached on disk
([src/rag/embedCache.ts](src/rag/embedCache.ts)) and near-duplicates are dropped
([src/rag/dedupe.ts](src/rag/dedupe.ts)). All sources are Vietnamese, and `bge-m3` handles Vietnamese queries well. Retrieval embeds the current message plus (when a previous user turn exists) `previous + current` in one call, merges hits by max score, drops hits more than `RAG_REL_MARGIN` (default 0.15) below the best (bge-m3 scores are compressed on a single-topic corpus, so the margin only trims the tail when one hit stands out; a few queries return 2–3 chunks), then picks the final top-K (`RAG_TOP_K`, default 4) with MMR (`RAG_MMR_LAMBDA`, default 0.7; 1 = plain top-K). `RAG_MIN_SCORE` (default 0) is the absolute cosine floor — calibrate it from the score distribution `npm run eval` prints; BM25 + reciprocal rank fusion is on by default (`RAG_HYBRID=0` = dense only). An embed failure at query time degrades to no RAG context for that turn. The embed cache is keyed by sha256 and pruned to the entries of the current build. The shared builder is `ingestAll`
([src/rag/buildStore.ts](src/rag/buildStore.ts)), used by both init and the runtime
`POST /api/setup/rag/rebuild` (edit a profile / drop docs into `data/docs/`, then rebuild — no restart).

### LLM provider abstraction

[src/llm/index.ts](src/llm/index.ts) `OpenAICompatEngine` is a single OpenAI-SDK-backed engine that
serves LM Studio, Ollama, Gemini (OpenAI-compat layer), and any OpenAI-compatible server.
[src/llm/providers.ts](src/llm/providers.ts) `PROVIDERS` only carries per-provider presets (default
base URL, whether an API key is required, display copy). It relies on `response_format: json_schema`
for structured decisions — providers must support it, including string `pattern` (the `message`
allow-list). LM Studio is verified. The Gemini check is still open: with a Gemini key, confirm once
that its OpenAI-compatible layer accepts the `pattern` keyword, since a rejected schema fails every
chat; drop `pattern` for that provider if it does not. `LlmEngine` also has streaming twins
(`completeStream`/`completeJsonStream`, `stream: true` + optional `AbortSignal`) used only by the
SSE path; a provider that buffers structured output despite `stream: true` degrades gracefully to
one big token frame.

### HTTP surface

[src/http/server.ts](src/http/server.ts) wires CORS (`@fastify/cors`, reflective origin — browser
chat apps POST from other origins), Swagger UI at `/docs`, then registers setup + chat routes.
Endpoints: `POST /chat/stream` (SSE) ([routes.chat.ts](src/http/routes.chat.ts)), the
OpenAI-compatible `POST /v1/chat/completions` + `GET /v1/models`
([routes.openai.ts](src/http/routes.openai.ts)) — **stateful**: keys the persistent `SessionStore` on
`(body.user ?? 'openai', body.session_id)`, minting a `uuidv4` when `session_id` is absent and returning
it via the `X-Session-Id` response header (a brand-new session is seeded from the caller's `messages[]`,
so legacy full-history clients still work; control confirmations live server-side — a later "có"/"không"
runs them, no `tool_calls` echo needed) — the `/setup` UI + `/api/setup/*`
([routes.setup.ts](src/http/routes.setup.ts)), `GET /health`. `POST /api/setup/rag/rebuild`
re-ingests the RAG store at runtime and hot-swaps store+profile into the live orchestrator
(synchronous; **build-then-swap** — a failed ingest keeps the old store; MCP/LLM/sessions untouched;
503 not_configured / 409 busy|rag_disabled / 502 embed_failed).
Before config completes, the chat endpoints return **503 `{error:"not_configured"}`**. Validation uses Zod DTOs
([src/http/dto.ts](src/http/dto.ts)) with `attachValidation: true` so failures return the
`{error:"invalid_request", details}` envelope rather than Fastify's default.

`POST /chat/stream` is the streaming chat endpoint (body `{userId, sessionId, message}`): the reply
arrives as SSE frames (`token`/`tool_status`/`reset`/`done`/`error` — contract documented on the
route's Swagger description). It rides `Orchestrator.handleChatStream`, which shares one event-generator core with
the buffered path; the decision JSON is scanned incrementally
([src/agent/streamParser.ts](src/agent/streamParser.ts)) so only the `message` field streams out —
`reasoning` and tool calls never reach the wire, and no token is emitted before the decision `type`
is known. The buffered path (`Orchestrator.handleChat`, used by non-stream `/v1/chat/completions`)
still uses the non-streaming LLM calls (provider behavior unchanged).
Pre-stream failures (400/503) stay plain JSON; smoke-test streaming with
`curl -N -X POST localhost:8787/chat/stream -H 'content-type: application/json' -d '{"userId":"u1","sessionId":"s1","message":"..."}'`.

## Testing conventions

Tests run with **no external services** because the app is built around DI seams: `LlmEngine`,
`McpGateway` ([src/mcp/client.ts](src/mcp/client.ts)), and `SetupDeps`
([src/setup/init.ts](src/setup/init.ts)) are all interfaces with production impls and test fakes.
When adding a feature that touches the LLM, MCP, or the init pipeline, thread it through the existing
interface rather than newing up a concrete class, so it stays fakeable. `npm run eval` (needs a live
LLM) is a separate accuracy measurement, not part of `npm test`.
