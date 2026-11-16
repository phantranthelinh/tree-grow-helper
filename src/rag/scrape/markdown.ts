const REFERENCES_HEADING = /^(TÀI LIỆU THAM KHẢO|REFERENCES)$/iu

/**
 * Turn crawler/PDF markdown into plain prose for review and chunking.
 *
 * Emphasis markers are removed rather than rendered because Word-pasted
 * .gov.vn pages split single words across bold spans (`**c****họn**`), and the
 * markers would otherwise stay inside the embedded text. Everything from the
 * last "TÀI LIỆU THAM KHẢO" / "REFERENCES" heading on is dropped: in journal
 * papers that is a citation list with no growing knowledge in it.
 */
export function cleanMarkdown(md: string): string {
  const lines = md
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\*\*|__/g, '')
    .split('\n')
    .map((l) => l.replace(/^#{1,6}\s+/, '').replace(/[ \t]+/g, ' ').trim())

  let cut = -1
  lines.forEach((l, i) => {
    if (REFERENCES_HEADING.test(l)) cut = i
  })
  const kept = cut > 0 ? lines.slice(0, cut) : lines
  return normalizeDegrees(kept.join('\n').replace(/\n{3,}/g, '\n\n').trim())
}

/** Vietnamese documents often type the degree sign as a letter: "30oC" → "30°C". */
export function normalizeDegrees(text: string): string {
  return text.replace(/(\d)\s?oC\b/g, '$1°C')
}

/**
 * PDF extraction turns a superscript-zero degree sign into a plain digit, so
 * "30⁰C" reads "300C" — which a model takes for 300 °C. Only numbers of three or
 * more digits ending in 0 are rewritten (300C → 30°C, 1000C → 100°C): a two-digit
 * "30C" is left alone, since it is more likely a real 30 °C typed without a sign.
 */
export function fixPdfDegrees(text: string): string {
  return text.replace(/\b(\d{2,})0\s?C\b/g, '$1°C')
}

/** First markdown heading, used as a record title when the source has no better one. */
export function firstHeading(md: string): string | null {
  const m = /^#{1,6}\s+(.+)$/m.exec(md)
  return m?.[1]?.replace(/\*\*|__/g, '').trim() || null
}
