import { cosineSimilarity } from './store'

/**
 * Greedily drop near-duplicate items: an item is skipped when its embedding is
 * more similar than `threshold` (cosine) to any item already kept. Order is
 * preserved, so the first occurrence of a duplicated passage wins. Used to stop
 * multiple scraped sources that copy each other from crowding the top-K.
 * `existing` items (e.g. records already in the store) count as already kept.
 */
export function dedupeByEmbedding<T extends { embedding: number[] }>(
  items: T[],
  threshold = 0.95,
  existing: ReadonlyArray<{ embedding: number[] }> = [],
): T[] {
  const kept: T[] = []
  for (const item of items) {
    const isDup =
      existing.some((k) => cosineSimilarity(item.embedding, k.embedding) > threshold) ||
      kept.some((k) => cosineSimilarity(item.embedding, k.embedding) > threshold)
    if (!isDup) kept.push(item)
  }
  return kept
}
