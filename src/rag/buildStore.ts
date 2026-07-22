import { resolve } from 'node:path'
import type { Config } from '../config'
import { loadDiseases } from '../domain/diseases'
import type { PlantProfile } from '../domain/profiles'
import type { LlmEngine } from '../llm'
import { loadEmbedCache, saveEmbedCache } from './embedCache'
import { ingestProfile } from './ingest'
import { ingestDiseases } from './ingestDiseases'
import { ingestDocs, readReviewedDocs } from './ingestDocs'
import { InMemoryVectorStore } from './store'

export interface RagBuildResult {
  store: InMemoryVectorStore
  counts: { profile: number; docs: number; diseases: number }
  /** Human-readable summary, e.g. "14 profile + 0 doc + 9 disease (store=23)"; carries the mixed-dims warning. */
  detail: string
}

/**
 * Build a fresh RAG store from every curated source (profile text + reviewed docs +
 * disease KB). Pure: creates and returns its own store, never mutates a live one.
 * Disease-KB failure is non-fatal (matches the original init behavior).
 */
export async function ingestAll(
  llm: LlmEngine,
  appCfg: Config,
  profile: PlantProfile,
  embedModel: string,
): Promise<RagBuildResult> {
  const store = new InMemoryVectorStore()
  const cachePath = resolve(process.cwd(), appCfg.rag.embedCachePath)
  const cache = loadEmbedCache(cachePath)

  const nProfile = await ingestProfile(store, llm, profile, {
    cache,
    embedModel,
    chunkSize: appCfg.rag.chunkSize,
    chunkOverlap: appCfg.rag.chunkOverlap,
    minChunkLen: appCfg.rag.minChunkLen,
  })

  const docs = readReviewedDocs(resolve(process.cwd(), appCfg.rag.docsDir))
  const nDocs = await ingestDocs(store, llm, docs, {
    plant: profile.plant,
    cache,
    embedModel,
    chunkSize: appCfg.rag.chunkSize,
    chunkOverlap: appCfg.rag.chunkOverlap,
    minChunkLen: appCfg.rag.minChunkLen,
  })

  let nDiseases = 0
  try {
    nDiseases = await ingestDiseases(store, llm, loadDiseases(profile.plant), {
      plant: profile.plant,
      cache,
      embedModel,
    })
  } catch (err) {
    console.warn(`[rag] disease KB skipped (${(err as Error).message}).`)
  }

  saveEmbedCache(cachePath, cache)
  const mixed = store.uniformDims()
    ? ''
    : ' ⚠ CHIỀU EMBEDDING KHÔNG ĐỒNG NHẤT — một số chunk sẽ không truy hồi được; xóa cache cũ.'
  const detail = `${nProfile} profile + ${nDocs} doc + ${nDiseases} disease (store=${store.size()})${mixed}`
  return { store, counts: { profile: nProfile, docs: nDocs, diseases: nDiseases }, detail }
}
