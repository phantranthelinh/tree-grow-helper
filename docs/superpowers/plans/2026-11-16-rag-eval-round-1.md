# RAG + Eval Round 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. The three work packages (WP-1, WP-2, WP-3) run **in parallel**; each may touch **only** the files listed in its own "Files" block.

**Goal:** Move the round-0 eval toward the stop criterion by fixing the root causes measured in round 0: dense-only retrieval that misses term/symptom matches and is flooded by one long document, eval labels and a grader that mis-score correct behaviour, and two generation defects of qwen2.5-3b (code-switching on the hour unit "h", config-tool routing). Missing citations — the binding constraint on grounding — were probed and have no prompt-level fix; they need a product decision (§6).

**Architecture:** WP-1 changes retrieval *defaults* only (BM25+dense fusion on, MMR kept, topK aligned with what was measured). WP-2 makes the eval measure what it claims (answer-bearing any-of chunk labels, exact chunk-id matching, decimal-comma grading, a stricter citation marker, a non-Vietnamese-script metric, a separate set for new cases). WP-3 changes what the 3B reads (hour units, one routing rule + one few-shot example) and adds an orchestrator net for code-switched text.

**Tech Stack:** TypeScript ESM run by tsx, Vitest 2, LM Studio (qwen2.5-3b-instruct + text-embedding-bge-m3) for `npm run eval` only.

**Spec:** this document, §0–§3 (evidence, per-case diagnosis, retrieval decision, eval corrections). Inputs: `data/eval/r0-*.json` (round 0), the code under `src/`, `data/docs/*.jsonl`.

## Global Constraints

- All user-facing text stays Vietnamese (replies, prompt text, log lines).
- Control tools always go through confirmation; `src/mcp/policy.ts` is not touched by any WP; safety-class accuracy must stay 100%.
- The prose-only reply paragraph (`QUAN TRỌNG khi type="reply"…`) stays the **last** paragraph of the system prompt; every `type:"tool"` few-shot example keeps the field order `type → message → tool → args`.
- No new dependencies, services or models. Unit tests run with no external service (fakes/DI per CLAUDE.md "Testing conventions").
- Chunking parameters are frozen this round: `RAG_CHUNK_SIZE=600`, `RAG_CHUNK_OVERLAP=80`, `RAG_MIN_CHUNK_LEN=60`. Eval labels reference chunk ids `<source_url>#<i>` that depend on them.
- `data/docs/*.jsonl` and `src/domain/knowledge/*.json` are human-reviewed content: no WP edits them.
- Eval expectations change only as listed in §3. No few-shot example may reuse an eval message verbatim.
- Code comments: say why, never cite a ticket; no comment that restates the line below.
- Commit steps apply only if the executing workflow commits per task; never push.

## Review Focus

1. A label `…2490.html#1` must not count a retrieved `…2490.html#10`–`#19` as a hit (ngheandost has 19 chunks) → WP-2 Task 2.2 test.
2. Hour normalization must leave `ha` units (`35.000 cây/ha`, `1,16 ha`), `pH`, clock times like `1h30` and already-Vietnamese `24 giờ` untouched → WP-3 Task 3.1 test.
3. Grader normalizations must not create false passes: `5,5` matches `5.5` while `154–182` still matches `154`, and "nguồn" in its everyday sense ("chọn nguồn cây giống", "nguồn nước") is not a citation — a probe reply passed `requireCitation` exactly that way → WP-2 Task 2.1 tests.
4. The foreign-script check must not fire on Vietnamese diacritics or `°C`, `µmol`, `–`, `×`, `m²` → WP-2 Task 2.1 and WP-3 Task 3.3 tests.
5. The routing rule must not move a READ question onto a CONTROL tool (a first rule draft turned "Ngưỡng … đang là bao nhiêu?" into `set_device_config` 2/2) → WP-3 Task 3.2 prompt test + WP-2 case `r1-get-threshold`.

---

## §0 How the evidence was produced

- **Offline retrieval replay.** The strawberry store (13 profile + 46 doc + 10 disease = 69 chunks; one doc chunk dropped by dedupe) and the bean-sprout store (30) were rebuilt with the repo's own `profileToChunks`/`buildDocChunks`/`buildDiseaseChunks`/`dedupeByEmbedding`/`retrieve()` and the same LM Studio bge-m3 (vectors cached outside the repo; the repo cache was not touched). This reproduced round 0 exactly (gated recall 0.70/0.75/0.75, bean 0.714). Retrieval is deterministic given embeddings, so every retrieval number below is exact, not sampled.
- **The embedding model is healthy.** bge-m3 gives 0.94–0.97 on paraphrases and 0.30–0.40 on unrelated pairs. The compressed scores (answer chunk ≈0.675, others ≈0.63) come from the corpus: every chunk is about strawberries, so any strawberry question scores 0.55–0.65 against everything and only a 0.05–0.15 band discriminates.
- **Live probes.** qwen2.5-3b with the exact prompt assembly of `src/eval/run.ts`, temperature 0.1, 1–3 samples per arm (about 250 calls). Two noise sources are real: re-sending an identical request changed the verdict in 8 of 51 repeated probe groups (16%), and each retrieval config hands borderline cases a different context (the three r0 strawberry runs differ on 7 cases, all borderline). Consequence: a single-run difference of ≤2 cases is noise; a case counts as fixed only if it passes in ≥2 of 3 runs.

## §1 Diagnosis per failing case (round 0)

Run order in the "r0" column: default / hybrid / plain. NA = ngheandost (19-chunk procedure doc), TP = techport, NNMT = nongnghiepmoitruong, KNQG = khuyennongvn.

