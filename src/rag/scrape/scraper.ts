import * as cheerio from 'cheerio'

const BOILERPLATE = 'script, style, nav, footer, header, noscript, iframe, svg, form, aside'
const BLOCK = 'p, li, h1, h2, h3, h4, h5, h6, br, div, tr, section, article, blockquote'

/**
 * Extract readable prose from an HTML string: drop scripts/nav/footer boilerplate,
 * separate block elements with whitespace, and normalize. When `selector` is given,
 * only text inside it is returned (target the main content region of a known source).
 */
export function extractText(html: string, selector?: string): string {
  const $ = cheerio.load(html)
  $(BOILERPLATE).remove()
  const scope = selector ? $(selector) : $('body')
  scope.find(BLOCK).append(' ')
  return scope.text().replace(/\s+/g, ' ').trim()
}

export interface FetchResult {
  ok: boolean
  status: number
  html: string
}

const USER_AGENT =
  'ai-server-knowledge-bot/0.1 (+strawberry RAG; contact: linh.phan@treehousei.com)'

/** Fetch a URL politely (identifying user-agent). Never throws; returns status. */
export async function fetchUrl(url: string): Promise<FetchResult> {
  try {
    const res = await fetch(url, { headers: { 'user-agent': USER_AGENT } })
    return { ok: res.ok, status: res.status, html: await res.text() }
  } catch {
    return { ok: false, status: 0, html: '' }
  }
}

/** Sleep helper for rate-limiting between requests (be a good web citizen). */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
