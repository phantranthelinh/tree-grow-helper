import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** Minimal engine surface needed for embedding (matches LlmEngine.embed). */
export interface Embedder {
  embed(texts: string[]): Promise<number[][]>
}

export type EmbedCache = Map<string, number[]>

/** Stable non-cryptographic hash (FNV-1a, hex) used to key embeddings by content. */
export function hashText(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16)
}

/**
 * Embed `texts`, reusing any cached vector keyed by content hash and only sending
 * cache-misses to the engine. Results stay aligned to the input order; `cache` is
 * mutated in place with the newly embedded vectors.
 */
export async function embedWithCache(
  llm: Embedder,
  texts: string[],
  cache: EmbedCache,
): Promise<number[][]> {
  const misses = texts.filter((t) => !cache.has(hashText(t)))
  if (misses.length > 0) {
    const fresh = await llm.embed(misses)
    misses.forEach((t, i) => {
      const emb = fresh[i]
      if (emb) cache.set(hashText(t), emb)
    })
  }
  return texts.map((t) => cache.get(hashText(t)) ?? [])
}

/** Load a content-hash → embedding cache from a JSONL file (empty if absent). */
export function loadEmbedCache(path: string): EmbedCache {
  const cache: EmbedCache = new Map()
  if (!existsSync(path)) return cache
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const { hash, embedding } = JSON.parse(trimmed) as { hash: string; embedding: number[] }
    cache.set(hash, embedding)
  }
  return cache
}

/** Persist the embedding cache as JSONL, creating the parent directory if needed. */
export function saveEmbedCache(path: string, cache: EmbedCache): void {
  mkdirSync(dirname(path), { recursive: true })
  const lines = [...cache.entries()].map(([hash, embedding]) => JSON.stringify({ hash, embedding }))
  writeFileSync(path, lines.join('\n') + '\n', 'utf8')
}
