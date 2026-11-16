export interface ChunkOptions {
  /** Target maximum characters per chunk. */
  size?: number
  /** Characters of trailing sentences repeated at the start of the next chunk. */
  overlap?: number
}

const DEFAULT_SIZE = 600
const DEFAULT_OVERLAP = 80

/** Join length of a word list as a space-separated string. */
function joinedLen(words: string[]): number {
  return words.length === 0 ? 0 : words.reduce((n, w) => n + w.length, 0) + (words.length - 1)
}

/** Trailing items of a chunk totalling up to `overlap` chars, kept in order. */
function overlapTail(items: string[], overlap: number): string[] {
  if (overlap <= 0) return []
  const tail: string[] = []
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]
    if (it === undefined) continue
    if (joinedLen([it, ...tail]) > overlap) break
    tail.unshift(it)
  }
  return tail
}

/** Sentences split on . ! ? ; and newlines; a dot inside a number ("5.5") never splits. */
function splitSentences(text: string): string[] {
  return text
    .split(/\n+/)
    .flatMap((line) => line.split(/(?<=[.!?;])\s+/))
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter((s) => s.length > 0)
}

/** Pack the words of one over-long sentence into word-boundary chunks with word overlap. */
function splitByWords(sentence: string, size: number, overlap: number): string[] {
  const chunks: string[] = []
  let cur: string[] = []
  for (const w of sentence.split(' ')) {
    if (joinedLen([...cur, w]) > size && cur.length > 0) {
      chunks.push(cur.join(' '))
      cur = [...overlapTail(cur, overlap), w]
    } else {
      cur.push(w)
    }
  }
  if (cur.length > 0) chunks.push(cur.join(' '))
  return chunks
}

interface Draft {
  sents: string[]
  /** Index where this chunk's own sentences begin (before it: overlap copied from the previous chunk). */
  ownStart: number
  /** Produced by word-splitting a single long sentence. */
  wordSplit: boolean
}

/**
 * Split free-form document text into chunks suitable for embedding. Whole
 * sentences are packed up to `size` chars and each new chunk repeats up to
 * `overlap` chars of trailing sentences from the previous one. A sentence longer
 * than `size` is split at word boundaries; a trailing chunk whose own content is
 * under a third of `size` is merged into its predecessor (which may then exceed
 * `size`) rather than emitted as a mostly-overlap fragment. `overlap` is clamped
 * below half of `size` so packing always makes progress.
 */
export function chunkDocument(text: string, opts: ChunkOptions = {}): string[] {
  const size = opts.size ?? DEFAULT_SIZE
  const overlap = Math.max(0, Math.min(opts.overlap ?? DEFAULT_OVERLAP, Math.ceil(size / 2) - 1))
  const norm = text.replace(/\s+/g, ' ').trim()
  if (norm.length === 0) return []
  if (norm.length <= size) return [norm]

  const drafts: Draft[] = []
  let cur: Draft = { sents: [], ownStart: 0, wordSplit: false }
  const flush = () => {
    if (cur.sents.length > cur.ownStart) drafts.push(cur)
    cur = { sents: [], ownStart: 0, wordSplit: false }
  }

  for (const s of splitSentences(text)) {
    if (s.length > size) {
      flush()
      for (const piece of splitByWords(s, size, overlap)) {
        drafts.push({ sents: [piece], ownStart: 0, wordSplit: true })
      }
      continue
    }
    if (cur.sents.length > cur.ownStart && joinedLen([...cur.sents, s]) > size) {
      const tail = overlapTail(cur.sents, overlap)
      while (tail.length > 0 && joinedLen([...tail, s]) > size) tail.shift()
      flush()
      cur = { sents: [...tail], ownStart: tail.length, wordSplit: false }
    }
    cur.sents.push(s)
  }
  flush()

  const last = drafts[drafts.length - 1]
  const prev = drafts[drafts.length - 2]
  if (last && prev && !last.wordSplit && !prev.wordSplit) {
    const own = last.sents.slice(last.ownStart)
    if (joinedLen(own) < size / 3) {
      prev.sents.push(...own)
      drafts.pop()
    }
  }
  return drafts.map((d) => d.sents.join(' '))
}

/** Drop chunks whose trimmed length is below `minLen` (boilerplate / fragments). */
export function dropShortChunks(chunks: string[], minLen = 40): string[] {
  return chunks.filter((c) => c.trim().length >= minLen)
}
