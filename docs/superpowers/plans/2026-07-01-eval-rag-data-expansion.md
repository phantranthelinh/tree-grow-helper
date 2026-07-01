# Eval Dataset + RAG Knowledge Expansion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Grow the eval dataset from 12 → 32 cases (full tool coverage + phrasing + knowledge) and fill the 5 empty fields of `strawberry.json` so RAG can answer light/toxicity/care questions.

**Architecture:** Data-only change. No `.ts` logic is modified. Two data files change: `src/eval/dataset.ts` (add `EvalCase` entries) and `src/domain/knowledge/strawberry.json` (fill null fields). Two new vitest guard-tests lock the goal in place: one asserts eval coverage properties, one asserts the strawberry profile is fully populated and its new text fields become RAG chunks.

**Tech Stack:** TypeScript (ESM), vitest, zod (existing `PlantProfileSchema`). No new dependencies.

## Global Constraints

- Do NOT modify any `.ts` logic file — only `src/eval/dataset.ts` (data) and `src/domain/knowledge/strawberry.json` (data), plus new `tests/*.test.ts` files.
- Eval cases must be **first-decision deterministic**: every device-oriented case names `esp32-01` explicitly so the model never needs `list_devices` first.
- RAG text content is written in **English** (matches existing fields; `bge-m3` is cross-lingual). Vietnamese is used only for `aliases`.
- Keep `notes` field flagged `web-sourced, review before production`.
- `scientific_name` uses the Unicode multiplication sign `×` (U+00D7): `Fragaria × ananassa`. File is UTF-8.
- Commit convention for this repo: message suffix ` (opus 4.8)`, no JIRA ticket.

---

### Task 1: Expand the eval dataset with full tool + phrasing + knowledge coverage

**Files:**
- Create: `tests/eval-dataset.test.ts`
- Modify: `src/eval/dataset.ts` (append 20 entries to `EVAL_CASES`, before the closing `]` at line 31)
- Reference (do not modify): `src/mcp/knownTools.ts` (`KNOWN_TOOLS`), `src/mcp/policy.ts` (`classifyTool`)

**Interfaces:**
- Consumes: `EVAL_CASES: EvalCase[]` from `src/eval/dataset.ts`; `KNOWN_TOOLS` from `src/mcp/knownTools.ts`; `classifyTool(name): 'read'|'control'` from `src/mcp/policy.ts`.
- Produces: an enlarged `EVAL_CASES` (32 entries) with the same `EvalCase` shape — consumed by `src/eval/run.ts` (unchanged).

- [ ] **Step 1: Write the failing coverage test**

Create `tests/eval-dataset.test.ts`:

```typescript
import { describe, expect, it } from 'vitest'
import { EVAL_CASES } from '../src/eval/dataset'
import { KNOWN_TOOLS } from '../src/mcp/knownTools'
import { classifyTool } from '../src/mcp/policy'

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
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- eval-dataset`
Expected: FAIL — "has at least 32 cases" (only 12), "covers every known MCP tool" (missing `get_device_info`, `get_moisture_rule`, `get_light_rule`, `auto_light`, `set_light_rule`), "has at least 8 reply cases" (only 3).

- [ ] **Step 3: Append the 20 new cases to `EVAL_CASES`**

In `src/eval/dataset.ts`, insert these entries immediately before the closing `]` (currently line 31, after the `kb-moisture` entry):