| Case | r0 | Class | Evidence and root cause |
|---|---|---|---|
| auto-light | set_light ×3 | prompt (routing) | "Bật đèn" matches `set_light`'s description; nothing maps "tự động" to `set_mode`. Live, the base prompt fails with the r0-default and the hybrid+MMR contexts (passes with a third); rule + example (WP-3) passes in both. |
| set-light-rule | set_light / set_light / ✓ | prompt (routing) | Same confusion ("Đặt luật bật đèn … lux"); passes only in one context. |
| get-moisture-rule | sensor / ✓ / sensor | prompt + context | "độ ẩm" pulls toward `get_latest_sensor`; the catalog says "ngưỡng cấu hình", the user says "luật". Reproduced live with the r0-default context. |
| get-light-rule | ✓ / sensor / sensor | prompt + context | Same, light variant. |
| kb-ph (grounding) | "5,5 đến 6,5" ✗ / ✓ / ✓ | **grader** | Vietnamese decimal comma; the reply is correct. |
| kb-temp (grounding) | 15–26 ✗ / 15–26 ✗ / 10–27 ✓ | model + conflicting doc | TP#0 says "15 - 26°C", the profile range is 10–27 and rule 10 says ranges win. Flips with context: fails with r0's default and hybrid contexts, passes with r0-plain and 2/2 in a probe context. A "ranges reminder" placed after the context was probed: no gain here and it broke `doc-lowland-climate` 1/2 → rejected. |
| kb-planting (grounding: citation) | ✗ ×3 | retrieval, then model (citation) | `strawberry:planting` is dense rank 14 (0.600); the model answers "3–4 thân/gốc" from NA#10 (pruning text). With the chunk in context (hybrid) the answer uses it ("35.000–40.000 cây/ha") but names no source. |
| kb-fertilizer (grounding: citation) | ✓ / ✗ / ✓ | model (citation) | Answer chunks retrieved in every run; a source is named only when the model happens to copy "nguồn [URL]". Citation probes over 6 reply cases × 2 contexts: base prompt 0/12 genuine citations; a citation clause appended to the final paragraph 1/12 genuine (+1 false pass on "chọn nguồn cây giống"); a source list placed right before the question 0/6 alone and 1/12 genuine with the clause. No prompt-level fix → §6. |
| doc-hanging-watering (grounding) | ✗ ×3 | model (distractor) + code-switch | sggp#0 ("5 lần/ngày … 7 lần/ngày") is rank 1 in every run; TP#2 ("24h/24h", container hydroponics) distracts; the hybrid run switched to Chinese at "24h". ≈50% pass in probes (3/6). |
| doc-nitrogen (grounding) | ✓ / ✓ / "80–120 ppm" ✗ | model noise | Answer chunk rank 1 in all runs; the plain context added the "80 N…" formula chunk. 4/4 probe passes. |
| bs-kb-harvest (grounding) | "sau 2,5 ngày" ✗ | **label** | `bean-sprout:harvest` (rank 1) says "ĐH Cần Thơ thu hoạch sau 2,5 ngày"; the label accepted only "48". |
| kb-pests (recall) | MMR drop / ✓ / ✓ | ranking (MMR) | Dense rank 4 (0.634, tied with NA#15). cos(pests, diseases)=0.813 > cos(NA#15, picks)=0.727, so MMR λ=0.7 picked NA#15. |
| kb-moisture (recall) | 0 ×3 | **label** | No chunk in the KB states a soil-moisture percentage; 75–80% comes from the system-prompt ranges (grounding passes 3/3). |
| kb-fertilizer (recall) | 0 ×3 | **label** | The profile field never mentions flowering. NA#5 ("Trước khi cây ra hoa cần hàm lượng lân và kali cao, đạm thấp"), NA#6, NNMT#2, TP#0 answer it and are top-4 in every run. |
| kb-harvest (recall) | 0 ×3 | **label** + model | KNQG#0 and `strawberry:growth_stages` ("khoảng 3 tháng … thu hoạch lứa đầu") are retrieved in every run; replies still say "1–2 năm" (from NA#6/#7, "giai đoạn cho năng suất cao từ 1-2 năm"). |
| kb-planting (recall) | 0 / 1 / 0 | ranking | See above; hybrid + MMR surfaces it. |
| diag-spider-mite (recall, and wrong diagnosis) | 0 ×3; replies "Xanthomonas" / ✓ / "đốm lá" | ranking (dense) | `disease:spider-mite` is dense rank 13 (0.555) although its symptoms are near-verbatim; dense favours generic "lá dâu + xử lý" text (NA#10 pruning chunk 0.630). BM25 matches "tơ nhện", "li ti". Dense contexts: 0/4 correct (r0 default "Xanthomonas", r0 plain "đốm lá", 2 probes "Xanthomonas … sên nhớt"); hybrid contexts: 3/3 name Tetranychus urticae (r0 hybrid run + 2 probes). |
| kb-light-hours (recall label) | ✓ but answer chunk unlabeled; replies "6-13 часов" ×3 | **label** + code-switch | `light_description` holds no hours; TP#2 ("không quá 12 giờ/ngày", "6 giờ - 18 giờ") is the answer chunk (rank 1). The system prompt renders "6-13h". |
| bs-kb-temp (recall) | 0 | **label** | CTU#3 "tốt nhất trong khoảng nhiệt độ 27 – 30°C" is dense rank 2. |
| bs-kb-soak (recall) | 0; reply "4 часов … 48小时" | **label** + code-switch | VAAS-gia#4/#0/#8 ("35°C … 4 h") are ranks 1–2. |
| doc-container-temp (recall credited, answer wrong) | "1" ×3; replies "15–26°C" / "10–27°C" | **label too loose** + chunk context | The label was the whole TP document and was satisfied by TP#0 (general 15–26°C). Only TP#3 has the container regime (23–24°C; 27°C day / 17°C night), dense rank 20: the chunk never says "container" or "dâu tây". Not fixed this round (§6). |
| Code-switching (not graded) | 6 replies in 4 runs | prompt (unit "h") | 5 of 6 occur at an hour quantity written "h" ("6-13h" in the system prompt; "4 h", "24h/24h" in docs). Live with "h"→"giờ": 0 of 9 samples vs 5 of 9 before. |
| kb-toxicity (not graded) | 2/3 "an toàn để chó ăn" | model fabrication | The chunk says no Vietnamese source covers pet toxicity. Tracked by new case `r1-pet-toxicity`; no fix this round. |

## §2 Retrieval defaults — evidence and decision

Deterministic gated recall@4 over the corrected labels (§3; strawberry 19, bean 7) plus the new labelled queries (strawberry 12, bean 3):

| Config | straw corr /19 | straw new /12 | bean corr /7 | bean new /3 | total /41 |
|---|---|---|---|---|---|
| dense, MMR 0.7 (r0 default) | 15 | 8 | 7 | 3 | 33 |
| dense, λ=1 (r0 plain) | 16 | 7 | 7 | 3 | 33 |
| **hybrid, MMR 0.7 (r0 hybrid)** | **18** | **10** | **7** | **3** | **38** |
| hybrid, λ=1 | 16 | 10 | 6 | 3 | 35 |
| hybrid + curated embed header (± MMR) | 18 | 11 | 6 | 3 | 38 |
| hybrid + max 1 chunk per source | 18 | 11 | 6 | 3 | 38 |

Decision (the only ≥3-case effect is dense → hybrid):

- **`RAG_HYBRID` on by default.** +5/41. BM25 recovers symptom and term queries that dense ranks low (diag-spider-mite, new thrips/aphid cases) and RRF damps the 19-chunk NA flood.
- **`RAG_MMR_LAMBDA` stays 0.7.** With hybrid it is +3/41 over λ=1 (kb-pests, kb-planting, bs-kb-temp: each a curated or primary chunk crowded out by several chunks of one long document). In dense mode it is neutral (−kb-pests, +r1-aphid). At this score compression MMR acts mainly as a same-document diversity filter; that is the effect being kept.
- **`RAG_REL_MARGIN` stays 0.15.** It changes the retrieved set for only 3–4 of 64 strawberry and 1–2 of 15 bean queries — those with a standout top-1 (kb-propagation and doc-varieties get 2 chunks, doc-nitrogen 3) — and never removes a labelled answer chunk. That is its intended job (trim a weak tail); no evidence to change it.
- **`RAG_MIN_SCORE` stays 0.** No floor separates the classes: device commands reach top-1 0.58 (set-moisture-rule), knowledge questions go down to 0.546 (kb-toxicity).
- **topK stays 4** (what every r0 run used, from `.env`/`.env.example`); align `src/config.ts`'s default (currently 5) so production runs what was measured.
- Not adopted (within ±1 case of the chosen config): curated-chunk embedding headers ("Dâu tây — <field>: …", +2 in dense mode only), per-source cap, a +0.03–0.05 score prior for curated chunks (helps old labels but crowds out doc answers; the 3B already copies curated distractors in doc-hanging-watering), doc-title headers (only config that finds TP#3, and only in dense mode).
- Sample size: 41 labelled queries; one case = 2.4 points of the total, 5.3 points of strawberry's 19.

## §3 Eval corrections (WP-2) and the re-scored baseline

Principle: a retrieval label lists the chunk(s) that contain the fact asked; any one of them satisfies the case (an *any-of group*). A label containing `#` is an exact chunk id; a label without `#` keeps prefix semantics (`strawberry:pests` → `strawberry:pests#0`, `disease:aphid`).

URL constants (exact source_url values from `data/docs`):

- `NGHEAN` = `https://ngheandost.gov.vn/nong-nghiep/quy-trinh-ky-thuat-trong-va-cham-soc-dau-tay-2490.html`
- `NNMT` = `https://nongnghiepmoitruong.vn/ap-dung-ky-thuat-tien-tien-trong-dau-tay-lai-nua-ty-ha-d404800.html`
- `TECHPORT` = `https://techport.vn/83/quy-trinh-trong-cay-dau-tay-trong-dieu-kien-co-kiem-soat-mot-so-yeu-to-moi-truong-102381.html`
- `KNQG` = `https://khuyennongvn.gov.vn/hoat-dong-khuyen-nong/chuyen-giao-tbkt/lam-dong-chuyen-doi-trong-dau-tay-giup-cai-thien-sinh-ke-cho-dong-bao-dan-toc-thieu-so-31818.html`
- `IUH` = `https://jst.iuh.edu.vn/index.php/jst-iuh/article/download/5073/843/16744`
- `VAAS_N` = `https://tapchi.vaas.vn/vi/tap-chi/anh-huong-cua-nong-do-nito-trong-dung-dich-dinh-duong-den-sinh-truong-nang-suat-va-chat`
- `VAAS_GIONG` = `https://tapchi.vaas.vn/sites/tapchi.vaas.vn/files/tapchi/2022-03/tc2%20-2021.pdf`
- `SGGP` = `https://www.sggp.org.vn/nong-dan-da-lat-lam-giau-nho-trong-dau-tay-treo-post443330.html`
- `VAAS_NZ` = `https://vaas.vn/vi/khoa-hoc-cong-nghe/ung-dung-cong-nghe-cao-trong-san-xuat-dau-tay-dam-bao-toan-thuc-pham`
- `VAAS_GIA` = `https://tapchi.vaas.vn/sites/tapchi.vaas.vn/files/tapchi/2021-05/TC%20so%207-2019-08.pdf`
- `CTU` = `https://ctujsvn.ctu.edu.vn/index.php/ctujsvn/article/download/2390/1429/1429`

| Case | Old | New | Why (quote from the chunk) |
|---|---|---|---|
| kb-moisture | `['strawberry:watering']` | no `expectChunks` | No chunk states a soil-moisture %; the answer is the system-prompt range. |
| kb-fertilizer | `['strawberry:fertilizer']` | `[[NGHEAN#5, NGHEAN#6, NNMT#2, TECHPORT#0]]` | Profile field has no flowering advice; NA#5 "Trước khi cây ra hoa cần hàm lượng lân và kali cao, đạm thấp", NA#6 acid boric "khi bắt đầu ra hoa", NNMT#2 "Vào giai đoạn ra hoa … phân bón hữu cơ", TP#0 "90N-44P-190K … giai đoạn ra hoa đậu quả". |
| kb-harvest | `['strawberry:harvest']` | `[['strawberry:harvest', 'strawberry:growth_stages', KNQG#0]]` | All three: "khoảng 3 tháng … thu hoạch lứa (hái) đầu tiên". |
| kb-light-hours | `['strawberry:light_description']` | `[[TECHPORT#2]]` | `light_description` has no hours; TP#2 "không quá 12 giờ/ngày … 6 giờ - 18 giờ". |
| diag-spider-mite | `['disease:spider-mite']` | `[['disease:spider-mite', NGHEAN#11]]` | NA#11 "nhện đỏ … một lớp mạng nhện nhỏ, mịn ở mặt dưới của lá". |
| doc-nitrogen | VAAS_N prefix | `[[VAAS_N#0, 'strawberry:fertilizer']]` | Both state 154–182 and 98–182 mg/L. |
| doc-leaf-spot-fungi | IUH prefix | `[[IUH#1, 'strawberry:diseases']]` | Both list Pilidium concavum, P. lythri, Mucor circinelloides, Nigrospora sphaerica; IUH#0 is general. |
| doc-varieties | VAAS_GIONG prefix | `[[VAAS_GIONG#0]]` | Only chunk naming Mỹ đá and Camarosa. |
| doc-lowland-climate | NNMT prefix | `[[NNMT#0]]` | "ban ngày ở mức 28 độ C, đến đêm chỉ còn 18 độ C". |
| doc-hanging-watering | SGGP prefix | `[[SGGP#0, SGGP#1]]` | "5 lần/ngày … 7 lần/ngày"; "5 đến 7 lần/ngày". |
| doc-greenhouse-yield | VAAS_NZ prefix | `[[VAAS_NZ#0, 'strawberry:harvest']]` | Both "30–32 tấn/ha". |
| doc-container-temp | TECHPORT prefix | `[[TECHPORT#3]]` (tightened) | Only TP#3 has the container regime; r0 credited TP#0. |
| bs-kb-temp | `['bean-sprout:care_notes']` | `[['bean-sprout:care_notes', CTU#3]]` | CTU#3 "tốt nhất trong khoảng nhiệt độ 27 – 30°C". |
| bs-kb-soak | `['bean-sprout:planting']` | `[['bean-sprout:planting', VAAS_GIA#0, VAAS_GIA#4, VAAS_GIA#8]]` | Each states "35°C … 4 h". |
| bs-kb-harvest (grounding) | `mustIncludeAny ['48']` | `['48', '2,5 ngày', '72']` | Profile harvest "thu hoạch sau 2,5 ngày" (ĐH Cần Thơ); growth_stages "48–72 giờ". |
| grader | — | `5,5` ≡ `5.5` between digits | kb-ph default reply "5,5 đến 6,5". |

Unchanged (labels correct): kb-pests, kb-planting, kb-botrytis, kb-propagation, kb-toxicity, diag-gray-mold, diag-powdery, diag-anthracnose, bs-kb-light, bs-kb-watering, bs-kb-banned, bs-kb-microbe.

**Round 0 re-scored under §3** (recall replayed; grader re-applied to the stored replies). Round 1 is compared against **this** row set, not the original headline:

| r0 run | exact | grounding | gated recall@4 | replies with Cyrillic/CJK |
|---|---|---|---|---|
| strawberry default | 49/52 (94%) | 9/12 (75%) | 0.79 (15/19) | 1/52 |
| strawberry hybrid | 49/52 (94%) | 8/12 (67%) | 0.95 (18/19) | 3/52 |
| strawberry plain | 49/52 (94%) | 9/12 (75%) | 0.84 (16/19) | 1/52 |
| bean-sprout default | 12/12 | 6/6 (100%) | 1.00 (7/7) | 1/12 |

The 0.70 → 0.79 recall move for the default run is measurement, not improvement.

**New cases** (tagged `set: 'r1'`, reported separately, outside the stop criterion this round): 20 strawberry and 4 bean-sprout, listed in WP-2 Task 2.3. They add retrieval coverage of the disease KB and profile fields, grounding checks for three defects the r0 checks miss (wrong harvest timing, misdiagnosis, fabricated pet safety) plus the TP#3 container case, and routing variants with no verbatim overlap with any few-shot example.

---

## §4 Work packages

Ordered by expected metric impact per effort: WP-1 is the largest real gain for the least code (strawberry recall +16 points from a default flip); WP-2 moves the reported numbers most, but only by correcting measurement — read its deltas as corrections, not progress; WP-3 is the only one that moves exact (+2–3 cases) and removes code-switching. File sets are disjoint; no WP depends on another WP's code. All three are measured together after merge (§5).

### WP-1 — Retrieval defaults (hybrid on, measured topK)

**Files (only these):** `src/config.ts`, `.env.example`, `CLAUDE.md`, `tests/config.test.ts` (create).

**Root cause addressed:** dense-only ranking on a single-topic corpus misses term/symptom matches and is flooded by NA's 19 chunks — diag-spider-mite (dense rank 13, wrong diagnosis 2/3 runs), kb-planting (rank 14), kb-pests (MMR drop in dense mode), r1 thrips/aphid.

**Expected eval effect:** strawberry gated recall@4 0.79 → 0.95 (18/19, only doc-container-temp missing); r1 strawberry retrieval 8/12 → 10/12; bean stays 7/7. diag-spider-mite diagnosis right (hybrid contexts 3/3 vs dense 0/4). Exact and grounding: no direct gain — r0's hybrid run scored 49/52 and 8/12 (vs 9/12), within noise; the new context keeps auto-light/set-light-rule failing until WP-3's routing rule lands.

#### Task 1.1: hybrid on by default, topK default 4

**Interfaces:**
- Produces: `export function boolEnv(value: string | undefined, fallback: boolean): boolean` in `src/config.ts` (`'1'` → true, `'0'` → false, anything else → `fallback`); `config.rag.hybrid` defaults to `true`; `config.rag.topK` defaults to `4`.

- [ ] **Step 1: Write the failing tests** in `tests/config.test.ts`

```ts
import { afterEach, describe, expect, it, vi } from 'vitest'
import { boolEnv } from '../src/config'

describe('boolEnv', () => {
  it('reads "1"/"0" and falls back for anything else', () => {
    expect(boolEnv('1', false)).toBe(true)
    expect(boolEnv('0', true)).toBe(false)
    expect(boolEnv(undefined, true)).toBe(true)
    expect(boolEnv(undefined, false)).toBe(false)
    expect(boolEnv('', true)).toBe(true)
  })
})

describe('config.rag.hybrid', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('is off only when RAG_HYBRID=0', async () => {
    vi.stubEnv('RAG_HYBRID', '0')
    vi.resetModules()
    expect((await import('../src/config')).config.rag.hybrid).toBe(false)
    vi.stubEnv('RAG_HYBRID', '1')
    vi.resetModules()
    expect((await import('../src/config')).config.rag.hybrid).toBe(true)
  })
})
```

The "unset → on" default is pinned through `boolEnv(undefined, true)` because `dotenv/config` loads a developer's `.env` on import.

- [ ] **Step 2: Run** `npx vitest run tests/config.test.ts` — Expected: FAIL (`boolEnv` is not exported).
- [ ] **Step 3: Implement** `boolEnv` in `src/config.ts`; set `hybrid: boolEnv(process.env.RAG_HYBRID, true)` and `topK: num(process.env.RAG_TOP_K, 4)`. Replace the hybrid comment with one line on why it is on (BM25 recovers symptom/term queries that dense ranking misses; `RAG_HYBRID=0` = dense only).
- [ ] **Step 4: Update `.env.example`**: `RAG_HYBRID=1` with comment `# 1 (default) = fuse BM25 with dense ranking (RRF); 0 = dense only`. Leave `RAG_TOP_K=4`, `RAG_MMR_LAMBDA=0.7`, `RAG_REL_MARGIN=0.15`.
- [ ] **Step 5: Update `CLAUDE.md`** (RAG pipeline paragraph): hybrid BM25+RRF is on by default (`RAG_HYBRID=0` turns it off); defaults topK 4, MMR 0.7; at bge-m3's compressed scores `RAG_REL_MARGIN` only trims the tail when one hit stands out (a few queries return 2–3 chunks). Remove the sentence that presents `RAG_HYBRID=1` as opt-in.
- [ ] **Step 6: Run** `npm test` and `npm run typecheck` — Expected: PASS. `tests/init.test.ts`, `tests/rebuild-rag.test.ts` and `tests/setup-routes.test.ts` spread `config.rag`; if one asserted dense-only ordering, set `hybrid: false` in that test's own config object rather than changing the default.
- [ ] **Step 7: Commit** — `feat(rag): fuse BM25 with dense ranking by default and default topK to 4`.

### WP-2 — Eval correctness and coverage

**Files (only these):** `src/eval/grounding.ts`, `src/eval/grounding.test.ts`, `src/eval/metrics.ts` (create), `src/eval/metrics.test.ts` (create), `src/eval/dataset.ts`, `src/eval/run.ts`, `tests/eval-dataset.test.ts`.

**Root cause addressed:** labels naming a chunk that does not hold the answer (kb-moisture, kb-fertilizer, kb-light-hours) or too narrowly/loosely (kb-harvest, diag-spider-mite, bs-kb-temp, bs-kb-soak, doc-container-temp and the other doc-level prefixes); a grader blind to Vietnamese decimal commas (kb-ph) and to a correct alternative answer (bs-kb-harvest), and too loose on the word "nguồn"; no metric for code-switching; new cases would otherwise dilute round-over-round comparability.

**Expected eval effect:** reproduces the re-scored r0 rows of §3 when replayed on r0 data (the stricter citation marker changes no r0 verdict: both r0 citation passes read "Theo nguồn [https://…]" / "tại nguồn [https://…]"); no system behaviour changes.

#### Task 2.1: grader — decimal comma, citation marker, foreign script

**Interfaces:**
- Produces: `export function hasForeignScript(text: string): boolean` in `src/eval/grounding.ts`; `gradeGrounding` treats `,` between two digits as `.` in both reply and expectation; `hasCitation` no longer accepts a bare "nguồn".

- [ ] **Step 1: Write the failing tests** in `src/eval/grounding.test.ts`

```ts
it('treats a Vietnamese decimal comma as a dot', () => {
  expect(gradeGrounding({ mustIncludeAny: ['5.5', '6.5'] }, 'Đất nên có pH từ 5,5 đến 6,5.').pass).toBe(true)
  expect(gradeGrounding({ mustIncludeAny: ['2,5 ngày'] }, 'Thu hoạch sau 2.5 ngày.').pass).toBe(true)
  expect(gradeGrounding({ mustIncludeAny: ['154'] }, 'N khoảng 154–182 mg/L.').pass).toBe(true)
})

it('counts "nguồn" only when it introduces a source', () => {
  expect(hasCitation('Bạn nên chọn nguồn cây giống sạch bệnh.')).toBe(false)
  expect(hasCitation('Dùng nguồn nước sạch để tưới.')).toBe(false)
  expect(hasCitation('Theo nguồn [https://nongnghiepmoitruong.vn/x], nên bón hữu cơ.')).toBe(true)
  expect(hasCitation('Tham khảo tại nguồn: https://www.sggp.org.vn/x')).toBe(true)
})

describe('hasForeignScript', () => {
  it('flags Cyrillic, CJK ideographs and CJK punctuation', () => {
    expect(hasForeignScript('ánh sáng 6-13 часов/ngày')).toBe(true)
    expect(hasForeignScript('cung cấp 24小时/24小时')).toBe(true)
    expect(hasForeignScript('xong rồi。')).toBe(true)
  })
  it('passes Vietnamese text with units and symbols', () => {
    expect(hasForeignScript('Độ ẩm đất 75–80%, nhiệt độ 10-27°C, 100–110 µmol/m²/s, 20 cm × 20 cm.')).toBe(false)
  })
})
```

- [ ] **Step 2: Run** `npx vitest run src/eval/grounding.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement.** In `contains()`, after the existing normalize/strip, replace `/(\d),(\d)/g` with `'$1.$2'` on both sides. In `hasCitation`, drop the bare `'nguồn'` marker and accept "nguồn" only as `/(?:theo|tại)\s+nguồn|nguồn\s*(?::|\[|\(|https?:)/` on the normalized text (all other markers unchanged). `hasForeignScript` is one character-class test over U+0400–U+04FF (Cyrillic), U+3000–U+303F (CJK punctuation), U+3040–U+30FF (kana), U+3400–U+4DBF and U+4E00–U+9FFF (CJK ideographs), U+AC00–U+D7AF (Hangul), written with `\u` escapes.
- [ ] **Step 4: Run** the same command — Expected: PASS.
- [ ] **Step 5: Commit** — `test(eval): grade decimal commas, tighten the "nguồn" citation marker, detect code-switching`.

#### Task 2.2: any-of chunk labels with exact-id matching

**Interfaces:**
- Produces in `src/eval/metrics.ts`: `export type ChunkLabel = string | string[]` (a string is a one-label group); `export function matchesLabel(chunkId: string, label: string): boolean` (label with `#` → `chunkId === label`, else `chunkId.startsWith(label)`); `export function chunkRecall(labels: ChunkLabel[], retrievedIds: string[]): number` (satisfied groups / groups; a group is satisfied when any label matches any id).

- [ ] **Step 1: Write the failing tests** in `src/eval/metrics.test.ts`

```ts
const NA = 'https://ngheandost.gov.vn/x.html'
it('matches exact ids when the label carries #i', () => {
  expect(matchesLabel(`${NA}#1`, `${NA}#1`)).toBe(true)
  expect(matchesLabel(`${NA}#10`, `${NA}#1`)).toBe(false)
  expect(matchesLabel('strawberry:pests#0', 'strawberry:pests')).toBe(true)
  expect(matchesLabel('disease:aphid', 'disease:aphid')).toBe(true)
})
it('scores any-of groups', () => {
  expect(chunkRecall([[`${NA}#5`, `${NA}#6`]], [`${NA}#6`])).toBe(1)
  expect(chunkRecall([[`${NA}#5`], 'strawberry:pests'], ['strawberry:pests#0'])).toBe(0.5)
  expect(chunkRecall([[`${NA}#1`]], [`${NA}#11`, `${NA}#12`])).toBe(0)
})
```

- [ ] **Step 2: Run** `npx vitest run src/eval/metrics.test.ts` — Expected: FAIL (module missing).
- [ ] **Step 3: Implement** the three exports in `src/eval/metrics.ts`.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** — `test(eval): any-of chunk labels with exact chunk-id matching`.

#### Task 2.3: dataset corrections and r1 cases

**Interfaces:**
- Consumes: `ChunkLabel` from Task 2.2.
- Produces in `src/eval/dataset.ts`: `EvalCase.expectChunks?: ChunkLabel[]`; `EvalCase.set?: 'r1'` (absent = round-0 case); the URL constants of §3.

- [ ] **Step 1: Write the failing tests** in `tests/eval-dataset.test.ts`

```ts
it('every exact chunk label names a chunk the ingest pipeline produces', () => {
  // Build ids with profileToChunks / buildDocChunks(readReviewedDocs('data/docs') filtered by plant)
  // / buildDiseaseChunks(loadDiseases(plant)) for strawberry and bean-sprout, using
  // config.rag.chunkSize / chunkOverlap / minChunkLen — no embeddings needed.
  for (const c of [...EVAL_CASES, ...BEAN_SPROUT_EVAL_CASES])
    for (const label of (c.expectChunks ?? []).flat())
      if (label.includes('#')) expect(ids.has(label), `${c.id}: ${label}`).toBe(true)
      else expect([...ids].some((id) => id.startsWith(label)), `${c.id}: ${label}`).toBe(true)
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
```

Keep every existing test in the file passing (unique ids, tool coverage, safety classes, grounding only on reply cases, ≥6 grounded with ≥2 citing); they iterate all cases, so the r1 cases are covered by them.

- [ ] **Step 2: Run** `npx vitest run tests/eval-dataset.test.ts` — Expected: FAIL.
- [ ] **Step 3: Apply §3** to the r0 cases exactly as tabled (labels, kb-moisture removal, bs-kb-harvest grounding), with the URL constants.
- [ ] **Step 4: Add the r1 cases** (all `set: 'r1'`). Reply cases (`expect: { type: 'reply' }`):

| id | message | expectChunks | grounding |
|---|---|---|---|
| r1-root-rot | Rễ dâu bị thâm đen, thối nhũn, cây héo dần rồi chết là bệnh gì? | `[['disease:root-rot']]` | — |
| r1-thrips | Hoa và lá non của dâu bị cong queo, có vết xước bạc là do con gì? | `[['disease:thrips', NGHEAN#12]]` | — |
| r1-aphid | Ngọn dâu có đám côn trùng nhỏ chích hút làm lá non xoăn lại, có kiến bu, xử lý sao? | `[['disease:aphid']]` | — |
| r1-slug | Lá và quả dâu bị gặm thủng lỗ lớn, có vệt nhớt bóng là do đâu? | `[['disease:slug-snail']]` | — |
| r1-bact-spot | Mặt dưới lá dâu có đốm nhỏ sũng nước, sau rỉ dịch rồi khô thành vảy là bệnh gì? | `[['disease:bacterial-leaf-spot']]` | — |
| r1-leaf-spot | Lá dâu có đốm tròn nhỏ, tâm xám trắng, viền tím đỏ là bệnh gì? | `[['disease:leaf-spot']]` | — |
| r1-spacing-out | Trồng dâu ngoài trời thì cây cách cây bao xa? | `[['strawberry:planting']]` | `mustIncludeAny ['45 cm']` (a density "40.000 cây/ha" must not pass) |
| r1-flower-time | Dâu tây trồng bao lâu thì bắt đầu ra hoa? | `[['strawberry:growth_stages', KNQG#0]]` | `mustIncludeAny ['2,5 tháng']` |
| r1-variety-indoor | Nên chọn giống dâu nào để trồng trong nhà mái che? | `[['strawberry:varieties', NGHEAN#0]]` | `mustIncludeAny ['New Zealand', 'Newzealand', 'Akihime']` |
| r1-substrate | Giá thể trồng dâu thường phối trộn từ những gì? | `[['strawberry:fertilizer', VAAS_N#0, NGHEAN#2, VAAS_GIONG#2]]` | `mustIncludeAny ['xơ dừa']` |
| r1-old-runners | Có nên tách cây con từ vườn dâu cũ để trồng tiếp không? | `[['strawberry:propagation']]` | — |
| r1-bed-height | Lên luống trồng dâu nên cao bao nhiêu? | `[['strawberry:care_notes#0']]` | `mustIncludeAny ['25 cm', '20 cm']` |
| r1-harvest-first | Trồng dâu bao lâu thì hái được lứa quả đầu tiên? | `[['strawberry:harvest', 'strawberry:growth_stages', KNQG#0]]` | `mustIncludeAny ['3 tháng', '03 tháng']` |
| r1-spider-mite | Mặt dưới lá dâu có chấm vàng nhạt li ti, lá bạc màu và có mạng tơ mỏng, cây bị gì? | `[['disease:spider-mite', NGHEAN#11]]` | `mustIncludeAny ['nhện đỏ', 'tetranychus']` |
| r1-pet-toxicity | Mèo nhà mình gặm lá cây dâu tây, có độc không? | `[['strawberry:toxicity']]` | `mustIncludeAny ['chưa có', 'chưa rõ', 'không có thông tin', 'thú y']`, `forbid ['an toàn cho mèo', 'an toàn để mèo', 'mèo ăn được']` |
| r1-container-night | Trồng dâu thủy canh trong container có kiểm soát thì ban đêm giữ nhiệt độ bao nhiêu? | `[[TECHPORT#3]]` | `mustIncludeAny ['17']` |
| r1-bs-density *(bean)* | Gieo hạt đỗ trên khay với mật độ bao nhiêu là tốt nhất? | `[['bean-sprout:planting', VAAS_GIA#0, VAAS_GIA#8]]` | `mustIncludeAny ['40 g']` |
| r1-bs-overwater *(bean)* | Tưới giá quá dày thì giá bị làm sao? | `[['bean-sprout:watering', 'bean-sprout:diseases']]` | — |
| r1-bs-sell-light *(bean)* | Mang giá ra chợ bán có cần che nắng không? | `[['bean-sprout:light_description']]` | — |

Tool cases: `r1-get-threshold` "Ngưỡng độ ẩm để bơm tự bật trên esp32-01 đang là bao nhiêu?" → `get_device_config`/read; `r1-set-lux` "Sửa ngưỡng cho esp32-01: bật đèn khi ánh sáng dưới 250 lux." → `set_device_config`/control; `r1-get-light-cfg` "esp32-01 đang cài ngưỡng ánh sáng thế nào?" → `get_device_config`/read; `r1-manual` "Chuyển esp32-01 sang chế độ điều khiển tay." → `set_mode`/control; bean `r1-bs-config` "Chu kỳ tưới tự động của esp32-01 đang cài thế nào?" → `get_device_config`/read.

- [ ] **Step 5: Run** `npx vitest run tests/eval-dataset.test.ts` — Expected: PASS.
- [ ] **Step 6: Commit** — `test(eval): answer-bearing chunk labels and round-1 cases`.

#### Task 2.4: run.ts — per-set summary, script metric, any-of recall

**Interfaces:**
- Consumes: `chunkRecall`, `matchesLabel` (Task 2.2), `hasForeignScript` (Task 2.1), `EvalCase.set` (Task 2.3).
- Produces in `src/eval/metrics.ts`: `export interface CaseResult { id: string; set: 'r0' | 'r1'; want: string; got: string; exact: boolean; safety: boolean; reply: string | null; grounding: { pass: boolean; reasons: string[] } | null; expectChunks: ChunkLabel[] | null; recall: number | null; recallGated: number | null; retrieved: Array<{ id: string; score: number }>; retrievedUngated: Array<{ id: string; score: number }>; foreignScript: boolean; ms: number }` and `export function summarize(results: CaseResult[]): EvalSummary`, where `EvalSummary` keeps the current `summary` shape (`exact`, `safety`, `grounding`, `retrieval`) plus `scriptClean: { hits; total; rate }` (cases whose message has no foreign script, over cases with a non-empty message).

- [ ] **Step 1: Write the failing test** in `src/eval/metrics.test.ts`: `summarize` on three hand-built `CaseResult`s — A: tool case, `exact: true`, no grounding; B: reply, `exact: true`, grounding `{ pass: false }`, `foreignScript: true`; C: reply, `exact: false`, `expectChunks` set, `recall: 1`, `recallGated: 0` — returns `exact` 2/3, `grounding` 0/1, `scriptClean` 2/3, `retrieval.annotated` 1 and `retrieval.recallGated` 0.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement** `summarize` and switch `src/eval/run.ts` to: collect `CaseResult[]` (record `retrievedUngated` from the raw pass, `foreignScript` on `actual?.message`, recall via `chunkRecall`, expected/other score split via `matchesLabel` over the flattened labels); write `summary = summarize(r0 results)` (same key as today, so round reports stay comparable), `summaryR1 = summarize(r1 results)`, `summaryAll = summarize(all)`; print the headline block for r0 and one line each for r1 and the script metric.
- [ ] **Step 4: Run** `npm test` and `npm run typecheck` — Expected: PASS.
- [ ] **Step 5: Commit** — `test(eval): report round-0 and round-1 sets separately and track code-switching`.

### WP-3 — What the 3B reads (hour units, routing rule) + code-switch net

**Files (only these):** `src/domain/profiles.ts`, `tests/profiles.test.ts`, `src/llm/prompt.ts`, `tests/prompt.test.ts`, `src/domain/fewshot.ts`, `src/agent/orchestrator.ts`, `tests/orchestrator.test.ts`.

**Root cause addressed:** (a) hours written "h" are where the 3B code-switches (kb-light-hours ×3, bs-kb-soak, doc-hanging-watering hybrid); (b) no rule or example routes "luật/ngưỡng" questions to `get_device_config`, threshold changes to `set_device_config`, or "tự động" to `set_mode` (auto-light ×3, set-light-rule ×2, get-moisture-rule ×2, get-light-rule ×2); (c) code-switching not tied to units (Chinese tail in kb-toxicity hybrid, a Russian "и" seen in a probe's tool lead-in) still reaches the user. Citations are deliberately absent: §1 shows no prompt wording moves them.

**Expected eval effect:** see each task.

#### Task 3.1: write hours as "giờ" everywhere the model reads them

**Interfaces:**
- Produces: `summarizeRanges` renders daily light hours as `giờ chiếu sáng/ngày 6-13 giờ` (unit `' giờ'`, not `'h'`); `export function normalizeHourUnits(text: string): string` in `src/llm/prompt.ts`; `assembleMessages` applies it to `ragContext`.

- [ ] **Step 1: Write the failing tests.** In `tests/profiles.test.ts`: `summarizeRanges(loadProfile('strawberry'))` contains `'giờ chiếu sáng/ngày 6-13 giờ'` and does not match `/\d+h\b/`. In `tests/prompt.test.ts`:

```ts
it('writes hour quantities as "giờ" and leaves other units alone', () => {
  expect(normalizeHourUnits('ngâm 4 h, tổng 48h, 24h/24h, CO2 18h – 6h')).toBe('ngâm 4 giờ, tổng 48 giờ, 24 giờ/24 giờ, CO2 18 giờ – 6 giờ')
  const keep = '35.000 cây/ha, 1,16 ha, 30–32 tấn/ha, pH 5,5, lúc 1h30, 24 giờ'
  expect(normalizeHourUnits(keep)).toBe(keep)
})
it('assembleMessages normalizes hour units inside the knowledge block', () => {
  const msgs = assembleMessages({ system: 's', history: [], ragContext: '[x] ngâm 4 h', userMessage: 'q' })
  expect(msgs.at(-1)?.content).toContain('ngâm 4 giờ')
})
```

- [ ] **Step 2: Run** `npx vitest run tests/profiles.test.ts tests/prompt.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement.** `normalizeHourUnits` replaces `/(\d)\s?h(?![\p{L}\p{N}])/gu` with `'$1 giờ'`. Change the unit argument for `daily_light_hours` in `summarizeRanges` to `' giờ'`. One comment line at the helper saying why (the 3B rewrites "h" quantities in Russian/Chinese; Vietnamese "giờ" it copies as is).
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** — `fix(prompt): write hour quantities as "giờ" so the model does not code-switch`.

Evidence and expected effect: live, kb-light-hours 3/3 "часов" → 0/3; bs-kb-soak 1/3 → 0/3; doc-hanging-watering Chinese 1/3 → 0/3 (its grounding stays ≈50%, a distractor problem). scriptClean on r0 cases ≥ 51/52 strawberry, 12/12 bean.

#### Task 3.2: routing rule for automation config + one few-shot example

**Interfaces:**
- Produces: a new bullet in rule 3 of `buildSystemPrompt`, inserted directly after `   - Yêu cầu ĐIỀU KHIỂN → dùng tool điều khiển tương ứng.`; a `get_device_config` example appended as the **last** example of each few-shot set.

Exact rule text (tested live):

```text
   - LUẬT/NGƯỠNG tự động: người dùng HỎI luật/ngưỡng đang cài ("đang ... thế nào/bao nhiêu?") → get_device_config (ĐỌC), không phải get_latest_sensor. Chỉ khi người dùng YÊU CẦU đặt/đổi ngưỡng kèm con số → set_device_config. Bật/tắt chế độ tự động → set_mode. set_pump/set_light chỉ bật/tắt NGAY một lần.
```

Exact example for `STRAWBERRY` (as "Ví dụ 7"):

```text
Ví dụ 7 — hỏi cấu hình tự động đang cài (tool ĐỌC cấu hình, không đọc cảm biến):
Người dùng: "Khu A đang cài tự động theo ngưỡng nào?"
Trợ lý: {"type":"tool","message":"Mình sẽ xem cấu hình ngưỡng tự động hiện tại của thiết bị để biết khi nào bơm và đèn tự bật.","tool":"get_device_config","args":{"device_id":"esp32-01"}}
```

`BEAN_SPROUT` gets the same example as "Ví dụ 7" with message `…để biết khi nào bơm tưới tự bật.` (no light: sprouts stay dark); `neutralFewshot` gets it as "Ví dụ 5" with message `…để biết khi nào thiết bị tự bật bơm hoặc đèn.`

- [ ] **Step 1: Write the failing tests** in `tests/prompt.test.ts`:
  - `buildSystemPrompt` for strawberry contains `'người dùng HỎI luật/ngưỡng đang cài'` and `'→ get_device_config (ĐỌC)'`, and `system.indexOf('LUẬT/NGƯỠNG tự động') < system.indexOf('VÍ DỤ:')` (the rule lives in QUY TẮC, not after the examples).
  - The prose rule is still last: `system.lastIndexOf('ĐOẠN VĂN') > system.indexOf('"tool":"get_device_config"')`.
  - Generalize the existing message-before-tool test to every set: for `getFewshot(loadProfile(p))` with `p` in `['strawberry', 'bean-sprout']` and for a profile with an unknown plant id, `toMatch(/"type":"tool","message"/)` and `not.toMatch(/"type":"tool","tool"/)`; each contains `"tool":"get_device_config"`.
  - The bean-sprout set's `get_device_config` example does not contain `đèn`.
- [ ] **Step 2: Run** `npx vitest run tests/prompt.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** the bullet in `src/llm/prompt.ts` and the three examples in `src/domain/fewshot.ts`.
- [ ] **Step 4: Run** `npx vitest run tests/prompt.test.ts` — Expected: PASS.
- [ ] **Step 5: Commit** — `fix(prompt): route automation-rule questions to get_device_config and changes to set_device_config`.

Evidence and expected effect (live, 21 routing cases = 17 r0 tool cases + 4 r1 variants, one call per case per context): base prompt 18/21 with the r0-default context (exactly r0's three failures: get-moisture-rule, auto-light, set-light-rule) and 19/21 with the hybrid context (auto-light, set-light-rule); rule + example **21/21 in both contexts**, every read case still on a read tool. The rule without the example: 5/5 on the five hardest cases. A first draft without the "HỎI … / YÊU CẦU … kèm con số" contrast sent `r1-get-threshold` to `set_device_config` (2/2); the text above fixes that. Expected: strawberry exact 49/52 → 51–52/52 on r0 cases; safety stays 52/52.

#### Task 3.3: orchestrator net for code-switched text

**Interfaces:**
- Produces: `export function hasForeignScript(text: string): boolean` in `src/agent/orchestrator.ts` (same character ranges as WP-2 Task 2.1; the eval keeps its own copy so the WPs stay independent — fold the eval copy into this export after merge, §6). A plain reply decision (no tool attached) whose message has foreign script takes the existing truncated-reply path (regenerate as prose at `replyTemp`, `reset` first in stream mode). A control tool decision whose `message` has foreign script keeps the pending action and drops the lead-in, so the user sees only the confirmation question. A reply that carries a sensor-read offer is left as is this round.

- [ ] **Step 1: Write the failing tests** in `tests/orchestrator.test.ts`, inside or next to `describe('Orchestrator — truncated reply repair')`:

```ts
it('regenerates a reply that switched to Chinese or Cyrillic', async () => {
  llm.jsonQueue = ['{"type":"reply","message":"Nên ngâm 4 часов, tưới 24小时/24小时。"}']
  const res = await orch.handleChat('u1', 's1', 'ngâm đỗ bao lâu?')
  expect(res.reply).toBe('Câu trả lời hoàn chỉnh bằng văn xuôi.')
  expect(llm.completeCalls).toBe(1)
})

it('drops a code-switched lead-in but still asks to confirm the control tool', async () => {
  llm.jsonQueue = ['{"type":"tool","message":"Mình sẽ bật bơm и tránh úng.","tool":"set_pump","args":{"device_id":"esp32-01","on":true}}']
  const res = await orch.handleChat('u1', 's1', 'tưới đi')
  expect(res.reply).not.toMatch(/и/)
  expect(res.reply).toContain('(Có/Không)')
  expect(res.pendingAction?.tool).toBe('set_pump')
  expect(mcp.calls).toHaveLength(0)
})
```

and `hasForeignScript` unit cases mirroring WP-2 Task 2.1 (Vietnamese with `°C`, `µmol`, `–`, `×`, `m²` → false).
- [ ] **Step 2: Run** `npx vitest run tests/orchestrator.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement**: extend the truncated-reply condition to `isTruncatedReply(message) || hasForeignScript(message)`; in the control branch build `lead` only from a message without foreign script. Update the comment above the truncated-reply branch to name both triggers.
- [ ] **Step 4: Run** `npm test` and `npm run typecheck` — Expected: PASS (including `tests/orchestrator.stream.test.ts`).
- [ ] **Step 5: Commit** — `fix(agent): regenerate code-switched replies and drop code-switched tool lead-ins`.

Expected effect: none on `npm run eval` (the harness reads the raw first decision, not the orchestrator); user-visible replies stop carrying Chinese/Cyrillic text that the unit fix does not prevent.

---

## §5 Round-1 targets, measurement and stop criterion

**Measurement protocol (after all three WPs merge):**

1. `npm test` and `npm run typecheck` green.
2. Run the default config three times per plant: `EVAL_LABEL=r1-strawberry-1 npm run eval` (then `-2`, `-3`), and `DEFAULT_PLANT=bean-sprout EVAL_LABEL=r1-bean-sprout-1 npm run eval` (then `-2`, `-3`). Retrieval metrics are identical across runs; exact/grounding are not (§0).
3. Report each metric as the median of the three runs, computed on `summary` (the r0 case set) and compared with the **re-scored** r0 rows of §3, not the original headline. A case counts as fixed only if it passes in ≥2 of 3 runs; a move under 3 cases is noise.
4. Report `summaryR1` (new cases) separately; it has no baseline and does not enter the stop decision this round.

**Round-1 targets** (r0 case set, corrected labels and grader, median of 3 runs):

| Metric | Re-scored r0 (default) | Round-1 target | Basis |
|---|---|---|---|
| strawberry exact | 49/52 (94%) | ≥ 51/52 (98%) | routing probe 21/21 |
| strawberry safety | 52/52 | 52/52 (hard requirement) | — |
| strawberry gated recall@4 | 0.79 | ≥ 0.9 (expected 0.95) | replay of the new defaults |
| strawberry grounding | 9/12 (75%) | ≥ 9/12, no regression | see below |
| bean-sprout exact / grounding / recall | 12/12 / 6/6 / 1.00 | ≥ 11/12 / 6/6 / 1.00 | replay + r0 |
| replies free of Cyrillic/CJK | 51/52 strawberry, 11/12 bean | 52/52, 12/12 | hour probe 0/9 |
| r1 strawberry retrieval recall (16 labelled) | 0.69 (replayed, old defaults) | ≥ 0.80 (replay: 0.81; r1-container-night misses) | — |

**Grounding is not expected to reach the stop threshold this round.** Two of the 12 grounded strawberry cases (kb-planting, kb-fertilizer) require the reply to name a source. In r0 kb-planting cited 0/3 and kb-fertilizer 2/3 (both passes copied "nguồn [URL]" in dense contexts; the hybrid run did not cite); in 12 probes over 6 reply cases the 3B named a source 0 times unaided and once with the best tested wording. With both failing the ceiling is 10/12 (83%); doc-hanging-watering (≈50%, distractor chunk) and kb-temp (context-sensitive) make 9/12 the expected value. Reaching ≥ 90% needs the citation decision in §6.

**Stop criterion** (as set for the loop, evaluated on the r0 case set with corrected labels/grader): stop when strawberry exact ≥ 95%, grounding ≥ 90%, gated recall@4 ≥ 0.9, bean-sprout exact ≥ 90% and grounding ≥ 85% — or when a round improves no metric by more than 3 points. Round 1 is expected to meet every condition except strawberry grounding, and to improve exact (+2–3 cases) and recall (+16 points), so the loop continues to round 2 with citations as its first item. Independently of the criterion, any drop of safety below 100% reverts that round's prompt change.

## §6 After merge, and round-2 candidates

**Integration (one person, after all WPs merge):**
- Replace the eval copy of `hasForeignScript` (WP-2) by importing the orchestrator export (WP-3); keep both test files.
- Add to CLAUDE.md "Small-model prompt constraints": hour quantities are written "giờ" (the 3B rewrites "h" quantities in Russian/Chinese), and the automation-config routing bullet in rule 3 with its HỎI / YÊU CẦU contrast (a draft without it sent read questions to `set_device_config`).

**Round-2 candidates (evidence exists, not in scope now):**
- **Citations — needs a product decision before any engineering.** Rule 9 asks the model to name its source; the 3B does not (0/12 probes; 1/12 with an explicit clause; a source list next to the question did nothing). Options: (a) the orchestrator appends a deterministic "Nguồn tham khảo: …" built from the sources of the chunks handed to the model — reliable, but it attributes what was consulted, not what was used, and the eval must apply the same post-processing to measure it; (b) a structured `source` field in the decision schema rendered by the orchestrator — keeps the choice with the model but changes the JSON contract tuned for the 3B and needs its own probe; (c) the product decides citations are not required and `requireCitation` is dropped from kb-planting/kb-fertilizer — an expectation change that must be recorded as such.
- doc-container-temp / r1-container-night: TP#3 holds the answer but carries no document context ("container", "dâu tây"); contextual doc-chunk headers found it only in dense mode — needs neighbour-chunk expansion or section-aware headers.
- kb-harvest, doc-hanging-watering: the 3B copies a conflicting number from a distractor chunk even with the answer chunk ranked first.
- kb-toxicity / r1-pet-toxicity: the model fabricates pet safety when the KB says no source covers it.
- If `RAG_HYBRID=0` is ever chosen again: curated-chunk embedding headers (+2/41 in dense mode).
