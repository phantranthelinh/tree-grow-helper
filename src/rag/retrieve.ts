import type { LlmEngine } from '../llm'
import { CATEGORY_LABELS_VI, FIELD_LABELS_VI } from './labels'
import { Bm25Index } from './lexical'
import { cosineSimilarity, type InMemoryVectorStore, type ScoredRecord } from './store'

export interface RetrievedChunk {
  /** Store record id (`<plant>:<field>#<i>`, `disease:<id>`, `<url>#<i>`). */
  id?: string
  text: string
  /** Cosine score (max over the query variants). */
  score: number
  /** Profile field name, when the chunk came from the curated plant profile. */
  field?: string
  /** Content category for scraped docs: grow | uses | disease | price | ... */
  category?: string
  /** Source URL, so answers can cite where a claim came from. */
  source?: string
}

export interface RetrievedContext {
  chunks: RetrievedChunk[]
  contextText: string
}

export interface RetrieveOptions {
  /** Previous user message; its concatenation with the query is searched as a second variant. */
  prevQuery?: string
  /** Drop hits scoring below top1 - margin. 0 or negative = off. */
  relMargin?: number
  /** MMR relevance weight over a topK*3 pool. >= 1 = plain top-K. */
  mmrLambda?: number
  /** Fuse BM25 ranking with the dense ranking (reciprocal rank fusion). */
  hybrid?: boolean
}

const LEADING_LABEL = /^\[([^\]]+)\]\s*/
const RRF_K = 60
const MMR_POOL_FACTOR = 3

/**
 * Build a labelled context block. Each chunk shows exactly one label: the one its
 * text already starts with (profile fields, diseases), else its field/category.
 */
export function formatContextText(chunks: RetrievedChunk[]): string {
  return chunks
    .map((c) => {
      const m = LEADING_LABEL.exec(c.text)
      const body = m ? c.text.slice(m[0].length) : c.text
      const label =
        m?.[1] ??
        (c.field ? FIELD_LABELS_VI[c.field] : undefined) ??
        (c.category ? (CATEGORY_LABELS_VI[c.category] ?? c.category) : undefined) ??
        c.field ??
        'kb'
      const src = c.source ? ` · nguồn: ${c.source}` : ''
      return `[${label}${src}] ${body}`
    })
    .join('\n\n')
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

interface Candidate {
  rec: ScoredRecord
  /** Relevance used by MMR, 0..1. */
  rel: number
}

function mmrSelect(cands: Candidate[], k: number, lambda: number): Candidate[] {
  const selected: Candidate[] = []
  const rest = [...cands]
  while (selected.length < k && rest.length > 0) {
    let bestIdx = 0
    let bestVal = -Infinity
    rest.forEach((c, i) => {
      const sim = selected.reduce((m, s) => Math.max(m, cosineSimilarity(c.rec.embedding, s.rec.embedding)), 0)
      const val = selected.length === 0 ? c.rel : lambda * c.rel - (1 - lambda) * sim
      if (val > bestVal) {
        bestVal = val
        bestIdx = i
      }
    })
    selected.push(rest.splice(bestIdx, 1)[0] as Candidate)
  }
  return selected
}

/**
 * Embed the query (and, when given, previous-turn + query) in one call and return
 * the most relevant knowledge chunks. Scores are cosine; `minScore` drops hits
 * below it (0 = off, keeps even negative-scored hits), `relMargin` drops hits
 * trailing the best one by more than the margin, and MMR diversifies the final
 * top-K. A query/store dimension mismatch yields an empty context.
 */
export async function retrieve(
  store: InMemoryVectorStore,
  llm: LlmEngine,
  query: string,
  topK: number,
  minScore = 0,
  opts: RetrieveOptions = {},
): Promise<RetrievedContext> {
  const empty: RetrievedContext = { chunks: [], contextText: '' }
  if (store.size() === 0 || query.trim().length === 0 || topK <= 0) return empty

  const prev = opts.prevQuery?.trim()
  const variants = prev ? [query, `${prev} ${query}`] : [query]
  const vectors = await llm.embed(variants)
  if (vectors.length === 0 || vectors.some((v) => !v || v.length === 0)) return empty

  const storeDim = store.dim()
  if (storeDim !== null && vectors.some((v) => v.length !== storeDim)) {
    console.warn(
      `[rag] chiều embedding truy vấn (${vectors[0]?.length}) khác chiều của store (${storeDim}) — ` +
        'bỏ qua retrieval. Kiểm tra embed model / xóa cache cũ tại data/cache/embeddings.jsonl.',
    )
    return empty
  }

  const records = store.all()
  const dense = new Map<string, ScoredRecord>()
  for (const v of vectors) {
    for (const hit of store.search(v, records.length)) {
      const seen = dense.get(hit.id)
      if (!seen || hit.score > seen.score) dense.set(hit.id, hit)
    }
  }
  const byScore = [...dense.values()].sort((a, b) => b.score - a.score)
  // Anchored to the current message alone: after a topic change the prev+query
  // variant can outscore it on old-topic chunks, and the margin would then drop
  // the hits that actually answer this turn.
  const top1 = store.search(vectors[0] as number[], 1)[0]?.score ?? 0

  let ordered: Candidate[]
  if (opts.hybrid) {
    const bm25 = new Bm25Index(records.map((r) => r.text))
    const lexScores = records.map(() => 0)
    for (const q of variants) bm25.scores(q).forEach((s, i) => (lexScores[i] = Math.max(lexScores[i] ?? 0, s)))
    const lexRank = new Map<string, number>()
    records
      .map((r, i) => ({ id: r.id, s: lexScores[i] ?? 0 }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .forEach((x, rank) => lexRank.set(x.id, rank))
    const fused = byScore.map((rec, rank) => {
      const lr = lexRank.get(rec.id)
      return { rec, f: 1 / (RRF_K + rank + 1) + (lr === undefined ? 0 : 1 / (RRF_K + lr + 1)) }
    })
    fused.sort((a, b) => b.f - a.f)
    const maxF = fused[0]?.f ?? 1
    ordered = fused.map((x) => ({ rec: x.rec, rel: x.f / maxF }))
  } else {
    ordered = byScore.map((rec) => ({ rec, rel: rec.score }))
  }

  const margin = opts.relMargin ?? 0
  const lambda = opts.mmrLambda ?? 1
  const gated = ordered.filter(
    (c) => (minScore <= 0 || c.rec.score >= minScore) && (margin <= 0 || c.rec.score >= top1 - margin),
  )
  const useMmr = lambda < 1
  const pool = gated.slice(0, useMmr ? topK * MMR_POOL_FACTOR : topK)
  const picked = useMmr ? mmrSelect(pool, topK, Math.max(0, lambda)) : pool

  const chunks: RetrievedChunk[] = picked.map(({ rec: h }) => ({
    id: h.id,
    text: h.text,
    score: h.score,
    field: str(h.metadata?.field),
    category: str(h.metadata?.category),
    source: str(h.metadata?.source_url),
  }))
  return { chunks, contextText: formatContextText(chunks) }
}
