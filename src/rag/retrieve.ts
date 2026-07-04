import type { LlmEngine } from '../llm'
import type { InMemoryVectorStore } from './store'

export interface RetrievedChunk {
  text: string
  score: number
  /** Profile field name, when the chunk came from the curated plant profile. */
  field?: string
  /** Content category for scraped docs: grow | uses | disease | price | ... */
  category?: string
  /** Source URL for scraped docs, so answers can cite where a claim came from. */
  source?: string
}

export interface RetrievedContext {
  chunks: RetrievedChunk[]
  contextText: string
}

/** Build a labelled context block: each chunk prefixed with its category/source. */
export function formatContextText(chunks: RetrievedChunk[]): string {
  return chunks
    .map((c) => {
      const label = c.category ?? c.field ?? 'kb'
      const src = c.source ? ` · nguồn: ${c.source}` : ''
      return `[${label}${src}] ${c.text}`
    })
    .join('\n\n')
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

/**
 * Embed the query and return the top-k most similar knowledge chunks. `minScore`
 * drops hits below that cosine score; 0 (default) keeps all top-K — including
 * negative-scored ones, matching the pre-threshold behavior.
 */
export async function retrieve(
  store: InMemoryVectorStore,
  llm: LlmEngine,
  query: string,
  topK: number,
  minScore = 0,
): Promise<RetrievedContext> {
  if (store.size() === 0 || query.trim().length === 0) {
    return { chunks: [], contextText: '' }
  }
  const [queryEmbedding] = await llm.embed([query])
  if (!queryEmbedding) return { chunks: [], contextText: '' }

  const storeDim = store.dim()
  if (storeDim !== null && queryEmbedding.length !== storeDim) {
    console.warn(
      `[rag] chiều embedding truy vấn (${queryEmbedding.length}) khác chiều của store (${storeDim}) — ` +
        'retrieval sẽ trả về rỗng. Kiểm tra embed model / xóa cache cũ tại data/cache/embeddings.jsonl.',
    )
  }

  const hits = store.search(queryEmbedding, topK).filter((h) => minScore <= 0 || h.score >= minScore)
  const chunks: RetrievedChunk[] = hits.map((h) => ({
    text: h.text,
    score: h.score,
    field: str(h.metadata?.field),
    category: str(h.metadata?.category),
    source: str(h.metadata?.source_url),
  }))
  return { chunks, contextText: formatContextText(chunks) }
}
