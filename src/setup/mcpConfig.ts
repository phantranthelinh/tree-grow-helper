import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { z } from 'zod'

/** Persisted MCP configuration chosen via the setup UI. */
export const McpConfigSchema = z.object({
  url: z.string().url(),
})
export type McpConfig = z.infer<typeof McpConfigSchema>

/**
 * Load a saved config. Any failure — missing file, invalid JSON, schema mismatch —
 * is treated the same as "no config": warn and return null so the caller falls back
 * to the MCP_URL env default.
 */
export function loadMcpConfig(path: string): McpConfig | null {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return null // missing file is the normal first-run case, no warning
  }
  try {
    const parsed = McpConfigSchema.safeParse(JSON.parse(raw))
    if (parsed.success) return parsed.data
    console.warn(`[setup] ${path} không hợp lệ (sai schema) — bỏ qua, dùng MCP_URL từ env.`)
    return null
  } catch (err) {
    console.warn(`[setup] ${path} lỗi đọc/parse (${(err as Error).message}) — bỏ qua, dùng MCP_URL từ env.`)
    return null
  }
}

/** Persist config, creating the parent directory if it doesn't exist yet. */
export function saveMcpConfig(path: string, cfg: McpConfig): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(cfg, null, 2), 'utf8')
}
