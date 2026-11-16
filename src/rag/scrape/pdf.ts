import { convert } from '@opendataloader/pdf'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, extname, join } from 'node:path'
import { USER_AGENT } from './scraper'

export interface DownloadResult {
  ok: boolean
  /** True when the file was already on disk and no request was made. */
  cached: boolean
  message?: string
}

/**
 * Download a PDF to `dest` unless it is already there. The files are committed
 * under data/pdf/, so a re-run never re-fetches them; delete a file to refresh it.
 */
export async function downloadPdf(url: string, dest: string): Promise<DownloadResult> {
  if (existsSync(dest)) return { ok: true, cached: true }
  try {
    const res = await fetch(url, { headers: { 'user-agent': USER_AGENT } })
    if (!res.ok) return { ok: false, cached: false, message: `HTTP ${res.status}` }
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.subarray(0, 5).toString('latin1') !== '%PDF-') {
      return { ok: false, cached: false, message: `không phải PDF (${res.headers.get('content-type') ?? '?'})` }
    }
    mkdirSync(dirname(dest), { recursive: true })
    writeFileSync(dest, buf)
    return { ok: true, cached: false }
  } catch (err) {
    return { ok: false, cached: false, message: (err as Error).message }
  }
}

/**
 * Convert PDFs to markdown with opendataloader-pdf (needs Java 11+ on PATH).
 * Every file goes through ONE convert call because each call starts a JVM.
 * Returns raw markdown keyed by the input path; a file the converter produced
 * nothing for is absent from the map.
 */
export async function pdfsToMarkdown(paths: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (paths.length === 0) return out
  const outDir = mkdtempSync(join(tmpdir(), 'pdf-md-'))
  try {
    await convert(paths, { outputDir: outDir, format: 'markdown', imageOutput: 'off', quiet: true })
    for (const p of paths) {
      const md = join(outDir, `${basename(p, extname(p))}.md`)
      if (existsSync(md)) out.set(p, readFileSync(md, 'utf8'))
    }
  } finally {
    rmSync(outDir, { recursive: true, force: true })
  }
  return out
}
