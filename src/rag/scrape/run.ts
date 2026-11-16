import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { config } from '../../config'
import { Crawl4aiClient } from './crawl4ai'
import { cleanMarkdown, firstHeading, fixPdfDegrees, normalizeDegrees } from './markdown'
import { downloadPdf, pdfsToMarkdown } from './pdf'
import { delay, extractMeta, extractText, fetchUrl, isHtmlContentType } from './scraper'
import { SOURCES, type Source, allowedHosts } from './sources'

interface StagingRecord {
  source_url: string
  plant: string
  category: string
  title: string
  date: string | null
  scraped_at: string
  /** Repo-relative path of the stored PDF, for PDF sources. */
  local_path?: string
  text: string
}

const today = new Date().toISOString().slice(0, 10)
/** Below this a "page" is an error screen or an empty shell, not an article. */
const MIN_TEXT_CHARS = 200
const slugTitle = (url: string) => url.split('/').filter(Boolean).pop() ?? url

/** HTML through Crawl4AI when it is up, else the cheerio scraper (static HTML only). */
async function scrapeHtml(src: Source, crawler: Crawl4aiClient | null): Promise<StagingRecord | null> {
  if (crawler) {
    try {
      const page = await crawler.crawl(src.url)
      return {
        source_url: src.url,
        plant: src.plant,
        category: src.category,
        title: page.title ?? firstHeading(page.markdown) ?? slugTitle(src.url),
        date: page.date,
        scraped_at: today,
        text: cleanMarkdown(page.markdown),
      }
    } catch (err) {
      console.warn(`[scrape] Crawl4AI lỗi (${(err as Error).message}): ${src.url}`)
      return null
    }
  }
  const res = await fetchUrl(src.url)
  if (!res.ok) {
    console.warn(`[scrape] tải thất bại (${res.status}): ${src.url}`)
    return null
  }
  if (!isHtmlContentType(res.contentType)) {
    console.warn(`[scrape] không phải HTML (${res.contentType}) — khai báo \`pdf\` trong sources.ts nếu là PDF: ${src.url}`)
    return null
  }
  const meta = extractMeta(res.html)
  return {
    source_url: src.url,
    plant: src.plant,
    category: src.category,
    title: meta.title ?? slugTitle(src.url),
    date: meta.date,
    scraped_at: today,
    text: normalizeDegrees(extractText(res.html, src.selector)),
  }
}

/** Download missing PDFs into data/pdf/<plant>/, then convert all of them in one JVM run. */
async function scrapePdfs(sources: Source[]): Promise<StagingRecord[]> {
  const pdfRoot = resolve(process.cwd(), config.rag.pdfDir)
  const local: Array<{ src: Source; path: string }> = []
  for (const src of sources) {
    const path = join(pdfRoot, src.plant, src.pdf as string)
    const dl = await downloadPdf(src.url, path)
    if (!dl.ok) {
      console.warn(`[scrape] tải PDF thất bại (${dl.message}): ${src.url}`)
      continue
    }
    console.log(`[scrape] PDF ${dl.cached ? 'đã có sẵn' : 'đã tải'}: ${join(config.rag.pdfDir, src.plant, src.pdf as string)}`)
    local.push({ src, path })
    if (!dl.cached) await delay(1500)
  }
  if (local.length === 0) return []

  let converted: Map<string, string>
  try {
    converted = await pdfsToMarkdown(local.map((l) => l.path))
  } catch (err) {
    console.warn(`[scrape] đọc PDF thất bại (${(err as Error).message}) — cần Java 11+ trên PATH.`)
    return []
  }
  const records: StagingRecord[] = []
  for (const { src, path } of local) {
    const md = converted.get(path)
    if (!md) {
      console.warn(`[scrape] opendataloader không đọc được nội dung: ${path}`)
      continue
    }
    records.push({
      source_url: src.url,
      plant: src.plant,
      category: src.category,
      title: firstHeading(md) ?? (src.pdf as string),
      date: null,
      scraped_at: today,
      local_path: join(config.rag.pdfDir, src.plant, src.pdf as string).replace(/\\/g, '/'),
      text: fixPdfDegrees(cleanMarkdown(md)),
    })
  }
  return records
}

