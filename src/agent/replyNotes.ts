import { type PlantProfile, plantDisplayName } from '../domain/profiles'
import { tokenize } from '../rag/lexical'
import type { RetrievedChunk } from '../rag/retrieve'

/**
 * Text the server appends to a knowledge reply, after the model's own words: the profile's range for a general
 * range question, and the sources of the retrieved chunks the reply drew on. Both come from data the server
 * already holds, because the 3B does neither reliably from the prompt: no placement of the range in the prompt or
 * the context made it state the profile's range on every general question, and it named a known source in 37 of
 * 494 replies.
 */

export type RangeField = 'temperature_range' | 'humidity_range' | 'soil_moisture_range' | 'light_range'

const QUANTITIES: Array<{ field: RangeField; label: string; unit: string; pattern: RegExp }> = [
  { field: 'temperature_range', label: 'nhiệt độ', unit: '°C', pattern: /nhiệt độ/u },
  { field: 'humidity_range', label: 'độ ẩm không khí', unit: '%', pattern: /(?:độ ẩm|ẩm độ) không khí/u },
  { field: 'soil_moisture_range', label: 'độ ẩm đất', unit: '%', pattern: /(?:độ ẩm|ẩm độ) (?:của )?đất/u },
  { field: 'light_range', label: 'ánh sáng', unit: ' lux', pattern: /ánh sáng|(?<!\p{L})lux(?!\p{L})/u },
]

const anyWord = (words: string[]): RegExp =>
  new RegExp(words.map((w) => String.raw`(?<!\p{L})${w}(?!\p{L})`).join('|'), 'u')

const ASKS_FOR_VALUE = anyWord(['bao nhiêu', 'khoảng nào', 'mức nào', 'mấy'])

// A question naming a device, a growing setting, a time, a stage, a region or a limit asks for something other
// than the plant's general optimum: "trong container … ban đêm" wants a document's 17°C, "esp32-01 … bây giờ"
// a sensor read, "chịu được … cao nhất" a limit, "bao nhiêu giờ ánh sáng" hours rather than lux.
const NOT_GENERAL = anyWord([
  'esp32', 'thiết bị', 'cảm biến', 'hiện tại', 'hiện giờ', 'bây giờ', 'lúc này', 'đang', 'cài', 'ngưỡng', 'luật',
  'đặt', 'chỉnh', 'bật', 'tắt', 'lịch sử', 'khay', 'giờ', 'ngày', 'tuần', 'lần', 'phút',
  'container', 'nhà kính', 'nhà màng', 'nhà lưới', 'mái che', 'nhà che', 'thủy canh', 'thuỷ canh', 'giá thể',
  'chậu', 'ban công', 'phòng', 'trong nhà', 'ngoài trời', 'kiểm soát', 'điều hòa', 'điều hoà', 'đèn', 'led', 'treo',
  'đêm', 'ban ngày', 'buổi', 'mùa', 'sáng sớm', 'trưa', 'chiều',
  'giai đoạn', 'ra hoa', 'cây con', 'nảy mầm', 'ra quả', 'nuôi quả', 'đậu quả', 'thu hoạch', 'ươm', 'ngâm',
  'bảo quản', 'vận chuyển', 'tháng',
  'vùng', 'miền', 'tỉnh',
  'ảnh hưởng', 'bệnh', 'dung dịch', 'nước tưới', 'tối đa', 'tối thiểu', 'chịu', 'cao nhất', 'thấp nhất', 'chết', 'quá',
])

/** The profile ranges a question asks for in general, or none when it names any qualifier above. */
export function generalRangeFields(question: string): RangeField[] {
  const text = question.normalize('NFC')
  const lower = text.toLowerCase()
  if (!ASKS_FOR_VALUE.test(lower) || NOT_GENERAL.test(lower)) return []
  // A capitalised word after the first one is a place name ("ở Mộc Châu", "tại Sơn La").
  if (text.split(/\s+/).slice(1).some((w) => /^\p{Lu}\p{Ll}/u.test(w))) return []
  return QUANTITIES.filter((q) => q.pattern.test(lower)).map((q) => q.field)
}

/**
 * True when the question names the profile's plant by its Vietnamese name or an alias. The profile's range is
 * the answer only for that plant: "Cà chua cần nhiệt độ bao nhiêu?" or a question about boiling water is not.
 */
function namesPlant(question: string, profile: PlantProfile): boolean {
  const lower = question.normalize('NFC').toLowerCase()
  const names = [profile.name_vi, ...profile.aliases].filter((n): n is string => !!n)
  return names.some((n) => {
    const escaped = n.normalize('NFC').toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)
    return new RegExp(String.raw`(?<!\p{L})${escaped}(?!\p{L})`, 'u').test(lower)
  })
}

/** True when `value` stands as a number of its own in `text` ("10-27°C" mentions 10; "100" does not). */
function mentions(text: string, value: number): boolean {
  const digits = String(value).replace('.', '[.,]')
  return new RegExp(String.raw`(?<![\d.,])${digits}(?![\d]|[.,]\d)`).test(text)
}

/**
 * The profile's range for each quantity a general range question asks about and the reply leaves out (one bound
 * missing counts). The sentence names the system as its origin, so the sources line after it is not read as
 * the source of the profile's numbers.
 */
