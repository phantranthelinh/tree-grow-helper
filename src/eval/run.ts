/**
 * Eval harness: measures the small model's (1) first-decision tool selection and
 * (2) answer grounding, on the Vietnamese dataset, WITH the real RAG context so it
 * mirrors production. Requires LM Studio running with the chat + embedding models.
 * Does NOT require the MCP (uses the static KNOWN_TOOLS catalog). Run: npm run eval
 */
import { resolve } from 'node:path'
import {
  AGENT_DECISION_JSON_SCHEMA,
  AGENT_DECISION_SCHEMA_NAME,
  AgentDecisionSchema,
} from '../agent/decision'
import { config } from '../config'
import { loadDiseases } from '../domain/diseases'
import { getFewshot } from '../domain/fewshot'
import { loadProfile } from '../domain/profiles'
import { OpenAICompatEngine } from '../llm'
import { assembleMessages, buildSystemPrompt } from '../llm/prompt'
import { KNOWN_TOOLS } from '../mcp/knownTools'
import { classifyTool } from '../mcp/policy'
import { loadEmbedCache, saveEmbedCache } from '../rag/embedCache'
import { ingestProfile } from '../rag/ingest'
import { ingestDiseases } from '../rag/ingestDiseases'
import { ingestDocs, readReviewedDocs } from '../rag/ingestDocs'
import { retrieve } from '../rag/retrieve'
import { InMemoryVectorStore } from '../rag/store'
import { EVAL_CASES, type EvalExpect } from './dataset'
import { gradeGrounding } from './grounding'

interface Decision {
  type: 'reply' | 'tool'
  tool?: string
  message: string
}

function parse(raw: string): Decision | null {
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  const json = start >= 0 && end > start ? raw.slice(start, end + 1) : raw
  try {
    const p = AgentDecisionSchema.safeParse(JSON.parse(json))
    return p.success ? { type: p.data.type, tool: p.data.tool, message: p.data.message } : null
  } catch {
    return null
  }
}

function grade(expect: EvalExpect, actual: Decision | null) {
  if (!actual) return { exact: false, safety: false }
  if (expect.type === 'reply') {
    const exact = actual.type === 'reply'
    return { exact, safety: exact }
  }
  const exact = actual.type === 'tool' && actual.tool === expect.tool
  const safety = actual.type === 'tool' && !!actual.tool && classifyTool(actual.tool) === expect.safety
  return { exact, safety }
}

/** Build the same RAG store production uses (profile + reviewed docs + disease KB). */
async function buildStore(llm: OpenAICompatEngine, plant: string): Promise<InMemoryVectorStore> {
  const store = new InMemoryVectorStore()
  if (config.rag.disabled) return store
  const cachePath = resolve(process.cwd(), config.rag.embedCachePath)
  const cache = loadEmbedCache(cachePath)
  const embedModel = config.llmDefaults.embedModel

  await ingestProfile(store, llm, loadProfile(plant), {
    cache,
    embedModel,
    chunkSize: config.rag.chunkSize,
    chunkOverlap: config.rag.chunkOverlap,
    minChunkLen: config.rag.minChunkLen,
  })
  const docs = readReviewedDocs(resolve(process.cwd(), config.rag.docsDir))
  await ingestDocs(store, llm, docs, {
    plant,
    cache,
    embedModel,
    chunkSize: config.rag.chunkSize,
    chunkOverlap: config.rag.chunkOverlap,
    minChunkLen: config.rag.minChunkLen,
  })
  try {
    await ingestDiseases(store, llm, loadDiseases(plant), { plant, cache, embedModel })
  } catch (err) {
    console.warn(`[eval] disease KB skipped (${(err as Error).message}).`)
  }
  saveEmbedCache(cachePath, cache)
  return store
}

async function main(): Promise<void> {
  const profile = loadProfile(config.defaultPlant)
  const llm = new OpenAICompatEngine(config.llmDefaults)
  const system = buildSystemPrompt({ profile, tools: KNOWN_TOOLS, fewshot: getFewshot() })
  const store = await buildStore(llm, profile.plant)

  const dimNote = store.size() === 0 ? ' (RAG off/empty)' : store.uniformDims() ? '' : ' ⚠ MIXED DIMS'
  console.log(
    `Eval: ${EVAL_CASES.length} cases | model=${config.llmDefaults.model} | plant=${profile.plant} | store=${store.size()} chunks${dimNote}\n`,
  )

  let exactHits = 0
  let safetyHits = 0
  let groundTotal = 0
  let groundHits = 0
  for (const c of EVAL_CASES) {
    const rag = await retrieve(store, llm, c.message, config.rag.topK)
    const messages = assembleMessages({ system, history: [], ragContext: rag.contextText, userMessage: c.message })
    let actual: Decision | null = null
    try {
      const raw = await llm.completeJson(messages, AGENT_DECISION_JSON_SCHEMA, AGENT_DECISION_SCHEMA_NAME, {
        temperature: config.llm.decisionTemp,
      })
      actual = parse(raw)
    } catch (err) {
      console.error(`\nLLM call failed. Is the LLM running at ${config.llmDefaults.baseURL} with "${config.llmDefaults.model}"?`)
      console.error(String((err as Error).message))
      process.exit(1)
    }
    const { exact, safety } = grade(c.expect, actual)
    if (exact) exactHits++
    if (safety) safetyHits++

    let groundNote = ''
    if (c.grounding) {
      groundTotal++
      const gr = gradeGrounding(c.grounding, actual?.message ?? '')
      if (gr.pass) {
        groundHits++
        groundNote = ' | ground=PASS'
      } else {
        groundNote = ` | ground=FAIL(${gr.reasons.join('; ')})`
      }
    }

    const want = c.expect.type === 'tool' ? c.expect.tool : 'reply'
    const got = actual ? (actual.type === 'tool' ? actual.tool : 'reply') : '(parse-fail)'
    console.log(`${exact ? 'PASS' : 'FAIL'} [${c.id}] want=${want} got=${got}${groundNote}`)
  }

  const n = EVAL_CASES.length
  console.log(`\nTool/reply exact accuracy: ${exactHits}/${n} (${Math.round((exactHits / n) * 100)}%)`)
  console.log(`Safety-class accuracy:     ${safetyHits}/${n} (${Math.round((safetyHits / n) * 100)}%)`)
  if (groundTotal > 0) {
    console.log(`Grounding accuracy:        ${groundHits}/${groundTotal} (${Math.round((groundHits / groundTotal) * 100)}%)`)
  }
  console.log('\nGhi chú: eval chạy CÓ ngữ cảnh RAG (giống prod); mọi tool ĐIỀU KHIỂN luôn được chặn để xác nhận bất kể model chọn gì.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
