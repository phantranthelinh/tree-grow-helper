import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BEAN_SPROUT_EVAL_CASES, EVAL_CASES, evalCasesFor } from '../src/eval/dataset'
import { gradeGrounding } from '../src/eval/grounding'
import { config } from '../src/config'
import { loadDiseases } from '../src/domain/diseases'
import { loadProfile } from '../src/domain/profiles'
import { KNOWN_TOOLS } from '../src/mcp/knownTools'
import { classifyTool } from '../src/mcp/policy'
import { profileToChunks } from '../src/rag/ingest'
import { buildDiseaseChunks } from '../src/rag/ingestDiseases'
import { buildDocChunks, readReviewedDocs } from '../src/rag/ingestDocs'

const chunkOpts = { chunkSize: config.rag.chunkSize, chunkOverlap: config.rag.chunkOverlap, minChunkLen: config.rag.minChunkLen }

/** Chunk ids the ingest pipeline produces for a plant, built without embeddings. */
function chunkIdsFor(plant: string): Set<string> {
  const profile = loadProfile(plant)
  const docs = readReviewedDocs(resolve(process.cwd(), config.rag.docsDir)).filter(
    (d) => !d.plant || d.plant.trim().toLowerCase() === plant,
  )
  // Plants without a disease KB are valid: init skips the disease source when the file is absent.
  let diseases: ReturnType<typeof loadDiseases> = []
  try {
    diseases = loadDiseases(plant)
  } catch {}
  return new Set([
    ...profileToChunks(profile, chunkOpts).map((c) => c.id),
    ...buildDocChunks(docs, { plant, ...chunkOpts }).map((c) => c.id),
    ...buildDiseaseChunks(diseases, { plant }).map((c) => c.id),
  ])
}

const caseOf = (id: string) => [...EVAL_CASES, ...BEAN_SPROUT_EVAL_CASES].find((c) => c.id === id)
const DIAGNOSES = ['diag-gray-mold', 'diag-powdery', 'diag-anthracnose', 'diag-spider-mite', 'r1-root-rot', 'r1-thrips', 'r1-aphid', 'r1-slug', 'r1-bact-spot', 'r1-leaf-spot']

