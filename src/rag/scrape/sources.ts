/**
 * Allowlist of trusted pages to scrape into the databank. This is deliberately
 * empty — add only sources YOU trust (nông nghiệp/khuyến nông, .edu.vn, .gov.vn,
 * viện nghiên cứu). Everything scraped lands in staging for review before ingest,
 * so this list is the first quality gate.
 *
 * `selector` targets the main content region of that specific site (inspect the
 * page and pick the article/main wrapper) so we skip menus, ads and comments.
 */
export interface Source {
  url: string
  category: 'grow' | 'uses' | 'disease'
  /** CSS selector for the main content region; omit to fall back to <body>. */
  selector?: string
}

export const SOURCES: Source[] = [
  // Ví dụ (thay bằng nguồn thật của bạn, rồi bỏ comment):
  // { url: 'https://<trusted>.edu.vn/ky-thuat-trong-dau-tay', category: 'grow', selector: 'article' },
  // { url: 'https://<trusted>.gov.vn/ung-dung-che-bien-dau-tay', category: 'uses', selector: 'main' },
  // { url: 'https://<trusted>.edu.vn/benh-hai-dau-tay', category: 'disease', selector: '.article-content' },
]

/** Hosts derived from SOURCES — used to hard-block accidental off-allowlist fetches. */
export function allowedHosts(): Set<string> {
  const hosts = new Set<string>()
  for (const s of SOURCES) {
    try {
      hosts.add(new URL(s.url).host)
    } catch {
      // ignore malformed entries; they are skipped at scrape time too
    }
  }
  return hosts
}
