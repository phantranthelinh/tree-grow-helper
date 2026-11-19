import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'
import { extractScriptBlock } from '../../scripts/deck-blocks'

const DECK_PATH = fileURLToPath(new URL('../../docs/presentation/gia-do-deck.html', import.meta.url))

type Move = { slide: number; step: number; kind: 'enter' | 'play' | 'seek' | 'enter-end' | 'none' }
type KeyEventLike = {
  key: string
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  target: { tagName?: string; isContentEditable?: boolean } | null
}
type SseFrame = { event: string; data: string }
type Panel = {
  mode: 'idle' | 'live' | 'recording' | 'error'
  text: string
  status: string | null
  pending: boolean
  done: boolean
  error: string | null
  recordedAt: string | null
}
type PanelAction =
  | { type: 'start' }
  | { type: 'delta'; text: string }
  | { type: 'chat-frame'; frame: SseFrame }
  | { type: 'end' }
  | { type: 'fallback'; text: string; recordedAt: string }
  | { type: 'fail'; message: string }
type Recordings = { recordedAt: string | null; model: string | null; left: Record<string, string>; right: Record<string, string> }
interface DeckLogic {
  createNavigator(steps: number[]): {
    state(): { slide: number; step: number }
    next(): Move
    prev(): Move
    goto(slide: number): Move
  }
  shouldHandleKey(e: KeyEventLike): boolean
  FIRST_TOKEN_TIMEOUT_MS: number
  createSseDecoder(): { push(chunk: string): SseFrame[]; flush(): SseFrame[] }
  openAiDeltaText(frame: SseFrame): string | null
  initialPanel(): Panel
  reducePanel(p: Panel, a: PanelAction): Panel
  pickRecording(rec: Recordings | null, side: 'left' | 'right', presetId: string | null): { text: string; recordedAt: string } | null
  isOnlineCopy(loc: { protocol: string; hostname: string }): boolean
  completionReply(json: unknown): { text: string; pending: boolean } | null
}
interface SlideInfo {
  id: string
  part: string
  steps: number
  min: number
  text: string
  notes: string
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: ' ' }

function plainText(fragment: string): string {
  return fragment
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (_, e: string) => ENTITIES[e] ?? '')
    .replace(/\s+/g, ' ')
    .trim()
}

function attr(tag: string, name: string): string {
  const m = tag.match(new RegExp(`\\b${name}="([^"]*)"`))
  if (!m) throw new Error(`missing ${name} in ${tag}`)
  return m[1] as string
}

function loadDeck(): { html: string; logic: DeckLogic; slides: SlideInfo[] } {
  const html = readFileSync(DECK_PATH, 'utf8')
  const ctx = vm.createContext({})
  vm.runInContext(extractScriptBlock(html, 'deck-logic'), ctx)
  const logic = (ctx as { DeckLogic?: DeckLogic }).DeckLogic
  if (!logic) throw new Error('deck-logic did not define DeckLogic')
  const slides = [...html.matchAll(/(<section class="slide"[^>]*>)([\s\S]*?)<\/section>/g)].map(([, open, body]) => {
    const tag = open as string
    const inner = body as string
    const aside = inner.match(/(<aside class="notes"[^>]*>)([\s\S]*?)<\/aside>/)
    return {
      id: attr(tag, 'id'),
      part: attr(tag, 'data-part'),
      steps: Number(attr(tag, 'data-steps')),
      min: aside ? Number(attr(aside[1] as string, 'data-min')) : NaN,
      text: plainText(aside ? inner.replace(aside[0], ' ') : inner),
      notes: aside ? plainText(aside[2] as string) : '',
    }
  })
  return { html, logic, slides }
}

const { html, logic, slides } = loadDeck()

function slideById(id: string): SlideInfo {
  const s = slides.find((x) => x.id === id)
  if (!s) throw new Error(`no slide ${id}`)
  return s
}
const text = (id: string): string => slideById(id).text
const notes = (id: string): string => slideById(id).notes

