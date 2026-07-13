import 'dotenv/config'
import type { ProviderId } from './llm/providers'

function num(value: string | undefined, fallback: number): number {
  const n = value !== undefined ? Number(value) : NaN
  return Number.isFinite(n) ? n : fallback
}

export const config = {
  port: num(process.env.PORT, 8787),
  // Defaults used ONLY to prefill the setup form — never to auto-connect.
  llmDefaults: {
    provider: (process.env.LLM_PROVIDER ?? 'lmstudio') as ProviderId,
    baseURL: process.env.LMSTUDIO_BASE_URL ?? 'http://localhost:1234/v1',
    apiKey: process.env.LMSTUDIO_API_KEY ?? 'lm-studio',
    model: process.env.MODEL ?? 'qwen2.5-3b-instruct',
    embedModel: process.env.EMBED_MODEL ?? 'text-embedding-bge-m3',
  },
  setup: {
    configPath: process.env.LLM_CONFIG_PATH ?? 'data/llm-config.json',
    probeTimeoutMs: num(process.env.SETUP_PROBE_TIMEOUT_MS, 10_000),
    openBrowser: process.env.SETUP_OPEN_BROWSER !== '0',
  },
  mcp: {
    // Like llmDefaults: `url` only prefills the setup form / is the fallback when
    // no saved config exists. The saved data/mcp-config.json wins once written.
    url: process.env.MCP_URL ?? 'http://localhost:8000/mcp',
    configPath: process.env.MCP_CONFIG_PATH ?? 'data/mcp-config.json',
  },
  agent: {
    maxToolSteps: num(process.env.MAX_TOOL_STEPS, 3),
  },
  llm: {
    // Sampling temperatures. Low for the JSON decision (consistency/citation
    // discipline), higher for the free-text fallback answer. Defaults match the
    // previous hardcoded engine values, so behavior is unchanged unless overridden.
    decisionTemp: num(process.env.LLM_DECISION_TEMP, 0.1),
    replyTemp: num(process.env.LLM_REPLY_TEMP, 0.3),
  },
  rag: {
    // RAG_DISABLED=1 skips building the vector store at init — the model then
    // answers from the system prompt alone (no [Tri thức tham khảo] block), so you
    // can A/B whether it stays accurate without the knowledge base.
    disabled: process.env.RAG_DISABLED === '1',
    topK: num(process.env.RAG_TOP_K, 5),
    // Drop retrieved chunks scoring below this cosine threshold. Default 0 = OFF
    // (keep all top-K, unchanged behavior). Raise (~0.3–0.4 for bge-m3) once the
    // grounding eval shows weak chunks are misleading the small model.
    minScore: num(process.env.RAG_MIN_SCORE, 0),
    docsDir: process.env.RAG_DOCS_DIR ?? 'data/docs',
    stagingDir: process.env.RAG_STAGING_DIR ?? 'data/staging',
    embedCachePath: process.env.RAG_EMBED_CACHE ?? 'data/cache/embeddings.jsonl',
    chunkSize: num(process.env.RAG_CHUNK_SIZE, 600),
    chunkOverlap: num(process.env.RAG_CHUNK_OVERLAP, 80),
    minChunkLen: num(process.env.RAG_MIN_CHUNK_LEN, 60),
  },
  memory: {
    // Session history + pendingAction được ghi ra file này để sống sót qua restart
    // (mount làm volume trong Docker). Mục tiêu 1–5 user; không hỗ trợ đa-instance.
    sessionsPath: process.env.SESSIONS_PATH ?? 'data/sessions.json',
    // pendingAction quá hạn (ms) coi như không còn → tránh confirm nhầm lệnh cũ sau restart.
    pendingTtlMs: num(process.env.PENDING_TTL_MS, 30 * 60 * 1000),
  },
  defaultPlant: process.env.DEFAULT_PLANT ?? 'strawberry',
} as const

export type Config = typeof config
