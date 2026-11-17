# RAG + Eval Round 4 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Five work packages in two phases: **WP-1, WP-2 and WP-5 run in parallel**; **WP-3 and WP-4 start once WP-1 and WP-2 are merged** and run in parallel with each other (both import WP-1's module and WP-2's engine options). Each WP may touch **only** the files listed in its own "Files" block; the file sets are disjoint.

**Goal:** Ship the three owner decisions and the two engineering items round 3 left open, measured so a reader can tell a better answer from added text, and end the loop. (1) **Citations** (kb-fertilizer, kb-planting): the server appends "Nguồn tham khảo: …" naming the retrieved chunks the reply drew on (§2.1). (2) **kb-temp**: a general range question gets the profile's range stated by the server when the reply leaves it out (§2.2). (3) **Pet toxicity**: the owner's sentence opens the strawberry `toxicity` entry; the probes show that removing the closing sentence, as the approval also asked, makes the 3B assert pet safety in 25 of 36 samples, so this plan keeps it and extends the eval check to catch that claim (§2.3, §3). (4) **Decision length cap** of 400 tokens on decision calls (§2.4). (5) **Type-token margin** Δ recorded per case in the eval report (§2.5). Items 5 and 6 were probed and are not adopted; item 9 cannot be measured by the eval this round (§2.6). After this round every stop threshold holds on the text users see; the model's own grounding does not move, and the eval now reports both (§2.7, §5).

**Architecture:** WP-1 adds `src/agent/replyNotes.ts`: pure functions that build two notes from data the server already holds — a range statement from the plant profile and a sources line from the retrieved chunks. WP-3 appends them in the orchestrator to every reply decided before a tool ran this turn, in both chat paths (in stream mode as one more `token` frame), and passes a token cap to decision calls. WP-2 adds `maxTokens` and `onLogprobs` to the `LlmEngine` options and `LLM_DECISION_MAX_TOKENS` to the config. WP-4 makes the eval grade the shipped text, keep the model's own text and grounding beside it, apply the cap, and record Δ. WP-5 edits one knowledge field. No byte of the system prompt, few-shot sets or decision schema changes.

**Tech Stack:** TypeScript ESM run by tsx, Vitest 2, LM Studio (qwen2.5-3b-instruct + text-embedding-bge-m3) for `npm run eval` only.

**Spec:** this document, §0–§3. Inputs: `data/eval/r3-strawberry-{1,2,3}-*.json`, `data/eval/r3-bean-sprout-1-*.json` (round 3 at the defaults), `data/eval/r1-*.json` and `r2-*.json`, the round-3 plan `docs/superpowers/plans/2026-11-17-rag-eval-round-3.md` (format, constraints, §6 list this round works through) and the round-2 plan's §2.5 (the six kb-temp prompt placements). The round-1 §0 noise rule still applies.

## Global Constraints

- All user-facing text stays Vietnamese: replies, the two notes, prompt text, orchestrator log lines. The eval's summary lines keep their current language.
- Control tools always go through confirmation; `src/mcp/policy.ts` and the orchestrator's control branch are not touched; the notes are never added to a tool decision; safety-class accuracy must stay 100% (a drop reverts the round).
- No prompt change: the system prompt, every few-shot set and `AGENT_DECISION_JSON_SCHEMA` are byte-identical to round 3. So the prose rule stays the last system-prompt paragraph, tool examples keep `type → message → tool → args`, strawberry keeps its knowledge reply right before the config example, and no example names a disease — all by construction. The decision JSON contract (`required: ['type']`, `MESSAGE_PATTERN` on `message`) is unchanged.
- The notes are appended after the model's text, never inserted into it or into the prompt; only to a reply decided before any tool ran this turn (plain reply, reply carrying a sensor-read offer, repaired reply); never to a tool lead-in, a control confirmation, a confirm/cancel reply, a sensor-read summary, the step-exhausted answer or the fallback.
- The chat path never requests log-probabilities; only the eval sets `onLogprobs`. The token cap applies to decision calls only; free-text calls keep no cap.
- No new dependencies, services or models. Unit tests need no external service: fakes/DI per CLAUDE.md "Testing conventions"; the engine tests use a local fake HTTP server, as `tests/llm-embed.test.ts` does.
- Chunking (`RAG_CHUNK_SIZE=600`, `RAG_CHUNK_OVERLAP=80`, `RAG_MIN_CHUNK_LEN=60`) and retrieval defaults (hybrid on, topK 4, MMR 0.7, margin 0.15, min score 0) are frozen.
- `data/docs/*.jsonl` is not edited. The only knowledge-JSON edit is the strawberry `toxicity` field (WP-5). Nothing edits `data/cache/` by hand; the edited chunk is re-embedded at init.
- `gradeGrounding` and `hasCitation` are unchanged. Eval expectations change only as §3 lists (one forbid list made stricter).
- Code comments say why, never cite a ticket, never restate the line below.
- Commit steps apply only if the executing workflow commits per task; never push.

## Review Focus

1. **The sources line passes the grader only by naming a known source.** "Nguồn tham khảo:" does not match `hasCitation`'s `NGUON_CITATION` (`nguồn\s*:` needs the colon right after "nguồn"); the line passes when it names a host or institution in `SOURCE_MARKERS` (`.gov.vn`, `vaas`, `khuyến nông`, …). A line naming only `sggp.org.vn` stays uncited, and a test pins that. Do not "simplify" the prefix to "Nguồn:", which would pass every line whatever it names. → WP-1 Task 1.1.
2. **Only the chunks the reply drew on are named**: those sharing ≥ 3 phrase bigrams that occur in ≤ 3 store chunks and not in the question. Citing every retrieved chunk would put sources under greetings and under answers taken from the system prompt's ranges (§2.1). → WP-1 Task 1.1.
3. **The range trigger fires on exactly kb-temp, kb-moisture and bs-kb-temp among the 88 eval messages**, on 11 held-out general questions, and on none of 17 held-out setting-, stage-, time-, place-, device- or limit-specific questions (`r1-container-night`, `doc-container-temp`, `doc-lowland-climate`, sensor and configuration cases included). → WP-1 Task 1.1 tests.
4. **Notes only on a reply decided before any tool ran**, in both paths; in stream mode they arrive as one `token` frame after the streamed message with no `reset`, and the buffered and streamed replies are identical. Offers get the notes before the "(Có/Không)" question. → WP-3 Task 3.1.
5. **The cap reaches decision calls only**, both attempts, both paths; a decision cut off mid-string falls back cleanly and never creates a pending action. → WP-3 Task 3.2.
6. **The eval grades the text users see and reports the model's own text beside it** (`grounding` vs `groundingModel`, `reply` vs `modelReply`). This round's grounding gain is in the notes, not in the model (§2.7); a reviewer reading only `grounding` would over-read it. → WP-4 Task 4.2.
7. **WP-5 keeps the closing sentence the owner asked to remove** (§2.3: removed → the 3B asserts pet safety in 25 of 36 samples; kept → 8 of 30). This is a stated deviation; dropping the sentence is a one-line change with that measured cost. → WP-5 Task 5.1.

---

## §0 How the evidence was produced

- **Round-3 reports.** Every case's verdicts across the three round-3 strawberry runs and the bean run were tabulated against round 2. Every stored reply of rounds 1–3 (494 reply decisions; 928 replies across rounds 0–3) was re-processed offline with WP-1's module as shipped in this plan and re-graded with the current `gradeGrounding`, so "with notes" and "model text alone" are compared on the same replies.
- **Exact assembly.** Probes rebuild the strawberry (69 chunks) and bean-sprout (30) stores with the repo's own `ingestAll`, with the embed cache pointed at scratch copies (one per profile variant), and call `retrieve()` at the round-3 defaults. Messages are built with `buildSystemPrompt` + `getFewshot` + `assembleMessages` and decided with `AGENT_DECISION_JSON_SCHEMA` at temperature 0.1 — the eval's path. Arms are string transforms of the knowledge block or a profile variant; nothing in the repo was edited.
- **Code validated before writing it down.** Every file in §4 was applied to a scratch export of `HEAD` (5e4e2c9) and run: `vitest run` 395/395 (325 existing + 70 new), `tsc --noEmit` clean, and WP-4's eval end to end on the bean set (16 live calls). The code blocks below are those files.
- **Calls.** 340 LLM chat calls: 81 kb-temp context arms (9 questions × 3 arms × 3 samples), 126 toxicity samples (5 wordings, 6 questions, 3–6 samples each), 18 for the session-history copy check, 88 for the simulated round 4 (§2.7), 16 for the end-to-end eval check, 11 for token counting, the cap's output shape and the SDK log-probability path. Embedding-only probes: retrieval under every toxicity variant (3 × 72 queries) and with title headers on doc chunks (2 plants × 2 arms). Every decision below rests on ≥ 3 samples per case per arm, or on all stored replies.
- **Noise rule (round-1 §0, unchanged).** A single-run difference of ≤ 2 cases is noise; a case counts as fixed only if it passes in ≥ 2 of 3 runs.

## §1 Round-3 results and per-failure diagnosis

**Measured (round-3 reports, current code).**

| Metric | Round 2 (median) | Round 3 runs 1 / 2 / 3 | Median |
|---|---|---|---|
| strawberry exact (r0, /52) | 52 | 52 / 52 / 52 | 52 |
| strawberry safety | 52 | 52 ×3 | 52 |
| strawberry gated recall@4 | 0.947 | 0.947 ×3 | 0.947 |
| strawberry grounding (/14) | 10 | 10 / 11 / 11 | 11 (79%) |
| strawberry script-clean | 52 | 52 ×3 | 52 |
| r1 strawberry exact (/20) | 19 | 20 / 20 / 20 | **20** |
| r1 strawberry grounding (/15) | 12 | 11 / 13 / 12 | 12 |
| r1 strawberry recall@4 | 0.875 | 0.875 ×3 | 0.875 |
| bean exact / grounding / recall / script-clean | 12/12, 6/6, 1.00, 12/12 | same (run 1) | same |
| bean r1 exact / grounding | 4/4, 1/1 | same | same |

Round 3's targets were met: `r1-container-night` became a reply in all three runs, and nothing regressed. The remaining grounding failures:

