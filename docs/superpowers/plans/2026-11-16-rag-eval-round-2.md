# RAG + Eval Round 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. The three work packages (WP-1, WP-2, WP-3) run **in parallel**; each may touch **only** the files listed in its own "Files" block, and none needs another WP's code to compile or to pass its tests.

**Goal:** Fix the defects the round-1 runs show, then close the loop. (1) The strawberry few-shot's diagnosis example is copied as the diagnosis for other diseases — gray mold, powdery mildew and bacterial leaf spot are answered "thán thư (Colletotrichum spp.)" in every run — and two grounding checks pass those wrong answers because the reply echoes the symptom from the question. (2) The 3B still code-switches — at "phút", "giờ" and "g/dm²", not only at "h" (bean script-clean 11/10/9 of 12). (3) The round-1 `get_device_config` example pulls a knowledge question onto that tool (`r1-container-night` 3/3). (4) The orchestrator's repair call can hand the user the raw decision JSON. (5) One r1 retrieval label misses an answer-bearing chunk. kb-temp and the pet-toxicity fabrication were probed and have no prompt-level fix (§2.5, §2.6); citations stay out of scope (owner decision pending). The loop stops after this round (§5).

**Architecture:** WP-1 constrains the decision's `message` while it is decoded — a JSON-schema `pattern` that LM Studio compiles into its sampling grammar, so the fix sits in the measured path — and makes the repair call ask for prose and unwrap a JSON answer. WP-2 changes what the 3B reads: one contrast clause on the automation-config routing bullet, and no diagnosis example in the strawberry few-shot set. WP-3 makes the eval grade diagnoses instead of echoed symptoms and corrects one r1 label.

**Tech Stack:** TypeScript ESM run by tsx, Vitest 2, LM Studio (qwen2.5-3b-instruct + text-embedding-bge-m3) for `npm run eval` only.

**Spec:** this document, §0–§3. Inputs: `data/eval/r1-strawberry-{1,2,3}-*.json` and `data/eval/r1-bean-sprout-{1,2,3}-*.json` (round 1 at the defaults: hybrid on, topK 4, MMR 0.7, margin 0.15), `data/eval/r0-*.json`, and the round-1 plan `docs/superpowers/plans/2026-11-16-rag-eval-round-1.md`, whose §0 noise rule and §3 labels still apply.

## Global Constraints

- All user-facing text stays Vietnamese (replies, prompt text, log lines).
- Control tools always go through confirmation; `src/mcp/policy.ts` and the orchestrator's control branch are not touched; safety-class accuracy must stay 100% (a drop reverts that round's prompt change).
- The prose-only reply paragraph (`QUAN TRỌNG khi type="reply"…`) stays the **last** paragraph of the system prompt; every `type:"tool"` few-shot example keeps the field order `type → message → tool → args`. The only few-shot change is WP-2's removal of the strawberry diagnosis example; the `get_device_config` example stays (round 1: rule + example 21/21, rule alone 5/5 on the five hardest cases).
- The decision JSON contract is unchanged (field names, `reasoning` listed first, `required: ['type']`); only `message` gains a `pattern`.
- No new dependencies, services or models. Unit tests run with no external service (fakes/DI per CLAUDE.md "Testing conventions").
- Chunking (`RAG_CHUNK_SIZE=600`, `RAG_CHUNK_OVERLAP=80`, `RAG_MIN_CHUNK_LEN=60`) and retrieval defaults (hybrid on, topK 4, MMR 0.7, margin 0.15, min score 0) are frozen: §2.4 shows no knob moves more than one labelled case.
- `data/docs/*.jsonl` and `src/domain/knowledge/*.json` are human-reviewed content: no WP edits them. Nothing edits `data/cache/` by hand.
- Eval expectations change only as listed in §3. kb-temp's expectation stays: the product rule is that the profile's ranges win over a document (CLAUDE.md "Profile drives both thresholds and RAG"). No few-shot example may reuse an eval message.
- Code comments: say why, never cite a ticket; no comment that restates the line below.
- Commit steps apply only if the executing workflow commits per task; never push.

## Review Focus

1. `MESSAGE_PATTERN` must admit everything a Vietnamese reply uses — NFC and NFD diacritics, `°C`, `µmol`, `m²`, `×`, `–`, `…`, `₫`, `≤`, `→`, and quotes/newlines as the escapes `\"`/`\n` — and reject Cyrillic, CJK (with full-width `：` `。`), kana, Hangul, Arabic, emoji and **every `\uXXXX` escape**: a deny-list pattern was bypassed live with `"دقائق\u00b7\u6253"`. No `(?:` — LM Studio answers 400 `Invalid JSON Schema`. → WP-1 Task 1.1.
2. The repair path never emits `{"type"` in either mode, and in stream mode the repaired text follows a `reset` when a fragment already went out. → WP-1 Task 1.2.
3. The routing contrast keeps every configuration read on `get_device_config` and every threshold change on `set_device_config` (`r1-get-threshold`, `r1-get-light-cfg`, `get-moisture-rule`, `get-light-rule`, `set-light-rule`, `r1-set-lux`, `r1-bs-config`) — live 90/90 in §2.1. → WP-2 Task 2.1.
4. Removing the diagnosis example costs `diag-anthracnose`, which was right only because it is the example's own disease (§2.2); WP-3 adds a check for it so the eval shows that cost instead of hiding it. → WP-3 Task 3.1.
5. Every new or corrected diagnosis check must name the diagnosis, never a symptom the question already contains (the round-0/1 checks for `diag-gray-mold` and `diag-powdery` passed "… khớp nhất với bệnh thán thư (Colletotrichum spp.)" by echoing "lớp mốc xám" / "lớp phấn trắng"). → WP-3 Task 3.1 echo test.

---

## §0 How the evidence was produced

- **Round-1 reports.** Every reply text, grounding reason, foreign-script flag and retrieved chunk id of the six round-1 runs was read; §1 counts are per run (run 1 / 2 / 3).
- **Offline retrieval replay.** The strawberry (69 chunks) and bean-sprout (30) stores were rebuilt with the repo's own `ingestAll` and `retrieve()` against the same LM Studio bge-m3, with the embedding cache redirected outside the repo. The replay reproduces round 1 exactly (strawberry r0 18/19, r1 13/16; bean 7/7, 3/3), so every retrieval number below is exact.
- **Live probes.** qwen2.5-3b-instruct with the eval's exact assembly (`buildSystemPrompt` + `getFewshot` + `retrieve` at the round-1 defaults + `assembleMessages` + `completeJson` at decision temperature 0.1). Each variant is a string transform of the assembled system prompt or knowledge block, or a changed JSON schema. About 1,100 calls in total, 2–6 samples per case per arm, including two **simulated round-2 evals** (every strawberry and bean case, 2 samples each) of the final configuration (see §2.8).
- **Noise rule (round-1 §0, unchanged).** A single-run difference of ≤2 cases is noise; a case counts as fixed only if it passes in ≥2 of 3 runs. Identical requests at temperature 0.1 still flipped verdicts here (`r1-container-night` 1/3 in a probe vs 0/3 in the eval; `doc-lowland-climate` 3/3 vs 2/3), so single-sample differences are not read as effects.

