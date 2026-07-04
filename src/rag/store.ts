export interface VectorRecord {
  id: string
  text: string
  embedding: number[]
  metadata?: Record<string, unknown>
}

export type ScoredRecord = VectorRecord & { score: number }

/** Cosine similarity; returns 0 for mismatched lengths or zero vectors. */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    const x = a[i] as number
    const y = b[i] as number
    dot += x * y
    na += x * x
    nb += y * y
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

/**
 * Tiny brute-force cosine vector store. Fine for the curated per-plant KB
 * (a few hundred chunks) and has zero native dependencies.
 */
export class InMemoryVectorStore {
  private records: VectorRecord[] = []

  add(records: VectorRecord[]): void {
    this.records.push(...records)
  }

  size(): number {
    return this.records.length
  }

  /** Embedding dimension of the store (from the first record), or null if empty. */
  dim(): number | null {
    return this.records[0]?.embedding.length ?? null
  }

  /**
   * True if every record shares one embedding dimension (or the store is empty).
   * A false result means mixed-dimension vectors — cosine scores them 0, so
   * some chunks are silently unretrievable (usually a stale embed cache).
   */
  uniformDims(): boolean {
    const first = this.records[0]
    if (!first) return true
    const d = first.embedding.length
    return this.records.every((r) => r.embedding.length === d)
  }

  clear(): void {
    this.records = []
  }

  search(queryEmbedding: number[], topK: number): ScoredRecord[] {
    return this.records
      .map((r) => ({ ...r, score: cosineSimilarity(queryEmbedding, r.embedding) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(0, topK))
  }
}