| Case (metric) | Set | Runs 1/2/3 | Class | Evidence and root cause | Action |
|---|---|---|---|---|---|
| kb-temp | r0 | ✗ ×3 | owner decision (range policy) | Every reply "Cây dâu tây thích hợp ở nhiệt độ từ 15 - 26°C" from TP#0's controlled-environment study; the profile's 10–27°C is in the system prompt only. Same in all nine runs of rounds 1–3. | WP-1/WP-3 range statement |
| kb-fertilizer, kb-planting | r0 | ✗ ×3 each | owner decision (citation) | The answer chunks are retrieved every run (NA#5/#6, `strawberry:planting#0`); replies name no source ("theo các tài liệu kỹ thuật trồng trọt"). | WP-1/WP-3 sources line |
| doc-hanging-watering | r0 | ✗ / ✓ / ✓ | opening-words near-tie | Round-3 §2.2, unchanged. | none |
| r1-bed-height | r1 | ✗ ×3 | retrieval (diluted chunk) | `care_notes#0` not retrieved; replies read NNMT#0's altitude "790 đến 900m" as bed height. | none — §6 |
| r1-container-night (grounding) | r1 | ✗ ×3 (routing ✓ ×3) | retrieval | TP#3 ("17°C ban đêm") not retrieved; replies give 15–18 / 18–20°C. | none — §2.6, §6 |
| r1-pet-toxicity | r1 | ✗ / ✓ / ✗ | owner decision (content) + model | Run 2 passed on "thú y" while claiming "lá chứa các chất độc hại khác nhau". | WP-5, §3 |
| r1-harvest-first | r1 | ✗ / ✓ / ✓ | near-tie | "2,5 tháng" (flowering) vs "3 tháng"; round-3 §2.4 predicted it. | none |
| not graded: chit-chat answered with care advice | r0 | chat-hello 3/3; bs-hello 1/1 | RAG context on chit-chat | Unchanged since round 2. | none — §2.6 |

## §2 Probes and decisions

### §2.1 Citations: a sources line built from the chunks the reply drew on

**What the grader accepts.** `hasCitation` passes when the text contains a `SOURCE_MARKERS` entry (`khuyến nông`, `vaas`, `vista`, `nasati`, `bvtv`, `chi cục`, `tạp chí`, `smart farm`, `mard`, `techport`, `.gov.vn`, `.edu.vn`) or matches `(?:theo|tại)\s+nguồn|nguồn\s*(?::|\[|\(|https?:)`. "Nguồn tham khảo: x" does not match the regex, so a line passes only by naming a marked source. 37 of 494 model replies in rounds 1–3 named one on their own.

**Which chunks to name.** Overlap between each stored reply and each chunk it was given, counted in phrase bigrams (adjacent syllables within punctuation-delimited phrases, so "nhiệt độ, độ ẩm" yields no "độ độ"), excluding bigrams the question contains:

| Gate | Knowledge replies with a line | Chit-chat replies with a line |
|---|---|---|
| every chunk given to the model | 451/451 | 43/43 |
| any bigram shared | 451/451 | 43/43 ("dâu tây", "chăm sóc", "nhiệt độ" are in most chunks) |
| ≥ 2 bigrams in ≤ 3 chunks | 402/451 | 20/43 (chat-weather's "cảm biến", "độ độ" before phrase splitting) |
| **≥ 3 bigrams in ≤ 3 chunks (shipped)** | **375/451** | **13/43** |

The 13 chit-chat lines are all greetings answered with care advice that did come from a chunk (chat-hello "luân canh với cây khác họ" from `care_notes#1`, bs-hello "27–30°C … 30 phút" from the watering entry); naming that chunk is accurate, and the advice itself is §6 item 6. The 76 uncited knowledge replies are mostly answers from elsewhere: kb-moisture and kb-ph state the system prompt's ranges (0–1 shared bigrams), symptom-yellow-leaves copies few-shot Ví dụ 1. Citing those would credit a document for text it did not supply. The cost is terse replies such as r1-flower-time ("khoảng 2,5 tháng") that draw on a chunk but share too few rare bigrams.

**How each chunk kind is named.** A document chunk or a disease entry with a source: its host without `www.` (`ngheandost.gov.vn`). Titles were rejected: up to 134 characters, 4 of 9 strawberry titles are all-caps PDF headings, and one bean title is "BÀI TRUYỀN THÔNG 1:". Full URLs reach 164 characters. A profile chunk: the institutions it cites inline, "(Khuyến nông Lâm Đồng; VAAS)"; other parentheses ("(Đà Lạt)", "(thân bò/stolon)", Latin names) are skipped by requiring an institution word at the start. A disease entry with no source and `care_notes#0` (no inline citation) contribute no name. Names are deduplicated case-insensitively, a name contained in another ("VAAS" in "Tạp chí VAAS") is dropped, a name the reply already contains is skipped, and at most three are shown, most-shared chunk first.

**Which turns.** Replies decided at step 0, the turn's first decision, before any tool ran. A reply after a tool result interprets device data, not the retrieved chunks. Offers get the notes before the "(Có/Không)" question, so the question stays last. Repaired replies get them too, because the repair answers the same question from the same context.

**Session history.** The noted reply is what the user saw, so it is what the session remembers. With a "Nguồn tham khảo: …" line in the previous assistant turn, 0 of 9 follow-up replies wrote one themselves (0 of 9 without it), so the history needs no special handling.

**Effect on stored replies** (round-1–3 replies, notes applied, current checks):

| Run | r0 grounding, model text → with notes | r1 |
|---|---|---|
| round 1 runs 1/2/3 | 9→12, 9→12, 9→11 | unchanged |
| round 2 runs 1/2/3 | 10→13, 10→13, 11→13 | unchanged |
| round 3 runs 1/2/3 | 10→13, 11→14, 11→14 | unchanged |

kb-fertilizer and kb-planting pass in 9 of 9 runs with notes (0/9 and 2/9 before), always through `ngheandost.gov.vn` or "Khuyến nông Lâm Đồng"/"Cổng KHCN VISTA". kb-temp's 9/9 comes from §2.2.

**What this is and is not.** The line gives users a real trace of where the reply's wording came from, which is what `requireCitation` was written to check. It does not make any answer better. kb-planting's round-3 run-2 reply gives a planting density and no spacing, and passes on the line. The line is chunk-level, not claim-level. In round 3, r1-container-night's invented "15-18°C" sits next to a line naming `light_description#0`'s institutions, because the reply paraphrased that chunk's container wording. In one simulated reply (§2.7) r1-thrips named the wrong pest in words taken from the thrips entry, and the line names that entry's site. §6 item 7 lists a claim-level check.

### §2.2 kb-temp: the server states the profile range for general range questions

**Context placements fail as before.** Round 2 tried six system-prompt and context placements (round-2 §2.5). This round tried the range as a knowledge entry added only when the question is general (the trigger below), first or last in the block, 3 samples per question:

| Question | base | entry first | entry last |
|---|---|---|---|
| kb-temp "Cây dâu tây thích hợp nhiệt độ khoảng bao nhiêu?" | 0/3 | 0/3 | 3/3 |
| "Nhiệt độ thích hợp cho dâu tây là bao nhiêu?" | 0/3 | 3/3 | 0/3 |
| "Nhiệt độ lý tưởng để trồng dâu tây khoảng bao nhiêu?" | 3/3 | 3/3 | 3/3 |
| "Cường độ ánh sáng thích hợp cho dâu là bao nhiêu?" | 0/3 (says "100–110 µmol/m2/s") | 3/3 | 3/3 |
| kb-moisture; "Dâu tây cần độ ẩm đất khoảng bao nhiêu?"; "Độ ẩm không khí phù hợp cho dâu là bao nhiêu?"; bs-kb-temp; "Độ ẩm không khí cho giá đỗ nên là bao nhiêu?" | 3/3 each | 3/3 each | 3/3 each |

Each placement fixes some questions and misses others; no placement fixes all. So the step is deterministic: after the reply, append the profile's range for each quantity the general question asked about whose two bounds the reply does not both state:

> Khoảng tối ưu chung hệ thống áp dụng cho cây dâu tây: nhiệt độ 10-27°C.

The sentence names the system as its origin ("hệ thống áp dụng" — the same ranges drive the control thresholds), so the sources line after it is not read as the source of 10–27°C. It is placed after the reply rather than before, so in stream mode it can follow the streamed message and is added only when the reply lacks the range.

**The trigger** (`generalRangeFields`): the question names a quantity (nhiệt độ; độ ẩm không khí; độ ẩm đất; ánh sáng/lux — the four the owner named; pH, EC and light hours are left out) and asks for a value ("bao nhiêu", "khoảng nào", "mức nào", "mấy"). It must name no device or live reading (esp32, cảm biến, hiện tại, đang, ngưỡng, …), no growing setting (container, nhà kính, thủy canh, chậu, kiểm soát, đèn/LED, …), no time (đêm, ban ngày, mùa, tháng, …), no stage (giai đoạn, ra hoa, cây con, ươm, ngâm, …), no region (vùng, a capitalised place name), and no limit or effect (chịu, cao nhất, tối đa, quá, ảnh hưởng, dung dịch, nước tưới). "độ ẩm" alone is ambiguous and does not fire. Measured:

- **Every eval message** (72 strawberry + 16 bean): fires on exactly kb-temp, kb-moisture and bs-kb-temp, all three general questions. It does not fire on r1-container-night, doc-container-temp, doc-lowland-climate ("khí hậu ngày đêm … Sơn La"), sensor-temp, the configuration reads or any threshold change.
- **Held-out:** 11 general questions fire on the right field (temperature ×6 incl. bean, humidity ×2, soil moisture, light ×2). 17 specific ones do not fire: "Ban đêm nên giữ nhiệt độ…", "Nhà kính trồng dâu nên để nhiệt độ…", "Dâu tây chịu được nhiệt độ cao nhất…", "Giai đoạn ra hoa…", "Trồng dâu ở Mộc Châu…", "Nhiệt độ nước tưới…", "Nhiệt độ esp32-01 đang đo…", "Nhiệt độ bây giờ…", "Mùa đông…", "…chậu ngoài ban công…", "Nhiệt độ quá cao…", "Cây con…", "Ánh sáng đèn LED…", "Bảo quản…", "Nhiệt độ ảnh hưởng…", "Dâu tây có cần nhiều ánh sáng không?", "Độ ẩm bao nhiêu thì dâu tốt?". "Dâu tây ưa nhiệt độ thế nào?" does not fire, because it has no value word (accepted false negative). A user who capitalises "Dâu Tây" mid-sentence also gets no statement, which errs toward silence.
- **Stored replies:** the statement is added to kb-temp in 9/9 runs and to kb-moisture (0/9) and bs-kb-temp (0/7) never, because those replies already give 75-80% and 27-30°C.

**What this is and is not.** The product rule "if sources conflict with the numeric ranges, the ranges win" now holds in the shipped text. The model still answers "15 - 26°C" in 9 of 9 stored kb-temp replies and 3 of 3 probes, so the reply carries both ranges: the study's narrower one, then the profile's. 15–26 lies inside 10–27, so they do not contradict each other. This is a policy outcome, not a better model answer.

### §2.3 Pet toxicity: the owner's sentence works, its removal of the closing sentence does not

Retrieval: `strawberry:toxicity#0` is rank 0 for r1-pet-toxicity, kb-toxicity and four held-out questions (dog/cat leaves, rabbit, dog fruit, chicken) under every wording. Gated recall is 32/35 in every arm. Other moves: `device-info` (a tool case), `chat-hello` and `chat-thanks` each swap one chunk, and kb-planting reorders its four. All still route correctly in the simulated round (§2.7).

Six questions, samples classified by regex over the reply: *check* = the current r1 check; *safety claim* = "không (chứa )?(chất )?độc", "không gây độc", "thường không độc", "an toàn cho vật nuôi/chó/mèo/thỏ/gà", "thường an toàn"; *any verdict* = a safety claim or a toxicity claim ("gây độc cho", "có thể gây khó chịu/tiêu chảy/nguy hiểm", "độc tố", "saponin", …); *clean* = says there is no information and gives no verdict.

| Wording of the `toxicity` entry | n | check | safety claim | any verdict | vet referral | clean |
|---|---|---|---|---|---|---|
| current | 24 | 10 | 0 | 11 | 6 | 6 |
| **owner's: opening sentence added, closing sentence removed** | 24 | 24 | **19** | 23 | 24 | 1 |
| opening "Chưa có tài liệu nào xác nhận … độc hoặc an toàn … nên không thể khẳng định", closing removed | 18 | 18 | 11 | 11 | 18 | 6 |
| **owner's opening added, closing sentence kept (WP-5)** | 18 | 16 | **4** | 7 | 17 | 8 |
| the "không thể khẳng định" opening, closing kept | 18 | 17 | 16 | 17 | 17 | 0 |
| resample, r1-pet-toxicity + kb-toxicity ×6: owner's / WP-5 | 12 / 12 | 11 / 10 | 6 / 4 | 12 / 7 | 11 / 11 | 0 / 0 |

With the owner's text the 3B turns "Chưa có thông tin về độc tính … với vật nuôi" into "Lá dâu tây không chứa chất độc gây nguy hiểm cho mèo" (r1-pet-toxicity 10 of 10 samples). The current check passes it 9 of 10 times, on "thú y". The closing sentence ("… chưa cung cấp thông tin riêng về độc tính của cây đối với vật nuôi, nên phần này chỉ khẳng định quả dâu tây an toàn để ăn cho người …") is what keeps most replies from extending food safety to pets. Removing it as a duplicate is the change that backfires, so WP-5 keeps it. This is a deviation from the approved edit, stated here and in Review Focus 7; the owner can drop the sentence at the measured cost.

No wording stops the 3B from giving a verdict: the best measured rate is 7 of 18. Every edited wording makes the vet referral near-certain (17–24 of 18–24, against 6 of 24 today), and every one introduces some pet-safety claims where today there are none (4 of 18 for WP-5). §3 extends r1-pet-toxicity's forbid list so the eval stops passing a safety claim; under it WP-5 passes r1-pet-toxicity in 5 of 9 samples (the owner's text 0 of 10). The stored round-1–3 verdicts are unchanged by the extension. Content alone cannot make this case reliable; §6 item 2 lists the deterministic option.

### §2.4 Decision length cap: 400 tokens

The longest of 928 stored decisions (rounds 0–3) is a 722-character reply: 237 tokens counted through LM Studio's `usage.prompt_tokens`. The next are 236, 211 and 208. A tool decision with a full lead-in and args is about 98. In the simulated round (§2.7) the longest completion was 163 tokens. The one runaway seen (round-3 §2.3) ran 1,742 characters to its 450-token cap. A capped constrained call returns the open prefix with `finish_reason: "length"` (checked live: `{\n  "type": "tool",\n` at 12 tokens), so `parseDecision` fails and the existing retry-then-fallback path takes over; in stream mode the emitted prefix is undone with `reset`. 400 is 1.7× the longest legitimate decision. It bounds a runaway to ≤ 400 streamed tokens per attempt instead of the context length. `LLM_DECISION_MAX_TOKENS=0` turns it off.

### §2.5 Type-token margin in the eval report

The OpenAI SDK path works under `response_format: json_schema` with `logprobs: true, top_logprobs: 5`: the type token is the one after the text `{"type":"`, and its alternatives include both choices (kb-temp: "reply" 0, "tool" −12.11; "Tắt đèn …": "tool" 0, "reply" −8.38). Without a system prompt the grammar emitted spaced JSON (`{\n  "type": "`), so the scan matches `"type"\s*:\s*"`. A choice missing from the top 5 gets the lowest listed log-probability, which makes Δ a lower bound on its size. Requesting log-probabilities did not change routing: 88 of 88 cases routed as expected in the simulated round. The smallest |Δ| was diag-spider-mite +1.95, r1-container-night +2.58 and r1-spider-mite +3.51, and none fell under 1. Round 3's near-ties are at message tokens (doc-hanging-watering's opening words, r1-harvest-first's number); the type-token margin does not see those.

### §2.6 Items 5, 6 and 9: measured, not adopted

- **Item 5, contextual headers.** Prefixing every doc chunk with "[title] " (re-embedded, hybrid retrieval at the defaults) moves r1-container-night's TP#3 into the top 4 (recall 0→1) but loses kb-pests, r1-thrips and r1-old-runners. Strawberry mean gated recall over 35 labelled cases drops from 0.914 to 0.857; bean drops from 1.00 to 0.90 (bs-kb-temp). Rejected. r1-bed-height needs `care_notes#0` split by topic, not a header.
- **Item 6, chit-chat answered with care advice.** BM25 separates "Xin chào!" and "Ok" (0 term hits) from terse plant questions, but "Cảm ơn bạn nhiều nhé" (4.93) and "Hôm nay trời đẹp nhỉ" (6.03) score above "Sâu" (1.84) and "Ngâm" (1.36). The unaccented "cay dau bi vang la phai lam sao" also has 0 hits, so a no-term-match gate would strip the context from unaccented questions, a common way to type Vietnamese. Rejected. With this round's gate, such greetings get a sources line only when the reply really used a chunk (§2.1).
- **Item 9, free-text paths.** The repair regeneration (round-2 §1 found no truncated reply in 272 reply decisions), the sensor-read summary and the step-exhausted answer are outside the eval, so a change there cannot be measured this round. `maxTokens` now exists for those calls too (§6 item 5).

### §2.7 Simulated round 4

The simulation was run: one pass of each eval set, eval order, with WP-5's profile, the notes, the 400-token cap and log-probabilities on, graded with §3's check.

| Set | exact | safety | grounding with notes | model text alone | recall | foreign script | max tokens | \|Δ\| < 1 |
|---|---|---|---|---|---|---|---|---|
| strawberry r0 | 52/52 | 52/52 | **14/14** | 11/14 | 0.947 | 0 | 163 | none |
| strawberry r1 | 20/20 | 20/20 | 10/15 | 10/15 | 0.875 | 0 | — | none |
| bean r0 | 12/12 | 12/12 | 6/6 | 6/6 | 1.000 | 0 | 125 | none |
| bean r1 | 4/4 | 4/4 | 1/1 | 1/1 | 1.000 | 0 | — | none |

r1 failures: r1-bed-height, r1-container-night and r1-harvest-first ("2,5 tháng", the known near-tie), r1-pet-toxicity ("Lá dâu tây không chứa chất độc gây nguy hiểm cho mèo", one of the 4/9 that §3's check now fails), and r1-thrips ("bọ sên (_Helix aspersa_)"; it passed 3/3 in round 3, and its retrieval is identical under every arm, so one sample at temperature 0.1 is noise by §0). The end-to-end bean run of WP-4's code gave the same numbers (12/12, 6/6, model-only 6/6, no near-ties) and Δ values within 0.2 of the simulation's.

## §3 Eval corrections

- **r1-pet-toxicity forbid list** gains `'không chứa chất độc'`, `'không chứa độc'`, `'không độc'`, `'không gây độc'`, `'an toàn cho vật nuôi'`, with the note "the toxicity entry holds no pet data, so a pet-safety verdict is unsupported". Chunk evidence: `strawberry:toxicity#0`, current and edited, states there is no information on pets, so a safety verdict is as unsupported as the "an toàn cho mèo" the list already forbids. The 3B's paraphrase "không chứa chất độc gây nguy hiểm cho mèo" got past that list in 9 of 10 samples (§2.3). The stricter list changes no stored verdict of rounds 1–3. `contains()` strips spaces before matching, so "không được biết là độc" ("not known to be toxic") is not caught by 'không độc'; a test pins that boundary. Toxicity claims ("lá chứa các chất độc hại") are left unforbidden, because a hedge such as "chưa rõ có độc tố không" would match any such entry.
- **Report fields (not a label change).** `reply` is now the text users see (model message + notes); `modelReply` holds the model's message; `groundingModel` grades it; `summary.groundingModel` aggregates it; `typeMargin` and a top-level `nearTies` list are new. Cross-round comparisons of model text should read `modelReply` from round 4 on.

---

## §4 Work packages

Ordered by user impact. WP-1 and WP-3 together put sources and the profile's ranges into the replies users read. WP-5 makes the vet referral near-certain on pet questions. WP-2 and WP-3's cap bound a runaway decision. WP-4 makes the eval report what users see and what the model wrote, side by side. Phase A: WP-1, WP-2, WP-5. Phase B, after WP-1 and WP-2 merge: WP-3, WP-4.

### WP-1 — Reply notes module

**Files (only these):** `src/agent/replyNotes.ts` (new), `tests/replyNotes.test.ts` (new).

**Root cause addressed:** the 3B does not state the profile's range over a document's (§2.2) and names a source in 37 of 494 replies (§2.1). Both notes can be built from data the server already holds.

**Expected eval effect:** none alone (nothing calls it until WP-3/WP-4).

#### Task 1.1: range statement and sources line

**Interfaces:**
- Produces `src/agent/replyNotes.ts` exporting `RangeField`, `generalRangeFields(question)`, `rangeStatement(question, reply, profile)`, `phraseBigrams(text)`, `bigramDocFreq(texts)`, `NotedChunk`, `sourceNames(chunk)`, `sourcesLine(reply, question, chunks, docFreq)`, `ReplyNotesInput`, `withReplyNotes(reply, input)`. WP-3 and WP-4 call only `bigramDocFreq` and `withReplyNotes`.

- [ ] **Step 1: Write the failing tests** — `tests/replyNotes.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import {
  bigramDocFreq,
  generalRangeFields,
  rangeStatement,
  sourceNames,
  sourcesLine,
  withReplyNotes,
} from '../src/agent/replyNotes'
import { loadProfile } from '../src/domain/profiles'
import { BEAN_SPROUT_EVAL_CASES, EVAL_CASES } from '../src/eval/dataset'
import { hasCitation } from '../src/eval/grounding'

const strawberry = loadProfile('strawberry')
const bean = loadProfile('bean-sprout')
const STRAWBERRY_TEMP = 'Khoảng tối ưu chung hệ thống áp dụng cho cây dâu tây: nhiệt độ 10-27°C.'

describe('generalRangeFields', () => {
  it('fires on exactly the three general range questions of the eval sets', () => {
    const fired = [...EVAL_CASES, ...BEAN_SPROUT_EVAL_CASES]
      .filter((c) => generalRangeFields(c.message).length > 0)
      .map((c) => c.id)
    // r1-container-night, doc-container-temp and doc-lowland-climate ask about a setting, a time or a region
    // and want a document's figure; the sensor and configuration cases ask about the device.
    expect(fired).toEqual(['kb-temp', 'kb-moisture', 'bs-kb-temp'])
  })

  it.each([
    ['Nhiệt độ thích hợp cho dâu tây là bao nhiêu?', 'temperature_range'],
    ['Dâu tây sống tốt ở nhiệt độ khoảng nào?', 'temperature_range'],
    ['Trồng dâu cần nhiệt độ bao nhiêu độ?', 'temperature_range'],
    ['Nhiệt độ tối ưu cho cây dâu là mấy độ?', 'temperature_range'],
    ['Nhiệt độ lý tưởng để trồng dâu tây khoảng bao nhiêu?', 'temperature_range'],
    ['Độ ẩm không khí phù hợp cho dâu là bao nhiêu?', 'humidity_range'],
    ['Dâu tây cần độ ẩm đất khoảng bao nhiêu?', 'soil_moisture_range'],
    ['Cây dâu cần ánh sáng bao nhiêu lux?', 'light_range'],
    ['Cường độ ánh sáng thích hợp cho dâu là bao nhiêu?', 'light_range'],
    ['Giá đỗ cần nhiệt độ bao nhiêu?', 'temperature_range'],
    ['Độ ẩm không khí cho giá đỗ nên là bao nhiêu?', 'humidity_range'],
  ])('reads %s as a general question about %s', (question, field) => {
    expect(generalRangeFields(question)).toEqual([field])
  })

  it.each([
    'Ban đêm nên giữ nhiệt độ cho dâu tây bao nhiêu?',
    'Nhà kính trồng dâu nên để nhiệt độ bao nhiêu?',
    'Dâu tây chịu được nhiệt độ cao nhất bao nhiêu?',
    'Giai đoạn ra hoa dâu cần nhiệt độ bao nhiêu?',
    'Trồng dâu ở Mộc Châu thì nhiệt độ thế nào, bao nhiêu độ?',
    'Nhiệt độ nước tưới cho dâu bao nhiêu là được?',
    'Nhiệt độ esp32-01 đang đo được bao nhiêu?',
    'Nhiệt độ bây giờ là bao nhiêu?',
    'Mùa đông nhiệt độ bao nhiêu thì dâu bị hại?',
    'Dâu trồng chậu ngoài ban công thì nên giữ độ ẩm đất bao nhiêu?',
    'Nhiệt độ quá cao là bao nhiêu thì dâu bị gì?',
    'Cây con dâu tây cần nhiệt độ bao nhiêu?',
    'Ánh sáng đèn LED cho dâu cần bao nhiêu?',
    'Bảo quản dâu tây ở nhiệt độ bao nhiêu?',
    'Nhiệt độ ảnh hưởng đến dâu tây bao nhiêu?',
    'Dâu tây có cần nhiều ánh sáng không?',
    'Độ ẩm bao nhiêu thì dâu tốt?',
  ])('leaves %s alone', (question) => {
    expect(generalRangeFields(question)).toEqual([])
  })
})

describe('rangeStatement', () => {
  it("states the profile's range when the reply gives another one", () => {
    expect(rangeStatement('Cây dâu tây thích hợp nhiệt độ khoảng bao nhiêu?', 'Dâu tây thích hợp ở 15 - 26°C.', strawberry)).toBe(
      STRAWBERRY_TEMP,
    )
  })

  it('says nothing when the reply already gives both bounds, in any spelling', () => {
    const asked = 'Nhiệt độ thích hợp cho dâu tây là bao nhiêu?'
    expect(rangeStatement('Độ ẩm đất tối ưu cho dâu là bao nhiêu phần trăm?', 'Khoảng 75-80%.', strawberry)).toBeNull()
    expect(rangeStatement(asked, 'Khoảng 10°C đến 27°C.', strawberry)).toBeNull()
  })

  it('counts a bound only as a number of its own, and needs both', () => {
    const asked = 'Nhiệt độ thích hợp cho dâu tây là bao nhiêu?'
    expect(rangeStatement(asked, 'Khoảng 100 đến 270 độ.', strawberry)).toBe(STRAWBERRY_TEMP)
    expect(rangeStatement(asked, 'Khoảng 10°C.', strawberry)).toBe(STRAWBERRY_TEMP)
  })

  it('says nothing for a setting-specific question or a range the profile does not have', () => {
    expect(rangeStatement('Ban đêm nên giữ nhiệt độ cho dâu tây bao nhiêu?', 'Khoảng 17°C.', strawberry)).toBeNull()
    expect(rangeStatement('Giá đỗ cần ánh sáng bao nhiêu lux?', 'Giá đỗ cần ủ trong tối.', bean)).toBeNull()
  })

  it("uses each plant's own profile", () => {
    expect(rangeStatement('Ủ giá đỗ cần nhiệt độ bao nhiêu?', 'Nên giữ 25°C.', bean)).toBe(
      'Khoảng tối ưu chung hệ thống áp dụng cho cây giá đỗ: nhiệt độ 27-30°C.',
    )
  })
})

describe('sourceNames', () => {
  it('names a document or disease entry by its host', () => {
    expect(sourceNames({ text: 'x', source: 'https://www.sggp.org.vn/a-b.html' })).toEqual(['sggp.org.vn'])
  })

  it('names a profile chunk by the institutions it cites, not by other parentheses', () => {
    const text =
      '[ánh sáng] Dâu cần nắng (Khuyến nông Lâm Đồng). LED trong container của Trung tâm Nghiên cứu Khoai tây (Đà Lạt). ' +
      'Ngó (thân bò/stolon) (Cổng KHCN VISTA; VAAS).'
    expect(sourceNames({ text, field: 'light_description' })).toEqual(['Khuyến nông Lâm Đồng', 'Cổng KHCN VISTA', 'VAAS'])
  })

  it('gives a disease entry without a source no name', () => {
    expect(sourceNames({ id: 'disease:aphid', text: '[bệnh] Rệp (Aphididae) — loại: sâu hại.' })).toEqual([])
  })
})

describe('sourcesLine', () => {
  const boric = {
    id: 'https://ngheandost.gov.vn/quy-trinh#6',
    text: 'Bổ sung acid Boric vào dung dịch dinh dưỡng từ 0,7 - 0,9 ppm khi cây bắt đầu ra hoa, nhắc lại sau một tuần.',
    source: 'https://ngheandost.gov.vn/quy-trinh',
  }
  const hanging = {
    id: 'https://www.sggp.org.vn/treo#0',
    text: 'Nông dân Đà Lạt trồng dâu tây treo, tưới 5-7 lần mỗi ngày.',
    source: 'https://www.sggp.org.vn/treo',
  }
  const df = bigramDocFreq([boric.text, hanging.text])
  const asked = 'Nên bón phân gì cho dâu khi cây ra hoa?'

  it('names the chunk the reply drew on, and the grader accepts it because it names a known source', () => {
    const line = sourcesLine('Khi dâu ra hoa, bổ sung acid Boric vào dung dịch dinh dưỡng từ 0,7 - 0,9 ppm.', asked, [hanging, boric], df)
    expect(line).toBe('Nguồn tham khảo: ngheandost.gov.vn.')
    expect(hasCitation(line ?? '')).toBe(true)
  })

  it('does not pass the grader on the prefix alone', () => {
    // sggp.org.vn is a real source outside the grader's marker list: the line names it and stays uncited.
    const line = sourcesLine('Trồng dâu tây treo thì tưới 5-7 lần mỗi ngày.', 'Dâu treo tưới mấy lần?', [hanging], df)
    expect(line).toBe('Nguồn tham khảo: sggp.org.vn.')
    expect(hasCitation(line ?? '')).toBe(false)
  })

  it('gives a greeting no sources, and does not count pairs the question already holds', () => {
    expect(sourcesLine('Chào bạn! Mình có thể giúp gì cho bạn?', 'Xin chào!', [hanging, boric], df)).toBeNull()
    expect(sourcesLine('Bổ sung acid Boric nhé.', 'Có nên bổ sung acid Boric không?', [boric], df)).toBeNull()
  })

  it('does not repeat a source the reply already names', () => {
    const reply = 'Theo ngheandost.gov.vn, bổ sung acid Boric vào dung dịch dinh dưỡng từ 0,7 - 0,9 ppm.'
    expect(sourcesLine(reply, asked, [boric], df)).toBeNull()
  })

  it('lists at most three names and drops a name contained in another', () => {
    const pests = {
      id: 'strawberry:pests#0',
      field: 'pests',
      text: '[sâu hại] Nhện đỏ, bọ trĩ, rệp hại dâu (Chi cục BVTV Lâm Đồng; Tạp chí VAAS; VAAS; Khuyến nông Lâm Đồng; Cổng KHCN VISTA).',
    }
    expect(sourcesLine('Dâu thường bị nhện đỏ, bọ trĩ, rệp hại dâu.', 'Dâu hay bị gì?', [pests], bigramDocFreq([pests.text]))).toBe(
      'Nguồn tham khảo: Chi cục BVTV Lâm Đồng; Tạp chí VAAS; Khuyến nông Lâm Đồng.',
    )
  })
})

describe('withReplyNotes', () => {
  it('puts the range statement, then the sources line, after the reply', () => {
    const study = {
      id: 'https://techport.vn/x#0',
      text: 'ngưỡng nhiệt độ thích hợp cho cây dâu tây là từ 15 - 26°C theo nghiên cứu',
      source: 'https://techport.vn/x',
    }
    const out = withReplyNotes('Dâu tây thích hợp ở 15 - 26°C theo nghiên cứu.', {
      question: 'Cây dâu tây thích hợp nhiệt độ khoảng bao nhiêu?',
      chunks: [study],
      docFreq: bigramDocFreq([study.text]),
      profile: strawberry,
    })
    expect(out).toBe(`Dâu tây thích hợp ở 15 - 26°C theo nghiên cứu.\n\n${STRAWBERRY_TEMP}\n\nNguồn tham khảo: techport.vn.`)
  })

  it('returns the reply unchanged when no note applies', () => {
    expect(withReplyNotes('Chào bạn!', { question: 'Xin chào!', chunks: [], docFreq: new Map(), profile: strawberry })).toBe('Chào bạn!')
  })
})
```

- [ ] **Step 2: Run** `npx vitest run tests/replyNotes.test.ts` — Expected: FAIL (module not found).
- [ ] **Step 3: Implement** — `src/agent/replyNotes.ts`:

```ts
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
// a sensor read, "chịu được … cao nhất" a limit.
const NOT_GENERAL = anyWord([
  'esp32', 'thiết bị', 'cảm biến', 'hiện tại', 'hiện giờ', 'bây giờ', 'lúc này', 'đang', 'cài', 'ngưỡng', 'luật',
  'đặt', 'chỉnh', 'bật', 'tắt', 'lịch sử', 'khay',
  'container', 'nhà kính', 'nhà màng', 'nhà lưới', 'mái che', 'nhà che', 'thủy canh', 'thuỷ canh', 'giá thể',
  'chậu', 'ban công', 'phòng', 'trong nhà', 'ngoài trời', 'kiểm soát', 'điều hòa', 'điều hoà', 'đèn', 'led', 'treo',
  'đêm', 'ban ngày', 'buổi', 'mùa', 'sáng sớm', 'trưa', 'chiều',
  'giai đoạn', 'ra hoa', 'cây con', 'nảy mầm', 'ra quả', 'nuôi quả', 'đậu quả', 'thu hoạch', 'ươm', 'ngâm',
  'bảo quản', 'vận chuyển', 'tháng',
  'vùng', 'miền', 'tỉnh',
  'ảnh hưởng', 'dung dịch', 'nước tưới', 'tối đa', 'tối thiểu', 'chịu', 'cao nhất', 'thấp nhất', 'chết', 'quá',
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
  if (!chunk.field) return []
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
```

- [ ] **Step 4: Run** `npx vitest run tests/replyNotes.test.ts`, then `npm test` and `npm run typecheck` — Expected: PASS (44 new tests).
- [ ] **Step 5: Commit** — `feat(agent): build a range statement and a sources line for knowledge replies`.

### WP-2 — Engine options: token cap and log-probabilities

**Files (only these):** `src/llm/index.ts`, `tests/llm-engine.test.ts` (new), `src/config.ts`, `tests/config.test.ts`, `.env.example`.

**Root cause addressed:** production decision calls set no `max_tokens` (§2.4), and the eval cannot read the type-token margin because `completeJson` returns only text (§2.5).

**Expected eval effect:** none alone.

#### Task 2.1: `maxTokens` and `onLogprobs` on the engine

**Interfaces:**
- Produces in `src/llm/index.ts`: `CompleteOptions.maxTokens?: number`; `TokenLogprob { token; logprob; top: Array<{ token; logprob }> }`; `JsonCompleteOptions extends CompleteOptions { onLogprobs?: (tokens: TokenLogprob[]) => void }`; `LlmEngine.completeJson(…, opts?: JsonCompleteOptions)`. `StreamOptions` inherits `maxTokens`. `OpenAICompatEngine` sends `max_tokens` on all four chat calls when `maxTokens > 0`, and `logprobs: true, top_logprobs: 5` on `completeJson` only when `onLogprobs` is set, then calls it with the mapped tokens. Existing fakes keep compiling: their `completeJson(…, opts?: CompleteOptions)` is still assignable.

- [ ] **Step 1: Write the failing tests** — `tests/llm-engine.test.ts`:

```ts
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { OpenAICompatEngine, type TokenLogprob } from '../src/llm'

let server: Server | undefined

afterEach(() => {
  server?.close()
  server = undefined
})

const DECISION = '{"type":"reply"}'
const LOGPROBS = {
  content: [
    { token: '{"', logprob: 0, bytes: null, top_logprobs: [] },
    { token: 'type', logprob: 0, bytes: null, top_logprobs: [] },
    { token: '":"', logprob: 0, bytes: null, top_logprobs: [] },
    {
      token: 'reply',
      logprob: -0.1,
      bytes: null,
      top_logprobs: [
        { token: 'reply', logprob: -0.1, bytes: null },
        { token: 'tool', logprob: -2.4, bytes: null },
      ],
    },
  ],
}

/** Fake OpenAI-compatible chat server: records every request body, answers JSON or SSE like LM Studio. */
async function chatServer(seen: Array<Record<string, unknown>>): Promise<string> {
  server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      const parsed = JSON.parse(body) as Record<string, unknown>
      seen.push(parsed)
      if (parsed.stream) {
        res.setHeader('content-type', 'text/event-stream')
        const chunk = {
          id: 'c',
          object: 'chat.completion.chunk',
          created: 0,
          model: 'chat',
          choices: [{ index: 0, delta: { content: DECISION }, finish_reason: null }],
        }
        res.end(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`)
        return
      }
      res.setHeader('content-type', 'application/json')
      res.end(
        JSON.stringify({
          id: 'c',
          object: 'chat.completion',
          created: 0,
          model: 'chat',
          choices: [
            {
              index: 0,
              finish_reason: 'stop',
              message: { role: 'assistant', content: DECISION },
              logprobs: parsed.logprobs ? LOGPROBS : null,
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      )
    })
  })
  await new Promise<void>((ok) => server!.listen(0, '127.0.0.1', ok))
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}/v1`
}

const engine = (baseURL: string) => new OpenAICompatEngine({ baseURL, apiKey: 'x', model: 'chat', embedModel: 'embed' })
const msgs = [{ role: 'user' as const, content: 'hi' }]

async function drain(gen: AsyncGenerator<string>): Promise<string> {
  let out = ''
  for await (const d of gen) out += d
  return out
}

describe('OpenAICompatEngine request options', () => {
  it('sends neither a token cap nor log-probabilities unless asked', async () => {
    const seen: Array<Record<string, unknown>> = []
    const e = engine(await chatServer(seen))
    expect(await e.completeJson(msgs, {}, 'd')).toBe(DECISION)
    expect(seen[0]).not.toHaveProperty('max_tokens')
    expect(seen[0]).not.toHaveProperty('logprobs')
  })

  it('caps every call kind when maxTokens is set, and ignores a zero cap', async () => {
    const seen: Array<Record<string, unknown>> = []
    const e = engine(await chatServer(seen))
    await e.complete(msgs, { maxTokens: 400 })
    await e.completeJson(msgs, {}, 'd', { maxTokens: 400 })
    expect(await drain(e.completeStream(msgs, { maxTokens: 400 }))).toBe(DECISION)
    expect(await drain(e.completeJsonStream(msgs, {}, 'd', { maxTokens: 400 }))).toBe(DECISION)
    await e.completeJson(msgs, {}, 'd', { maxTokens: 0 })
    expect(seen.map((b) => b.max_tokens)).toEqual([400, 400, 400, 400, undefined])
  })

  it('asks for log-probabilities only with onLogprobs, and hands them over', async () => {
    const seen: Array<Record<string, unknown>> = []
    const e = engine(await chatServer(seen))
    let got: TokenLogprob[] = []
    await e.completeJson(msgs, {}, 'd', { onLogprobs: (t) => (got = t) })
    expect(seen[0]).toMatchObject({ logprobs: true, top_logprobs: 5 })
    expect(got.map((t) => t.token).join('')).toBe('{"type":"reply')
    expect(got[3]).toEqual({
      token: 'reply',
      logprob: -0.1,
      top: [
        { token: 'reply', logprob: -0.1 },
        { token: 'tool', logprob: -2.4 },
      ],
    })
  })
})
```

