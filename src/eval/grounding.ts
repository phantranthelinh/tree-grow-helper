/**
 * Deterministic grounding checks for eval answer text. These are heuristics, not
 * proofs — they catch the failure modes the small model actually exhibits
 * (fabricated numbers, missing citations, ignoring the curated ranges) without an
 * LLM judge, so the grader itself runs in CI. The live-model grounding score is
 * measured by src/eval/run.ts, which applies these to real replies.
 */

export interface EvalGrounding {
  /** Reply must name a known KB source (see hasCitation). */
  requireCitation?: boolean
  /** Every string must appear in the reply (whitespace- and case-insensitive). */
  mustInclude?: string[]
  /** At least one must appear — for synonyms or either bound of a range. */
  mustIncludeAny?: string[]
  /** None may appear — fabricated numbers or wrong claims the model tends to emit. */
  forbid?: string[]
}

/**
 * Source markers found across the curated Vietnamese KB (profile `sources[]`).
 * A reply "cites" when it names one of these. `nguồn` covers an explicit
 * "nguồn: ..." / "theo nguồn ...".
 */
const SOURCE_MARKERS = [
  'khuyến nông',
  'vaas',
  'vista',
  'nasati',
  'bvtv',
  'chi cục',
  'tạp chí',
  'smart farm',
  'mard',
  'techport',
  '.gov.vn',
  '.edu.vn',
  'nguồn',
]

/** Lowercase + collapse whitespace to a single space. */
function normalize(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim()
}

/** Whitespace-insensitive containment so "30 %" matches "30%" and "mốc  xám" matches "mốc xám". */
function contains(haystack: string, needle: string): boolean {
  const strip = (s: string) => normalize(s).replace(/ /g, '')
  return strip(haystack).includes(strip(needle))
}

/**
 * A reply cites when it names a known KB source marker. Deliberately does NOT
 * match a bare "theo" — Vietnamese uses "theo dõi" / "theo mùa" / "tưới theo nhu
 * cầu" constantly, which would false-positive citation everywhere.
 */
export function hasCitation(text: string): boolean {
  const t = normalize(text)
  return SOURCE_MARKERS.some((m) => t.includes(m))
}

export interface GroundingResult {
  pass: boolean
  reasons: string[]
}

/** Grade a reply's text against grounding expectations. No expectations → pass. */
export function gradeGrounding(g: EvalGrounding, message: string): GroundingResult {
  const reasons: string[] = []
  if (g.requireCitation && !hasCitation(message)) {
    reasons.push('thiếu trích dẫn nguồn')
  }
  for (const need of g.mustInclude ?? []) {
    if (!contains(message, need)) reasons.push(`thiếu "${need}"`)
  }
  if (g.mustIncludeAny && g.mustIncludeAny.length > 0) {
    if (!g.mustIncludeAny.some((n) => contains(message, n))) {
      reasons.push(`thiếu tất cả [${g.mustIncludeAny.join(', ')}]`)
    }
  }
  for (const bad of g.forbid ?? []) {
    if (contains(message, bad)) reasons.push(`chứa nội dung cấm "${bad}"`)
  }
  return { pass: reasons.length === 0, reasons }
}
