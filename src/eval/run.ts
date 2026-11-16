/**
 * Eval harness: measures the small model's (1) first-decision tool selection and
 * (2) answer grounding, on the Vietnamese dataset, WITH the real RAG context so it
 * mirrors production. Requires LM Studio running with the chat + embedding models.
 * Does NOT require the MCP (uses the static KNOWN_TOOLS catalog). Run: npm run eval
 */
import {
  AGENT_DECISION_JSON_SCHEMA,
  AGENT_DECISION_SCHEMA_NAME,
  AgentDecisionSchema,
} from '../agent/decision'
import { config } from '../config'
import { getFewshot } from '../domain/fewshot'
import { loadProfile } from '../domain/profiles'
import { OpenAICompatEngine } from '../llm'
import { assembleMessages, buildSystemPrompt, knowledgeLabel } from '../llm/prompt'
import { KNOWN_TOOLS } from '../mcp/knownTools'
import { classifyTool } from '../mcp/policy'
import { ingestAll } from '../rag/buildStore'
import { retrieve } from '../rag/retrieve'
import { InMemoryVectorStore } from '../rag/store'
import { loadLlmConfig } from '../setup/llmConfig'
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

const mean = (xs: number[]): number => (xs.length === 0 ? NaN : xs.reduce((a, c) => a + c, 0) / xs.length)
const fmt = (n: number): string => (Number.isFinite(n) ? n.toFixed(3) : 'n/a')

async function main(): Promise<void> {
  const profile = loadProfile(config.defaultPlant)
  const saved = loadLlmConfig(config.setup.configPath)
  const embedModel = saved?.embedModel ?? config.llmDefaults.embedModel
  const llm = new OpenAICompatEngine({ ...config.llmDefaults, embedModel })
  const system = buildSystemPrompt({ profile, tools: KNOWN_TOOLS, fewshot: getFewshot(profile) })
  const store = config.rag.disabled
    ? new InMemoryVectorStore()
    : (await ingestAll(llm, config, profile, embedModel)).store

  const dimNote = store.size() === 0 ? ' (RAG off/empty)' : store.uniformDims() ? '' : ' ⚠ MIXED DIMS'
  console.log(
    `Eval: ${EVAL_CASES.length} cases | model=${config.llmDefaults.model} | embed=${embedModel} | plant=${profile.plant} | store=${store.size()} chunks${dimNote}\n`,
  )

  let exactHits = 0
  let safetyHits = 0
  let groundTotal = 0
  let groundHits = 0
  const expectedScores: number[] = []
  const otherScores: number[] = []
  const top1Annotated: number[] = []
  const top1Other: number[] = []
  let recallSum = 0
  let recallGatedSum = 0
  let annotated = 0
  for (const c of EVAL_CASES) {
    const rag = await retrieve(store, llm, c.message, config.rag.topK, config.rag.minScore, {
      relMargin: config.rag.relMargin,
      mmrLambda: config.rag.mmrLambda,
      hybrid: config.rag.hybrid,
    })
    const messages = assembleMessages({
      system,
      history: [],
      ragContext: rag.contextText,
      knowledgeLabel: knowledgeLabel(profile),
      userMessage: c.message,
    })
    // Ungated pass (no thresholds, no MMR) so the score distribution is the raw
    // cosine signal RAG_MIN_SCORE / RAG_REL_MARGIN would be tuned against.
    const raw = await retrieve(store, llm, c.message, config.rag.topK, 0, { hybrid: config.rag.hybrid })
    const top1 = raw.chunks.reduce((m, h) => Math.max(m, h.score), -Infinity)
    let retrievalNote = ''
    if (raw.chunks.length > 0) {
      const matches = (id: string | undefined, prefix: string) => !!id && id.startsWith(prefix)
      if (c.expectChunks && c.expectChunks.length > 0) {
        annotated++
        top1Annotated.push(top1)
        const found = (chunks: typeof raw.chunks) =>
          c.expectChunks!.filter((p) => chunks.some((h) => matches(h.id, p))).length / c.expectChunks!.length
        const recall = found(raw.chunks)
        recallSum += recall
        recallGatedSum += found(rag.chunks)
        for (const h of raw.chunks) {
          if (c.expectChunks.some((p) => matches(h.id, p))) expectedScores.push(h.score)
          else otherScores.push(h.score)
        }
        retrievalNote = ` | recall=${recall.toFixed(2)} top1=${fmt(top1)}`
      } else {
        top1Other.push(top1)
        retrievalNote = ` | top1=${fmt(top1)}`
      }
    } else if (c.expectChunks && c.expectChunks.length > 0) {
      annotated++
      top1Annotated.push(NaN)
      retrievalNote = ' | recall=0.00 top1=n/a'
    }
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
    console.log(`${exact ? 'PASS' : 'FAIL'} [${c.id}] want=${want} got=${got}${groundNote}${retrievalNote}`)
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