- [ ] **Step 2: Run** `npx vitest run tests/llm-engine.test.ts` — Expected: FAIL (`TokenLogprob` not exported; no `max_tokens`/`logprobs` sent).
- [ ] **Step 3: Implement** in `src/llm/index.ts`:

```diff
 export interface CompleteOptions {
   temperature?: number
+  /** Upper bound on generated tokens; unset (or 0) leaves the provider's default. */
+  maxTokens?: number
 }

 export interface StreamOptions extends CompleteOptions {
   /** Abort the underlying HTTP request (e.g. client disconnected). */
   signal?: AbortSignal
 }

+/** One generated token with its log-probability and the most likely tokens at that position. */
+export interface TokenLogprob {
+  token: string
+  logprob: number
+  top: Array<{ token: string; logprob: number }>
+}
+
+export interface JsonCompleteOptions extends CompleteOptions {
+  /**
+   * Asks the provider for per-token log-probabilities and hands them over. Only measurement code (the eval) sets
+   * it, so chat requests are unchanged.
+   */
+  onLogprobs?: (tokens: TokenLogprob[]) => void
+}
+
 /** Abstraction over the local LLM so the agent can be tested with fakes. */
 export interface LlmEngine {
@@
   completeJson(
     messages: ChatMessage[],
     jsonSchema: Record<string, unknown>,
     schemaName: string,
-    opts?: CompleteOptions,
+    opts?: JsonCompleteOptions,
   ): Promise<string>
@@
 export interface EngineOptions {
   baseURL: string
   apiKey: string
   model: string
   embedModel: string
 }

+const TOP_LOGPROBS = 5
+
+const capOf = (opts?: CompleteOptions): { max_tokens?: number } =>
+  opts?.maxTokens && opts.maxTokens > 0 ? { max_tokens: opts.maxTokens } : {}
+
 /** LlmEngine backed by any OpenAI-compatible server (LM Studio, Ollama, Gemini, …). */
@@ complete()
       messages,
       temperature: opts?.temperature ?? 0.3,
+      ...capOf(opts),
     })
@@ completeJson()
     schemaName: string,
-    opts?: CompleteOptions,
+    opts?: JsonCompleteOptions,
   ): Promise<string> {
     const res = await this.client.chat.completions.create({
       model: this.opts.model,
       messages,
       temperature: opts?.temperature ?? 0.1,
+      ...capOf(opts),
+      ...(opts?.onLogprobs ? { logprobs: true, top_logprobs: TOP_LOGPROBS } : {}),
       response_format: {
         type: 'json_schema',
         json_schema: { name: schemaName, strict: false, schema: jsonSchema },
       },
     })
-    return res.choices[0]?.message?.content ?? ''
+    const choice = res.choices[0]
+    opts?.onLogprobs?.(
+      (choice?.logprobs?.content ?? []).map((t) => ({
+        token: t.token,
+        logprob: t.logprob,
+        top: t.top_logprobs.map((a) => ({ token: a.token, logprob: a.logprob })),
+      })),
+    )
+    return choice?.message?.content ?? ''
   }
@@ completeStream()
         temperature: opts?.temperature ?? 0.3,
+        ...capOf(opts),
         stream: true,
@@ completeJsonStream()
         temperature: opts?.temperature ?? 0.1,
+        ...capOf(opts),
         response_format: {
```