/**
 * Scrape every allowlisted source into data/staging/<plant>-docs.raw.jsonl. This
 * does NOT touch the vector store — a human reviews/trims the staging file and
 * copies the good records into data/docs/ before ingestDocs runs.
 *
 * Run: npm run scrape            (every plant)
 *      npm run scrape -- <plant> (one plant, e.g. bean-sprout)
 */
async function main(): Promise<void> {
  const only = process.argv[2]
  const hosts = allowedHosts()
  const selected = SOURCES.filter((s) => !only || s.plant === only)
  if (selected.length === 0) {
    const plants = [...new Set(SOURCES.map((s) => s.plant))].join(', ')
    console.log(`[scrape] không có nguồn nào${only ? ` cho cây "${only}"` : ''}. Các cây hiện có: ${plants}.`)
    return
  }

  const pdfNames = selected.filter((s) => s.pdf).map((s) => s.pdf as string)
  const dupes = pdfNames.filter((n, i) => pdfNames.indexOf(n) !== i)
  if (dupes.length > 0) throw new Error(`Tên file PDF bị trùng trong sources.ts: ${[...new Set(dupes)].join(', ')}`)

  const usable = selected.filter((s) => {
    let host: string
    try {
      host = new URL(s.url).host
    } catch {
      console.warn(`[scrape] URL hỏng, bỏ qua: ${s.url}`)
      return false
    }
    if (!hosts.has(host)) console.warn(`[scrape] ${host} ngoài allowlist, bỏ qua: ${s.url}`)
    return hosts.has(host)
  })

  const htmlSources = usable.filter((s) => !s.pdf)
  let crawler: Crawl4aiClient | null = null
  if (htmlSources.length > 0) {
    const candidate = new Crawl4aiClient(config.crawl4ai.url, config.crawl4ai.token)
    if (await candidate.healthy()) {
      if (!config.crawl4ai.token) console.warn('[scrape] CRAWL4AI_API_TOKEN trống — Crawl4AI 0.9+ sẽ từ chối request.')
      crawler = candidate
      console.log(`[scrape] dùng Crawl4AI tại ${config.crawl4ai.url}`)
    } else {
      console.warn(
        `[scrape] Crawl4AI không chạy ở ${config.crawl4ai.url} — dùng cheerio (chỉ HTML tĩnh). ` +
          'Bật Crawl4AI: docker compose --profile scrape up -d crawl4ai',
      )
    }
  }

  const records: StagingRecord[] = []
  for (const src of htmlSources) {
    const rec = await scrapeHtml(src, crawler)
    if (rec && rec.text.length < MIN_TEXT_CHARS) {
      console.warn(`[scrape] nội dung quá ngắn (${rec.text.length} ký tự) — trang lỗi hoặc cần selector, bỏ qua: ${src.url}`)
    } else if (rec) {
      records.push(rec)
      console.log(`[scrape] ok (${rec.text.length} ký tự): ${src.url}`)
    }
    await delay(1500) // lịch sự: giãn cách giữa các request
  }
  for (const rec of await scrapePdfs(usable.filter((s) => s.pdf))) {
    records.push(rec)
    console.log(`[scrape] ok PDF (${rec.text.length} ký tự): ${rec.local_path}`)
  }

  const stagingDir = join(process.cwd(), config.rag.stagingDir)
  mkdirSync(stagingDir, { recursive: true })
  for (const plant of new Set(records.map((r) => r.plant))) {
    const mine = records.filter((r) => r.plant === plant)
    const outPath = join(stagingDir, `${plant}-docs.raw.jsonl`)
    writeFileSync(outPath, mine.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')
    console.log(`[scrape] ${plant}: ${mine.length} bản ghi → ${outPath}`)
  }
  console.log(
    `[scrape] BƯỚC TIẾP: xem/cắt rác trong các file staging, rồi copy bản ghi tốt sang ${config.rag.docsDir}/ (đuôi .jsonl).`,
  )
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
