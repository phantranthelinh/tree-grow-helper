import type { PlantProfile } from '../domain/profiles'
import type { LlmEngine } from '../llm'
import { type EmbedCache, embedWithCache } from './embedCache'
import { InMemoryVectorStore, type VectorRecord } from './store'
import { chunkDocument, dropShortChunks } from './textChunk'

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

export interface ProfileChunkOptions {
  chunkSize?: number
  chunkOverlap?: number
  minChunkLen?: number
}

/**
 * Split the text portion of a profile into RAG chunks. Long fields (care_notes,
 * light_description…) are sub-split with the shared document chunker so one big
 * multi-topic field can't crowd a top-K slot or dilute its own embedding. Every
 * non-empty field still yields at least one chunk carrying its `[field]` label.
 */
export function profileToChunks(p: PlantProfile, opts: ProfileChunkOptions = {}): Chunk[] {
  const chunks: Chunk[] = []
  const addField = (field: string, value: string) => {
    const trimmed = value.trim()
    const pieces = dropShortChunks(
      chunkDocument(trimmed, { size: opts.chunkSize, overlap: opts.chunkOverlap }),
      opts.minChunkLen,
    )
    // Keep the whole field if it's shorter than minChunkLen (don't drop it entirely).
    const finalPieces = pieces.length > 0 ? pieces : [trimmed]
    finalPieces.forEach((text, i) => {
      chunks.push({ id: `${p.plant}:${field}#${i}`, field, text: `[${field}] ${text}` })
    })
  }
  for (const field of TEXT_FIELDS) {
    const value = p[field]
    if (typeof value === 'string' && value.trim().length > 0) addField(String(field), value)
  }
  if (p.varieties.length > 0) addField('varieties', p.varieties.join('; '))
  return chunks
}

export interface IngestProfileOptions extends ProfileChunkOptions {
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
  const chunks = profileToChunks(p, opts)
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
