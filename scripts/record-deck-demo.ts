import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { summarizeAction } from '../src/agent/confirmation'
import { extractScriptBlock, replaceScriptBlock, toJsonBlock } from './deck-blocks'

export type Side = 'left' | 'right'

export interface Preset {
  id: string
  question: string
  sides: Side[]
}

export interface DemoConfig {
  lmUrl: string
  serverUrl: string
  model: string
  bareSystemPrompt: string
  temperature: number
  maxTokens: number
  presets: Preset[]
}

export interface Recordings {
  recordedAt: string
  model: string
  left: Record<string, string>
  right: Record<string, string>
  rightSource: 'live' | 'eval'
}

/**
 * Asks every preset on each of its sides, one call at a time (a local model serves one request
 * well, not several). A failed or blank answer leaves its key out, so the deck shows "chưa ghi"
 * for it instead of anything written by hand.
 */
export async function buildRecordings(
  cfg: DemoConfig,
  answer: (side: Side, preset: Preset) => Promise<string>,
  today: string,
  rightSource: 'live' | 'eval' = 'live',
): Promise<Recordings> {
  const rec: Recordings = { recordedAt: today, model: cfg.model, left: {}, right: {}, rightSource }
  for (const preset of cfg.presets) {
    for (const side of preset.sides) {
      try {
        const text = (await answer(side, preset)).trim()
        if (text) rec[side][preset.id] = text
      } catch (err) {
        console.warn(`[deck:record] ${side} · ${preset.id}: ${(err as Error).message}`)
      }
    }
  }
  return rec
}

/** Preset sides with no recorded answer, as "side · id". */
export function missingRecordings(cfg: DemoConfig, rec: Recordings): string[] {
  return cfg.presets.flatMap((p) => p.sides.filter((side) => !rec[side][p.id]).map((side) => `${side} · ${p.id}`))
}

interface EvalCase {
  id: string
  got?: string
  reply?: string
}

async function postJson(url: string, body: unknown): Promise<any> {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
  return res.json()
}

function contentOf(completion: any): string {
  const text = completion?.choices?.[0]?.message?.content
  if (typeof text !== 'string') throw new Error('no choices[0].message.content')
  return text
}

function localDate(d = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/**
 * The eval stores only the model's lead-in for a control case. The server's reply is that lead-in
 * plus its fixed confirmation line, built the way the orchestrator builds `finalReply`. The eval
 * keeps the tool name but not its arguments, so the device comes from the question and the pump
 * is switched on, as the question asks.
 */
function evalAnswer(cases: EvalCase[], preset: Preset): string {
  const c = cases.find((x) => x.id === preset.id)
  if (!c?.reply) throw new Error(`eval has no reply for ${preset.id}`)
  if (c.got !== 'set_pump') return c.reply
  const device = /esp32-\d+/.exec(preset.question)?.[0]
  const summary = summarizeAction('set_pump', { ...(device ? { device_id: device } : {}), on: true })
  return `${c.reply}\n\nBạn xác nhận thực hiện: "${summary}"? (Có/Không)`
}

interface CliArgs {
  lm?: string
  server?: string
  fromEval?: string
  deck: string
  partial: boolean
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = { deck: 'docs/presentation/gia-do-deck.html', partial: false }
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i + 1]
    if (argv[i] === '--partial') out.partial = true
    else if (argv[i] === '--lm' && v) { out.lm = v; i++ }
    else if (argv[i] === '--server' && v) { out.server = v; i++ }
    else if (argv[i] === '--right-from-eval' && v) { out.fromEval = v; i++ }
    else if (argv[i] === '--deck' && v) { out.deck = v; i++ }
  }
  return out
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const html = readFileSync(args.deck, 'utf8')
  const cfg = JSON.parse(extractScriptBlock(html, 'demo-config')) as DemoConfig
  const lm = (args.lm ?? cfg.lmUrl).replace(/\/+$/, '')
  const server = (args.server ?? cfg.serverUrl).replace(/\/+$/, '')
  const evalCases: EvalCase[] | null = args.fromEval ? JSON.parse(readFileSync(args.fromEval, 'utf8')).cases : null

  const answer = async (side: Side, preset: Preset): Promise<string> => {
    if (side === 'left') {
      return contentOf(await postJson(`${lm}/v1/chat/completions`, {
        model: cfg.model,
        messages: [{ role: 'system', content: cfg.bareSystemPrompt }, { role: 'user', content: preset.question }],
        temperature: cfg.temperature,
        max_tokens: cfg.maxTokens,
        stream: false,
      }))
    }
    if (evalCases) return evalAnswer(evalCases, preset)
    return contentOf(await postJson(`${server}/v1/chat/completions`, {
      model: 'plant-assistant',
      user: 'deck-record',
      session_id: randomUUID(),
      messages: [{ role: 'user', content: preset.question }],
    }))
  }

  const rec = await buildRecordings(cfg, answer, localDate(), evalCases ? 'eval' : 'live')
  for (const side of ['left', 'right'] as const) {
    for (const [id, text] of Object.entries(rec[side])) console.log(`\n=== ${side} · ${id}\n${text}`)
  }
  // A side that is down would otherwise replace every fallback answer of the last good run.
  const missing = missingRecordings(cfg, rec)
  if (missing.length > 0 && !args.partial) {
    console.error(`\n[deck:record] chưa ghi được: ${missing.join(', ')}. Bản ghi cũ giữ nguyên; chạy lại khi cả hai phía sẵn sàng, hoặc thêm --partial để ghi phần đã có.`)
    process.exitCode = 1
    return
  }
  writeFileSync(args.deck, replaceScriptBlock(html, 'demo-recordings', toJsonBlock(rec)))
  console.log(`\n[deck:record] ${Object.keys(rec.left).length} left, ${Object.keys(rec.right).length} right (${rec.rightSource}) → ${args.deck}`)
}

if (process.argv[1] && resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
