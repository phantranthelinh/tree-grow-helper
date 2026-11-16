import * as cheerio from 'cheerio'

const BOILERPLATE = 'script, style, nav, footer, header, noscript, iframe, svg, form, aside'
const BLOCK = 'p, li, h1, h2, h3, h4, h5, h6, br, div, tr, section, article, blockquote'

const MAIN_CONTAINERS = ['article', 'main', '[itemprop=articleBody]', '.item-page', '.content']
const MIN_CONTAINER_TEXT = 200

/** First common main-content container holding real prose, else the whole <body>. */
function mainContent($: cheerio.CheerioAPI): ReturnType<cheerio.CheerioAPI> {
  for (const sel of MAIN_CONTAINERS) {
    const el = $(sel).first()
    if (el.length > 0 && el.text().replace(/\s+/g, ' ').trim().length >= MIN_CONTAINER_TEXT) return el
  }
  return $('body')
}

/**
 * Extract readable prose from an HTML string: drop scripts/nav/footer boilerplate,
 * separate block elements with whitespace, and normalize. When `selector` is given,
 * only text inside it is returned (target the main content region of a known source);
 * otherwise the first common article container is used before falling back to <body>.
 */
export function extractText(html: string, selector?: string): string {
  const $ = cheerio.load(html)
  $(BOILERPLATE).remove()
  const scope = selector ? $(selector) : mainContent($)
  scope.find(BLOCK).append(' ')
  return scope.text().replace(/\s+/g, ' ').trim()
}

export interface PageMeta {
  title: string | null
  /** Publication date from page metadata (ISO date when parseable), else null. */
  date: string | null
}

/** Title (og:title > h1 > <title>) and publication date from page metadata. */
export function extractMeta(html: string): PageMeta {
  const $ = cheerio.load(html)
  const clean = (v: string | undefined) => v?.replace(/\s+/g, ' ').trim() || null
  const title =
    clean($('meta[property="og:title"]').attr('content')) ??
    clean($('h1').first().text()) ??
    clean($('title').first().text())
  const rawDate =
    clean($('meta[property="article:published_time"]').attr('content')) ??
    clean($('meta[itemprop="datePublished"]').attr('content')) ??
    clean($('[itemprop="datePublished"]').first().attr('datetime')) ??
    clean($('meta[name="pubdate"], meta[name="date"], meta[name="DC.date.issued"]').first().attr('content')) ??
    clean($('time[datetime]').first().attr('datetime'))
  const date = rawDate ? (/^\d{4}-\d{2}-\d{2}/.exec(rawDate)?.[0] ?? null) : null
  return { title, date }
}

export interface FetchResult {
  ok: boolean
  status: number
  html: string
  /** Lowercased Content-Type header ('' when absent or on a network failure). */
  contentType: string
}

/** True unless the server declared a non-HTML type (PDF, image, ...). A missing header counts as HTML. */
export function isHtmlContentType(contentType: string): boolean {
  return contentType === '' || /html|xml/.test(contentType)
}

export const USER_AGENT =
  'ai-server-knowledge-bot/0.1 (+plant RAG; contact: linh.phan@treehousei.com)'

/** Fetch a URL politely (identifying user-agent). Never throws; returns status. */
export async function fetchUrl(url: string): Promise<FetchResult> {
  try {
    const res = await fetch(url, { headers: { 'user-agent': USER_AGENT } })
    const contentType = (res.headers.get('content-type') ?? '').toLowerCase()
    return { ok: res.ok, status: res.status, html: isHtmlContentType(contentType) ? await res.text() : '', contentType }
  } catch {
    return { ok: false, status: 0, html: '', contentType: '' }
  }
}

/** Sleep helper for rate-limiting between requests (be a good web citizen). */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
