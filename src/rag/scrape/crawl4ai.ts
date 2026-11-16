export interface CrawledPage {
  /** Raw markdown of the page body (nav/header/footer/aside excluded, links and images dropped). */
  markdown: string
  title: string | null
  /** Publication date (YYYY-MM-DD) when the page metadata carries one. */
  date: string | null
}

/**
 * The crawl request sent to Crawl4AI. `raw_markdown` is used on purpose instead of
 * the pruned `fit_markdown`: the pruning filter drops one-letter text nodes, and
 * Word-pasted .gov.vn pages wrap the first letter of words in their own span, so
 * "chọn giống" came back as "họn giống". Boilerplate is cut with excluded_tags instead;
 * `form` is deliberately not excluded because ASP.NET sites (khuyennongvn.gov.vn)
 * wrap the whole page body in one <form>.
 */
function crawlBody(url: string) {
  return {
    urls: [url],
    browser_config: { type: 'BrowserConfig', params: { headless: true } },
    crawler_config: {
      type: 'CrawlerRunConfig',
      params: {
        cache_mode: 'bypass',
        excluded_tags: ['nav', 'header', 'footer', 'aside'],
        markdown_generator: {
          type: 'DefaultMarkdownGenerator',
          params: { options: { type: 'dict', value: { ignore_links: true, ignore_images: true } } },
        },
      },
    },
  }
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)

/** Client for a self-hosted Crawl4AI server (Docker image unclecode/crawl4ai). */
export class Crawl4aiClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  /** True when GET /health answers; it is the one endpoint that needs no token. */
  async healthy(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(5000) })
      return res.ok
    } catch {
      return false
    }
  }

  /** Render one page in headless Chromium and return its markdown. Throws on any failure. */
  async crawl(url: string): Promise<CrawledPage> {
    const res = await fetch(`${this.baseUrl}/crawl`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.token}` },
      body: JSON.stringify(crawlBody(url)),
      signal: AbortSignal.timeout(180_000),
    })
    if (res.status === 401 || res.status === 403) {
      throw new Error(`Crawl4AI từ chối token (HTTP ${res.status}) — kiểm tra CRAWL4AI_API_TOKEN trong .env`)
    }
    if (!res.ok) throw new Error(`Crawl4AI HTTP ${res.status}`)

    const body = (await res.json()) as { results?: Array<Record<string, unknown>> }
    const r = body.results?.[0]
    if (!r) throw new Error('Crawl4AI không trả về kết quả')
    if (r.success !== true) throw new Error(`Crawl4AI: ${str(r.error_message) ?? `HTTP ${String(r.status_code)}`}`)
    // Crawl4AI reports success for any page it could render, including a 404 page.
    if (typeof r.status_code === 'number' && r.status_code >= 400) throw new Error(`trang trả về HTTP ${r.status_code}`)

    const md = r.markdown as { raw_markdown?: unknown } | string | undefined
    const markdown = typeof md === 'string' ? md : (str(md?.raw_markdown) ?? '')
    const meta = (r.metadata ?? {}) as Record<string, unknown>
    const rawDate = str(meta['article:published_time']) ?? str(meta['datePublished']) ?? str(meta['date'])
    return {
      markdown,
      title: str(meta['og:title']) ?? str(meta.title),
      date: rawDate ? (/^\d{4}-\d{2}-\d{2}/.exec(rawDate)?.[0] ?? null) : null,
    }
  }
}