```typescript
  // --- A1: tools not previously covered ---
  { id: 'device-info', message: 'Cho xem thông tin chi tiết thiết bị esp32-01.', expect: { type: 'tool', tool: 'get_device_info', safety: 'read' } },
  { id: 'get-moisture-rule', message: 'Luật tưới theo độ ẩm của esp32-01 đang đặt thế nào?', expect: { type: 'tool', tool: 'get_moisture_rule', safety: 'read' } },
  { id: 'get-light-rule', message: 'Xem luật chiếu sáng hiện tại của esp32-01.', expect: { type: 'tool', tool: 'get_light_rule', safety: 'read' } },
  { id: 'auto-light', message: 'Bật đèn tự động cho esp32-01 khi trời tối.', expect: { type: 'tool', tool: 'auto_light', safety: 'control' } },
  { id: 'set-light-rule', message: 'Đặt luật bật đèn khi ánh sáng dưới 300 lux cho esp32-01.', expect: { type: 'tool', tool: 'set_light_rule', safety: 'control' } },

  // --- A2: phrasing variants of already-covered tools ---
  { id: 'sensor-temp', message: 'Nhiệt độ hiện tại của esp32-01 là bao nhiêu?', expect: { type: 'tool', tool: 'get_latest_sensor', safety: 'read' } },
  { id: 'list-devices-alt', message: 'Có những thiết bị nào đang kết nối?', expect: { type: 'tool', tool: 'list_devices', safety: 'read' } },
  { id: 'sensor-history-12h', message: 'Cho xem số liệu độ ẩm 12 giờ qua của esp32-01.', expect: { type: 'tool', tool: 'get_sensor_history', safety: 'read' } },
  { id: 'pending-alt', message: 'esp32-01 còn lệnh nào chưa chạy không?', expect: { type: 'tool', tool: 'get_pending_commands', safety: 'read' } },
  { id: 'light-off', message: 'Tắt đèn thiết bị esp32-01.', expect: { type: 'tool', tool: 'send_command', safety: 'control' } },
  { id: 'fan-on', message: 'Bật quạt cho esp32-01.', expect: { type: 'tool', tool: 'send_command', safety: 'control' } },
  { id: 'water-15s', message: 'Mở nước tưới esp32-01 trong 15 giây.', expect: { type: 'tool', tool: 'send_command', safety: 'control' } },

  // --- A3: knowledge questions that should stay a reply (drives RAG) ---
  { id: 'kb-fertilizer', message: 'Nên bón phân gì cho dâu khi cây ra hoa?', expect: { type: 'reply' } },
  { id: 'kb-botrytis', message: 'Dâu bị mốc xám (nấm Botrytis) thì xử lý sao?', expect: { type: 'reply' } },
  { id: 'kb-harvest', message: 'Khi nào thì thu hoạch dâu được?', expect: { type: 'reply' } },
  { id: 'kb-propagation', message: 'Dâu tây nhân giống bằng cách nào?', expect: { type: 'reply' } },
  { id: 'kb-planting', message: 'Trồng dâu nên để khoảng cách cây bao nhiêu?', expect: { type: 'reply' } },
  { id: 'kb-toxicity', message: 'Chó ăn phải lá dâu có sao không?', expect: { type: 'reply' } },
  { id: 'kb-light-hours', message: 'Dâu tây cần mấy giờ nắng mỗi ngày?', expect: { type: 'reply' } },
  { id: 'kb-ph', message: 'Đất trồng dâu nên có pH khoảng bao nhiêu?', expect: { type: 'reply' } },
```