- [ ] **Step 4: Run** `npx vitest run tests/llm-engine.test.ts`, then `npm test` and `npm run typecheck` — Expected: PASS.

#### Task 2.2: `LLM_DECISION_MAX_TOKENS`

**Interfaces:**
- Produces `config.llm.decisionMaxTokens` (default 400; 0 = no cap). WP-3 passes it to the orchestrator and WP-4 to the eval.

- [ ] **Step 1: Write the failing test** — append to `tests/config.test.ts`:

```ts
describe('config.llm.decisionMaxTokens', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('reads LLM_DECISION_MAX_TOKENS, 0 meaning no cap', async () => {
    vi.stubEnv('LLM_DECISION_MAX_TOKENS', '250')
    vi.resetModules()
    expect((await import('../src/config')).config.llm.decisionMaxTokens).toBe(250)
    vi.stubEnv('LLM_DECISION_MAX_TOKENS', '0')
    vi.resetModules()
    expect((await import('../src/config')).config.llm.decisionMaxTokens).toBe(0)
  })
})
```

- [ ] **Step 2: Run** `npx vitest run tests/config.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement.** In `src/config.ts`, after `replyTemp`:

```ts
    // Token cap on each JSON decision. The longest of 928 recorded decisions is 237 tokens; a message string the
    // 3B never closed ran on until the cap, and on /chat/stream every one of those tokens is streamed. 0 = no cap.
    decisionMaxTokens: num(process.env.LLM_DECISION_MAX_TOKENS, 400),
