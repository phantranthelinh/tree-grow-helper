import 'dotenv/config'

function num(value: string | undefined, fallback: number): number {
  const n = value !== undefined ? Number(value) : NaN
  return Number.isFinite(n) ? n : fallback
}

export const config = {
  port: num(process.env.PORT, 8787),
  lmStudio: {
    baseURL: process.env.LMSTUDIO_BASE_URL ?? 'http://localhost:1234/v1',
    apiKey: process.env.LMSTUDIO_API_KEY ?? 'lm-studio',
    model: process.env.MODEL ?? 'qwen2.5-3b-instruct',
    embedModel: process.env.EMBED_MODEL ?? 'text-embedding-bge-m3',
  },
  mcp: {
    url: process.env.MCP_URL ?? 'http://localhost:8000/mcp',
  },
  agent: {
    maxToolSteps: num(process.env.MAX_TOOL_STEPS, 3),
  },
  rag: {
    topK: num(process.env.RAG_TOP_K, 4),
  },
  defaultPlant: process.env.DEFAULT_PLANT ?? 'strawberry',
} as const

export type Config = typeof config
