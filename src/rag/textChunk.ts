export interface ChunkOptions {
  /** Target maximum characters per chunk. */
  size?: number
  /** Characters of trailing context repeated at the start of the next chunk. */
  overlap?: number
}

const DEFAULT_SIZE = 600
const DEFAULT_OVERLAP = 80

/** Join length of a word list as a space-separated string. */
function joinedLen(words: string[]): number {
  return words.length === 0 ? 0 : words.reduce((n, w) => n + w.length, 0) + (words.length - 1)
}

/** Trailing words of a chunk totalling up to `overlap` chars, kept in order. */
function overlapTail(words: string[], overlap: number): string[] {
  if (overlap <= 0) return []
  const tail: string[] = []
  for (let i = words.length - 1; i >= 0; i--) {
    const w = words[i]
    if (w === undefined) continue
    const next = [w, ...tail]
    if (joinedLen(next) > overlap) break
    tail.unshift(w)
  }
  return tail
}

/**
 * Split free-form document text into overlapping, word-boundary chunks suitable
 * for embedding. Whitespace is normalized; chunks stay at or under `size` chars
 * (a lone word longer than `size` becomes its own oversized chunk), and each new
 * chunk repeats up to `overlap` chars of the previous one so context is not lost
 * at the seam.
 */
export function chunkDocument(text: string, opts: ChunkOptions = {}): string[] {
  const size = opts.size ?? DEFAULT_SIZE
  const overlap = opts.overlap ?? DEFAULT_OVERLAP
  const norm = text.replace(/\s+/g, ' ').trim()
  if (norm.length === 0) return []
  if (norm.length <= size) return [norm]

  const words = norm.split(' ')
  const chunks: string[] = []
  let cur: string[] = []

  for (const w of words) {
    const wouldExceed = joinedLen([...cur, w]) > size
    if (wouldExceed && cur.length > 0) {
      chunks.push(cur.join(' '))
      cur = [...overlapTail(cur, overlap), w]
    } else {
      cur.push(w)
    }
  }
  if (cur.length > 0) chunks.push(cur.join(' '))
  return chunks
}

/** Drop chunks whose trimmed length is below `minLen` (boilerplate / fragments). */
export function dropShortChunks(chunks: string[], minLen = 40): string[] {
  return chunks.filter((c) => c.trim().length >= minLen)
}
