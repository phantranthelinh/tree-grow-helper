/**
 * Eval harness: measures the small model's first-decision tool selection on the
 * Vietnamese dataset. Requires LM Studio running with the chat model loaded.
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
import { LmStudioEngine } from '../llm'
import { assembleMessages, buildSystemPrompt } from '../llm/prompt'
import { KNOWN_TOOLS } from '../mcp/knownTools'
import { classifyTool } from '../mcp/policy'
import { EVAL_CASES, type EvalExpect } from './dataset'

function parse(raw: string): { type: 'reply' | 'tool'; tool?: string } | null {
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  const json = start >= 0 && end > start ? raw.slice(start, end + 1) : raw
  try {
    const p = AgentDecisionSchema.safeParse(JSON.parse(json))
    return p.success ? { type: p.data.type, tool: p.data.tool } : null
  } catch {
    return null
  }
}

function grade(expect: EvalExpect, actual: { type: 'reply' | 'tool'; tool?: string } | null) {
  if (!actual) return { exact: false, safety: false }
  if (expect.type === 'reply') {
    const exact = actual.type === 'reply'
    return { exact, safety: exact }
  }
  const exact = actual.type === 'tool' && actual.tool === expect.tool
  const safety = actual.type === 'tool' && !!actual.tool && classifyTool(actual.tool) === expect.safety
  return { exact, safety }
}

async function main(): Promise<void> {
  const profile = loadProfile(config.defaultPlant)
  const llm = new LmStudioEngine(config.lmStudio)
  const system = buildSystemPrompt({ profile, tools: KNOWN_TOOLS, fewshot: getFewshot() })

  console.log(`Eval: ${EVAL_CASES.length} cases | model=${config.lmStudio.model} | plant=${profile.plant}\n`)

  let exactHits = 0
  let safetyHits = 0
  for (const c of EVAL_CASES) {
    const messages = assembleMessages({ system, history: [], userMessage: c.message })
    let actual: { type: 'reply' | 'tool'; tool?: string } | null = null
    try {
      const raw = await llm.completeJson(messages, AGENT_DECISION_JSON_SCHEMA, AGENT_DECISION_SCHEMA_NAME)
      actual = parse(raw)
    } catch (err) {
      console.error(`\nLLM call failed. Is LM Studio running at ${config.lmStudio.baseURL} with "${config.lmStudio.model}"?`)
      console.error(String((err as Error).message))
      process.exit(1)
    }
    const { exact, safety } = grade(c.expect, actual)
    if (exact) exactHits++
    if (safety) safetyHits++
    const want = c.expect.type === 'tool' ? c.expect.tool : 'reply'
    const got = actual ? (actual.type === 'tool' ? actual.tool : 'reply') : '(parse-fail)'
    console.log(`${exact ? 'PASS' : 'FAIL'} [${c.id}] want=${want} got=${got}`)
  }

  const n = EVAL_CASES.length
  console.log(`\nTool/reply exact accuracy: ${exactHits}/${n} (${Math.round((exactHits / n) * 100)}%)`)
  console.log(`Safety-class accuracy:     ${safetyHits}/${n} (${Math.round((safetyHits / n) * 100)}%)`)
  console.log('\nGhi chú: mọi tool ĐIỀU KHIỂN luôn được chặn để xác nhận bất kể model chọn gì.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
