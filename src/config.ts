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
    url: process.env.MCP_URL ?? 'http://localhost:8000/mcp',
  },
  agent: {
    maxToolSteps: num(process.env.MAX_TOOL_STEPS, 3),
  },
  rag: {
    topK: num(process.env.RAG_TOP_K, 5),
    docsDir: process.env.RAG_DOCS_DIR ?? 'data/docs',
    stagingDir: process.env.RAG_STAGING_DIR ?? 'data/staging',
    embedCachePath: process.env.RAG_EMBED_CACHE ?? 'data/cache/embeddings.jsonl',
    chunkSize: num(process.env.RAG_CHUNK_SIZE, 600),
    chunkOverlap: num(process.env.RAG_CHUNK_OVERLAP, 80),
    minChunkLen: num(process.env.RAG_MIN_CHUNK_LEN, 60),
  },
  defaultPlant: process.env.DEFAULT_PLANT ?? 'strawberry',
} as const

export type Config = typeof config
