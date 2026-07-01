import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { config } from '../../config'
import { delay, extractText, fetchUrl } from './scraper'
import { SOURCES, allowedHosts } from './sources'

/**
 * Scrape every allowlisted source into a staging JSONL file. This does NOT touch
 * the vector store — a human reviews/trims the staging file and copies the good
 * records into `data/docs/` before `ingestDocs` runs on server start.
 *
 * Run: npm run scrape
 */
async function main(): Promise<void> {
  if (SOURCES.length === 0) {
    console.log(
      '[scrape] SOURCES rỗng. Mở src/rag/scrape/sources.ts, thêm URL nguồn tin cậy rồi chạy lại.',
    )
    return
  }

  const hosts = allowedHosts()
  const today = new Date().toISOString().slice(0, 10)
  const stagingDir = join(process.cwd(), config.rag.stagingDir)
  mkdirSync(stagingDir, { recursive: true })
  const outPath = join(stagingDir, 'strawberry-docs.raw.jsonl')

  const records: string[] = []
  for (const src of SOURCES) {
    let host: string
    try {
      host = new URL(src.url).host
    } catch {
      console.warn(`[scrape] URL hỏng, bỏ qua: ${src.url}`)
      continue
    }
    if (!hosts.has(host)) {
      console.warn(`[scrape] ${host} ngoài allowlist, bỏ qua: ${src.url}`)
      continue
    }

    const res = await fetchUrl(src.url)
    if (!res.ok) {
      console.warn(`[scrape] tải thất bại (${res.status}): ${src.url}`)
      await delay(1000)
      continue
    }
    const text = extractText(res.html, src.selector)
    const title = src.url.split('/').filter(Boolean).pop() ?? src.url
    records.push(
      JSON.stringify({ source_url: src.url, category: src.category, title, date: today, text }),
    )
    console.log(`[scrape] ok (${text.length} ký tự): ${src.url}`)
    await delay(1500) // lịch sự: giãn cách giữa các request
  }

  writeFileSync(outPath, records.join('\n') + '\n', 'utf8')
  console.log(`\n[scrape] Đã ghi ${records.length} bản ghi → ${outPath}`)
  console.log(
    `[scrape] BƯỚC TIẾP: xem/cắt rác trong file này, rồi copy các bản ghi tốt sang ${config.rag.docsDir}/ (đuôi .jsonl) để ingest khi khởi động server.`,
  )
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