export function rangeStatement(question: string, reply: string, profile: PlantProfile): string | null {
  if (!namesPlant(question, profile)) return null
  const asked = generalRangeFields(question)
  const parts: string[] = []
  for (const q of QUANTITIES) {
    const range = profile[q.field]
    if (!asked.includes(q.field) || !range) continue
    if (mentions(reply, range[0]) && mentions(reply, range[1])) continue
    parts.push(`${q.label} ${range[0]}-${range[1]}${q.unit}`)
  }
  return parts.length > 0
    ? `Khoảng tối ưu chung hệ thống áp dụng cho cây ${plantDisplayName(profile)}: ${parts.join('; ')}.`
    : null
}

// Punctuation ends a phrase: "nhiệt độ, độ ẩm" must not yield the bigram "độ độ".
const PHRASE_BREAK = /[.,;:!?()[\]\n]+/

/** Adjacent-syllable pairs inside each phrase, the unit the sources line matches replies to chunks on. */
export function phraseBigrams(text: string): Set<string> {
  const out = new Set<string>()
  for (const phrase of text.normalize('NFC').split(PHRASE_BREAK)) {
    const t = tokenize(phrase)
    for (let i = 0; i + 1 < t.length; i++) out.add(`${t[i]} ${t[i + 1]}`)
  }
  return out
}

/** How many corpus texts contain each phrase bigram. */
export function bigramDocFreq(texts: readonly string[]): Map<string, number> {
  const df = new Map<string, number>()
  for (const text of texts) for (const b of phraseBigrams(text)) df.set(b, (df.get(b) ?? 0) + 1)
  return df
}

// Measured on the 494 stored replies of rounds 1–3: pairs in more than three chunks ("dâu tây", "chăm sóc",
// "nhiệt độ") made greetings look sourced; three shared rare pairs separate a reply built from a chunk from one that
// only shares the topic, and leave out answers taken from the system prompt's ranges or a few-shot example.
const RARE_IN_CORPUS = 3
const MIN_SHARED = 3
const MAX_SOURCES = 3

const HOST = /^[a-z]+:\/\/(?:www\.)?([^/?#]+)/i
// Profile text cites its sources inline, "(Khuyến nông Lâm Đồng; VAAS)"; other parentheses hold Latin names,
// places and asides, so only names that start like a Vietnamese institution count.
const INSTITUTION = /^(?:Khuyến nông|Tạp chí|Chi cục|Cổng|Viện|Trung tâm|Sở|Bộ|Cục|ĐH|Đại học|Trường|UBND|VAAS|VISTA|NASATI)(?!\p{L})/u

/** What the notes read from a retrieved chunk; scores and categories play no part. */
export type NotedChunk = Pick<RetrievedChunk, 'id' | 'text' | 'source' | 'field'>

/** Source names for one chunk: a document's or disease entry's host, or the institutions a profile chunk cites. */
export function sourceNames(chunk: NotedChunk): string[] {
  if (chunk.source) {
    const host = HOST.exec(chunk.source)?.[1]
    return host ? [host] : []
  }
  // The toxicity entry has no pet data, so a source line under it would lend authority to a pet verdict.
  if (!chunk.field || chunk.field === 'toxicity') return []
  const names: string[] = []
  for (const m of chunk.text.matchAll(/\(([^()]+)\)/g)) {
    for (const part of (m[1] ?? '').split(';')) {
      const name = part.trim()
      if (INSTITUTION.test(name)) names.push(name)
    }
  }
  return names
}

/**
 * "Nguồn tham khảo: …" naming the chunks the reply drew on — those sharing at least MIN_SHARED rare phrase
 * bigrams with it, not counting pairs the question already contains — most-shared first, at most MAX_SOURCES
 * names, none the reply already names. Null when no chunk qualifies or none has a name.
 */
export function sourcesLine(
  reply: string,
  question: string,
  chunks: readonly NotedChunk[],
  docFreq: ReadonlyMap<string, number>,
): string | null {
  const asked = phraseBigrams(question)
  const distinctive = [...phraseBigrams(reply)].filter((b) => {
    const df = docFreq.get(b) ?? 0
    return df > 0 && df <= RARE_IN_CORPUS && !asked.has(b)
  })
  const drawnOn = chunks
    .map((chunk, rank) => {
      const own = phraseBigrams(chunk.text)
      return { chunk, rank, shared: distinctive.filter((b) => own.has(b)).length }
    })
    .filter((c) => c.shared >= MIN_SHARED)
    .sort((a, b) => b.shared - a.shared || a.rank - b.rank)
  const names: string[] = []
  for (const { chunk } of drawnOn) {
    for (const name of sourceNames(chunk)) {
      if (!names.some((n) => n.toLowerCase() === name.toLowerCase())) names.push(name)
    }
  }
  const said = reply.toLowerCase()
  const shown = names
    .filter((n) => !names.some((o) => o !== n && o.toLowerCase().includes(n.toLowerCase())))
    .filter((n) => !said.includes(n.toLowerCase()))
    .slice(0, MAX_SOURCES)
  return shown.length > 0 ? `Nguồn tham khảo: ${shown.join('; ')}.` : null
}

export interface ReplyNotesInput {
  question: string
  chunks: readonly NotedChunk[]
  docFreq: ReadonlyMap<string, number>
  profile: PlantProfile
}

/** The reply followed by its range statement and sources line, each as its own paragraph, when they apply. */
export function withReplyNotes(reply: string, input: ReplyNotesInput): string {
  const notes = [
    rangeStatement(input.question, reply, input.profile),
    sourcesLine(reply, input.question, input.chunks, input.docFreq),
  ].filter((n): n is string => n !== null)
  return [reply, ...notes].join('\n\n')
}