(The existing entries `light-on`, `fan-off` already cover `send_command`; the three new `send_command` entries are intentional phrasing variety — the coverage test only requires each tool once, duplicates are fine.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- eval-dataset`
Expected: PASS (5 tests green).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add tests/eval-dataset.test.ts src/eval/dataset.ts
git commit -m "expand eval dataset to 32 cases with full tool coverage (opus 4.8)"
```

---

### Task 2: Enrich the strawberry RAG knowledge (fill 5 empty fields)

**Files:**
- Create: `tests/strawberry-knowledge.test.ts`
- Modify: `src/domain/knowledge/strawberry.json` (fill `scientific_name`, `aliases`, `light_description`, `toxicity`, `care_notes`; extend `sources`; update `notes`)
- Reference (do not modify): `src/domain/profiles.ts` (`loadProfile`), `src/rag/ingest.ts` (`profileToChunks`, `TEXT_FIELDS`)

**Interfaces:**
- Consumes: `loadProfile(plant): PlantProfile` from `src/domain/profiles.ts`; `profileToChunks(p): Chunk[]` (where `Chunk = { id: string; field: string; text: string }`) from `src/rag/ingest.ts`.
- Produces: a fully-populated `strawberry.json` whose `light_description`, `toxicity`, `care_notes` are non-empty — so `profileToChunks` emits three additional chunks that the RAG store embeds.

- [ ] **Step 1: Write the failing knowledge test**

Create `tests/strawberry-knowledge.test.ts`:

```typescript
import { describe, expect, it } from 'vitest'
import { loadProfile } from '../src/domain/profiles'
import { profileToChunks } from '../src/rag/ingest'

describe('strawberry knowledge enrichment', () => {
  const p = loadProfile('strawberry')

  it('has the scientific name and Vietnamese alias filled', () => {
    expect(p.scientific_name).toBe('Fragaria × ananassa')
    expect(p.aliases).toContain('dâu tây')
  })

  it('fills the previously-empty text fields', () => {
    for (const field of ['light_description', 'toxicity', 'care_notes'] as const) {
      expect(typeof p[field]).toBe('string')
      expect((p[field] as string).trim().length).toBeGreaterThan(20)
    }
  })

  it('states strawberries are non-toxic to pets', () => {
    expect(p.toxicity?.toLowerCase()).toContain('non-toxic')
  })

  it('embeds the new text fields as RAG chunks', () => {
    const fields = new Set(profileToChunks(p).map((c) => c.field))
    expect(fields.has('light_description')).toBe(true)
    expect(fields.has('toxicity')).toBe(true)
    expect(fields.has('care_notes')).toBe(true)
  })

  it('records the new sources', () => {
    expect(p.sources.some((s) => s.includes('aspca.org'))).toBe(true)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- strawberry-knowledge`
Expected: FAIL — `scientific_name` is `null`, the three text fields are `null`, no `aspca.org` source.

- [ ] **Step 3: Fill the empty fields in `strawberry.json`**

Replace the five null/empty lines (`scientific_name`, `aliases`, `light_description`, `toxicity`, `care_notes`) with the values below, extend `sources`, and update `notes`. Exact field values:

```json
  "scientific_name": "Fragaria × ananassa",
  "aliases": ["dâu tây", "strawberry", "garden strawberry"],
  "light_description": "Strawberries need full sun to fruit well: 6-10 hours of direct sunlight per day is ideal, with a practical minimum of about 6 hours. Optimal ambient light for foliage is roughly 200-800 lux, well below the intensity of direct midday sun. In greenhouses, growers supplement with red-dominant LED light (for example 70% red / 30% blue) at about 130-250 µmol m-2 s-1 over a 14-16 hour photoperiod for maximum growth and yield. Indoors or in shaded spots, add grow lights (roughly one 60 W lamp per 6 m2). Photoperiod also drives flowering type: June-bearers are short-day plants, while day-neutral cultivars flower regardless of day length.",
  "toxicity": "Non-toxic. The ASPCA lists strawberry (Fragaria spp., family Rosaceae) as non-toxic to dogs, cats and horses, and the ripe fruit is edible and safe for humans. The plant contains no known toxic compound, but eating a large amount of fibrous leaves or stems can cause mild digestive upset (vomiting or diarrhoea) in pets, and whole berries can pose a choking risk for small dogs. When sharing fruit with pets, wash it, remove stems and leaves, and cut it into small pieces.",
  "care_notes": "Grow strawberries in fertile, well-drained, slightly acidic soil (pH 5.5-6.5); raised beds or containers improve drainage and reduce soil-borne disease. Keep plants weed-free and mulch with straw, pine needles or plastic film to conserve moisture, suppress weeds and keep the fruit off the soil. Water regularly while plants establish and during dry spells - about 25 mm (1 inch) per week - watering in the morning and avoiding wetting the crown or fruit to prevent grey mould (Botrytis). Set each plant with the midpoint of the crown level with the soil surface, neither buried nor exposed. In Da Lat-type climates strawberries are grown mainly from November to April at 18-22 C using clean-water drip or sub-surface irrigation; overly dense spacing in humid weather encourages disease. Remove first-year blossoms on June-bearing types to build vigour, and replace crowded, ageing plants to keep productivity high.",
```

Append these entries to the `sources` array (after the existing last URL, before the closing `]`):

```json
    "https://www.aspca.org/pet-care/aspca-poison-control/toxic-and-non-toxic-plants/strawberry",
    "https://extension.umn.edu/fruit/growing-strawberries-home-garden",
    "https://www.rhs.org.uk/fruit/strawberries/grow-your-own",
    "https://www.almanac.com/plant/strawberries",
    "https://chimi.com.vn/ky-thuat-trong-cham-soc-va-thu-hoach-dau-tay/",
    "https://baoangreen.vn/trong-dau-tay-o-da-lat-voi-da-perlite-nd32.html"
```

Update the `notes` field to record the new facets:

```json
  "notes": "src:exa | facets:environment,nutrients,health,lifecycle,care,light,toxicity | web-sourced, review before production"
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- strawberry-knowledge`
Expected: PASS (5 tests green).

- [ ] **Step 5: Typecheck + full test suite**

Run: `npm run typecheck && npm test`
Expected: typecheck clean; all tests (existing + 2 new files) pass. Note `tests/profiles.test.ts` still passes because it only asserts numeric ranges and `pests`, which are unchanged.

- [ ] **Step 6: Commit**

```bash
git add tests/strawberry-knowledge.test.ts src/domain/knowledge/strawberry.json
git commit -m "enrich strawberry RAG knowledge: light, toxicity, care fields (opus 4.8)"
```

---

## Manual Verification (optional, requires LM Studio)

Not part of the automated gate — needs LM Studio running with the chat model loaded.

- [ ] Run `npm run eval`. Expected: it now reports accuracy over 32 cases (`Eval: 32 cases | ...`). Use the per-case PASS/FAIL lines to spot which tools the small model mis-selects.

---

## Self-Review Notes

- **Spec coverage:** FR1 (eval, all 3 groups A1/A2/A3) → Task 1. FR2 (5 RAG fields + sources) → Task 2. Every acceptance-criteria bullet maps to a test assertion in Task 1 or Task 2, except the LM-Studio-dependent `npm run eval` bullet, which is in Manual Verification (external service required).
- **Placeholder scan:** none — all test code and data content is literal.
- **Type consistency:** tests use existing exports verified against source — `EVAL_CASES`, `KNOWN_TOOLS` (array of `{name}`), `classifyTool`, `loadProfile`, `profileToChunks` (returns `{id, field, text}[]`). `EvalExpect.safety` values (`'read'|'control'`) match `classifyTool` return type.
