import { resolve } from 'node:path'
import { Orchestrator } from '../agent/orchestrator'
import type { Config } from '../config'
import { loadDiseases } from '../domain/diseases'
import { getFewshot } from '../domain/fewshot'
import { loadProfile } from '../domain/profiles'
import { OpenAICompatEngine, type LlmEngine } from '../llm'
import { PlantMcpClient, type McpGateway, type McpTool } from '../mcp/client'
import { KNOWN_TOOLS } from '../mcp/knownTools'
import { SessionStore } from '../memory/sessions'
import { loadEmbedCache, saveEmbedCache } from '../rag/embedCache'
import { ingestProfile } from '../rag/ingest'
import { ingestDiseases } from '../rag/ingestDiseases'
import { ingestDocs, readReviewedDocs } from '../rag/ingestDocs'
import { InMemoryVectorStore } from '../rag/store'
import type { LlmConfig } from './llmConfig'
import { saveLlmConfig } from './llmConfig'
import { loadMcpConfig, saveMcpConfig } from './mcpConfig'
import { testLlmConnection, type ProbeFn } from './probe'
import type { ProbeResult } from './probe'
import type { AppState } from './state'

/** Injectable construction seams so tests can run the pipeline with fakes. */
export interface SetupDeps {
  probe: ProbeFn
  buildEngine: (cfg: LlmConfig) => LlmEngine
  buildMcp: (url: string) => McpGateway
}

export function defaultSetupDeps(): SetupDeps {
  return {
    probe: testLlmConnection,
    buildEngine: (cfg) =>
      new OpenAICompatEngine({
        baseURL: cfg.baseURL,
        apiKey: cfg.apiKey,
        model: cfg.model,
        embedModel: cfg.embedModel,
      }),
    buildMcp: (url) => new PlantMcpClient(url),
  }
}

export type ApplyResult =
  | ProbeResult
  | { ok: false; stage: 'busy'; code: 'busy'; message: string }

/**
 * Probe the config, persist it on success, then kick off the init pipeline in the
 * background (exposed via `state.initPromise`). Returns after the probe settles —
 * callers/UI observe pipeline progress by polling `state.getStatus()`.
 */
export async function applyLlmConfig(
  cfg: LlmConfig,
  state: AppState,
  appCfg: Config,
  deps: Partial<SetupDeps> = {},
  opts: { mcpUrl?: string } = {},
): Promise<ApplyResult> {
  if (state.isBusy()) {
    return { ok: false, stage: 'busy', code: 'busy', message: 'Đang xử lý cấu hình khác, vui lòng đợi.' }
  }
  const d = { ...defaultSetupDeps(), ...deps }
  // Explicit UI choice > saved mcp-config.json > MCP_URL env fallback.
  const mcpUrl = opts.mcpUrl ?? loadMcpConfig(appCfg.mcp.configPath)?.url ?? appCfg.mcp.url

  state.beginConnecting()
  const probe = await d.probe(cfg, { timeoutMs: appCfg.setup.probeTimeoutMs })
  if (!probe.ok) {
    state.fail(probe.stage, probe.code, probe.message)
    return probe
  }

  saveLlmConfig(appCfg.setup.configPath, cfg)
  // Persist only on an explicit choice — boot auto-reconnect keeps env-only setups pure.
  if (opts.mcpUrl !== undefined) saveMcpConfig(appCfg.mcp.configPath, { url: mcpUrl })
  state.beginInitializing(cfg, mcpUrl)
  state.initPromise = runInitPipeline(cfg, mcpUrl, state, appCfg, d).catch((err) => {
    state.crash((err as Error).message)
  })

  return probe
}

/**
 * Build the LLM engine, connect MCP (degrading to KNOWN_TOOLS), build the RAG index
 * (degrading to no-RAG), then assemble the Orchestrator and mark the app ready.
 * Extracted from the original single-shot main().
 */
async function runInitPipeline(
  cfg: LlmConfig,
  mcpUrl: string,
  state: AppState,
  appCfg: Config,
  deps: SetupDeps,
): Promise<void> {
  const profile = loadProfile(appCfg.defaultPlant)
  const llm = deps.buildEngine(cfg)
  const mcp = deps.buildMcp(mcpUrl)
  const store = new InMemoryVectorStore()
  const sessions = new SessionStore()

  // MCP connect — degrade to the static catalog so control actions are known.
  state.setStep('mcp', 'running')
  let tools: McpTool[] = []
  try {
    tools = await mcp.listTools()
    state.setStep('mcp', 'done', `${tools.length} tools`)
    console.log(`[mcp] connected at ${mcpUrl} — ${tools.length} tools`)
  } catch (err) {
    tools = KNOWN_TOOLS
    const msg = `MCP không kết nối được (${(err as Error).message}) — dùng ${tools.length} tool tĩnh (điều khiển sẽ lỗi đến khi MCP sẵn sàng).`
    state.setStep('mcp', 'failed', msg)
    console.warn(`[mcp] ${msg}`)
  }

  // RAG index — skipped entirely when RAG_DISABLED (store stays empty, so the
  // orchestrator sends no [Tri thức tham khảo] block); otherwise degrade to no-RAG
  // if embeddings are unavailable.
  state.setStep('rag', 'running')
  if (appCfg.rag.disabled) {
    const msg = 'RAG đã tắt (RAG_DISABLED) — chạy KHÔNG có tri thức tham khảo, model tự trả lời.'
    state.setStep('rag', 'done', msg)
    console.log(`[rag] ${msg}`)
  } else {
    try {
      const cachePath = resolve(process.cwd(), appCfg.rag.embedCachePath)
      const cache = loadEmbedCache(cachePath)

      const nProfile = await ingestProfile(store, llm, profile)

      const docs = readReviewedDocs(resolve(process.cwd(), appCfg.rag.docsDir))
      const nDocs = await ingestDocs(store, llm, docs, {
        plant: profile.plant,
        cache,
        chunkSize: appCfg.rag.chunkSize,
        chunkOverlap: appCfg.rag.chunkOverlap,
        minChunkLen: appCfg.rag.minChunkLen,
      })

      let nDiseases = 0
      try {
        nDiseases = await ingestDiseases(store, llm, loadDiseases(profile.plant), {
          plant: profile.plant,
          cache,
        })
      } catch (err) {
        console.warn(`[rag] disease KB skipped (${(err as Error).message}).`)
      }

      saveEmbedCache(cachePath, cache)
      const detail = `${nProfile} profile + ${nDocs} doc + ${nDiseases} disease (store=${store.size()})`
      state.setStep('rag', 'done', detail)
      console.log(`[rag] ingested ${detail}`)
    } catch (err) {
      const msg = `Nạp RAG thất bại (${(err as Error).message}) — chạy KHÔNG có RAG.`
      state.setStep('rag', 'failed', msg)
      console.warn(`[rag] ${msg}`)
    }
  }

  const orch = new Orchestrator({
    llm,
    mcp,
    store,
    sessions,
    profile,
    tools,
    fewshot: getFewshot(),
    maxToolSteps: appCfg.agent.maxToolSteps,
    ragTopK: appCfg.rag.topK,
  })

  state.setReady(orch)
  console.log(`[setup] sẵn sàng — provider=${cfg.provider} model=${cfg.model}`)
}
