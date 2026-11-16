import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { dedupeByEmbedding } from './dedupe'
import { type EmbedCache, type Embedder, embedWithCache } from './embedCache'
import { InMemoryVectorStore, type VectorRecord } from './store'
import { chunkDocument, dropShortChunks } from './textChunk'

/** A reviewed source document (staging output after the human review gate). */
export interface SourceDoc {
  source_url: string
  category: string
  title?: string
  date?: string
  text: string
  plant?: string
}

export interface DocChunk {
  id: string
  text: string
  metadata: Record<string, unknown>
}

export interface IngestDocsOptions {
  plant?: string
  chunkSize?: number
  chunkOverlap?: number
  minChunkLen?: number
  dedupeThreshold?: number
  cache?: EmbedCache
  /** Embed model name; namespaces the cache key so vectors can't cross models. */
  embedModel?: string
}

/**
 * Read reviewed source docs from every .jsonl file in a directory (empty if absent).
 * These files are edited by hand, so a malformed line is skipped with a warning
 * instead of taking down the whole RAG build.
 */
export function readReviewedDocs(dir: string): SourceDoc[] {
  if (!existsSync(dir)) return []
  const docs: SourceDoc[] = []
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.jsonl')) continue
    const lines = readFileSync(join(dir, file), 'utf8').split('\n')
    for (const [idx, line] of lines.entries()) {
      const trimmed = line.trim()
      if (!trimmed) continue
      let obj: Partial<SourceDoc>
      try {
        obj = JSON.parse(trimmed) as Partial<SourceDoc>
      } catch (err) {
        console.warn(`[rag] bỏ qua dòng ${idx + 1} của ${join(dir, file)}: ${(err as Error).message}`)
        continue
      }
      if (
        typeof obj.text === 'string' &&
        typeof obj.source_url === 'string' &&
        typeof obj.category === 'string'
      ) {
        docs.push(obj as SourceDoc)
      }
    }
  }
  return docs
}

/** Chunk each document's text and tag every chunk with source/category metadata. */
export function buildDocChunks(docs: SourceDoc[], opts: IngestDocsOptions = {}): DocChunk[] {
  const chunks: DocChunk[] = []
  for (const doc of docs) {
    const pieces = dropShortChunks(
      chunkDocument(doc.text, { size: opts.chunkSize, overlap: opts.chunkOverlap }),
      opts.minChunkLen,
    )
    pieces.forEach((text, i) => {
      chunks.push({
        id: `${doc.source_url}#${i}`,
        text,
        metadata: {
          plant: doc.plant ?? opts.plant ?? null,
          category: doc.category,
          source_url: doc.source_url,
          title: doc.title ?? null,
          date: doc.date ?? null,
        },
      })
    })
  }
  return chunks
}

/**
 * Ingest reviewed source documents into the vector store: chunk → embed (reusing
 * the on-disk cache) → drop near-duplicates (of each other and of what the store
 * already holds) → add. Returns the number of records
 * actually added. Advisory only — never touches control thresholds.
 */
export async function ingestDocs(
  store: InMemoryVectorStore,
  llm: Embedder,
  docs: SourceDoc[],
  opts: IngestDocsOptions = {},
): Promise<number> {
  const sameCrop = (d: SourceDoc) =>
    !d.plant || !opts.plant || d.plant.trim().toLowerCase() === opts.plant.trim().toLowerCase()
  const scoped = docs.filter(sameCrop)
  if (scoped.length < docs.length) {
    console.warn(`[rag] bỏ qua ${docs.length - scoped.length} tài liệu thuộc cây khác (không phải ${opts.plant}).`)
  }
  const chunks = buildDocChunks(scoped, opts)
  if (chunks.length === 0) return 0

  const cache = opts.cache ?? new Map<string, number[]>()
  const embeddings = await embedWithCache(llm, chunks.map((c) => c.text), cache, opts.embedModel ?? '')

  const withEmbedding = chunks
    .map((c, i) => ({ ...c, embedding: embeddings[i] ?? [] }))
    .filter((c) => c.embedding.length > 0)

  const deduped = dedupeByEmbedding(withEmbedding, opts.dedupeThreshold ?? 0.95, store.all())

  const records: VectorRecord[] = deduped.map((c) => ({
    id: c.id,
    text: c.text,
    embedding: c.embedding,
    metadata: c.metadata,
  }))
  store.add(records)
  return records.length
}