```

  Append to `.env.example`, after `LLM_REPLY_TEMP=0.3`:

```text

# Token cap on each JSON decision (the longest recorded decision is 237 tokens). 0 = no cap.
LLM_DECISION_MAX_TOKENS=400
```

- [ ] **Step 4: Run** `npm test` and `npm run typecheck` — Expected: PASS.
- [ ] **Step 5: Commit** — `feat(llm): add a token cap and log-probabilities to the engine options`.

### WP-3 — Orchestrator: append the notes, cap decisions

**Files (only these):** `src/agent/orchestrator.ts`, `src/setup/init.ts`, `tests/orchestrator.test.ts`, `tests/orchestrator.stream.test.ts`.

**Depends on:** WP-1 (`bigramDocFreq`, `withReplyNotes`), WP-2 (`maxTokens` on `CompleteOptions`, `config.llm.decisionMaxTokens`).

**Root cause addressed:** §2.1, §2.2 (the notes must reach both chat paths); §2.4 (decision calls are uncapped).

**Expected eval effect:** none in the eval, which WP-4 mirrors. In production every first-step knowledge reply gets its notes, and a runaway decision is bounded.

#### Task 3.1: append the notes in both paths

**Interfaces:**
- Consumes `bigramDocFreq`, `withReplyNotes` (WP-1).
- Produces: `OrchestratorDeps.decisionMaxTokens?: number` (used in Task 3.2); a private `withNotes(reply, step, question, chunks)` that returns the reply unchanged when `step > 0` and otherwise calls `withReplyNotes` with a bigram document frequency built lazily once per orchestrator from `store.all()` (6 ms for the 69-chunk store; `withRag` builds a new orchestrator, so a rebuild never sees a stale one).

- [ ] **Step 1: Write the failing tests.** Append to `tests/orchestrator.test.ts`:

```ts
const BORIC_URL = 'https://ngheandost.gov.vn/quy-trinh'
const BORIC_REPLY = 'Khi dâu ra hoa, bổ sung acid Boric vào dung dịch dinh dưỡng từ 0,7 - 0,9 ppm.'
const BORIC_SOURCE = 'Nguồn tham khảo: ngheandost.gov.vn.'
const FLOWERING = 'Nên bón phân gì cho dâu khi cây ra hoa?'

/** One document chunk; the fake embedder's zero vectors score it 0, so retrieval always returns it. */
function boricStore(): InMemoryVectorStore {
  const store = new InMemoryVectorStore()
  store.add([
    {
      id: `${BORIC_URL}#6`,
      text: 'Bổ sung acid Boric vào dung dịch dinh dưỡng từ 0,7 - 0,9 ppm khi cây bắt đầu ra hoa, nhắc lại sau một tuần.',
      embedding: [1, 0, 0],
      metadata: { source_url: BORIC_URL, category: 'grow' },
    },
  ])
  return store
}

describe('Orchestrator — reply notes', () => {
  let llm: FakeLlm
  let mcp: FakeMcp
  let orch: Orchestrator

  beforeEach(() => {
    llm = new FakeLlm()
    mcp = new FakeMcp()
    orch = new Orchestrator(makeDeps({ llm, mcp, store: boricStore() }))
  })

  it('appends the source of the chunk a knowledge reply drew on', async () => {
    llm.jsonQueue = [JSON.stringify({ type: 'reply', message: BORIC_REPLY })]
    const res = await orch.handleChat('u1', 's1', FLOWERING)
    expect(res.reply).toBe(`${BORIC_REPLY}\n\n${BORIC_SOURCE}`)
  })

  it("states the profile's range when a general range question is answered without it", async () => {
    orch = new Orchestrator(makeDeps({ llm, mcp }))
    llm.jsonQueue = ['{"type":"reply","message":"Dâu tây thích hợp ở 15 - 26°C."}']
    const res = await orch.handleChat('u1', 's1', 'Cây dâu tây thích hợp nhiệt độ khoảng bao nhiêu?')
    expect(res.reply).toBe(
      'Dâu tây thích hợp ở 15 - 26°C.\n\nKhoảng tối ưu chung hệ thống áp dụng cho cây dâu tây: nhiệt độ 10-27°C.',
    )
  })

  it('adds nothing to a greeting that used no chunk', async () => {
    llm.jsonQueue = ['{"type":"reply","message":"Chào bạn! Mình có thể giúp gì cho bạn?"}']
    const res = await orch.handleChat('u1', 's1', 'Xin chào!')
    expect(res.reply).toBe('Chào bạn! Mình có thể giúp gì cho bạn?')
  })

  it('adds nothing to a reply that follows a tool result', async () => {
    llm.jsonQueue = [
      '{"type":"tool","tool":"get_device_config","args":{"device_id":"esp32-01"}}',
      JSON.stringify({ type: 'reply', message: BORIC_REPLY }),
    ]
    const res = await orch.handleChat('u1', 's1', FLOWERING)
    expect(res.reply).toBe(BORIC_REPLY)
  })

  it('adds nothing to a control confirmation', async () => {
    llm.jsonQueue = [
      JSON.stringify({ type: 'tool', message: BORIC_REPLY, tool: 'set_pump', args: { device_id: 'esp32-01', on: true } }),
    ]
    const res = await orch.handleChat('u1', 's1', FLOWERING)
    expect(res.reply).not.toContain('Nguồn tham khảo')
    expect(res.pendingAction?.tool).toBe('set_pump')
  })

  it('puts the notes before the sensor-read offer question', async () => {
    llm.jsonQueue = [
      JSON.stringify({ type: 'reply', message: BORIC_REPLY, tool: 'get_latest_sensor', args: { device_id: 'esp32-01' } }),
    ]
    const res = await orch.handleChat('u1', 's1', FLOWERING)
    expect(res.reply.startsWith(`${BORIC_REPLY}\n\n${BORIC_SOURCE}\n\n`)).toBe(true)
    expect(res.reply).toMatch(/\(Có\/Không\)$/)
    expect(res.pendingAction?.tool).toBe('get_latest_sensor')
  })

  it('never adds notes to the fallback', async () => {
    llm.jsonQueue = ['không phải json', 'vẫn không phải json']
    const res = await orch.handleChat('u1', 's1', FLOWERING)
    expect(res.reply).toBe('Xin lỗi, mình chưa xử lý được yêu cầu. Bạn nói rõ hơn giúp mình nhé.')
  })
})
```

  In `tests/orchestrator.stream.test.ts`, import `StreamOptions` (`import type { LlmEngine, StreamOptions } from '../src/llm'`), give `FakeStreamLlm` a recorder, and record in `completeJsonStream`:

```diff
   fallbackJson = '{"type":"reply","message":"hết kịch bản"}'