const SLIDE_TABLE: Array<[string, string, number, number]> = [
  ['s01-title', 'mo-dau', 1, 0.5],
  ['s02-question', 'mo-dau', 2, 1],
  ['s03-local', 'mo-dau', 2, 1.5],
  ['s04-next-word', 'bo-nao', 3, 2],
  ['s05-train-or-read', 'bo-nao', 2, 2],
  ['s06-rag', 'thu-vien', 3, 1.5],
  ['s07-ingest', 'thu-vien', 2, 1],
  ['s08-chunk', 'thu-vien', 2, 1],
  ['s09-embed', 'thu-vien', 3, 1.5],
  ['s10-hybrid', 'thu-vien', 3, 1.5],
  ['s11-select', 'thu-vien', 2, 1],
  ['s12-profile', 'thu-vien', 3, 1.5],
  ['s13-sources', 'thu-vien', 2, 1],
  ['s14-fewshot', 'cu-xu', 3, 1.5],
  ['s15-structured', 'cu-xu', 2, 1],
  ['s16-mcp', 'cu-xu', 2, 1.5],
  ['s17-guardrails', 'cu-xu', 2, 1],
  ['s18-eval', 'cham-bai', 2, 2],
  ['s19-demo', 'cham-bai', 0, 4],
  ['s20-still-wrong', 'cham-bai', 2, 1.5],
  ['s21-recap', 'ket', 3, 2],
]

