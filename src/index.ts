import { join } from 'node:path'
import { Orchestrator } from './agent/orchestrator'
import { config } from './config'
import { loadDiseases } from './domain/diseases'
import { getFewshot } from './domain/fewshot'
import { loadProfile } from './domain/profiles'
import { buildServer } from './http/server'
import { LmStudioEngine } from './llm'
import { PlantMcpClient, type McpTool } from './mcp/client'
import { KNOWN_TOOLS } from './mcp/knownTools'
import { SessionStore } from './memory/sessions'
import { loadEmbedCache, saveEmbedCache } from './rag/embedCache'
import { ingestProfile } from './rag/ingest'
import { ingestDiseases } from './rag/ingestDiseases'
import { ingestDocs, readReviewedDocs } from './rag/ingestDocs'
import { InMemoryVectorStore } from './rag/store'

async function main(): Promise<void> {
  const profile = loadProfile(config.defaultPlant)
  const llm = new LmStudioEngine(config.lmStudio)
  const mcp = new PlantMcpClient(config.mcp.url)
  const store = new InMemoryVectorStore()
  const sessions = new SessionStore()

  // Connect to MCP; degrade gracefully so the server still boots for diagnosis.
  let tools: McpTool[] = []
  try {
    tools = await mcp.listTools()
    console.log(`[mcp] connected at ${config.mcp.url} — ${tools.length} tools`)
  } catch (err) {
    tools = KNOWN_TOOLS
    console.warn(
      `[mcp] connect failed (${(err as Error).message}). Using ${tools.length} known tools (degraded: control actions will fail until MCP is up).`,
    )
  }

  // Build the RAG index: curated profile + reviewed scraped docs + structured
  // disease KB, sharing an on-disk embedding cache so restarts don't re-embed.
  try {
    const cachePath = join(process.cwd(), config.rag.embedCachePath)
    const cache = loadEmbedCache(cachePath)

    const nProfile = await ingestProfile(store, llm, profile)

    const docs = readReviewedDocs(join(process.cwd(), config.rag.docsDir))
    const nDocs = await ingestDocs(store, llm, docs, {
      plant: profile.plant,
      cache,
      chunkSize: config.rag.chunkSize,
      chunkOverlap: config.rag.chunkOverlap,
      minChunkLen: config.rag.minChunkLen,
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
    console.log(
      `[rag] ingested ${nProfile} profile + ${nDocs} doc + ${nDiseases} disease chunks (store=${store.size()})`,
    )
  } catch (err) {
    console.warn(`[rag] ingest failed (${(err as Error).message}). Continuing WITHOUT RAG.`)
  }

  const orch = new Orchestrator({
    llm,
    mcp,
    store,
    sessions,
    profile,
    tools,
    fewshot: getFewshot(),
    maxToolSteps: config.agent.maxToolSteps,
    ragTopK: config.rag.topK,
  })

  const app = buildServer(orch)
  await app.listen({ port: config.port, host: '0.0.0.0' })
  console.log(`[http] AI server listening on http://localhost:${config.port}`)
  console.log(`[llm] LM Studio: ${config.lmStudio.baseURL} model=${config.lmStudio.model}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