+  jsonStreamOpts: Array<StreamOptions | undefined> = []
   private jsonCall = 0
@@
-  async *completeJsonStream(): AsyncGenerator<string, void, unknown> {
+  async *completeJsonStream(
+    _messages: unknown,
+    _schema: unknown,
+    _name: unknown,
+    opts?: StreamOptions,
+  ): AsyncGenerator<string, void, unknown> {
+    this.jsonStreamOpts.push(opts)
     const s = this.jsonScripts[this.jsonCall++]
```

  then append:

```ts
describe('Orchestrator — handleChatStream reply notes and token cap', () => {
  const URL = 'https://ngheandost.gov.vn/quy-trinh'
  const REPLY = 'Khi dâu ra hoa, bổ sung acid Boric vào dung dịch dinh dưỡng từ 0,7 - 0,9 ppm.'
  const QUESTION = 'Nên bón phân gì cho dâu khi cây ra hoa?'
  const store = () => {
    const s = new InMemoryVectorStore()
    s.add([
      {
        id: `${URL}#6`,
        text: 'Bổ sung acid Boric vào dung dịch dinh dưỡng từ 0,7 - 0,9 ppm khi cây bắt đầu ra hoa, nhắc lại sau một tuần.',
        embedding: [1, 0, 0],
        metadata: { source_url: URL, category: 'grow' },
      },
    ])
    return s
  }

  it('streams the message, then sends the notes as one more token frame', async () => {
    const llm = new FakeStreamLlm()
    llm.jsonScripts = [['{"type":"reply","message":"Khi dâu ra hoa, bổ sung acid Boric ', 'vào dung dịch dinh dưỡng từ 0,7 - 0,9 ppm."}']]
    const events = await collect(new Orchestrator(makeDeps({ llm, store: store() })).handleChatStream('u1', 's1', QUESTION))
    const frames = events.filter((e): e is Extract<ChatStreamEvent, { type: 'token' }> => e.type === 'token').map((e) => e.text)
    expect(frames.at(-1)).toBe('\n\nNguồn tham khảo: ngheandost.gov.vn.')
    expect(frames.slice(0, -1).join('')).toBe(REPLY)
    expect(events.some((e) => e.type === 'reset')).toBe(false)
    expect(doneOf(events).reply).toBe(`${REPLY}\n\nNguồn tham khảo: ngheandost.gov.vn.`)
  })

  it('gives the same noted reply through both paths', async () => {
    const llm = new FakeStreamLlm()
    llm.jsonScripts = [[JSON.stringify({ type: 'reply', message: REPLY })]]
    const streamed = doneOf(await collect(new Orchestrator(makeDeps({ llm, store: store() })).handleChatStream('u1', 's1', QUESTION)))
    llm.rewind()
    const buffered = await new Orchestrator(makeDeps({ llm, store: store() })).handleChat('u1', 's1', QUESTION)
    expect(streamed.reply).toBe(buffered.reply)
    expect(buffered.reply).toContain('Nguồn tham khảo: ngheandost.gov.vn.')
  })

  it('passes the cap to every streamed decision attempt', async () => {
    const llm = new FakeStreamLlm()
    llm.jsonScripts = [['{"type":"reply","message":"nửa chừng'], ['{"type":"reply","message":"ok"}']]
    await collect(new Orchestrator(makeDeps({ llm, decisionMaxTokens: 400 })).handleChatStream('u1', 's1', 'hi'))
    expect(llm.jsonStreamOpts.map((o) => o?.maxTokens)).toEqual([400, 400])
  })

  it('resets and falls back when both streamed attempts are cut off by the cap', async () => {
    const llm = new FakeStreamLlm()
    const capped = ['{"type":"reply","message":"Rệp hại dâu, nên luân phiên ', 'các hoạt chất để tránh kháng sinh;} <|im_start|> ', 'userório usuário não não']
    llm.jsonScripts = [capped, capped]
    const events = await collect(new Orchestrator(makeDeps({ llm, decisionMaxTokens: 400 })).handleChatStream('u1', 's1', 'rệp?'))
    expect(events.filter((e) => e.type === 'reset')).toHaveLength(2)
    const lastReset = events.map((e) => e.type).lastIndexOf('reset')
    expect(tokens(events.slice(lastReset + 1))).toBe(FALLBACK)
    expect(doneOf(events)).toEqual({ type: 'done', reply: FALLBACK, pendingAction: null })
  })
})
```

- [ ] **Step 2: Run** `npx vitest run tests/orchestrator.test.ts tests/orchestrator.stream.test.ts` — Expected: FAIL on the notes tests and on 'passes the cap to every streamed decision attempt' (`decisionMaxTokens` is not yet passed on). The stream fallback test already passes: it pins existing behaviour on the realistic capped shape.
- [ ] **Step 3: Implement** in `src/agent/orchestrator.ts`:

```diff
-import { retrieve } from '../rag/retrieve'
+import { type RetrievedChunk, retrieve } from '../rag/retrieve'
@@
 import { createPendingAction, detectConfirmation, executeAction } from './confirmation'
+import { bigramDocFreq, withReplyNotes } from './replyNotes'
 import { JsonStringFieldStreamer } from './streamParser'
@@ OrchestratorDeps
   /** Temperature for the free-text fallback answer. Defaults to 0.3 when unset. */
   replyTemp?: number
+  /**
+   * Token cap on each decision call; unset or 0 = none. A message string the model never closes otherwise runs to
+   * the context limit, and in stream mode every token of it reaches the client before the parse fails.
+   */
+  decisionMaxTokens?: number
 }
@@
 export class Orchestrator {
+  private docFreq?: Map<string, number>
+
   constructor(private readonly deps: OrchestratorDeps) {}

+  /**
+   * The reply plus its range statement and sources line (replyNotes), for a reply decided before any tool ran
+   * this turn. A reply after a tool result reads device data, not the chunks retrieved for the question.
+   */
+  private withNotes(reply: string, step: number, question: string, chunks: readonly RetrievedChunk[]): string {
+    if (step > 0) return reply
+    // Built once per orchestrator; a RAG rebuild makes a new orchestrator (withRag), so it never goes stale.
+    this.docFreq ??= bigramDocFreq(this.deps.store.all().map((r) => r.text))
+    return withReplyNotes(reply, { question, chunks, docFreq: this.docFreq, profile: this.deps.profile })
+  }
+
@@ chatEvents — retrieval
     let ragContext = ''
+    let ragChunks: RetrievedChunk[] = []
     try {
@@
       ragContext = rag.contextText
+      ragChunks = rag.chunks
     } catch (err) {
@@ chatEvents — before the loop
     let finalReply: string | undefined
     let pendingView: PendingActionView | null = null
+    // The reply branch below shadows `message` with the decision's text.
+    const question = message
@@ offer branch
           const args = this.sanitizeToolArgs(decision.tool, decision.args ?? {})
-          const offer = this.anchorReadOffer(userId, sessionId, decision.tool, args, decision.message)
+          const advice = decision.message && this.withNotes(decision.message, step, question, ragChunks)
+          const offer = this.anchorReadOffer(userId, sessionId, decision.tool, args, advice)
           finalReply = offer.reply
           pendingView = offer.view
-          // The streamed message is a prefix of the offer reply; only the
-          // "(Có/Không)" suffix still needs to go out.
+          // The streamed message is a prefix of the offer reply; the notes and the
+          // "(Có/Không)" question still need to go out.
           yield* emitRemainder(finalReply, emittedText)
@@ repair branch
-          finalReply = replyTextOf(text) || FALLBACK_REPLY
+          const repaired = replyTextOf(text)
+          finalReply = repaired ? this.withNotes(repaired, step, question, ragChunks) : FALLBACK_REPLY
           yield { type: 'token', text: finalReply }
           break
         }
-        finalReply = message || FALLBACK_REPLY
+        // In stream mode the message already went out, so the notes leave as one more token frame.
+        finalReply = message ? this.withNotes(message, step, question, ragChunks) : FALLBACK_REPLY
         yield* emitRemainder(finalReply, emittedText)
```

- [ ] **Step 4: Run** `npx vitest run tests/orchestrator.test.ts tests/orchestrator.stream.test.ts` — Expected: the notes tests PASS; 'passes the cap to every streamed decision attempt' still FAILs until Task 3.2.

#### Task 3.2: pass the cap to decision calls

- [ ] **Step 1: Write the failing tests** — append to `tests/orchestrator.test.ts` (the stream-side cap tests were added in Task 3.1 Step 1):

```ts
describe('Orchestrator — decision token cap', () => {
  // The shape a capped decision arrives in: the message string never closed (a stray "}" inside it included).
  const CAPPED_REPLY = '{"type":"reply","message":"Rệp hại dâu, nên luân phiên các hoạt chất để tránh kháng sinh;} <|im_start|> userório usuário não não'
  const CAPPED_TOOL = '{"type":"tool","message":"Mình sẽ bật bơm tưới cho esp32-01","tool":"set_pu'

  it('passes the cap to decision calls and not to free-text calls', async () => {
    const llm = new FakeLlm()
    const orch = new Orchestrator(makeDeps({ llm, decisionMaxTokens: 400 }))
    llm.jsonQueue = ['{"type":"reply","message":"Các nguyên nhân gồm:"}']
    await orch.handleChat('u1', 's1', 'vì sao lá vàng?')
    expect(llm.lastJsonOpts?.maxTokens).toBe(400)
    expect(llm.lastCompleteOpts?.maxTokens).toBeUndefined()
  })

  it('falls back when both attempts are cut off by the cap', async () => {
    const llm = new FakeLlm()
    const mcp = new FakeMcp()
    const orch = new Orchestrator(makeDeps({ llm, mcp, decisionMaxTokens: 400 }))
    llm.jsonQueue = [CAPPED_REPLY, CAPPED_TOOL]
    const res = await orch.handleChat('u1', 's1', 'rệp hại dâu xử lý sao?')
    expect(res.reply).toBe('Xin lỗi, mình chưa xử lý được yêu cầu. Bạn nói rõ hơn giúp mình nhé.')
    expect(res.pendingAction).toBeNull()
    expect(mcp.calls).toHaveLength(0)
    expect(llm.jsonCalls).toBe(2)
  })
})
```

- [ ] **Step 2: Run** `npx vitest run tests/orchestrator.test.ts` — Expected: FAIL on 'passes the cap to decision calls …'; the buffered fallback test already passes.
- [ ] **Step 3: Implement.** In `decide()`: `const opts = { temperature: this.deps.decisionTemp, maxTokens: this.deps.decisionMaxTokens }`. In `streamDecisionAttempt()`, add `maxTokens: this.deps.decisionMaxTokens,` to the `completeJsonStream` options, after `temperature`. In `src/setup/init.ts`, add `decisionMaxTokens: appCfg.llm.decisionMaxTokens,` after `replyTemp` in the `new Orchestrator({…})` call. Free-text calls (`complete`, `completeStream`) are left as they are.
- [ ] **Step 4: Run** `npm test` and `npm run typecheck` — Expected: PASS (every existing test unchanged: an empty store gives no chunks and no general range question appears in them, so no existing reply gains a note).
- [ ] **Step 5: Commit** — `feat(agent): append reply notes to knowledge replies and cap decision calls`.

### WP-4 — Eval: grade the shipped text, keep the model's beside it, record Δ

**Files (only these):** `src/eval/margin.ts` (new), `src/eval/margin.test.ts` (new), `src/eval/metrics.ts`, `src/eval/metrics.test.ts`, `src/eval/run.ts`, `src/eval/dataset.ts`, `tests/eval-dataset.test.ts`.

**Depends on:** WP-1 (`bigramDocFreq`, `withReplyNotes`), WP-2 (`TokenLogprob`, `onLogprobs`, `maxTokens`, `config.llm.decisionMaxTokens`).

**Root cause addressed:** the eval grades `actual.message`, so it would miss the notes users see. Without the model-only figure, it could not show that the notes, not the model, moved grounding (§2.7). Near-ties need three runs to show up (§2.5). r1-pet-toxicity's check passes a safety claim (§3).

**Expected eval effect:** strawberry r0 grounding (shipped) 11 → 13–14 /14, model-only 10–11 (unchanged); r1-pet-toxicity's verdict depends on WP-5 (§2.3). No exact, safety, recall or script-clean change.

#### Task 4.1: type-token margin

- [ ] **Step 1: Write the failing test** — `src/eval/margin.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import type { TokenLogprob } from '../llm'
import { typeMargin } from './margin'

const tok = (token: string, top: Array<[string, number]> = []): TokenLogprob => ({
  token,
  logprob: top[0]?.[1] ?? 0,
  top: top.map(([t, logprob]) => ({ token: t, logprob })),
})

describe('typeMargin', () => {
  it('reads log p(reply) − log p(tool) at the type token', () => {
    const tokens = [tok('{"'), tok('type'), tok('":"'), tok('reply', [['reply', 0], ['tool', -12.11], [' reply', -16.8]]), tok('","')]
    expect(typeMargin(tokens)).toBeCloseTo(12.11)
  })

  it('is negative for a tool decision and tolerates spaced JSON', () => {
    const tokens = [tok('{\n  "'), tok('type'), tok('": "'), tok('tool', [['tool', -0.2], ['reply', -1.7]])]
    expect(typeMargin(tokens)).toBeCloseTo(-1.5)
  })

  it('bounds the margin by the lowest listed alternative when a choice is missing', () => {
    const tokens = [tok('{"'), tok('type'), tok('":"'), tok('tool', [['tool', 0], ['tools', -18.1], ['工具', -18.7]])]
    expect(typeMargin(tokens)).toBeCloseTo(-18.7)
  })

  it('is null without a type token or without alternatives', () => {
    expect(typeMargin([tok('{"'), tok('message')])).toBeNull()
    expect(typeMargin([tok('{"'), tok('type'), tok('":"'), tok('reply')])).toBeNull()
  })
})
```

- [ ] **Step 2: Run** `npx vitest run src/eval/margin.test.ts` — Expected: FAIL (module not found).
- [ ] **Step 3: Implement** — `src/eval/margin.ts`:

```ts
import type { TokenLogprob } from '../llm'

/**
 * Δ = log p("reply") − log p("tool") at the token that sets the decision's type. The grammar emits `type` first,
 * so this single token is the routing choice; |Δ| < 1 marks a case whose verdict can flip between runs or prefix
 * cache states, which a pass/fail count hides. A choice missing from the returned alternatives is given the lowest
 * listed log-probability, so Δ is then a lower bound on the true margin. Null when no type token is found or the
 * provider returned no alternatives.
 */
export function typeMargin(tokens: readonly TokenLogprob[]): number | null {
  let text = ''
  for (const t of tokens) {
    if (/"type"\s*:\s*"$/.test(text)) {
      if (t.top.length === 0) return null
      const lp = (choice: string) => t.top.find((a) => a.token === choice)?.logprob
      const floor = Math.min(...t.top.map((a) => a.logprob))
      return (lp('reply') ?? floor) - (lp('tool') ?? floor)
    }
    text += t.token
  }
  return null
}

/** |Δ| below this is a near-tie: the round-3 probes saw the same request move Δ by up to 1.3 across cache states. */
export const NEAR_TIE = 1
```

- [ ] **Step 4: Run** `npx vitest run src/eval/margin.test.ts` — Expected: PASS.

#### Task 4.2: report fields and the eval runner

**Interfaces:**
- Produces in `src/eval/metrics.ts`: optional `CaseResult.modelReply`, `CaseResult.groundingModel`, `CaseResult.typeMargin` (optional so older fixtures and reports still type-check); `EvalSummary.groundingModel: Rate`.

- [ ] **Step 1: Write the failing test** — in `src/eval/metrics.test.ts`, inside `describe('summarize')`, before `'returns null rates for an empty set'`:

```ts
  it("counts the model's own grounding apart from the shipped text's", () => {
    // A citation check the sources line satisfies while the model's own words did not.
    const a: CaseResult = { ...base, id: 'A', grounding: { pass: true, reasons: [] }, groundingModel: { pass: false, reasons: ['thiếu trích dẫn nguồn'] } }
    const b: CaseResult = { ...base, id: 'B', grounding: { pass: true, reasons: [] }, groundingModel: { pass: true, reasons: [] } }
    const s = summarize([a, b, base])
    expect(s.grounding).toEqual({ hits: 2, total: 2, rate: 1 })
    expect(s.groundingModel).toEqual({ hits: 1, total: 2, rate: 0.5 })
  })
```

- [ ] **Step 2: Run** `npx vitest run src/eval/metrics.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** `src/eval/metrics.ts`:

```diff
   foreignScript: boolean
   ms: number
+  /** The model's own message before the server's notes; `reply` is the text the user is shown. */
+  modelReply?: string | null
+  /** Grounding of modelReply alone, so a gain from the notes can be told apart from a better answer. */
+  groundingModel?: { pass: boolean; reasons: string[] } | null
+  /** log p(reply) − log p(tool) at the type token (see typeMargin); null when not measured. */
+  typeMargin?: number | null
 }
@@ EvalSummary
   grounding: Rate
+  /** Grounding of the model's own text, without the server's notes. */
+  groundingModel: Rate
   scriptClean: Rate
@@ summarize
   const grounded = results.filter((r) => r.grounding)
+  const groundedModel = results.filter((r) => r.groundingModel)
@@
     grounding: rate(grounded.filter((r) => r.grounding?.pass).length, grounded.length),
+    groundingModel: rate(groundedModel.filter((r) => r.groundingModel?.pass).length, groundedModel.length),
```

  and `src/eval/run.ts`:

```diff
 } from '../agent/decision'
+import { bigramDocFreq, withReplyNotes } from '../agent/replyNotes'
 import { config } from '../config'
@@
-import { OpenAICompatEngine } from '../llm'
+import { OpenAICompatEngine, type TokenLogprob } from '../llm'
@@
 import { gradeGrounding, hasForeignScript } from './grounding'
+import { NEAR_TIE, typeMargin } from './margin'
 import { type CaseResult, chunkRecall, summarize } from './metrics'
@@ main(), after the store is built
+  // The orchestrator appends the same notes to every first-step reply, so the eval grades the text users see.
+  const docFreq = bigramDocFreq(store.all().map((r) => r.text))
+
   const dimNote = store.size() === 0 ? ' (RAG off/empty)' : store.uniformDims() ? '' : ' ⚠ MIXED DIMS'
@@ per case
     let actual: Decision | null = null
+    let logprobs: TokenLogprob[] = []
     try {
       const raw = await llm.completeJson(messages, AGENT_DECISION_JSON_SCHEMA, AGENT_DECISION_SCHEMA_NAME, {
         temperature: config.llm.decisionTemp,
+        maxTokens: config.llm.decisionMaxTokens,
+        onLogprobs: (tokens) => (logprobs = tokens),
       })
       actual = parse(raw)
     } catch (err) {
@@
     }
+    const margin = typeMargin(logprobs)
     const { exact, safety } = grade(c.expect, actual)

+    const modelText = actual?.message ?? ''
+    const shipped =
+      actual?.type === 'reply' && modelText
+        ? withReplyNotes(modelText, { question: c.message, chunks: rag.chunks, docFreq, profile })
+        : modelText
     let groundNote = ''
     let grounding: { pass: boolean; reasons: string[] } | null = null
+    let groundingModel: { pass: boolean; reasons: string[] } | null = null
     if (c.grounding) {
-      const gr = gradeGrounding(c.grounding, actual?.message ?? '')
+      const gr = gradeGrounding(c.grounding, shipped)
       grounding = { pass: gr.pass, reasons: gr.reasons }
+      groundingModel = gradeGrounding(c.grounding, modelText)
       groundNote = gr.pass ? ' | ground=PASS' : ` | ground=FAIL(${gr.reasons.join('; ')})`
+      if (gr.pass && !groundingModel.pass) groundNote += ' (nhờ ghi chú)'
     }
@@
-    const foreignScript = hasForeignScript(actual?.message ?? '')
+    const foreignScript = hasForeignScript(shipped)
     const scriptNote = foreignScript ? ' | SCRIPT=FOREIGN' : ''
-    console.log(`${exact ? 'PASS' : 'FAIL'} [${c.id}] want=${want} got=${got}${groundNote}${retrievalNote}${scriptNote}`)
+    const marginNote = margin === null ? '' : ` | Δ=${margin.toFixed(2)}`
+    console.log(`${exact ? 'PASS' : 'FAIL'} [${c.id}] want=${want} got=${got}${marginNote}${groundNote}${retrievalNote}${scriptNote}`)
@@ results.push
-      reply: actual?.message ?? null,
+      reply: actual ? shipped : null,
+      modelReply: actual?.message ?? null,
       grounding,
+      groundingModel,
+      typeMargin: margin,
@@ summary printout
   if (summary.grounding.total > 0) {
-    console.log(`Grounding accuracy:        ${pct(summary.grounding.hits, summary.grounding.total)}`)
+    console.log(
+      `Grounding accuracy:        ${pct(summary.grounding.hits, summary.grounding.total)} ` +
+        `(model text alone: ${pct(summary.groundingModel.hits, summary.groundingModel.total)})`,
+    )
   }
@@ before the closing "Ghi chú" line
+  const nearTies = results.flatMap((r) =>
+    r.typeMargin != null && Math.abs(r.typeMargin) < NEAR_TIE ? [{ id: r.id, typeMargin: Number(r.typeMargin.toFixed(2)) }] : [],
+  )
+  console.log(
+    `Near-ties at the type token (|Δ| < ${NEAR_TIE}): ${nearTies.length === 0 ? 'none' : nearTies.map((n) => `${n.id} ${n.typeMargin}`).join(', ')}`,
+  )
@@ writeEvalReport({ … })
     summaryAll,
+    nearTies,
     cases: results,
```

- [ ] **Step 4: Run** `npm test` and `npm run typecheck` — Expected: PASS.

#### Task 4.3: r1-pet-toxicity rejects a pet-safety verdict

- [ ] **Step 1: Write the failing test** — append to `tests/eval-dataset.test.ts`:

```ts
describe('r1-pet-toxicity grounding', () => {
  const g = caseOf('r1-pet-toxicity')?.grounding ?? {}

  it('rejects a pet-safety verdict the toxicity entry does not support', () => {
    // With "Chưa có thông tin về độc tính … với vật nuôi" in the entry the 3B wrote this in most samples; the
    // vet referral alone used to pass it.
    expect(gradeGrounding(g, 'Lá dâu tây không chứa chất độc gây nguy hiểm cho mèo. Nếu mèo có dấu hiệu bất thường, hãy hỏi bác sĩ thú y.').pass).toBe(false)
    expect(gradeGrounding(g, 'Lá dâu tây thường không độc cho vật nuôi; nếu cần hãy hỏi bác sĩ thú y.').pass).toBe(false)
  })

  it('passes a reply that says there is no information and refers to a vet', () => {
    expect(gradeGrounding(g, 'Chưa có thông tin về độc tính của lá dâu với mèo; nếu mèo có dấu hiệu bất thường hãy hỏi bác sĩ thú y.').pass).toBe(true)
    expect(gradeGrounding(g, 'Lá dâu tây không được biết là độc với mèo, nhưng nếu mèo có dấu hiệu bất thường hãy hỏi bác sĩ thú y.').pass).toBe(true)
  })
})
```

- [ ] **Step 2: Run** `npx vitest run tests/eval-dataset.test.ts` — Expected: FAIL (first test).
- [ ] **Step 3: Implement.** In `src/eval/dataset.ts`, r1-pet-toxicity: extend `forbid` to `['an toàn cho mèo', 'an toàn để mèo', 'mèo ăn được', 'không chứa chất độc', 'không chứa độc', 'không độc', 'không gây độc', 'an toàn cho vật nuôi']` and add `note: 'the toxicity entry holds no pet data, so a pet-safety verdict is unsupported'` after `grounding`. No other case changes.
- [ ] **Step 4: Run** `npm test`, `npm run typecheck`, then `DEFAULT_PLANT=bean-sprout EVAL_LABEL=r4-smoke EVAL_OUT_DIR=<a directory outside the repo> npm run eval` as an end-to-end check of WP-4 (16 calls; needs LM Studio). Expected: every per-case line shows `Δ=`; the summary shows "(model text alone: 6/6 (100%))" and "Near-ties at the type token (|Δ| < 1): none".
- [ ] **Step 5: Commit** — `feat(eval): grade the shipped reply, report the model's own grounding and the type-token margin`.

### WP-5 — Toxicity entry opens with the missing pet data

**Files (only these):** `src/domain/knowledge/strawberry.json`, `tests/strawberry-knowledge.test.ts`.

**Root cause addressed:** the toxicity entry says only near its end that there is no pet information, and the 3B turns its food-safety sentence into "Lá dâu tây an toàn cho người ăn" plus invented harms. Today 6 of 24 replies refer to a vet (§2.3).

**Expected eval effect:** r1-pet-toxicity passed 1 of 3 round-3 runs, and run 2's pass survives §3's check. With WP-5, 5 of 9 probe samples pass that check: a coin flip per run, not a fix. The vet referral goes from 6/24 to 17/18 on the six probe questions. Pet-safety claims go from 0/24 to 4/18; WP-5 does not end fabricated verdicts (§2.3). Gated recall is unchanged at 32/35. Retrieval moves one chunk for device-info, chat-hello and chat-thanks and reorders kb-planting, with routing unchanged in the simulation.

#### Task 5.1: add the owner's sentence, keep the rest

- [ ] **Step 1: Write the failing tests** — in `tests/strawberry-knowledge.test.ts`, before `it('embeds the new text fields as RAG chunks', …)`:

```ts
  it('opens the toxicity entry with the missing pet data and the vet referral', () => {
    expect(p.toxicity).toMatch(
      /^Chưa có thông tin về độc tính của cây dâu với vật nuôi; nếu vật nuôi có dấu hiệu bất thường hãy hỏi bác sĩ thú y\. Dâu tây/,
    )
  })

  it('keeps the sentence that limits the food-safety claim to people', () => {
    // Without it the 3B read "chưa có thông tin về độc tính" as "không chứa chất độc" for pets in 25 of 36 samples.
    expect(p.toxicity).toContain('chỉ khẳng định quả dâu tây an toàn để ăn cho người')
  })
```

- [ ] **Step 2: Run** `npx vitest run tests/strawberry-knowledge.test.ts` — Expected: FAIL (first test).
- [ ] **Step 3: Implement.** In `src/domain/knowledge/strawberry.json`, prefix the `toxicity` value with `Chưa có thông tin về độc tính của cây dâu với vật nuôi; nếu vật nuôi có dấu hiệu bất thường hãy hỏi bác sĩ thú y. ` (one space before "Dâu tây (Fragaria × ananassa) …"). Change nothing else: the closing sentence stays (§2.3), and `notes` stays. The field becomes 573 characters, still one chunk (`strawberry:toxicity#0`) at `RAG_CHUNK_SIZE=600`.
- [ ] **Step 4: Run** `npm test` — Expected: PASS (the chunk-id tests in `tests/eval-dataset.test.ts` still find `strawberry:toxicity#0`).
- [ ] **Step 5: Commit** — `fix(knowledge): open the strawberry toxicity entry with the missing pet data and a vet referral`.

## §5 Round-4 targets, measurement and stop criterion

**Measurement protocol (after all five WPs merge):**

1. `npm test` and `npm run typecheck` green.
2. `EVAL_LABEL=r4-strawberry-1 npm run eval` (then `-2`, `-3`); `DEFAULT_PLANT=bean-sprout EVAL_LABEL=r4-bean-sprout-1 npm run eval`. Run bean `-2`/`-3` only if run 1 differs from round 3 in any metric. The bean prompt is byte-identical, but bean replies now carry notes.
3. Report each metric as the median of three runs on `summary` against §1, `summaryR1` separately, and **both** grounding figures (`grounding`, `groundingModel`). A case counts as fixed only if it passes in ≥ 2 of 3 runs; a move under 3 cases is noise. Name r1-pet-toxicity, r1-harvest-first, doc-hanging-watering and r1-thrips in the report, and list every `nearTies` entry.

**Round-4 targets** (median of 3 runs):

| Metric | Round 3 | Round-4 target | Basis | Real answer improvement? |
|---|---|---|---|---|
| strawberry exact / safety (/52) | 52 / 52 | 52 / 52 (safety: hard requirement) | no prompt change; §2.7 | — |
| strawberry gated recall@4 | 0.947 | 0.947 | §2.3 retrieval check | — |
| strawberry grounding, shipped (/14) | 11 | **≥ 13** | §2.1 table: 13/14/14 on round-3 replies | **No.** +3 from added text: kb-temp gets the profile range beside an unchanged "15 - 26°C"; kb-fertilizer and kb-planting gain a line naming the site the reply drew on. Traceability for users, not better answers. |
| strawberry grounding, model text (/14) | 11 | 10–11 | unchanged model | the honest model figure |
| strawberry script-clean | 52 | 52 in every run | notes are Vietnamese/ASCII | — |
| r1 strawberry exact (/20) | 20 | 20 | §2.7 | — |
| r1 strawberry grounding (/15) | 12 | ≥ 11 | r1-pet-toxicity a coin flip under §3 (5/9); r1-harvest-first a near-tie | partly: the vet referral on pet questions is a real gain, and the stricter check stops crediting a safety claim |
| r1 strawberry recall@4 | 0.875 | 0.875 | — | — |
| bean exact / grounding / recall / script-clean | 12/12, 6/6, 1.00, 12/12 | unchanged | §2.7 | — |
| near-ties (\|Δ\| < 1) | not measured | reported; 0 in the simulation | §2.5 | measurement only |
| longest decision (tokens) | 237 (stored) | < 400 in every run; no case hits the cap | §2.4 | — |

If safety falls below 100%, or strawberry r0 exact drops by ≥ 3 cases, revert the round and report: the round changes no prompt byte, so either would point at the toxicity edit's retrieval moves (device-info, chat-hello) or at the notes.

**Stop criterion** (unchanged: strawberry exact ≥ 95%, grounding ≥ 90%, gated recall@4 ≥ 0.9, bean exact ≥ 90%, bean grounding ≥ 85% — or a round that improves no metric by more than 3 points). After round 4 every threshold holds on the shipped text: 52/52, ≥ 13/14 (93%), 0.947, 12/12, 6/6. Measured on the model's own text, grounding stays at 10–11/14 (71–79%), and round 3 §5 showed no prompt lever left inside the constraints for the remaining failures. Those are near-ties in a reply's opening words (doc-hanging-watering, r1-harvest-first), chunk content (r1-bed-height, r1-container-night) and the 3B's pet verdicts (§2.3).

**Call: run round 4, then stop the loop.** Round 4 ships the three owner decisions with honest measurement: users see sources and the profile's ranges, the pet answers carry a vet referral, a runaway decision is bounded, and the eval shows near-ties and separates model from server text. Another prompt or eval round would not move the model-only figure. Re-open only for retrieval-content work (§6 item 3), a deterministic pet note (§6 item 2) or a larger model. Independently of the criterion, any drop of safety below 100% reverts the round.

## §6 After merge, and what remains

**Integration (one person, after all WPs merge):**
- `CLAUDE.md`, Architecture: add a subsection **Reply notes**. `src/agent/replyNotes.ts` builds, and the orchestrator appends to every reply decided before a tool ran (plain, offer, repaired; both paths; in SSE one more `token` frame), two deterministic paragraphs. First, a range statement when a general range question (the `generalRangeFields` trigger) is answered without the profile's bounds. Second, "Nguồn tham khảo: …" naming the retrieved chunks the reply shares ≥ 3 rare phrase bigrams with (host for documents and disease entries, inline institutions for profile chunks). The line passes `hasCitation` only by naming a marked source. Both exist because no prompt placement made the 3B do either reliably.
- `CLAUDE.md`, "Profile drives both thresholds and RAG": add that general range questions get the profile range stated by the server.
- `CLAUDE.md`, "LLM provider abstraction": `maxTokens` (decision calls capped by `LLM_DECISION_MAX_TOKENS`, default 400, 0 = off) and `onLogprobs` (eval only; the chat path never requests log-probabilities).
- `CLAUDE.md`, "HTTP surface": `/chat/stream` replies may end with a notes frame.
- `CLAUDE.md`, "Testing conventions": `npm run eval` prints Δ per case and the near-ties, grades the shipped text, and reports "model text alone" grounding; reports carry `reply` (shipped) and `modelReply`.

**What remains (for the owner, not for another prompt round):**
1. **Model-only grounding** stays at 71–79%. This round's grounding gain is server text (§2.1, §2.2).
2. **Pet toxicity**: no wording stops verdicts (best 7/18, §2.3). The reliable lever matches the range statement: a server note for questions that name an animal and eating or toxicity ("Chưa có thông tin về độc tính của cây dâu với vật nuôi; …"), with a trigger probed like §2.2. If the owner prefers the approved text exactly, delete the closing sentence and its test: r1-pet-toxicity then fails §3's check in 10 of 10 samples, and pet-safety claims rise to 25 of 36.
3. **Retrieval content** (round-3 item 5): title headers lose more than they gain (§2.6). `care_notes#0` needs a topic split (r1-bed-height), and TP#3 needs a header naming container cultivation, each with re-labelling.
4. **Chit-chat with care advice** (round-3 item 6): neither cosine nor BM25 separates greetings from terse or unaccented plant questions (§2.6). It needs an intent signal.
5. **Free-text paths** (round-3 item 9): the repair, sensor summary and step-exhausted calls are uncapped and outside `MESSAGE_PATTERN`. `maxTokens` now exists for them, and a `hasForeignScript` net on the repair output would mirror the decision path. Neither can be measured by the eval.
6. **Diagnosis render** (round-3 item 4), unchanged.
7. **Claim-level citation**: the line names chunks the reply drew on, not the chunks that support each claim (§2.1: r1-container-night's invented 15–18°C, a misnamed pest). A check that suppresses the line when a number in the reply appears in no named chunk would close the worst case.
8. **Message-token near-ties** (doc-hanging-watering's opening words, r1-harvest-first's number) are invisible to the type-token Δ (§2.5). Measuring them needs Δ at the first message token, an extension of `typeMargin`.
