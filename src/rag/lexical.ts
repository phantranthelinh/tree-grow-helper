/** Lowercased tokens split on anything that is not a letter or digit; Vietnamese diacritics are kept. */
export function tokenize(text: string): string[] {
  return text
    .normalize('NFC')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 0)
}

/** Minimal BM25 index over a fixed list of documents. */
export class Bm25Index {
  private readonly docs: Array<Map<string, number>>
  private readonly lens: number[]
  private readonly df = new Map<string, number>()
  private readonly avgLen: number

  constructor(texts: string[], private readonly k1 = 1.5, private readonly b = 0.75) {
    this.docs = texts.map((t) => {
      const tf = new Map<string, number>()
      for (const tok of tokenize(t)) tf.set(tok, (tf.get(tok) ?? 0) + 1)
      return tf
    })
    this.lens = this.docs.map((tf) => [...tf.values()].reduce((a, c) => a + c, 0))
    for (const tf of this.docs) for (const tok of tf.keys()) this.df.set(tok, (this.df.get(tok) ?? 0) + 1)
    this.avgLen = this.lens.length === 0 ? 0 : this.lens.reduce((a, c) => a + c, 0) / this.lens.length
  }

  /** BM25 score of every document for `query` (0 when no query term occurs). */
  scores(query: string): number[] {
    const n = this.docs.length
    const terms = [...new Set(tokenize(query))]
    return this.docs.map((tf, i) => {
      let score = 0
      for (const term of terms) {
        const f = tf.get(term)
        if (!f) continue
        const df = this.df.get(term) ?? 0
        const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5))
        const norm = 1 - this.b + (this.b * (this.lens[i] ?? 0)) / (this.avgLen || 1)
        score += (idf * f * (this.k1 + 1)) / (f + this.k1 * norm)
      }
      return score
    })
  }
}
