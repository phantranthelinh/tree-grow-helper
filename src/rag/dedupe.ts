import { cosineSimilarity } from './store'

/**
 * Greedily drop near-duplicate items: an item is skipped when its embedding is
 * more similar than `threshold` (cosine) to any item already kept. Order is
 * preserved, so the first occurrence of a duplicated passage wins. Used to stop
 * multiple scraped sources that copy each other from crowding the top-K.
 */
export function dedupeByEmbedding<T extends { embedding: number[] }>(
  items: T[],
  threshold = 0.95,
): T[] {
  const kept: T[] = []
  for (const item of items) {
    const isDup = kept.some((k) => cosineSimilarity(item.embedding, k.embedding) > threshold)
    if (!isDup) kept.push(item)
  }
  return kept
}
