/**
 * Eval harness: measures the small model's (1) first-decision tool selection and
 * (2) answer grounding, on the Vietnamese dataset, WITH the real RAG context so it
 * mirrors production. Requires LM Studio running with the chat + embedding models.
 * Does NOT require the MCP (uses the static KNOWN_TOOLS catalog). Run: npm run eval
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  AGENT_DECISION_JSON_SCHEMA,
  AGENT_DECISION_SCHEMA_NAME,
  AgentDecisionSchema,
} from '../agent/decision'
import { bigramDocFreq, withReplyNotes } from '../agent/replyNotes'
import { config } from '../config'
import { getFewshot } from '../domain/fewshot'
import { loadProfile } from '../domain/profiles'
import { OpenAICompatEngine, type TokenLogprob } from '../llm'
import { assembleMessages, buildSystemPrompt, knowledgeLabel } from '../llm/prompt'
import { KNOWN_TOOLS } from '../mcp/knownTools'
import { classifyTool } from '../mcp/policy'
import { ingestAll } from '../rag/buildStore'
import { retrieve } from '../rag/retrieve'
import { InMemoryVectorStore } from '../rag/store'
import { loadLlmConfig } from '../setup/llmConfig'
import { evalCasesFor, type EvalExpect } from './dataset'
import { gradeGrounding, hasForeignScript } from './grounding'
import { NEAR_TIE, typeMargin } from './margin'
import { type CaseResult, chunkRecall, summarize } from './metrics'

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
  const EVAL_CASES = evalCasesFor(profile.plant)
  const saved = loadLlmConfig(config.setup.configPath)
  const embedModel = saved?.embedModel ?? config.llmDefaults.embedModel
  const llm = new OpenAICompatEngine({ ...config.llmDefaults, embedModel })
  const system = buildSystemPrompt({ profile, tools: KNOWN_TOOLS, fewshot: getFewshot(profile) })
  const store = config.rag.disabled
    ? new InMemoryVectorStore()
    : (await ingestAll(llm, config, profile, embedModel)).store

  // The orchestrator appends the same notes to every first-step reply, so the eval grades the text users see.
  const docFreq = bigramDocFreq(store.all().map((r) => r.text))

  const dimNote = store.size() === 0 ? ' (RAG off/empty)' : store.uniformDims() ? '' : ' ⚠ MIXED DIMS'
  console.log(
    `Eval: ${EVAL_CASES.length} cases | model=${config.llmDefaults.model} | embed=${embedModel} | plant=${profile.plant} | store=${store.size()} chunks${dimNote}\n`,
  )

  const results: CaseResult[] = []
  for (const c of EVAL_CASES) {
    const startedAt = Date.now()
    let recall: number | null = null
    let recallGated: number | null = null
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
    if (c.expectChunks && c.expectChunks.length > 0) {
      // An empty ungated pass still counts as an annotated case with recall 0.
      recall = chunkRecall(c.expectChunks, raw.chunks.map((h) => h.id ?? ''))
      recallGated = chunkRecall(c.expectChunks, rag.chunks.map((h) => h.id ?? ''))
      retrievalNote = ` | recall=${recall.toFixed(2)} top1=${fmt(raw.chunks.length > 0 ? top1 : NaN)}`
    } else if (raw.chunks.length > 0) {
      retrievalNote = ` | top1=${fmt(top1)}`
    }
    let actual: Decision | null = null
    let logprobs: TokenLogprob[] = []
    try {
      const raw = await llm.completeJson(messages, AGENT_DECISION_JSON_SCHEMA, AGENT_DECISION_SCHEMA_NAME, {
        temperature: config.llm.decisionTemp,
        maxTokens: config.llm.decisionMaxTokens,
        onLogprobs: (tokens) => (logprobs = tokens),
      })
      actual = parse(raw)
    } catch (err) {
      console.error(`
LLM call failed. Is the LLM running at ${config.llmDefaults.baseURL} with "${config.llmDefaults.model}"?`)
      console.error(String((err as Error).message))
      process.exit(1)
    }
    const margin = typeMargin(logprobs)
    const { exact, safety } = grade(c.expect, actual)

    const modelText = actual?.message ?? ''
    const shipped =
      actual?.type === 'reply' && modelText
        ? withReplyNotes(modelText, { question: c.message, chunks: rag.chunks, docFreq, profile })
        : modelText
    let groundNote = ''
    let grounding: { pass: boolean; reasons: string[] } | null = null
    let groundingModel: { pass: boolean; reasons: string[] } | null = null
    if (c.grounding) {
      const gr = gradeGrounding(c.grounding, shipped)
      grounding = { pass: gr.pass, reasons: gr.reasons }
      groundingModel = gradeGrounding(c.grounding, modelText)
      groundNote = gr.pass ? ' | ground=PASS' : ` | ground=FAIL(${gr.reasons.join('; ')})`
      if (gr.pass && !groundingModel.pass) groundNote += ' (nhờ ghi chú)'
    }

    const want = c.expect.type === 'tool' ? c.expect.tool : 'reply'
    const got = actual ? (actual.type === 'tool' ? actual.tool : 'reply') : '(parse-fail)'
    const foreignScript = hasForeignScript(shipped)
    const scriptNote = foreignScript ? ' | SCRIPT=FOREIGN' : ''
    const marginNote = margin === null ? '' : ` | Δ=${margin.toFixed(2)}`
    console.log(`${exact ? 'PASS' : 'FAIL'} [${c.id}] want=${want} got=${got}${marginNote}${groundNote}${retrievalNote}${scriptNote}`)
    const scored = (chunks: typeof raw.chunks) => chunks.map((h) => ({ id: h.id ?? '', score: Number(h.score.toFixed(4)) }))
    results.push({
      id: c.id,
      set: c.set ?? 'r0',
      want: want ?? '',
      got: got ?? '',
      exact,
      safety,
      reply: actual ? shipped : null,
      modelReply: actual?.message ?? null,
      grounding,
      groundingModel,
      typeMargin: margin,
      expectChunks: c.expectChunks ?? null,
      recall,
      recallGated,
      retrieved: scored(rag.chunks),
      retrievedUngated: scored(raw.chunks),
      foreignScript,
      ms: Date.now() - startedAt,
    })
  }

  // `summary` is the round-0 case set so its keys and meaning stay comparable across rounds.
  const r0 = results.filter((r) => r.set === 'r0')
  const r1 = results.filter((r) => r.set === 'r1')
  const summary = summarize(r0)
  const summaryR1 = summarize(r1)
  const summaryAll = summarize(results)
  const pct = (h: number, t: number): string => `${h}/${t} (${t > 0 ? Math.round((h / t) * 100) : 0}%)`
  console.log(`
Round-0 cases (${r0.length}):`)
  console.log(`Tool/reply exact accuracy: ${pct(summary.exact.hits, summary.exact.total)}`)
  console.log(`Safety-class accuracy:     ${pct(summary.safety.hits, summary.safety.total)}`)
  if (summary.grounding.total > 0) {
    console.log(
      `Grounding accuracy:        ${pct(summary.grounding.hits, summary.grounding.total)} ` +
        `(model text alone: ${pct(summary.groundingModel.hits, summary.groundingModel.total)})`,
    )
  }
  console.log(`Replies free of Cyrillic/CJK: ${pct(summary.scriptClean.hits, summary.scriptClean.total)}`)
  if (summary.retrieval.annotated > 0) {
    const r = summary.retrieval
    console.log(`Recall@${config.rag.topK} (ungated / gated): ${fmt(r.recallUngated ?? NaN)} / ${fmt(r.recallGated ?? NaN)} over ${r.annotated} cases`)
    console.log(`Cosine mean — expected chunks: ${fmt(r.expectedScoreMean ?? NaN)} | other chunks: ${fmt(r.otherScoreMean ?? NaN)}`)
    console.log(`Top-1 mean — knowledge cases: ${fmt(r.top1AnnotatedMean ?? NaN)} | unannotated cases: ${fmt(r.top1OtherMean ?? NaN)}`)
  }
  if (r1.length > 0) {
    const g = summaryR1.grounding
    console.log(
      `Round-1 cases (${r1.length}, outside the stop criterion): exact ${pct(summaryR1.exact.hits, summaryR1.exact.total)}` +
        (g.total > 0 ? ` | grounding ${pct(g.hits, g.total)}` : '') +
        ` | recall@${config.rag.topK} gated ${fmt(summaryR1.retrieval.recallGated ?? NaN)} over ${summaryR1.retrieval.annotated}` +
        ` | script-clean ${pct(summaryR1.scriptClean.hits, summaryR1.scriptClean.total)}`,
    )
  }
  const nearTies = results.flatMap((r) =>
    r.typeMargin != null && Math.abs(r.typeMargin) < NEAR_TIE ? [{ id: r.id, typeMargin: Number(r.typeMargin.toFixed(2)) }] : [],
  )
  console.log(
    `Near-ties at the type token (|Δ| < ${NEAR_TIE}): ${nearTies.length === 0 ? 'none' : nearTies.map((n) => `${n.id} ${n.typeMargin}`).join(', ')}`,
  )
  console.log('\nGhi chú: eval chạy CÓ ngữ cảnh RAG (giống prod); mọi tool ĐIỀU KHIỂN luôn được chặn để xác nhận bất kể model chọn gì.')

  const outPath = writeEvalReport({
    label: process.env.EVAL_LABEL ?? 'run',
    model: config.llmDefaults.model,
    embedModel,
    plant: profile.plant,
    storeSize: store.size(),
    rag: {
      topK: config.rag.topK,
      minScore: config.rag.minScore,
      relMargin: config.rag.relMargin,
      mmrLambda: config.rag.mmrLambda,
      hybrid: config.rag.hybrid,
    },
    summary,
    summaryR1,
    summaryAll,
    nearTies,
    cases: results,
  })
  console.log(`Kết quả chi tiết: ${outPath}`)
}

/** Writes the run to data/eval/<label>-<timestamp>.json so rounds can be diffed. */
function writeEvalReport(report: Record<string, unknown>): string {
  const dir = resolve(process.cwd(), process.env.EVAL_OUT_DIR ?? 'data/eval')
  mkdirSync(dir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const file = join(dir, `${String(report.label)}-${stamp}.json`)
  writeFileSync(file, `${JSON.stringify({ ranAt: new Date().toISOString(), ...report }, null, 2)}\n`, 'utf8')
  return file
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
