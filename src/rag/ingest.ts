import type { PlantProfile } from '../domain/profiles'
import type { LlmEngine } from '../llm'
import { type EmbedCache, embedWithCache } from './embedCache'
import { InMemoryVectorStore, type VectorRecord } from './store'

/** Long-text fields worth embedding for semantic retrieval. */
const TEXT_FIELDS: Array<keyof PlantProfile> = [
  'watering',
  'fertilizer',
  'pests',
  'diseases',
  'growth_stages',
  'planting',
  'harvest',
  'propagation',
  'care_notes',
  'light_description',
  'toxicity',
]

export interface Chunk {
  id: string
  field: string
  text: string
}

/** Split the text portion of a profile into one chunk per non-empty field. */
export function profileToChunks(p: PlantProfile): Chunk[] {
  const chunks: Chunk[] = []
  for (const field of TEXT_FIELDS) {
    const value = p[field]
    if (typeof value === 'string' && value.trim().length > 0) {
      chunks.push({ id: `${p.plant}:${String(field)}`, field: String(field), text: `[${String(field)}] ${value.trim()}` })
    }
  }
  if (p.varieties.length > 0) {
    chunks.push({ id: `${p.plant}:varieties`, field: 'varieties', text: `[varieties] ${p.varieties.join('; ')}` })
  }
  return chunks
}

export interface IngestProfileOptions {
  cache?: EmbedCache
  embedModel?: string
}

/** Embed the profile's text chunks and add them to the store. Returns count added. */
export async function ingestProfile(
  store: InMemoryVectorStore,
  llm: LlmEngine,
  p: PlantProfile,
  opts: IngestProfileOptions = {},
): Promise<number> {
  const chunks = profileToChunks(p)
  if (chunks.length === 0) return 0
  const cache = opts.cache ?? new Map<string, number[]>()
  const embeddings = await embedWithCache(llm, chunks.map((c) => c.text), cache, opts.embedModel ?? '')
  const records: VectorRecord[] = []
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]
    const embedding = embeddings[i]
    if (!chunk || !embedding) continue
    records.push({
      id: chunk.id,
      text: chunk.text,
      embedding,
      metadata: { plant: p.plant, field: chunk.field },
    })
  }
  store.add(records)
  return records.length
}
