import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { z } from 'zod'

/** Persisted LLM configuration chosen via the setup UI. */
export const LlmConfigSchema = z.object({
  provider: z.enum(['lmstudio', 'ollama', 'gemini', 'openai-compat']),
  baseURL: z.string().url(),
  apiKey: z.string(), // dummy already substituted before save (never empty)
  model: z.string().min(1),
  embedModel: z.string().min(1),
})
export type LlmConfig = z.infer<typeof LlmConfigSchema>

/**
 * Load a saved config. Any failure — missing file, invalid JSON, schema mismatch —
 * is treated the same as "no config": warn and return null so startup falls back
 * to the setup UI.
 */
export function loadLlmConfig(path: string): LlmConfig | null {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return null // missing file is the normal first-run case, no warning
  }
  try {
    const parsed = LlmConfigSchema.safeParse(JSON.parse(raw))
    if (parsed.success) return parsed.data
    console.warn(`[setup] ${path} không hợp lệ (sai schema) — bỏ qua, chờ cấu hình lại.`)
    return null
  } catch (err) {
    console.warn(`[setup] ${path} lỗi đọc/parse (${(err as Error).message}) — bỏ qua, chờ cấu hình lại.`)
    return null
  }
}

/** Persist config, creating the parent directory if it doesn't exist yet. */
export function saveLlmConfig(path: string, cfg: LlmConfig): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(cfg, null, 2), 'utf8')
}
