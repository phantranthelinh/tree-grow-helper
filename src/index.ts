import { Orchestrator } from './agent/orchestrator'
import { config } from './config'
import { getFewshot } from './domain/fewshot'
import { loadProfile } from './domain/profiles'
import { buildServer } from './http/server'
import { LmStudioEngine } from './llm'
import { PlantMcpClient, type McpTool } from './mcp/client'
import { KNOWN_TOOLS } from './mcp/knownTools'
import { SessionStore } from './memory/sessions'
import { ingestProfile } from './rag/ingest'
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

  // Build the RAG index from the plant profile; degrade if embeddings are down.
  try {
    const n = await ingestProfile(store, llm, profile)
    console.log(`[rag] ingested ${n} chunks for "${profile.plant}"`)
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
