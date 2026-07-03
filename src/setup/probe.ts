import OpenAI from 'openai'
import type { McpGateway } from '../mcp/client'
import type { LlmConfig } from './llmConfig'

export type ProbeErrorCode =
  | 'unreachable'
  | 'timeout'
  | 'auth_failed'
  | 'model_not_found'
  | 'embed_model_not_found'
  | 'unknown'

export type ProbeStage = 'models' | 'chat' | 'embed'

export type ProbeResult =
  | { ok: true; models: string[] }
  | { ok: false; stage: ProbeStage; code: ProbeErrorCode; message: string }

export type ProbeFn = typeof testLlmConnection

const DEFAULT_TIMEOUT_MS = 10_000

/** Map an OpenAI SDK error to a stable code + human message. */
function classify(err: unknown): { code: ProbeErrorCode; message: string } {
  if (err instanceof OpenAI.APIConnectionTimeoutError) {
    return { code: 'timeout', message: err.message }
  }
  if (err instanceof OpenAI.APIConnectionError) {
    return { code: 'unreachable', message: err.message }
  }
  if (err instanceof OpenAI.APIError) {
    const status = err.status
    if (status === 401 || status === 403) return { code: 'auth_failed', message: err.message }
    if (status === 404) return { code: 'model_not_found', message: err.message }
    return { code: 'unknown', message: err.message }
  }
  return { code: 'unknown', message: (err as Error)?.message ?? String(err) }
}

function makeClient(baseURL: string, apiKey: string, timeoutMs: number): OpenAI {
  return new OpenAI({ baseURL, apiKey, timeout: timeoutMs, maxRetries: 0 })
}

/**
 * List models exposed by an OpenAI-compatible server. Used by the setup UI to
 * populate the model dropdowns before Connect.
 */
export async function listProviderModels(opts: {
  baseURL: string
  apiKey: string
  timeoutMs?: number
}): Promise<{ ok: true; models: string[] } | { ok: false; code: ProbeErrorCode; message: string }> {
  const client = makeClient(opts.baseURL, opts.apiKey, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  try {
    const res = await client.models.list()
    const models = res.data.map((m) => m.id).sort((a, b) => a.localeCompare(b))
    return { ok: true, models }
  } catch (err) {
    return { ok: false, ...classify(err) }
  }
}

/**
 * Verify a full LLM configuration: list models (soft — some servers lack the
 * endpoint), then a 1-token chat completion, then a tiny embedding. Returns the
 * discovered model list on success, or the failing stage + code on failure.
 */
export async function testLlmConnection(
  cfg: LlmConfig,
  opts?: { timeoutMs?: number },
): Promise<ProbeResult> {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const client = makeClient(cfg.baseURL, cfg.apiKey, timeoutMs)

  // 1) models.list — a 404/501 means the server just doesn't implement /models;
  // that's fine, we continue with an empty list. Connection/auth errors are fatal.
  let models: string[] = []
  try {
    const res = await client.models.list()
    models = res.data.map((m) => m.id).sort((a, b) => a.localeCompare(b))
  } catch (err) {
    const { code, message } = classify(err)
    if (code === 'unreachable' || code === 'timeout' || code === 'auth_failed') {
      return { ok: false, stage: 'models', code, message }
    }
    // model_not_found/unknown here == "/models not implemented" → soft-continue.
  }

  // 2) tiny chat completion to validate the chat model.
  try {
    await client.chat.completions.create({
      model: cfg.model,
      messages: [{ role: 'user', content: 'ping' }],
      max_tokens: 1,
      temperature: 0,
    })
  } catch (err) {
    return { ok: false, stage: 'chat', ...classify(err) }
  }

  // 3) tiny embedding to validate the embed model.
  try {
    await client.embeddings.create({ model: cfg.embedModel, input: 'ping' })
  } catch (err) {
    const { code, message } = classify(err)
    // On the embed stage a "model not found" is specifically the embed model.
    const embedCode: ProbeErrorCode = code === 'model_not_found' ? 'embed_model_not_found' : code
    return { ok: false, stage: 'embed', code: embedCode, message }
  }

  return { ok: true, models }
}

export type McpProbeResult =
  | { ok: true; toolCount: number; tools: string[] }
  | { ok: false; code: ProbeErrorCode; message: string }

class McpTimeoutError extends Error {}

/**
 * Verify an MCP URL by connecting and listing tools. Advisory only — MCP being
 * down never gates connect (init degrades to the static catalog); this backs the
 * "Kiểm tra MCP" button in the setup UI.
 */
export async function testMcpConnection(
  buildMcp: (url: string) => McpGateway,
  url: string,
  opts?: { timeoutMs?: number },
): Promise<McpProbeResult> {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const gw = buildMcp(url)
  let timer: NodeJS.Timeout | undefined
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new McpTimeoutError()), timeoutMs)
    })
    const tools = await Promise.race([gw.listTools(), timeout])
    return { ok: true, toolCount: tools.length, tools: tools.map((t) => t.name) }
  } catch (err) {
    if (err instanceof McpTimeoutError) {
      return { ok: false, code: 'timeout', message: `MCP không phản hồi sau ${timeoutMs}ms` }
    }
    return { ok: false, code: 'unreachable', message: (err as Error)?.message ?? String(err) }
  } finally {
    if (timer) clearTimeout(timer)
    // McpGateway doesn't declare close(), but PlantMcpClient has one — call it so
    // the probe never leaks a streamable-HTTP connection. Fakes without close are fine.
    const close = (gw as { close?: () => Promise<void> }).close
    if (typeof close === 'function') {
      try {
        await close.call(gw)
      } catch {
        // best-effort cleanup only
      }
    }
  }
}