describe('eval dataset', () => {
  it('has at least 32 cases', () => {
    expect(EVAL_CASES.length).toBeGreaterThanOrEqual(32)
  })

  it('has unique ids', () => {
    const ids = EVAL_CASES.map((c) => c.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('covers every known MCP tool at least once', () => {
    const expected = new Set(
      EVAL_CASES.filter((c) => c.expect.type === 'tool').map((c) => c.expect.tool),
    )
    for (const tool of KNOWN_TOOLS) {
      expect(expected.has(tool.name), `missing eval case for tool ${tool.name}`).toBe(true)
    }
  })

  it('has at least 8 knowledge (reply) cases', () => {
    const replies = EVAL_CASES.filter((c) => c.expect.type === 'reply')
    expect(replies.length).toBeGreaterThanOrEqual(8)
  })

  it('labels each tool case with the correct safety class', () => {
    for (const c of EVAL_CASES) {
      if (c.expect.type === 'tool' && c.expect.tool && c.expect.safety) {
        expect(classifyTool(c.expect.tool), `bad safety for ${c.id}`).toBe(c.expect.safety)
      }
    }
  })

  it('only attaches grounding expectations to reply cases', () => {
    for (const c of EVAL_CASES) {
      if (c.grounding) {
        expect(c.expect.type, `grounding on non-reply case ${c.id}`).toBe('reply')
      }
    }
  })

  it('bean-sprout set has unique ids, correct safety classes and is picked by plant', () => {
    const ids = BEAN_SPROUT_EVAL_CASES.map((c) => c.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const c of BEAN_SPROUT_EVAL_CASES) {
      if (c.expect.type === 'tool' && c.expect.tool && c.expect.safety) {
        expect(classifyTool(c.expect.tool), `bad safety for ${c.id}`).toBe(c.expect.safety)
      }
    }
    expect(evalCasesFor('bean-sprout')).toBe(BEAN_SPROUT_EVAL_CASES)
    expect(evalCasesFor('strawberry')).toBe(EVAL_CASES)
    expect(evalCasesFor('unknown-plant')).toBe(EVAL_CASES)
  })

  it('keeps the grounding metric meaningful: >=6 cases, >=2 requiring a citation', () => {
    const grounded = EVAL_CASES.filter((c) => c.grounding)
    expect(grounded.length).toBeGreaterThanOrEqual(6)
    const citing = grounded.filter((c) => c.grounding?.requireCitation)
    expect(citing.length).toBeGreaterThanOrEqual(2)
  })

  it('every chunk label names a chunk the ingest pipeline produces', () => {
    const sets: Array<[string, typeof EVAL_CASES]> = [
      ['strawberry', EVAL_CASES],
      ['bean-sprout', BEAN_SPROUT_EVAL_CASES],
    ]
    for (const [plant, cases] of sets) {
      const ids = chunkIdsFor(plant)
      for (const c of cases) {
        for (const label of (c.expectChunks ?? []).flat()) {
          if (label.includes('#')) expect(ids.has(label), `${c.id}: ${label}`).toBe(true)
          else expect([...ids].some((id) => id.startsWith(label)), `${c.id}: ${label}`).toBe(true)
        }
      }
    }
  })

  it('keeps round-0 comparability: r0 cases unchanged in number, r1 cases tagged', () => {
    expect(EVAL_CASES.filter((c) => !c.set)).toHaveLength(52)
    expect(BEAN_SPROUT_EVAL_CASES.filter((c) => !c.set)).toHaveLength(12)
    expect(EVAL_CASES.filter((c) => c.set === 'r1')).toHaveLength(20)
    expect(BEAN_SPROUT_EVAL_CASES.filter((c) => c.set === 'r1')).toHaveLength(4)
  })

  it('kb-moisture carries no retrieval label (no chunk states a soil-moisture %)', () => {
    expect(EVAL_CASES.find((c) => c.id === 'kb-moisture')?.expectChunks).toBeUndefined()
  })

  it('r1-old-runners also accepts the NGHEAN chunk with the mother-plant age rule', () => {
    expect(caseOf('r1-old-runners')?.expectChunks).toEqual([
      ['strawberry:propagation', 'https://ngheandost.gov.vn/nong-nghiep/quy-trinh-ky-thuat-trong-va-cham-soc-dau-tay-2490.html#2'],
    ])
  })

  it('diagnosis checks fail a wrong diagnosis that repeats the symptom', () => {
    const g = (id: string) => caseOf(id)?.grounding ?? {}
    expect(gradeGrounding(g('diag-gray-mold'), 'Quả dâu bị thối mềm và có lớp mốc xám phủ lên khớp với triệu chứng của bệnh thán thư (Colletotrichum spp.).').pass).toBe(false)
    expect(gradeGrounding(g('diag-gray-mold'), 'Nhiều khả năng là bệnh mốc xám (Botrytis cinerea).').pass).toBe(true)
    expect(gradeGrounding(g('diag-powdery'), 'Lá dâu tây có lớp phấn trắng mặt dưới kèm mép lá cong tím đỏ khớp nhất với bệnh thán thư (Colletotrichum spp.).').pass).toBe(false)
    expect(gradeGrounding(g('diag-powdery'), 'Nhiều khả năng là bệnh phấn trắng (Podosphaera aphanis).').pass).toBe(true)
    expect(gradeGrounding(g('r1-bact-spot'), 'Đốm nhỏ sũng nước trên mặt dưới lá kèm dịch rỉ ra rồi khô lại thành vảy khớp nhất với thán thư (Colletotrichum spp.).').pass).toBe(false)
  })

  it('no diagnosis check can be met by repeating the question', () => {
    for (const id of DIAGNOSES) {
      const c = caseOf(id)
      expect(c?.grounding?.mustIncludeAny?.length, id).toBeGreaterThan(0)
      expect(gradeGrounding(c?.grounding ?? {}, c?.message ?? '').pass, id).toBe(false)
    }
  })
})
