import { type Disease, diseaseToText } from '../domain/diseases'
import { type EmbedCache, type Embedder, embedWithCache } from './embedCache'
import type { DocChunk } from './ingestDocs'
import { InMemoryVectorStore, type VectorRecord } from './store'

export interface IngestDiseasesOptions {
  plant?: string
  cache?: EmbedCache
}

/** Turn each disease into a symptom-focused chunk carrying diagnosis metadata. */
export function buildDiseaseChunks(diseases: Disease[], opts: IngestDiseasesOptions = {}): DocChunk[] {
  return diseases.map((d) => ({
    id: `disease:${d.id}`,
    text: diseaseToText(d),
    metadata: {
      plant: opts.plant ?? null,
      category: 'disease',
      disease_id: d.id,
      name_vi: d.name_vi,
      severity: d.severity,
      favorable_conditions: d.favorable_conditions,
    },
  }))
}

/**
 * Embed the structured disease KB and add it to the store. Curated data, so no
 * dedup. Retrieval surfaces these as diagnosis candidates matched on symptoms.
 */
export async function ingestDiseases(
  store: InMemoryVectorStore,
  llm: Embedder,
  diseases: Disease[],
  opts: IngestDiseasesOptions = {},
): Promise<number> {
  const chunks = buildDiseaseChunks(diseases, opts)
  if (chunks.length === 0) return 0

  const cache = opts.cache ?? new Map<string, number[]>()
  const embeddings = await embedWithCache(llm, chunks.map((c) => c.text), cache)

  const records: VectorRecord[] = []
  chunks.forEach((c, i) => {
    const embedding = embeddings[i]
    if (embedding && embedding.length > 0) {
      records.push({ id: c.id, text: c.text, embedding, metadata: c.metadata })
    }
  })
  store.add(records)
  return records.length
}
