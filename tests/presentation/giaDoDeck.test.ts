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
interface DeckLogic {
  createNavigator(steps: number[]): {
    state(): { slide: number; step: number }
    next(): Move
    prev(): Move
    goto(slide: number): Move
  }
  shouldHandleKey(e: KeyEventLike): boolean
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

  it('embeds GSAP 3.13.0 and honours reduced motion', () => {
    expect(extractScriptBlock(html, 'gsap')).toContain('3.13.0')
    expect(html).toContain('prefers-reduced-motion')
    expect(html).toMatch(/<html lang="vi"/)
    expect(html).toMatch(/<title>Bộ não ươm giá<\/title>/)
  })
})