describe('gia-do deck shell', () => {
  it('navigates steps, then slides, and back to the end state', () => {
    const nav = logic.createNavigator([0, 2, 1])
    expect([nav.next(), nav.next(), nav.next(), nav.next(), nav.next(), nav.next()].map((m) => [m.slide, m.step, m.kind]))
      .toEqual([[1, 0, 'enter'], [1, 1, 'play'], [1, 2, 'play'], [2, 0, 'enter'], [2, 1, 'play'], [2, 1, 'none']])
    expect([nav.prev(), nav.prev()].map((m) => [m.slide, m.step, m.kind])).toEqual([[2, 0, 'seek'], [1, 2, 'enter-end']])
    expect(logic.createNavigator([1]).prev().kind).toBe('none')
  })

  it('shouldHandleKey ignores typing targets and modifier chords', () => {
    const base = { metaKey: false, ctrlKey: false, altKey: false }
    expect(logic.shouldHandleKey({ ...base, key: 'ArrowRight', target: { tagName: 'BODY' } })).toBe(true)
    expect(logic.shouldHandleKey({ ...base, key: ' ', target: { tagName: 'INPUT' } })).toBe(false)
    expect(logic.shouldHandleKey({ ...base, key: 'ArrowLeft', target: { tagName: 'TEXTAREA' } })).toBe(false)
    expect(logic.shouldHandleKey({ ...base, key: 'n', target: { tagName: 'DIV', isContentEditable: true } })).toBe(false)
    expect(logic.shouldHandleKey({ ...base, ctrlKey: true, key: 'ArrowRight', target: null })).toBe(false)
  })

  it('matches the slide table', () => {
    expect(slides.map((s) => [s.id, s.part, s.steps, s.min])).toEqual(SLIDE_TABLE)
  })

  it('every slide has speaker notes', () => {
    for (const s of slides) expect(s.notes.trim().length).toBeGreaterThan(0)
  })

  it('has no external resources except Google Fonts', () => {
    const urls = [...html.matchAll(/\b(?:src|href)="(https?:[^"]+)"/g)].map((m) => m[1])
    for (const u of urls) expect(u).toMatch(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//)
  })

  it('slides 1-5 carry their pinned facts', () => {
    expect(text('s04-next-word')).toContain('minh hoạ')
    expect(text('s05-train-or-read')).toMatch(/không train/i)
    expect(text('s05-train-or-read')).toContain('3B')
  })

  it('slides 6-9 carry their pinned facts', () => {
    expect(text('s07-ingest')).toMatch(/người duyệt/)
    expect(text('s08-chunk')).toMatch(/600/)
    expect(text('s08-chunk')).toMatch(/80/)
    expect(text('s09-embed')).toContain('bge-m3')
    expect(text('s09-embed')).toContain('1024')
    expect(text('s09-embed')).toContain('minh hoạ')
  })

  it('slides 10-13 carry their pinned facts', () => {
    expect(text('s10-hybrid')).toContain('BM25')
    expect(text('s10-hybrid')).toContain('6-BAP')
    expect(text('s11-select')).toContain('MMR')
    for (const s of ['27–30°C', '22–24°C', 'ĐH Cần Thơ', 'VAAS', 'bản nháp']) expect(text('s12-profile')).toContain(s)
    expect(text('s13-sources')).toContain('Nguồn tham khảo')
  })

  it('slides 14-17 carry their pinned facts', () => {
    expect(text('s14-fewshot')).toContain('7 ví dụ')
    expect(text('s14-fewshot')).toMatch(/bật đèn/)
    expect(text('s15-structured')).toContain('minh hoạ')
    expect(text('s16-mcp')).toContain('Có/Không')
    for (const s of ['часов', '小时', 'giờ']) expect(text('s17-guardrails')).toContain(s)
  })

  it('slides 18, 20, 21 carry their pinned facts', () => {
    for (const s of ['12/12', '5/6', '6/6', 'chưa đo', '52/52', 'một lần chạy']) expect(text('s18-eval')).toContain(s)
    expect(text('s20-still-wrong')).toMatch(/ra chợ/)
    for (const s of ['sách đúng', 'quản lý dữ liệu', 'Đo, đừng đoán']) expect(text('s21-recap')).toContain(s)
  })

  it('waits 20 seconds for the first token', () => {
    expect(logic.FIRST_TOKEN_TIMEOUT_MS).toBe(20000)
  })

  it('decodes frames across every split point', () => {
    const raw = ': ping\r\nevent: token\r\ndata: {"text":"Giá 🌱 ủ"}\r\n\r\nevent: done\ndata: {"reply":"x","pendingAction":null}\n\n'
    for (let i = 0; i <= raw.length; i++) {
      const d = logic.createSseDecoder()
      const frames = [...d.push(raw.slice(0, i)), ...d.push(raw.slice(i)), ...d.flush()]
      expect(frames).toEqual([{ event: 'token', data: '{"text":"Giá 🌱 ủ"}' }, { event: 'done', data: '{"reply":"x","pendingAction":null}' }])
    }
  })

  it('reads OpenAI deltas and the DONE sentinel', () => {
    expect(logic.openAiDeltaText({ event: 'message', data: '{"choices":[{"delta":{"content":"27"}}]}' })).toBe('27')
    expect(logic.openAiDeltaText({ event: 'message', data: '{"choices":[{"delta":{}}]}' })).toBe('')
    expect(logic.openAiDeltaText({ event: 'message', data: '[DONE]' })).toBeNull()
  })

  it('reduces /chat/stream frames', () => {
    const f = (event: string, data: object): PanelAction => ({ type: 'chat-frame', frame: { event, data: JSON.stringify(data) } })
    let p = logic.reducePanel(logic.initialPanel(), { type: 'start' })
    p = [f('token', { text: 'Sai ' }), f('reset', {}), f('tool_status', { tool: 't', note: 'đang đọc' }), f('token', { text: 'Đúng' })]
      .reduce((acc, a) => logic.reducePanel(acc, a), p)
    expect([p.text, p.status]).toEqual(['Đúng', 'đang đọc'])
    p = logic.reducePanel(p, f('done', { reply: 'Bạn xác nhận thực hiện: "x"? (Có/Không)', pendingAction: { id: '1' } }))
    expect([p.done, p.pending, p.status]).toEqual([true, true, null])
  })

  it('ignores live frames after fallback', () => {
    let p = logic.reducePanel(logic.initialPanel(), { type: 'start' })
    p = logic.reducePanel(p, { type: 'fallback', text: 'bản ghi', recordedAt: '2026-11-19' })
    p = logic.reducePanel(p, { type: 'delta', text: ' muộn' })
    expect([p.mode, p.text]).toEqual(['recording', 'bản ghi'])
  })

  it('picks recordings and detects the online copy', () => {
    const rec = { recordedAt: '2026-11-19', model: 'm', left: { a: 'L' }, right: {} }
    expect(logic.pickRecording(rec, 'left', 'a')).toEqual({ text: 'L', recordedAt: '2026-11-19' })
    expect(logic.pickRecording(rec, 'right', 'a')).toBeNull()
    expect(logic.pickRecording(rec, 'left', null)).toBeNull()
    expect(logic.isOnlineCopy({ protocol: 'file:', hostname: '' })).toBe(false)
    expect(logic.isOnlineCopy({ protocol: 'http:', hostname: 'localhost' })).toBe(false)
    expect(logic.isOnlineCopy({ protocol: 'https:', hostname: 'claude.ai' })).toBe(true)
  })

  it('reads a buffered completion and its pending confirmation', () => {
    expect(logic.completionReply({ choices: [{ message: { content: 'ok' } }] })).toEqual({ text: 'ok', pending: false })
    expect(logic.completionReply({ choices: [{ message: { content: 'x? (Có/Không)', tool_calls: [{ id: 'p' }] } }] }))
      .toEqual({ text: 'x? (Có/Không)', pending: true })
    expect(logic.completionReply({ choices: [] })).toBeNull()
    expect(logic.completionReply(null)).toBeNull()
  })

  it('demo config and recordings blocks are valid', () => {
    const cfg = JSON.parse(extractScriptBlock(html, 'demo-config'))
    expect(cfg.presets.map((p: { id: string }) => p.id)).toEqual(['bs-kb-temp', 'bs-kb-soak', 'bs-kb-banned', 'bs-kb-light', 'bs-water'])
    expect(cfg.presets.find((p: { id: string }) => p.id === 'bs-water').sides).toEqual(['right'])
    expect(cfg.bareSystemPrompt).toBe('Bạn là trợ lý nông nghiệp. Trả lời ngắn gọn bằng tiếng Việt.')
    const rec = JSON.parse(extractScriptBlock(html, 'demo-recordings'))
    expect(rec).toHaveProperty('left')
    expect(rec).toHaveProperty('right')
    expect(text('s19-demo')).toMatch(/RAG/)
    expect(text('s19-demo')).toMatch(/hồ sơ/)
    expect(text('s19-demo')).toMatch(/ví dụ mẫu/)
  })

  it('slide 18 grades both rounds with the same answer key', () => {
    const count = (s: string, needle: string) => s.split(needle).length - 1
    expect(count(text('s18-eval'), '6/6')).toBeGreaterThanOrEqual(2)
    expect(count(text('s18-eval'), '7/7')).toBeGreaterThanOrEqual(2)
    expect(text('s18-eval')).toMatch(/tiêu chí cũ/)
  })

  it('speaker notes claim only what the recordings and code show', () => {
    expect(notes('s19-demo')).not.toMatch(/27–30°C kèm dòng nguồn/)
    expect(notes('s14-fewshot')).not.toMatch(/model sẽ khuyên bật đèn/)
  })

  it('loads Google Fonts without blocking the first render', () => {
    const head = html.slice(0, html.indexOf('</head>'))
    expect(head).not.toMatch(/<link[^>]+rel="stylesheet"[^>]+fonts\.googleapis\.com/)
    expect(html).toContain('fonts.googleapis.com/css2')
  })

  it('notes are complete and the talk runs about 30 minutes', () => {
    const total = slides.reduce((n, s) => n + s.min, 0)
    expect(total).toBeGreaterThanOrEqual(27)
    expect(total).toBeLessThanOrEqual(33)
    for (const s of slides) expect(s.notes).not.toMatch(/TODO|tạm/i)
    expect(notes('s19-demo')).toMatch(/DEFAULT_PLANT=bean-sprout/)
    expect(notes('s19-demo')).toMatch(/Enable CORS/)
  })

  it('embeds GSAP 3.13.0 and honours reduced motion', () => {
    expect(extractScriptBlock(html, 'gsap')).toContain('3.13.0')
    expect(html).toContain('prefers-reduced-motion')
    expect(html).toMatch(/<html lang="vi"/)
    expect(html).toMatch(/<title>Bộ não ươm giá<\/title>/)
  })
})
