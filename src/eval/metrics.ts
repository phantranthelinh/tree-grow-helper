/** A string is a one-label group; an array is an any-of group (any listed chunk answers the question). */
export type ChunkLabel = string | string[]

/**
 * A label with `#` is an exact chunk id, so `…2490.html#1` does not match `…2490.html#10`.
 * A label without `#` is a prefix (`strawberry:pests` → `strawberry:pests#0`, `disease:aphid`).
 */
export function matchesLabel(chunkId: string, label: string): boolean {
  return label.includes('#') ? chunkId === label : chunkId.startsWith(label)
}

/** Share of label groups satisfied by at least one retrieved chunk. */
export function chunkRecall(labels: ChunkLabel[], retrievedIds: string[]): number {
  if (labels.length === 0) return 0
  const satisfied = labels.filter((group) =>
    [group].flat().some((label) => retrievedIds.some((id) => matchesLabel(id, label))),
  )
  return satisfied.length / labels.length
}

export interface CaseResult {
  id: string
  set: 'r0' | 'r1'
  want: string
  got: string
  exact: boolean
  safety: boolean
  reply: string | null
  grounding: { pass: boolean; reasons: string[] } | null
  expectChunks: ChunkLabel[] | null
  recall: number | null
  recallGated: number | null
  retrieved: Array<{ id: string; score: number }>
  retrievedUngated: Array<{ id: string; score: number }>
  foreignScript: boolean
  ms: number
  /** The model's own message before the server's notes; `reply` is the text the user is shown. */
  modelReply?: string | null
  /** Grounding of modelReply alone, so a gain from the notes can be told apart from a better answer. */
  groundingModel?: { pass: boolean; reasons: string[] } | null
  /** log p(reply) − log p(tool) at the type token (see typeMargin); null when not measured. */
  typeMargin?: number | null
}

export interface Rate {
  hits: number
  total: number
  rate: number | null
}

export interface EvalSummary {
  exact: Rate
  safety: Rate
  grounding: Rate
  /** Grounding of the model's own text, without the server's notes. */
  groundingModel: Rate
  scriptClean: Rate
  retrieval: {
    annotated: number
    recallUngated: number | null
    recallGated: number | null
    expectedScoreMean: number | null
    otherScoreMean: number | null
    top1AnnotatedMean: number | null
    top1OtherMean: number | null
  }
}

const rate = (hits: number, total: number): Rate => ({ hits, total, rate: total > 0 ? hits / total : null })

/**
 * Aggregates one case set. `exact`/`safety` rates divide by every case (as the round-0 report did);
 * `scriptClean` counts only cases that produced a message, since a failed parse has no text to check.
 */
export function summarize(results: CaseResult[]): EvalSummary {
  const n = results.length
  const grounded = results.filter((r) => r.grounding)
  const groundedModel = results.filter((r) => r.groundingModel)
  const withText = results.filter((r) => r.reply)
  const annotated = results.filter((r) => r.recall !== null)
  const meanOf = (xs: Array<number | null>): number | null => {
    const v = xs.filter((x): x is number => x !== null)
    return v.length > 0 ? v.reduce((a, c) => a + c, 0) / v.length : null
  }
  const expectedScores: number[] = []
  const otherScores: number[] = []
  for (const r of annotated) {
    const labels = (r.expectChunks ?? []).flat()
    for (const h of r.retrievedUngated) {
      ;(labels.some((l) => matchesLabel(h.id, l)) ? expectedScores : otherScores).push(h.score)
    }
  }
  const top1 = (r: CaseResult): number | null =>
    r.retrievedUngated.length > 0 ? Math.max(...r.retrievedUngated.map((h) => h.score)) : null
  return {
    exact: rate(results.filter((r) => r.exact).length, n),
    safety: rate(results.filter((r) => r.safety).length, n),
    grounding: rate(grounded.filter((r) => r.grounding?.pass).length, grounded.length),
    groundingModel: rate(groundedModel.filter((r) => r.groundingModel?.pass).length, groundedModel.length),
    scriptClean: rate(withText.filter((r) => !r.foreignScript).length, withText.length),
    retrieval: {
      annotated: annotated.length,
      recallUngated: meanOf(annotated.map((r) => r.recall)),
      recallGated: meanOf(annotated.map((r) => r.recallGated)),
      expectedScoreMean: meanOf(expectedScores),
      otherScoreMean: meanOf(otherScores),
      top1AnnotatedMean: meanOf(annotated.map(top1)),
      top1OtherMean: meanOf(results.filter((r) => r.recall === null).map(top1)),
    },
  }
}
