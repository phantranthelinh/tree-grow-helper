import type { LlmEngine } from '../llm'
import type { InMemoryVectorStore } from './store'

export interface RetrievedChunk {
  text: string
  score: number
  field?: string
}

export interface RetrievedContext {
  chunks: RetrievedChunk[]
  contextText: string
}

/** Embed the query and return the top-k most similar knowledge chunks. */
export async function retrieve(
  store: InMemoryVectorStore,
  llm: LlmEngine,
  query: string,
  topK: number,
): Promise<RetrievedContext> {
  if (store.size() === 0 || query.trim().length === 0) {
    return { chunks: [], contextText: '' }
  }
  const [queryEmbedding] = await llm.embed([query])
  if (!queryEmbedding) return { chunks: [], contextText: '' }

  const hits = store.search(queryEmbedding, topK)
  const chunks: RetrievedChunk[] = hits.map((h) => ({
    text: h.text,
    score: h.score,
    field: typeof h.metadata?.field === 'string' ? h.metadata.field : undefined,
  }))
  return { chunks, contextText: chunks.map((c) => c.text).join('\n\n') }
}