## §1 Diagnosis per remaining failure (round-1 runs)

NA = ngheandost (19-chunk procedure doc), TP = techport, NNMT = nongnghiepmoitruong. "Fused" ranks are the hybrid (dense + BM25, RRF) order before MMR; 0 = best. "Right diagnosis" counts a reply that names the expected disease before any "thán thư".

| Case (metric) | Set | Runs 1/2/3 | Class | Evidence and root cause | Action |
|---|---|---|---|---|---|
| diag-gray-mold, diag-powdery (grounding) | r0 | **false pass** ×3 each | few-shot copy + grader | Every reply diagnoses the few-shot's disease: "Quả dâu bị thối mềm và có lớp mốc xám phủ lên khớp với triệu chứng của bệnh thán thư (Colletotrichum spp.)"; "Lá dâu tây có lớp phấn trắng mặt dưới kèm mép lá cong tím đỏ khớp nhất với bệnh thán thư (Colletotrichum spp.)". The right `disease:` chunk is rank 1 in every run (0.670, 0.689). Strawberry Ví dụ 6 answers "thán thư (Colletotrichum spp.)" with the reasoning template "… khớp nhất với thán thư"; the 3B reuses both. The checks `['mốc xám', 'botrytis']` / `['phấn trắng']` pass on the symptom words the question already holds. Same in all three round-0 runs. | WP-2 Task 2.2, WP-3 Task 3.1 |
| r1-bact-spot (no check), r1-slug, diag-spider-mite | r1 / r0 | bact-spot wrong ×3; slug wrong in run 3; spider-mite wrong in 2 of 3 round-0 runs | few-shot copy | "Đốm nhỏ sũng nước trên mặt dưới lá … khớp nhất với thán thư (Colletotrichum spp.)" with `disease:bacterial-leaf-spot` at rank 1. Over the 13 diagnosis-type cases, round 1 named the right disease in 26/36 replies; all 10 wrong ones say "thán thư". | WP-2 Task 2.2, WP-3 Task 3.1 |
| kb-temp (grounding) | r0 | ✗ / ✗ / ✗ | model vs conflicting document | Every reply: "Cây dâu tây thích hợp ở nhiệt độ từ 15 - 26°C". TP#0 (a controlled-environment study: "ngưỡng nhiệt độ thích hợp cho cây dâu tây là từ 15 - 26°C") is fused rank 0 (cos 0.789); the profile's 10–27°C is only in the system prompt and rule 10 is not followed. Same in r0's default and hybrid runs. | none — §2.5, §6 |
| kb-fertilizer, kb-planting (grounding: citation) | r0 | ✗✗✗ / ✗✗✓ | citation | Answer chunks retrieved every run; run 3 of kb-planting named the NA URL. | out of scope |
| doc-lowland-climate (grounding) | r0 | ✓ / ✓ / ✗ | noise | Run 3 "ban ngày … 20-30°C … ban đêm không quá 15°C" with the same context as runs 1–2 (NNMT#0 "ban ngày ở mức 28 độ C, đến đêm chỉ còn 18 độ C" at rank 1). | none |
| doc-container-temp (recall) | r0 | 0 / 0 / 0 | retrieval: the chunk never names its topic | TP#3, the only chunk with "27°C ban ngày, 17°C ban đêm", is fused rank 8 (dense 19, BM25 9) and never says "container" or "dâu tây"; replies give TP#0's "15-26°C". | none — §2.4, §6 |
| code-switch, strawberry | r0 | 2 / 1 / 0 replies | model (script) | Run 1: kb-light-hours "6-12 часов/ngày" although the context already says "giờ"; uses-processing "nước ép giải渴。". Run 2: kb-toxicity "rửa tay kỹ sau khi拾取叶子。". Script-clean 50/51/52. | WP-1 Task 1.1 |
| code-switch, bean | r0 | 1 / 2 / 3 replies | model (script) | bs-kb-soak runs 2–3 and bs-kb-watering runs 2–3 "mỗi lần tưới trong 1 минут" (every source says "1 phút"); bs-kb-microbe runs 1 and 3 "35°C trong 4 часов … 40 г/дм²" (context "4 giờ" after round 1's normalization, "40 g/dm2"). Script-clean 11/10/9. Round 1's "unit h" diagnosis was incomplete: the 3B switches at quantities whatever the spelling. | WP-1 Task 1.1 |
| r1-container-night (exact, grounding, recall) | r1 | `get_device_config` ×3 | prompt — **round-1 regression** — plus retrieval | The lead-in is Ví dụ 7's message verbatim ("Mình sẽ xem cấu hình ngưỡng tự động hiện tại của thiết bị để biết khi nào bơm và đèn tự bật."). §2.1 isolates the example as the cause. TP#3 is fused rank 8, so no reply can contain "17". | WP-2 Task 2.1; grounding stays ✗ |
| r1-bed-height (grounding, recall) | r1 | ✗ / ✗ / ✗ | retrieval (diluted chunk) → fabrication | `strawberry:care_notes#0` ("Lên luống cao 20–25 cm ở vùng đất thấp và 15–20 cm ở vùng đất cao") is dense rank 26 — 600 characters on soil, beds, mulch and pruning — BM25 rank 1, fused 6. Replies invent "30-40cm" (runs 1, 3) or read altitude as bed height ("790 đến 900m", run 2). | none — §2.4, §6 |
| r1-old-runners (recall) | r1 | 0 / 0 / 0 | **label** | `strawberry:propagation#0` is BM25 rank 0, dense 15, fused 4, dropped by MMR. NA#2, picked in every run, states the rule: "Chỉ nên lấy cây con từ tách ngó cây mẹ dưới 01 năm tuổi thì mới đảm bảo chất lượng giống"; runs 1 and 3 answer from it. | WP-3 Task 3.2 |
| r1-pet-toxicity (grounding); kb-toxicity (no check) | r1 / r0 | ✗ / ✓ / ✗; kb-toxicity "safe" ×3 | model fabrication | `strawberry:toxicity#0` is retrieved every run: "chưa cung cấp thông tin riêng về độc tính của cây đối với vật nuôi, nên phần này chỉ khẳng định quả dâu tây an toàn để ăn cho người". Replies turn "quả" into "Lá" ("Lá dâu tây an toàn để chó ăn theo tiêu chuẩn VietGAP/GlobalGAP", kb-toxicity run 1) and invent compounds ("coumarin và saponin"). | none — §2.6, §6 |
| repair path (not in the eval) | — | — | orchestrator defect | The repair request (decision prompt + `PROSE_ANSWER_INSTRUCTION`, unconstrained, temperature 0.3) answered with the decision JSON in 5/5 samples on bs-kb-soak, 3 of them still in Cyrillic; the orchestrator ships that string verbatim. Pre-existing for truncated replies (none in 272 reply decisions across all ten reports), reachable since round 1 by every code-switched reply. | WP-1 Task 1.2 |
| not graded | — | — | — | Self-written sensor offers ("Nếu muốn, mình có thể kiểm tra …"; the reply carries no tool, so a following "có" runs nothing): 5 of 93 r0-case replies in round 1 vs 2 of 93 in round 0 — within noise. bs-hello 3/3 answers the greeting with care advice ending "kiểm tra ngưỡng tự động của thiết bị" (round 0: a plain greeting) — wording bleed from Ví dụ 7. | §6 |

Retrieval for every other labelled case is at its round-1 value (strawberry r0 18/19, bean 7/7 + 3/3).

## §2 Probes and decisions

### §2.1 The `get_device_config` example pulls a knowledge question (round-1 regression)

`r1-container-night`, 3 samples per arm (the eval itself: 0/3 reply):

| Arm | Correct (reply) |
|---|---|
| round-1 prompt | 1/3 |
| routing bullet removed, Ví dụ 7 kept | 0/3 |
| Ví dụ 7 removed, bullet kept | 3/3 |
| both removed | 3/3 |
| bullet + a contrast clause, Ví dụ 7 kept (three wordings) | 3/3 each |

The example drives the error, but it is also what routes real configuration questions (round 1), so it stays and the bullet gets a contrast clause (WP-2 Task 2.1). With that clause, over all 25 strawberry tool cases (r0 + r1), 11 strawberry knowledge/chat traps (kb-temp, kb-moisture, kb-ph, kb-light-hours, doc-container-temp, doc-nitrogen, doc-hanging-watering, r1-container-night, r1-bed-height, chat-hello, symptom-yellow-leaves), the 5 bean tool cases and 4 bean traps (bs-kb-watering "Máy làm giá tự động nên tưới theo chu kỳ thế nào?", bs-kb-temp, bs-hello, bs-kb-soak), 2 samples each: **90/90 correct**, every read case on its read tool. No round-0 knowledge case moved to a tool in round 1 (93/93 replies).

### §2.2 The diagnosis example is copied

13 diagnosis-type cases (diag-gray-mold, diag-powdery, diag-anthracnose, diag-spider-mite, kb-botrytis, symptom-leaf-spot and the seven r1 disease cases), 2 samples per arm, right diagnosis among the 12 with a known answer:

| Arm | Right | Lost / gained vs the round-1 prompt |
|---|---|---|
| round-1 prompt | 17/24 | gray-mold 0/2, powdery 0/2, bact-spot 0/2, spider-mite 1/2 — each wrong reply says "thán thư" |
| **Ví dụ 6 removed** | **22/24** | gains gray-mold 2/2, powdery 2/2, bact-spot 2/2, spider-mite 2/2; loses diag-anthracnose 0/2 ("Bệnh này thường do đốm lá hoặc thối rễ gây ra") |
| Ví dụ 6 kept, reasoning rewritten to "So triệu chứng với phần Triệu chứng của từng mục [bệnh] trong tri thức tham khảo …" | 16/22 | gains powdery, bact-spot; still thán thư for gray mold; loses slug and anthracnose |

The anthracnose case was right only because it asks for the example's own disease. Removing the example is the measured best; WP-3 adds a check for `diag-anthracnose` so the eval sees that cost. Full-set effect: §2.7.

### §2.3 Code-switching: a decode-time allow-list

Same six contexts, 6 samples per case per arm (bs-kb-soak, bs-kb-watering, bs-kb-microbe, kb-toxicity, kb-light-hours, uses-processing):

| Arm | Replies with Cyrillic/CJK | Grounding (bs-kb-soak) | Mean latency per call |
|---|---|---|---|
| round-1 schema | 8/36 (bs-kb-soak 5/6 "1 минут", kb-toxicity 3/6 "拾取叶子") | 6/6 | 2.6–5.7 s |
| `message` with `MESSAGE_PATTERN` | **0/36** ("mỗi lần tưới trong 1 phút", "rửa tay kỹ sau khi cắt lá") | 6/6 | 2.4–3.6 s |

- LM Studio enforces `pattern`: `^[a-z ]*$` turned "Hello World 123" into "hello world  ert".
- A deny-list (`^[^\u0400-\u04FF…]*$`) is not enough: asked for Russian and Chinese words, the model wrote `"دقائق\u00b7\u6253"` — Arabic, plus a JSON `\u` escape that decodes to 打. With the allow-list the same request gave ".Minute. agua", and a Vietnamese sentence with `75–80%`, `10-27°C`, `µmol/m²/s`, `20 cm × 20 cm` and quotes came back intact.
- `(?:…)` groups make LM Studio reject the whole schema (400 `Invalid JSON Schema`); plain groups work.
- No Latin transliteration ("minut", "chasov") in the 36 constrained samples.

The round-1 hour normalization stays ("h" is still a trigger, and it is harmless). The orchestrator's `hasForeignScript` net stays for providers that ignore `pattern`.

### §2.4 Retrieval: no knob change

Deterministic gated recall@4 over every labelled case (strawberry r0 19 + r1 16, bean r0 7 + r1 3):

| Config | straw r0 | straw r1 | bean r0 | bean r1 | total /45 |
|---|---|---|---|---|---|
| **round-1 default** (hybrid, topK 4, MMR 0.7, pool 3×topK) | 18 | 13 | 7 | 3 | 41 |
| topK 5 | 18 | 13 | 7 | 3 | 41 |
| topK 6 | 18 | 13 | 7 | 3 | 41 |
| MMR pool 2×topK | 18 | 13 | 7 | 3 | 41 |
| λ 0.85 | 17 | 13 | 7 | 3 | 40 |
| λ 1 (plain top-K) | 16 | 13 | 6 | 3 | 38 |
| min-max relevance inside the MMR pool | 17 | 13 | 6 | 3 | 39 |
| min-max, λ 0.5 | 17 | 13 | 7 | 3 | 40 |
| BM25 top-1 always kept | 18 | 14 | 7 | 3 | 42 |

Nothing moves more than one case (the last row only recovers `r1-old-runners`, whose label WP-3 corrects anyway). The remaining misses — TP#3 for `doc-container-temp` and `r1-container-night`, `care_notes#0` for `r1-bed-height` — are chunk-content problems (a chunk that never names its topic; a long multi-topic profile chunk) that need chunking or content work outside this round's constraints (§6). For later work: RRF scores normalized by the maximum span only 0.9–1.0 across the 12-chunk pool, so MMR at λ 0.7 is close to "the most mutually different chunks of the top 12" — the measured round-1 effect being kept, not a tuned trade-off.

### §2.5 kb-temp: every placement that fixes it breaks something else

3 samples per arm. The 3B copies numbers from the knowledge block and ignores system-prompt rules about them.

| Arm | kb-temp | Side effects |
|---|---|---|
| round-1 prompt | 0/3 | — |
| rule 10 rewritten ("câu hỏi CHUNG … → Khoảng tối ưu") | 0/3 | doc-lowland-climate 2/3 |
| reminder paragraph right before the prose rule | 0/3 | doc-hanging-watering 2/3 → 0/3 |
| ranges as the **first** knowledge entry, "ưu tiên khi tài liệu dưới đây nói khác" | 3/3 | doc-lowland-climate 3/3 → 0/3, doc-hanging-watering 2/3 → 0/3: the reply pastes the whole list ("khí hậu cần ưu tiên điều kiện nhiệt độ 10-27°C; độ ẩm không khí 40-90%; …") |
| neutral first entry / one-sentence first entry | 3/3 / 3/3 | doc-lowland-climate 1/3 / 0/3 |
| neutral **last** entry `[khoảng tối ưu chung (hồ sơ cây)] …` | 3/3 (2/2 in the simulated eval) | simulated eval with the WP-1/WP-2 changes: `r1-container-night` back on `get_device_config` 2/2, three replies emitted two JSON objects (parse failures on chat-hello, chat-name, r1-thrips); strawberry exact 139/144 vs 144/144 |

Not adopted. kb-temp stays failing; §6 lists what would fix it.

### §2.6 Pet toxicity: every rule variant is worse

4 samples per case per arm (kb-toxicity, r1-pet-toxicity), plus 8 answerable reply cases at 1 sample to check for over-hedging:

| Arm | r1-pet-toxicity grounding | kb-toxicity tells the user the leaves are safe **for the dog** |
|---|---|---|
| round-1 prompt | 0/4 | 0/4 ("Lá … an toàn để ăn cho người" 4/4) |
| rule 8 + "nếu tri thức ghi là CHƯA có thông tin … KHÔNG tự kết luận là an toàn hay vô hại" | 0/4 | 1/4 |
| same + "(vd độc tính với vật nuôi) … khuyên hỏi bác sĩ thú y" | 2/4, via "thú y", still inventing "lá … chứa các chất gây độc nhẹ" | **4/4** |
| the clause as a paragraph before the prose rule | 1/4 | **4/4** |

The 8 other reply cases stayed replies in every arm. Not adopted.

### §2.7 The repair request

`PROSE_ANSWER_INSTRUCTION` is appended to a conversation whose system prompt demands one JSON decision. 5 samples per arm:

| Context | Current instruction: JSON / Cyrillic | Instruction opening with "Lần này KHÔNG trả JSON." |
|---|---|---|
| bs-kb-soak | **5/5 / 3/5** | 0/5 / 0/5 |
| kb-toxicity | 0/5 / 0/5 | 0/5 / 0/5 |

Whether the answer comes back as JSON depends on the context, so WP-1 Task 1.2 changes the instruction **and** unwraps a decision JSON.

### §2.8 Simulated round-2 eval

Never filled in: this table has no recorded run, so the figures other sections cite from §2.8 have no recorded run behind them. The one recorded combined run (the last row of §2.5) already had `r1-container-night` back on `get_device_config`; see the round-3 plan (`2026-11-17-rag-eval-round-3.md`) §2.1.

## §3 Eval corrections (WP-3)

**Diagnosis checks (Task 3.1).** A diagnosis check must name the diagnosis; a term the question already contains passes any reply that repeats the symptom.

| Case | Set | Old grounding | New grounding | Why |
|---|---|---|---|---|
| diag-gray-mold | r0 | `mustIncludeAny ['mốc xám', 'botrytis']` | `['botrytis', 'bệnh mốc xám', 'thối xám']` | The question holds "lớp mốc xám"; all six round-0/1 replies passed while diagnosing thán thư (quoted in §1). |
| diag-powdery | r0 | `['phấn trắng']` | `['bệnh phấn trắng', 'nấm phấn trắng', 'podosphaera', 'sphaerotheca']` | The question holds "lớp phấn trắng"; same six false passes. `disease:powdery-mildew` names Podosphaera aphanis, `strawberry:diseases#0` Sphaerotheca macularis. |
| diag-anthracnose | r0 | none | `['thán thư', 'colletotrichum']` | Makes WP-2's one known loss visible (§2.2). |
| diag-spider-mite | r0 | none | `['nhện đỏ', 'tetranychus']` | Round 0 named "Xanthomonas" and "đốm lá" here; the round-0 labels already list `disease:spider-mite` / NA#11. |
| r1-root-rot | r1 | none | `['thối đen rễ', 'thối rễ', 'rễ thối', 'pythium', 'fusarium']` | Names from `disease:root-rot` and `strawberry:diseases#0`. |
| r1-thrips | r1 | none | `['bọ trĩ', 'bù lạch', 'thrips', 'frankliniella']` | `disease:thrips`. |
| r1-aphid | r1 | none | `['rệp', 'aphid']` | `disease:aphid`. |
| r1-slug | r1 | none | `['ốc sên', 'sên nhớt', 'gastropoda']` | `disease:slug-snail`. |
| r1-bact-spot | r1 | none | `['vi khuẩn', 'xanthomonas', 'xì mủ']` | `disease:bacterial-leaf-spot` "Đốm lá vi khuẩn (xì mủ)"; round 1 answered thán thư 3/3. |
| r1-leaf-spot | r1 | none | `['đốm lá', 'mycosphaerella']` | `disease:leaf-spot`. |

No term appears in its own question (checked for all ten). kb-botrytis keeps `['mốc xám', 'botrytis']`: its question names the disease, so the check only confirms the reply stays on it; its replies are right in all six runs.

**Retrieval label (Task 3.2).**

| Case | Old | New | Why (quote from the chunk) |
|---|---|---|---|
| r1-old-runners | `[['strawberry:propagation']]` | `[['strawberry:propagation', `${NGHEAN}#2`]]` | NA#2: "Chỉ nên lấy cây con từ tách ngó cây mẹ dưới 01 năm tuổi thì mới đảm bảo chất lượng giống." It answers whether runners from an old garden should be reused; runs 1 and 3 answered from it ("Nên tách cây con từ ngó cây mẹ dưới một năm tuổi để đảm bảo chất lượng giống"). |

Not changed: kb-temp (product rule), r1-bed-height (only `care_notes#0` gives bed height; VAAS_GIONG#2's "Máng trồng rộng 30 cm, cao 25 cm" is a trough), r1-container-night and doc-container-temp (only TP#3 has the container regime), r1-pet-toxicity.

**Rounds 0 and 1 re-scored under §3** (stored replies, repo grader; recall replayed). Round 2 is compared against **this** row set:

| Run set | strawberry r0 grounding (/14) | strawberry r1 grounding (/15) | r1 gated recall (/16) |
|---|---|---|---|
| round 0 (default / hybrid / plain) | 8 / 8 / 8 (57%) | — | — |
| round 1 (runs 1 / 2 / 3) | **9 / 9 / 9 (64%)** | **11 / 12 / 11** | **14** (0.875) |

Round-1 failures under §3: r0 kb-temp, kb-fertilizer, kb-planting (runs 1–2), diag-gray-mold, diag-powdery, doc-lowland-climate (run 3); r1 r1-bact-spot, r1-bed-height, r1-container-night, r1-pet-toxicity (runs 1, 3). The headline moves from 9/12 (75%) to 9/14 (64%) because two passes were false and two checks were added; this is measurement, not regression.

**Post-repair output is not measured.** The eval keeps grading the raw first decision. With WP-1 that decision cannot carry Cyrillic/CJK on LM Studio (0/36 in §2.3, 0/176 in §2.8), and truncation — the other repair trigger — occurred in none of the 272 reply decisions of rounds 0–1, so the repaired text is not what a user sees in the measured setup; WP-1's unit tests pin it. If a provider that ignores `pattern` is ever evaluated, `scriptClean` will show it, and that is when a post-repair metric is worth adding.

---

## §4 Work packages

Ordered by user impact. WP-1 removes code-switching from every decision and stops the repair path from shipping JSON. WP-2 stops wrong diagnoses copied from the few-shot set and undoes the round-1 routing regression. WP-3 makes the eval see diagnoses at all. File sets are disjoint and no WP needs another WP's code; all three are measured together after merge (§5).

### WP-1 — Decode-time script guard and a prose-only repair

**Files (only these):** `src/agent/decision.ts`, `tests/decision.test.ts`, `src/agent/orchestrator.ts`, `tests/orchestrator.test.ts`, `tests/orchestrator.stream.test.ts`.

**Root cause addressed:** the 3B switches script at quantities and Sino-Vietnamese words whatever the unit's spelling in its context ("1 phút" → "1 минут", "4 giờ" → "4 часов", "40 g/dm2" → "40 г/дм²", "giải khát" → "giải渴"), and round 1's only answer was a net outside the measured path whose regeneration — the decision prompt plus a prose instruction — comes back as a decision JSON string in some contexts (§2.7), which the orchestrator ships verbatim.

**Expected eval effect:** script-clean on the r0 set 50/51/52 → 52/52 in every run for strawberry and 11/10/9 → 12/12 for bean (§2.3: 0/36 constrained vs 8/36; §2.8: no foreign script in any constrained sample); exact, grounding and recall unchanged (§2.8). The repair change has no eval effect; its unit tests carry it.

#### Task 1.1: allow-list `pattern` on `message`

**Interfaces:**
- Produces: `export const MESSAGE_PATTERN: string` in `src/agent/decision.ts`; `AGENT_DECISION_JSON_SCHEMA.properties.message.pattern === MESSAGE_PATTERN`. `reasoning`, `tool` and `args` stay unconstrained. `src/eval/run.ts` and the orchestrator already import `AGENT_DECISION_JSON_SCHEMA`, so both pick it up unchanged.

- [ ] **Step 1: Write the failing tests** in `tests/decision.test.ts`

```ts
import { AGENT_DECISION_JSON_SCHEMA, MESSAGE_PATTERN } from '../src/agent/decision'

// llama.cpp applies a string `pattern` to the raw JSON string body, escapes included.
const admits = (text: string) => new RegExp(MESSAGE_PATTERN, 'u').test(JSON.stringify(text).slice(1, -1))

describe('MESSAGE_PATTERN', () => {
  it('admits Vietnamese with the units, symbols and escapes replies use', () => {
    expect(admits('Độ ẩm đất 75–80%, nhiệt độ 10-27°C, 100–110 µmol/m²/s, 20 cm × 20 cm, ≤ 50.000₫ → tưới…')).toBe(true)
    expect(admits('Độ ẩm đất'.normalize('NFD'))).toBe(true)
    expect(admits('Theo "Khuyến nông Lâm Đồng":\nnên tưới nhỏ giọt.')).toBe(true)
    expect(admits('pH 5,5–6,5; EC 0.8–2.2 mS/cm; https://ngheandost.gov.vn/x-2490.html#2')).toBe(true)
    expect(admits('')).toBe(true)
  })

  it('rejects Cyrillic, CJK, kana, Hangul, Arabic, emoji and full-width punctuation', () => {
    for (const t of ['mỗi lần tưới 1 минут', 'nước ép giải渴。', 'tưới みず', '물 주기', 'دقائق', 'dâu 🍓', 'xong rồi：'])
      expect(admits(t), t).toBe(false)
  })

  it('rejects \\u escapes, which carried a CJK character past a deny-list', () => {
    expect(new RegExp(MESSAGE_PATTERN, 'u').test(String.raw`sau khi \u6253`)).toBe(false)
  })

  it('constrains message only, without the (?: groups LM Studio rejects', () => {
    const props = AGENT_DECISION_JSON_SCHEMA.properties as Record<string, { pattern?: string }>
    expect(props.message?.pattern).toBe(MESSAGE_PATTERN)
    expect(props.reasoning?.pattern).toBeUndefined()
    expect(MESSAGE_PATTERN).not.toContain('(?:')
  })
})
```

- [ ] **Step 2: Run** `npx vitest run tests/decision.test.ts` — Expected: FAIL (`MESSAGE_PATTERN` is not exported).
- [ ] **Step 3: Implement.** In `src/agent/decision.ts`:

```ts
export const MESSAGE_PATTERN = String.raw`^([ -\[\]-~\u00A0-\u024F\u0300-\u036F\u1E00-\u1EFF\u2000-\u206F\u2070-\u20CF\u2100-\u214F\u2190-\u22FF]|\\["\\/nt])*$`
```

and add `pattern: MESSAGE_PATTERN` to the `message` property. Comment above the constant (why, not what): the 3B code-switches mid-sentence at quantities and Sino-Vietnamese words; LM Studio compiles the pattern into its sampling grammar so those characters cannot be generated; it is an allow-list (printable ASCII without the backslash, Latin-1 and Latin Extended, combining marks, Vietnamese tone letters, punctuation, super/subscripts and currency, letterlike symbols, arrows, math operators; escapes only `\" \\ \/ \n \t`) because a deny-list was bypassed with other scripts and `\u` escapes; plain groups because LM Studio rejects `(?:`; a provider that ignores `pattern` still has the orchestrator's `hasForeignScript` net. Leave the `reasoning`-first comment as is.
- [ ] **Step 4: Run** `npx vitest run tests/decision.test.ts` — Expected: PASS (the two existing tests too).
- [ ] **Step 5: Commit** — `fix(agent): constrain the decision message to Vietnamese text while it is decoded`.

Live check of this exact pattern (LM Studio, before writing the plan): a Vietnamese sentence with `75–80%`, `10-27°C`, `µmol/m²/s`, `×` and quotes passes unchanged; a request for Russian and Chinese words yields Latin only.

#### Task 1.2: the repair call asks for prose and never ships JSON

**Interfaces:**
- Produces: `export function replyTextOf(raw: string): string` in `src/agent/orchestrator.ts` — when `raw` parses as a decision (the existing `parseDecision`), its trimmed `message` (possibly `''`); otherwise `raw.trim()`. `PROSE_ANSWER_INSTRUCTION` becomes exactly `'Lần này KHÔNG trả JSON. Hãy viết câu trả lời cho người dùng bằng tiếng Việt thành MỘT đoạn văn liền mạch, ngắn gọn (2-5 câu), KHÔNG dùng gạch đầu dòng hay danh sách, và KHÔNG kết thúc bằng dấu hai chấm.'` (the probed text, §2.7). In both modes the regenerated text goes through `replyTextOf(text) || FALLBACK_REPLY`; stream mode still calls `completeStream` (with the abort signal) but collects the deltas and sends the result as one `token` frame, after the `reset` it already sends when a fragment went out.

- [ ] **Step 1: Write the failing tests.** In `tests/orchestrator.test.ts`, let `FakeLlm.complete` record its messages (`lastCompleteMessages = messages`), then add to `describe('Orchestrator — truncated reply repair')`:

```ts
it('ships the message, not the JSON, when the repair answers with a decision object', async () => {
  llm.jsonQueue = ['{"type":"reply","message":"Nên ngâm 4 часов."}']
  llm.completeReturn = '{"type":"reply","message":"Nên ngâm đỗ xanh trong nước 35°C khoảng 4 giờ."}'
  const res = await orch.handleChat('u1', 's1', 'ngâm đỗ bao lâu?')
  expect(res.reply).toBe('Nên ngâm đỗ xanh trong nước 35°C khoảng 4 giờ.')
})

it('tells the repair call not to answer in JSON', async () => {
  llm.jsonQueue = ['{"type":"reply","message":"Các nguyên nhân gồm:"}']
  await orch.handleChat('u1', 's1', 'vì sao lá vàng?')
  expect(String(llm.lastCompleteMessages?.at(-1)?.content)).toMatch(/^Lần này KHÔNG trả JSON\./)
})
```

and next to `describe('isTruncatedReply')`:

```ts
describe('replyTextOf', () => {
  it('unwraps a decision, keeps prose, and empties a decision without a message', () => {
    expect(replyTextOf('{"type":"reply","message":"Tưới nhỏ giọt."}')).toBe('Tưới nhỏ giọt.')
    expect(replyTextOf('  Tưới nhỏ giọt, tránh úng.  ')).toBe('Tưới nhỏ giọt, tránh úng.')
    expect(replyTextOf('{"type":"reply","message":""}')).toBe('')
  })
})
```

In `tests/orchestrator.stream.test.ts`, inside `describe('Orchestrator — handleChatStream')`:

```ts
it('sends the unwrapped repair as one frame after a reset', async () => {
  llm.jsonScripts = [['{"type":"reply","message":"Các nguyên nhân gồm:"}']]
  llm.streamScripts = [['{"type":"reply",', '"message":"Lá vàng do úng nước."}']]
  const events = await collect(orch.handleChatStream('u1', 's1', 'vì sao lá vàng?'))
  const reset = events.findIndex((e) => e.type === 'reset')
  expect(reset).toBeGreaterThan(-1)
  expect(tokens(events.slice(reset + 1))).toBe('Lá vàng do úng nước.')
  expect(doneOf(events).reply).toBe('Lá vàng do úng nước.')
})
```

- [ ] **Step 2: Run** `npx vitest run tests/orchestrator.test.ts tests/orchestrator.stream.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** `replyTextOf`, the new instruction text and the collected stream as specified. Update the comment above the repair branch: it now also says the regeneration shares the JSON-demanding system prompt, so its answer is unwrapped and, in stream mode, sent whole.
- [ ] **Step 4: Run** `npm test` and `npm run typecheck` — Expected: PASS (the existing dangling-colon, empty-reply, code-switch and control lead-in tests unchanged).
- [ ] **Step 5: Commit** — `fix(agent): repair call asks for prose and never ships a decision JSON`.

### WP-2 — What the 3B reads: routing contrast, no diagnosis example

**Files (only these):** `src/llm/prompt.ts`, `src/domain/fewshot.ts`, `tests/prompt.test.ts`.

**Root cause addressed:** (a) Ví dụ 7 (a configuration read) is the nearest template for a "… có kiểm soát thì … giữ nhiệt độ bao nhiêu?" knowledge question, and the routing bullet never says what is not a configuration question; (b) strawberry Ví dụ 6 is a diagnosis whose disease the 3B reuses as its answer for other diseases even with the right `[bệnh]` entry ranked first.

**Expected eval effect:** r1 strawberry exact 19/20 → 20/20 (`r1-container-night` reply 5/5 in probes, 2/2 in §2.8); r0 exact stays 52/52; under the §3 checks, r0 grounding 9/14 → 10/14 (diag-gray-mold and diag-powdery right, diag-anthracnose lost) and r1 grounding +1 (r1-bact-spot) — §2.2, §2.8.

#### Task 2.1: contrast clause on the routing bullet

**Interfaces:**
- Produces: the rule-3 bullet that starts `   - LUẬT/NGƯỠNG tự động:` ends with the sentence ` Hỏi kiến thức trồng trọt ("nên/cần giữ nhiệt độ bao nhiêu") → reply, không gọi tool.` The rest of the bullet is unchanged:

```text
   - LUẬT/NGƯỠNG tự động: người dùng HỎI luật/ngưỡng đang cài ("đang ... thế nào/bao nhiêu?") → get_device_config (ĐỌC), không phải get_latest_sensor. Chỉ khi người dùng YÊU CẦU đặt/đổi ngưỡng kèm con số → set_device_config. Bật/tắt chế độ tự động → set_mode. set_pump/set_light chỉ bật/tắt NGAY một lần. Hỏi kiến thức trồng trọt ("nên/cần giữ nhiệt độ bao nhiêu") → reply, không gọi tool.
```

- [ ] **Step 1: Write the failing test** in `tests/prompt.test.ts`:

```ts
it('keeps "what should it be kept at" questions on reply, inside the routing bullet', () => {
  const profile = loadProfile('strawberry')
  const system = buildSystemPrompt({ profile, tools: KNOWN_TOOLS, fewshot: getFewshot(profile) })
  const bullet = system.split('\n').find((l) => l.startsWith('   - LUẬT/NGƯỠNG tự động:')) ?? ''
  expect(bullet).toContain('người dùng HỎI luật/ngưỡng đang cài')
  expect(bullet).toContain('YÊU CẦU đặt/đổi ngưỡng kèm con số → set_device_config')
  expect(bullet.endsWith('Hỏi kiến thức trồng trọt ("nên/cần giữ nhiệt độ bao nhiêu") → reply, không gọi tool.')).toBe(true)
})
```

- [ ] **Step 2: Run** `npx vitest run tests/prompt.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** the sentence in `buildSystemPrompt`.
- [ ] **Step 4: Run** — Expected: PASS (the round-1 routing test still passes).
- [ ] **Step 5: Commit** — `fix(prompt): keep knowledge questions about values to keep off get_device_config`.

#### Task 2.2: no diagnosis example in the strawberry set

**Interfaces:**
- Produces: `STRAWBERRY` in `src/domain/fewshot.ts` without the block "Ví dụ 6 — chẩn đoán bệnh …" (user message, reasoning and reply); the `get_device_config` example becomes "Ví dụ 6". `BEAN_SPROUT` and the neutral set are unchanged (bean's Ví dụ 6 explains causes, not a disease, and no bean case showed copying).

- [ ] **Step 1: Write the failing test** in `tests/prompt.test.ts`:

```ts
it('gives the strawberry set no diagnosis to copy', () => {
  const fewshot = getFewshot(loadProfile('strawberry'))
  // The 3B answered "thán thư (Colletotrichum spp.)" for gray mold, powdery mildew and bacterial
  // leaf spot while the right [bệnh] entry was ranked first.
  expect(fewshot).not.toMatch(/thán thư|Colletotrichum/)
  expect(fewshot).not.toContain('chẩn đoán bệnh')
  expect(fewshot).toContain('Ví dụ 6 — hỏi cấu hình tự động')
})
```

- [ ] **Step 2: Run** `npx vitest run tests/prompt.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement.** Delete the block and renumber. Extend the file's top comment with one sentence: an example must not answer a diagnosis, because the 3B reuses its disease as the answer for other symptoms.
- [ ] **Step 4: Run** `npm test` — Expected: PASS (every set still has message-before-tool and a `get_device_config` example).
- [ ] **Step 5: Commit** — `fix(prompt): drop the strawberry diagnosis example the model copied as its answer`.

### WP-3 — Eval: grade diagnoses, one retrieval label

**Files (only these):** `src/eval/dataset.ts`, `tests/eval-dataset.test.ts`.

**Root cause addressed:** two r0 diagnosis checks are met by repeating the question's symptom, so six wrong diagnoses scored as passes in rounds 0–1; no other diagnosis case had a check, so the few-shot copy defect was invisible, and so would WP-2's one known loss be; `r1-old-runners` omits the chunk that states the rule its replies use.

**Expected eval effect:** measurement only — the re-scored rows of §3 (round 1: r0 grounding 9/14, r1 11–12/15, r1 recall 0.875). No system behaviour changes.

#### Task 3.1: diagnosis checks

**Interfaces:**
- Consumes: `gradeGrounding` from `src/eval/grounding.ts` (unchanged).
- Produces: the ten `grounding` values of the §3 table on those cases, exactly as tabled.

- [ ] **Step 1: Write the failing tests** in `tests/eval-dataset.test.ts`:

```ts
import { gradeGrounding } from '../src/eval/grounding'

const caseOf = (id: string) => [...EVAL_CASES, ...BEAN_SPROUT_EVAL_CASES].find((c) => c.id === id)
const DIAGNOSES = ['diag-gray-mold', 'diag-powdery', 'diag-anthracnose', 'diag-spider-mite', 'r1-root-rot', 'r1-thrips', 'r1-aphid', 'r1-slug', 'r1-bact-spot', 'r1-leaf-spot']

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
```

Keep every existing test in the file passing (52/12 r0 cases, 20/4 r1 cases, ≥6 grounded with ≥2 citing, grounding only on reply cases).
- [ ] **Step 2: Run** `npx vitest run tests/eval-dataset.test.ts` — Expected: FAIL.
- [ ] **Step 3: Apply** the §3 diagnosis table to `EVAL_CASES`.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** — `test(eval): grade diagnoses by the disease named, not the symptom repeated`.

#### Task 3.2: `r1-old-runners` label

- [ ] **Step 1: Write the failing test** in `tests/eval-dataset.test.ts`:

```ts
it('r1-old-runners also accepts the NGHEAN chunk with the mother-plant age rule', () => {
  expect(caseOf('r1-old-runners')?.expectChunks).toEqual([
    ['strawberry:propagation', 'https://ngheandost.gov.vn/nong-nghiep/quy-trinh-ky-thuat-trong-va-cham-soc-dau-tay-2490.html#2'],
  ])
})
```

The existing "every exact chunk label names a chunk the ingest pipeline produces" test checks the id exists.
- [ ] **Step 2: Run** `npx vitest run tests/eval-dataset.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** `expectChunks: [['strawberry:propagation', `${NGHEAN}#2`]]`.
- [ ] **Step 4: Run** `npm test` and `npm run typecheck` — Expected: PASS.
- [ ] **Step 5: Commit** — `test(eval): accept the NGHEAN mother-plant rule for r1-old-runners`.

## §5 Round-2 targets, measurement and stop criterion

**Measurement protocol (after all three WPs merge):**

1. `npm test` and `npm run typecheck` green.
2. Run the default config three times per plant, as in round 1: `EVAL_LABEL=r2-strawberry-1 npm run eval` (then `-2`, `-3`) and `DEFAULT_PLANT=bean-sprout EVAL_LABEL=r2-bean-sprout-1 npm run eval` (then `-2`, `-3`).
3. Report each metric as the median of the three runs on `summary` (the r0 set) and compare it with the **re-scored** round-1 rows of §3, not the round-1 headline. A case counts as fixed only if it passes in ≥2 of 3 runs; a move under 3 cases is noise.
4. Report `summaryR1` separately.

**Round-2 targets** (r0 set, §3 checks, median of 3 runs):

| Metric | Round 1, re-scored | Round-2 target | Basis |
|---|---|---|---|
| strawberry exact | 52/52 | 52/52 | §2.8 |
| strawberry safety | 52/52 | 52/52 (hard requirement) | — |
| strawberry gated recall@4 | 0.947 (18/19) | 0.947 | no retrieval change |
| strawberry grounding | 9/14 (64%) | ≥ 10/14 (71%) | §2.2, §2.8 |
| strawberry script-clean | 51/52 (50/51/52) | 52/52 in every run | §2.3, §2.8 |
| bean-sprout exact / grounding / recall | 12/12 / 6/6 / 1.00 | unchanged | §2.8 |
| bean-sprout script-clean | 10/12 (11/10/9) | 12/12 in every run | §2.3, §2.8 |
| r1 strawberry exact | 19/20 | 20/20 | §2.1, §2.8 |
| r1 strawberry grounding (/15) | 11/15 (11/12/11) | ≥ 12/15 | r1-bact-spot (§2.2); bed-height, container-night, pet-toxicity stay ✗ |
| r1 strawberry recall@4 | 0.875 (re-scored) | 0.875 | — |

**Stop criterion** (unchanged: strawberry exact ≥ 95%, grounding ≥ 90%, gated recall@4 ≥ 0.9, bean exact ≥ 90%, bean grounding ≥ 85% — or a round that improves no metric by more than 3 points). After round 2 every condition is expected to hold except strawberry grounding (~71%). Its remaining failures are kb-fertilizer and kb-planting (citations, an owner decision), kb-temp (six context and prompt placements tried, none without collateral damage, §2.5) and diag-anthracnose (traded for four other diseases, §2.2); with citations out of scope the reachable ceiling is 11/14 (79%), so the 90% bar cannot be met by engineering in this loop.

**Call: stop the loop after round 2.** Round 2 is worth running — it removes code-switching, two classes of wrong answer (copied diagnoses, the routing regression) and a repair path that can show JSON to users — but a round 3 inside the current constraints has no lever on any remaining grounding failure, so it would improve nothing by more than 3 points (the criterion's second clause). Re-open only when the owner decides on citations (§6 item 1) or on the range policy behind kb-temp (§6 item 2). Independently of the criterion, any drop of safety below 100% reverts that round's prompt change.

## §6 After merge, and what remains

**Integration (one person, after all WPs merge):**
- `CLAUDE.md`, "Small-model prompt constraints": extend the hour bullet — code-switching is not only an "h" problem (the 3B switches at quantities such as "1 phút" → "1 минут" and at Sino-Vietnamese words); `AGENT_DECISION_JSON_SCHEMA` constrains `message` with the allow-list `MESSAGE_PATTERN`, which LM Studio compiles into its sampling grammar (a deny-list was bypassed with `\u` escapes; `(?:` groups make LM Studio reject the schema); the orchestrator's regenerate net remains for providers that ignore `pattern`, and its answer is unwrapped because the regeneration shares the JSON-demanding system prompt. Add two bullets: the routing bullet's "Hỏi kiến thức trồng trọt … → reply" clause exists because the `get_device_config` example pulled "giữ nhiệt độ bao nhiêu?" questions onto the tool; and no few-shot example may answer a diagnosis, because the 3B reused Ví dụ 6's "thán thư (Colletotrichum spp.)" for gray mold, powdery mildew and bacterial leaf spot with the right `[bệnh]` entry ranked first.
- `CLAUDE.md`, "LLM provider abstraction": providers must support `response_format: json_schema` **including string `pattern`**. LM Studio is verified; check once with a Gemini key that its OpenAI-compatible layer accepts the keyword (if it rejects the schema, every chat fails), and drop `pattern` for that provider if it does not.

**What remains (for the owner, not for another prompt round):**
1. **Citations** (kb-fertilizer, kb-planting): the product decision from round-1 §6 (a deterministic "Nguồn tham khảo" built from the chunks shown, a structured `source` field, or dropping `requireCitation`).
2. **kb-temp**: the 3B answers a controlled-environment study's "15 - 26°C" over the profile's 10–27°C, and every placement that fixes it breaks region-specific or routing answers (§2.5). Options: decide that a document's narrower range inside the profile range is acceptable (an expectation change only the owner can make), or have the orchestrator state the profile range itself for general range questions (deterministic, needs its own design), or a larger model.
3. **Diagnosis quality**: without the copied example the 3B names the retrieved disease 22/24 but misses anthracnose; a diagnosis path that renders the top `[bệnh]` entry's name and treatment deterministically would remove the guesswork.
4. **Pet toxicity**: the 3B rewrites the chunk's closing "quả dâu tây an toàn để ăn cho người" as "Lá … an toàn" and invents compounds; no rule helps (§2.6). Options for the content reviewers (human-reviewed data, not ours to edit): lead the `toxicity` field with the "no data for pets" statement; or a deterministic notice when a pet question retrieves that chunk.
5. **Retrieval content**: TP#3 never names its topic (container regime → `doc-container-temp`, `r1-container-night`) and `care_notes#0` mixes four topics (bed height → `r1-bed-height`); section-aware chunking or contextual headers would help but change chunk ids and need re-labelling.
6. **Free-text paths**: the repair regeneration, the sensor-read summary and the step-exhausted answer are plain completions that `MESSAGE_PATTERN` does not reach; a one-field JSON schema with the same pattern would cover them.
7. **Not graded**: self-written sensor offers that a "có" cannot honour (5/93), and greetings answered with care advice and device thresholds (bs-hello 3/3).
