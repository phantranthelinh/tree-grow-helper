# RAG + Eval Round 3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. The two work packages (WP-1, WP-2) run **in parallel**; each may touch **only** the files listed in its own "Files" block, and neither needs the other's code to compile or to pass its tests.

**Goal:** Close the one routing defect round 2 left, correct the claims about the decision prompt that the round-3 probes disproved, and end the loop. (1) `r1-container-night` still goes to `get_device_config` in every run. Round 2's contrast clause was probed only while the strawberry diagnosis example sat right before the config example; round-2 Task 2.2 then removed that example, and with it the only reply example in front of the config example. The clause alone has no measured effect; a knowledge reply placed right before the config example does (§2.1). (2) The schema comment says `reasoning` is listed first so the model thinks before it decides; LM Studio's grammar emits `type` first in every captured decision, and forcing `reasoning` first routes knowledge questions to sensor reads (§2.1). (3) `doc-hanging-watering`'s 2-of-3 failure is a near-tie in the reply's opening words that any prompt edit moves; it is noise by the round-1 §0 rule (§2.2). Nothing else regressed against round 1 (§1, §2.3). Citations, kb-temp's range policy and pet-toxicity content stay out of scope (owner decisions pending). The loop stops after this round (§5).

**Architecture:** WP-1 adds one knowledge example to the strawberry few-shot set, immediately before the `get_device_config` example, and pins its place and wording with prompt tests. WP-2 corrects the decision schema's comment and the test named after it; no schema byte changes. The CLAUDE.md bullets that carry the disproved claims are corrected at integration (§6).

**Tech Stack:** TypeScript ESM run by tsx, Vitest 2, LM Studio (qwen2.5-3b-instruct + text-embedding-bge-m3) for `npm run eval` only.

**Spec:** this document, §0–§3. Inputs: `data/eval/r2-strawberry-{1,2,3}-*.json` and `data/eval/r2-bean-sprout-{1,2,3}-*.json` (round 2 at the defaults: hybrid on, topK 4, MMR 0.7, margin 0.15, `MESSAGE_PATTERN` on), the round-1 reports `data/eval/r1-*.json`, round 0 `data/eval/r0-*.json`, and the round-2 plan `docs/superpowers/plans/2026-11-16-rag-eval-round-2.md` (format, constraints, stop criterion). The round-1 plan's §0 noise rule and §3 labels still apply.

## Global Constraints

- All user-facing text stays Vietnamese (replies, prompt text, log lines).
- Control tools always go through confirmation; `src/mcp/policy.ts` and the orchestrator's control branch are not touched; safety-class accuracy must stay 100% (a drop reverts that round's prompt change).
- The prose-only reply paragraph (`QUAN TRỌNG khi type="reply"…`) stays the **last** paragraph of the system prompt; every `type:"tool"` few-shot example keeps the field order `type → message → tool → args`.
- The only few-shot change is WP-1's added strawberry example. No example names a disease as its answer, and the new one names no growing setting in its answer (§2.1: the 3B copied "Trong nhà kính, …" into other answers). The bean-sprout and neutral sets and `src/llm/prompt.ts` are unchanged, so the bean system prompt is byte-identical to round 2's. The routing bullet keeps its "Hỏi kiến thức trồng trọt …" clause: it does not hold `r1-container-night` alone (§2.1), and removing it would be an unmeasured change to every routing decision.
- The decision JSON contract is unchanged (field names and order, `required: ['type']`, `MESSAGE_PATTERN` on `message`). Making `reasoning` required was probed and rejected (§2.1).
- No new dependencies, services or models. Unit tests run with no external service (fakes/DI per CLAUDE.md "Testing conventions").
- Chunking (`RAG_CHUNK_SIZE=600`, `RAG_CHUNK_OVERLAP=80`, `RAG_MIN_CHUNK_LEN=60`) and retrieval defaults (hybrid on, topK 4, MMR 0.7, margin 0.15, min score 0) are frozen. §2.3 measured a min-score floor for chit-chat and rejects it.
- `data/docs/*.jsonl` and `src/domain/knowledge/*.json` are human-reviewed content: no WP edits them. Nothing edits `data/cache/` by hand.
- Eval expectations are unchanged this round (§3). No few-shot example may reuse an eval message; WP-1's example is checked against both eval sets by a test.
- Code comments: say why, never cite a ticket; no comment that restates the line below.
- Commit steps apply only if the executing workflow commits per task; never push.

## Review Focus

1. The new example must sit **immediately before** the `get_device_config` example. Placed after it, or with the config example moved earlier, `r1-container-night` stays on a tool (§2.1: Δ −0.10, −2.36, −2.65). → WP-1 Task 1.1 order test.
2. The example is a plain `type:"reply"` with no `tool`/`args`/`reasoning`, and its answer is the profile's own range (độ ẩm không khí 40-90%) with no setting phrase. The first wording ("Trong nhà kính, nên giữ …") was copied into 5 of 57 swept replies and 4 of 5 `doc-hanging-watering` samples, including an invented EC range "1.0 - 2.5 mS/cm"; the shipped wording was copied into none of 29 (§2.1). → WP-1 Task 1.1 wording test.
3. Every configuration read stays on `get_device_config` and every threshold change on `set_device_config` with the example in place (`r1-get-threshold`, `r1-get-light-cfg`, `get-moisture-rule`, `get-light-rule`, `set-light-rule`, `r1-set-lux`, `set-moisture-rule`, plus five held-out reads that mention "nhà kính", "container", "có kiểm soát" or "ban đêm"): §2.4, 12/12, margins −8.9 to −14.6 against −9.4 to −15.4 today. → WP-1 Task 1.1.
4. WP-2 must not change `AGENT_DECISION_JSON_SCHEMA`: key order, `required`, descriptions and `pattern` stay byte-identical; only the two comments on `reasoning` and the test titles move. → WP-2 Task 2.1.

---

## §0 How the evidence was produced

- **Round-2 reports.** Every case's verdicts across the six round-1 and round-2 strawberry runs and the six bean runs were tabulated; every stored reply of rounds 0–2 was re-graded with the current `gradeGrounding` and dataset, so the rounds are compared under the same checks; every reply text of the cases that moved was read. §1 counts are per run (run 1 / 2 / 3).
- **Exact assembly.** Probes rebuild the strawberry (69 chunks) and bean-sprout (30) stores with the repo's own `ingestAll`, with `RAG_EMBED_CACHE` pointed at a scratch copy, and call `retrieve()` at the round-2 defaults. The retrieved chunk ids match all 264 round-2 case records exactly. Messages are built with `buildSystemPrompt` + `getFewshot` + `assembleMessages`, and decisions use `AGENT_DECISION_JSON_SCHEMA` at decision temperature 0.1 — the eval's path. Each arm is a string transform of the few-shot set, the system prompt or the user message, or a changed schema. 16 held-out probes (knowledge questions about values to keep in greenhouses, containers and "có kiểm soát" settings; configuration reads that mention those settings) were retrieved the same way; none is an eval message.
- **Log-probability margins (new this round).** LM Studio returns per-token log-probabilities under `response_format: json_schema` (`logprobs: true, top_logprobs: 6`). The grammar emits `type` first (the only required key), so the reply-or-tool choice is the single token after `{"type":"`. Its margin **Δ = log p(reply) − log p(tool)** is read from one call per case per arm; at temperature 0.1 the sampled choice follows the sign unless |Δ| is small. Two measured limits: (a) identical requests return identical values, but the same request in another prefix-cache state (after a different preceding request) moved Δ by up to 1.3, so |Δ| < 1 is read as undecided and confirmed by sampling, and decisions rest on several cache states; (b) the values are the model's raw distribution before LM Studio's sampler penalties (in `doc-hanging-watering` the top raw first token "D", −0.57, is never sampled), so message-token values only locate forks; their rates come from samples.
- **Calls.** About 410 LLM calls: 368 margin calls (a full strawberry sweep in eval order on the current prompt with 90-token replies, one with full replies on the first WP-1 candidate, and targeted arms), 36 sampled full decisions, 6 token traces. At least 3 samples or 3 cache states per case per arm back every decision below.
- **Noise rule (round-1 §0, unchanged).** A single-run difference of ≤2 cases is noise; a case counts as fixed only if it passes in ≥2 of 3 runs.
- **Not done in round 2.** The round-2 plan's §2.8 "simulated round-2 eval" table is a placeholder: the simulation was never run, so its "r1-container-night reply 2/2" expectation was never measured with the round-2 changes combined. §2.1 shows why it could not hold.

## §1 Round-2 results and per-failure diagnosis

**Measured (round-2 reports, current code).**

| Metric | Round 1 (re-scored, round-2 §3) | Round 2 runs 1 / 2 / 3 | Median |
|---|---|---|---|
| strawberry exact (r0, /52) | 52 | 52 / 52 / 52 | 52 |
| strawberry safety | 52 | 52 / 52 / 52 | 52 |
| strawberry gated recall@4 | 0.947 | 0.947 ×3 | 0.947 |
| strawberry grounding (/14) | 9 / 9 / 9 | 10 / 10 / 11 | 10 (71%) |
| strawberry script-clean | 50 / 51 / 52 | 52 ×3 | 52 |
| r1 strawberry exact (/20) | 19 | 19 / 19 / 19 | 19 |
| r1 strawberry grounding (/15) | 11 / 12 / 11 | 12 / 12 / 12 | 12 |
| r1 strawberry recall@4 | 0.875 | 0.875 ×3 | 0.875 |
| bean exact / grounding / recall | 12/12, 6/6, 1.00 | same ×3 | same |
| bean script-clean | 11 / 10 / 9 | 12 ×3 | 12 |
| bean r1 exact / grounding | 4/4, 1/1 | same ×3 | same |

Every diagnosis case named the right disease in all three runs, including `diag-anthracnose`, which the round-2 plan expected to lose. Grounding per case under the current checks, for every case that differs across rounds (G pass, g fail; round 0 default / hybrid / plain, then runs 1 / 2 / 3):

| Case | Round 0 | Round 1 | Round 2 |
|---|---|---|---|
| diag-gray-mold, diag-powdery | g g g | g g g | **G G G** |
| diag-spider-mite | g G g | G G G | G G G |
| r1-bact-spot (r1 set) | — | g g g | **G G G** |
| doc-hanging-watering | g g g | G G G | **g g G** |
| doc-lowland-climate | G G G | G G g | G G g |
| kb-planting | g g g | g g G | g g G |
| kb-temp | g g G | g g g | g g g |
| kb-fertilizer | G g G | g g g | g g g |
| doc-nitrogen | G G g | G G G | G G G |
| r1-pet-toxicity (r1 set) | — | g G g | g g g |

**Per-failure diagnosis (round-2 runs).**

| Case (metric) | Set | Runs 1/2/3 | Class | Evidence and root cause | Action |
|---|---|---|---|---|---|
| r1-container-night (exact) | r1 | `get_device_config` ×3 | prompt — interaction of round-2 Tasks 2.1 and 2.2 | The same lead-in in all six round-1/2 runs ("Mình sẽ xem cấu hình ngưỡng tự động hiện tại của thiết bị để biết khi nào bơm và đèn tự bật."). Δ on the round-1 prompt −0.35, on round 2's −1.64 (−1.81, −1.95 in other cache states). The clause changes nothing (−1.63 without it). The diagnosis example restored before the config example gives +0.31 — the setup the round-2 plan probed 3/3 — so the clause "worked" only next to the example Task 2.2 removed. Recency is not the cause: the config example is last in round 1 too, moving it earlier makes Δ worse (−2.36, −2.65), removing it worse still (−3.16). The trigger is the question's wording: without "trong container có kiểm soát" Δ = +1.32. The held-out "Nhà kính có kiểm soát khí hậu thì độ ẩm không khí giữ bao nhiêu cho dâu?" fails the same way (`get_latest_sensor`, Δ −2.78), so the defect is a phrasing class, not one eval message. | WP-1 |
| r1-container-night (grounding, recall) | r1 | ✗ ×3, recall 0 | retrieval | TP#3, the only chunk with "27°C ban ngày, 17°C ban đêm", is fused rank 8; routed to reply, the answer guesses "15-18°C" / "18-20°C". | none — §6 item 5 |
| doc-hanging-watering (grounding) | r0 | ✗ / ✗ / ✓ | generation near-tie | Retrieved ids identical in all six runs (SGGP#0, TP#2, NNMT#2, SGGP#1). Passing replies open "Trong kỹ thuật trồng dâu tây tại Đà Lạt, … tưới 5-7 lần/ngày"; failing ones restate the question ("Đối với / Trồng dâu tây treo thủy canh tĩnh, lượng nước và chất dinh dưỡng được cung cấp 24 giờ/24 giờ") and follow TP#2's recirculating system. At the first token the raw log-probs are within 0.08 (round 1, favouring the passing opening) and 0.13 (round 2, the other way). Round 0 failed it 3/3 the same way. | none — noise (§2.2) |
| doc-lowland-climate (grounding) | r0 | ✓ / ✓ / ✗ | noise | 2/3 in round 1 too. Run 3 "ban ngày … 20-30°C … chênh lệch 10-15°C". Runs 1–2 pass on the night value alone ("ban đêm … 18-20°C") with a day value of 20-25 / 25-30°C (NNMT#0: 28°C) — a lenient check, §3. | none |
| kb-temp, kb-fertilizer, kb-planting, r1-pet-toxicity, r1-bed-height | r0 / r1 | as round 1 | owner decision / chunk content | Unchanged causes (round-2 §1). r1-pet-toxicity's one round-1 pass said "thú y". | out of scope |
| not graded: self-written sensor offers | r0+r1 | 5 / 8 / 8 of 46 replies | model | "Nếu cần, mình có thể kiểm tra cảm biến …" with no tool attached, mostly on diagnosis cases that now name the right disease. Round 1: 7 / 5 / 7. | none — noise |
| not graded: chit-chat answered with care advice | r0 | chat-hello, chat-thanks 3/3; bs-hello 3/3 | RAG context on chit-chat | Since round 0 (chat-hello in 2 of 3 round-0 runs). "Xin chào!" retrieves four chunks (top-1 cosine 0.419; the 0.15 margin keeps all four) and the reply is built from them ("Chào bạn! Dâu tây cần được chăm sóc theo luân canh …"). | none — §2.3, §6 item 6 |

Against round 1, no strawberry or bean case lost exact, safety, recall or script-clean in any run.

## §2 Probes and decisions

### §2.1 `r1-container-night`: what moves the decision

Δ = log p(reply) − log p(tool) at the type token (> 0 = reply), one call per arm unless several cache states are listed:

| Arm (strawberry set) | Δ |
|---|---|
| round-2 prompt (current) | −1.64 / −1.81 / −1.95 |
| round-1 prompt (diagnosis example, no clause, no `pattern`) | −0.35 |
| current without `pattern` | −1.64 |
| current without the routing clause | −1.63 |
| current + diagnosis example before the config example (the round-2 plan's probe setup) | +0.31 |
| same, diagnosis example without its `reasoning` field | +0.44 |
| current + diagnosis example **after** the config example | −1.57 |
| config example moved before Ví dụ 5 / to second place / removed | −2.36 / −2.65 / −3.16 |
| question without "có kiểm soát" / without "trong container có kiểm soát" | +0.26 / +1.32 |
| question ending "… nhiệt độ thích hợp là bao nhiêu" | +1.85 |

- `MESSAGE_PATTERN` cannot touch this decision: the type token precedes `message`, and the margins with and without it are identical.
- What helps is a reply example right before the config example; the diagnosis example's disease and its `reasoning` field are irrelevant. Candidates for that slot (held-out `x2-greenhouse-ctrl` = "Nhà kính có kiểm soát khí hậu thì độ ẩm không khí giữ bao nhiêu cho dâu?"):

| Change | r1-container-night Δ (cache states) | x2-greenhouse-ctrl Δ |
|---|---|---|
| none (current) | −1.64 / −1.81 / −1.95 | −2.78 |
| generic care reply ("Mùa mưa chăm dâu cần chú ý gì?"), with / without `reasoning` | −0.02 / −0.31 | — |
| config example header only: "… tool ĐỌC cấu hình đang cài trên thiết bị, không đọc cảm biến; hỏi nên giữ mức nào → reply từ kiến thức" | −0.13 / −0.80 / −0.92 | — |
| knowledge reply on EC ("Trồng dâu trong nhà màng có hệ thống tự động thì EC dung dịch nên giữ ở mức nào?"), plain header / no-tool note | +2.06 / −0.28 | −1.50 / −1.26 |
| knowledge reply on greenhouse humidity, plain header, answer "Trong nhà kính, nên giữ …" | +0.12 (sampled: tool) | +3.92 |
| same with the no-tool note in the header | +2.50 / +1.20 / +0.69 (eval order) / +1.21 / +1.27 / +1.72; sampled reply 5/5 | +3.85 |
| same placed after the config example | −0.10 | — |
| **WP-1: same question and header, answer without a setting ("Độ ẩm không khí phù hợp cho dâu là 40-90%; …")** | **+2.50 / +2.12 / +1.98 / +2.25 (eval order); sampled reply 4/4** | **+5.78** |
| WP-1 + the config-header change above | +0.65 / +0.82 / +0.57 | — |

  Header wording moves Δ by up to 2 in either direction, so the choice rests on the variant with the best minimum over cache states and samples, not on a header rule. `x2-greenhouse-ctrl` shares the example's topic and is not counted as held-out evidence for the fix; it only shows the defect exists beyond the eval message.
- **The first answer wording was copied.** With "Trong nhà kính, nên giữ độ ẩm không khí cho dâu trong khoảng 40-90%, …" as the answer, 5 of 57 swept replies took the greenhouse setting or the humidity figure where neither the question nor the context had it — `doc-hanging-watering` "Trong nhà kính, dâu tây treo thủy canh tĩnh nên được tưới 5-7 lần/ngày" (and 4 of 5 samples), `x-hydro-ec` "Đối với cây dâu tây trồng trong nhà kính, EC dung dịch dinh dưỡng cần duy trì trong khoảng 1.0 - 2.5 mS/cm" (a range no source gives), `x2-room-ctrl`, `x-room-humidity`, `chat-hello`. With WP-1's wording: 0 of 29 graded replies. WP-1 pins the wording with a test.
- **Reasoning first is worse.** With `required: ['reasoning', 'type']` the grammar emits `reasoning` first and the 3B reasons itself onto a sensor read: "… nhiệt độ thích hợp là từ 10-27°C. Tuy nhiên, để trả lời chính xác hơn, tôi sẽ kiểm tra cảm biến hiện tại" → `get_latest_sensor` (Δ −15.71; `x2-greenhouse-ctrl` −14.17); four configuration cases stayed correct. With the shipped schema every one of the 392 complete decisions captured this round begins `{"type"`, including arms whose examples put `reasoning` first, and none contains a `reasoning` key at all. WP-2 corrects the comment that claims otherwise.

### §2.2 `doc-hanging-watering`: an opening-words near-tie, not a regression

Raw log-probabilities of the first message token:

| Arm | "Tr…" | "Đ…" | Favoured |
|---|---|---|---|
| round-1 prompt | −1.70 | −1.78 | Tr by 0.08 |
| round-2 prompt | −1.83 / −1.75 | −1.70 / −1.73 | Đ by 0.13 / 0.02 |
| round-2 without `pattern` | −1.83 | −1.70 | identical — both openings are allowed text |
| round-2 without the routing clause | −1.63 | −1.81 | Tr by 0.18 |
| round-2 + diagnosis example restored | −1.52 | −1.90 | Tr by 0.38 |
| config example moved earlier / removed | −1.88 / −1.74 | −1.64 / −1.58 | Đ by 0.24 / 0.16 |
| WP-1 | −1.50 | −1.77 | Tr by 0.27 |

Sampled with the current prompt: 3/3 pass in one cache state, 1/6 in another (five "Đối với dâu tây treo thủy canh tĩnh, … 24 giờ/24 giờ"), 1/3 in the round-2 eval — 5/12. "Tr" is not safe either: WP-1's one swept reply opened "Trồng dâu tây treo thủy canh tĩnh, lượng nước và chất dinh dưỡng được cung cấp 24 giờ/24 giờ" and failed. Each round-2 change moved the tie by 0.2–0.5 (the clause and the diagnosis-example removal toward the failing opening, `pattern` not at all), as does every other arm; the verdict flips with the prompt and with the cache state. One case in two runs is noise by the round-1 §0 rule, and there is no lever specific to it: the failing answer draws on TP#2's "dinh dưỡng tưới được cung cấp 24h/24h qua hệ thống thủy canh hồi lưu", retrieved next to SGGP because both say "thủy canh". The first WP-1 candidate passed 6/6 only by copying its own opener ("Trong nhà kính, …"), which §2.1 rejects.

### §2.3 Other round-2 changes and the ungraded issues

- **Per-case scan.** Against round 1, grounding moved only on the cases in §1: three diagnosis cases fixed (as planned), `doc-hanging-watering` (§2.2), `r1-pet-toxicity` 1/3 → 0/3 (out of scope). No bean case moved in any metric.
- **Self-written sensor offers.** 7 / 5 / 7 of 46 strawberry replies in round 1, 5 / 8 / 8 in round 2. Within noise; no change.
- **Chit-chat answered with care advice.** An empty context fixes it: with `RAG_MIN_SCORE=0.45`, chat-hello, chat-thanks and bs-hello lose their context and answer as chat in 6/6 samples ("Chào bạn! Bạn cần tư vấn về chăm sóc cây dâu tây của mình hay muốn kiểm tra một số thông số hiện tại?", "Rất vui được giúp đỡ! …"); the 11 device commands whose context also empties keep their tool (Δ −6.7 to −20.4), and gated recall is unchanged on both plants (strawberry 32/35, bean 10/10). But cosine does not separate chit-chat from terse plant questions:

| Query | Top-1 cosine |
|---|---|
| chit-chat: chat-name, chat-thanks, bs-hello, chat-hello, chat-weather; "Ok", "Có", "Tạm biệt nhé", "Hôm nay mưa to quá" | 0.334, 0.379, 0.393, 0.419, 0.475; 0.397, 0.421, 0.403, 0.427 |
| terse plant questions: "Sâu", "Lá vàng", "Lá héo", "Ra hoa", "Quả chua"; bean "Ngâm", "Rễ dài" | 0.378, 0.394, 0.395, 0.421, 0.464; 0.397, 0.431 |
| lowest eval knowledge questions (kb-toxicity; bean r1-bs-sell-light) | 0.546; 0.590 |

  A floor that removes the greeting's context removes "Lá vàng"'s too. Rejected; §6 item 6 lists what could separate them.
- **A message string that never closed.** In one of 153 full-length constrained decisions (the first WP-1 candidate on `r1-thrips`) the model wrote "… luân phiên các hoạt chất để tránh kháng sinh;}" inside the string and continued "<|im_start|> userório usuário não não não …" until the 450-token cap; the same request re-sent closed normally, and none of the 264 round-2 eval decisions failed to parse. Production decision calls set no `max_tokens`, so such a decision would run to the context limit and, on `/chat/stream`, stream the garbage. Too rare to measure in this loop; §6 item 8.

### §2.4 Simulated round 3

Routing, one call per case in eval order (Δ at the type token, tool from the greedy continuation):

| Set | Current prompt | First WP-1 candidate (full sweep) | WP-1 as shipped |
|---|---|---|---|
| 72 strawberry eval cases | 71/72 (`r1-container-night` → `get_device_config`, Δ −1.95) | 72/72 | `r1-container-night` reply in 4 cache states and 4/4 samples; the 12 configuration and threshold cases 12/12 |
| configuration / threshold margins (7 eval + 5 held-out) | −9.4 to −15.4 | −8.2 to −14.3 | −8.9 to −14.6 |
| 16 held-out probes | 15/16 (`x2-greenhouse-ctrl` → `get_latest_sensor`) | 16/16 | `x2-greenhouse-ctrl` +5.78, `x-room-humidity` +5.45 |
| eval reply cases with \|Δ\| < 1 | `diag-spider-mite` +0.85 | `r1-container-night` +0.69 | none among the 41 cases re-run (`diag-spider-mite` +1.84) |

WP-1 differs from the swept candidate only in the example's answer text, so the tool cases it was not re-run on (all with Δ between −6.9 and −20) are not expected to move.

Grounding, one full reply per graded case with WP-1 as shipped, in eval order: r0 **10/14** (fails kb-temp, kb-fertilizer, kb-planting, doc-hanging-watering — the round-2 run-1/2 set); r1 **12/15** (fails r1-bed-height, r1-container-night, r1-harvest-first; r1-pet-toxicity passed). No foreign script in any reply. `r1-harvest-first` answered "2,5 tháng" (KNQG's flowering time) instead of "3 tháng" in the eval-order call with both example wordings (2/2), but 3/3 correct in isolated samples with WP-1 and 3/3 with the current prompt: a near-tie to watch in the round-3 runs (§5).

Bean: no file it reads changes; not probed.

## §3 Eval corrections

None. No label or check has chunk evidence of being wrong in a way that changes a verdict this round. One leniency is recorded: `doc-lowland-climate`'s `mustIncludeAny ['28', '18']` passes on the night value alone (round-2 runs 1–2 give a day value of 20-25 / 25-30°C against NNMT#0's 28°C). Requiring both numbers would also fail a defensible "25-30°C", so a substring check cannot grade it correctly; it stays.

---

## §4 Work packages

Ordered by user impact. WP-1 stops a class of knowledge questions ("… có kiểm soát thì … giữ … bao nhiêu?") from being answered with the device's configuration or a sensor read. WP-2 removes a comment that states the opposite of what the decoder does. File sets are disjoint and neither WP needs the other's code; both are measured together after merge (§5).

### WP-1 — A knowledge reply before the configuration example

**Files (only these):** `src/domain/fewshot.ts`, `tests/prompt.test.ts`.

**Root cause addressed:** round 2 removed the strawberry diagnosis example, the only reply example in front of the `get_device_config` example. Without a reply in that slot, a knowledge question about a value to keep in a controlled setting ("Trồng dâu thủy canh trong container có kiểm soát thì ban đêm giữ nhiệt độ bao nhiêu?") is answered with a configuration read, and the routing clause added for it has no measured effect (§2.1).

**Expected eval effect:** r1 strawberry exact 19/20 → 20/20 (`r1-container-night` reply in 4 cache states and 4/4 samples). r1 grounding stays 12/15 (`r1-container-night` cannot contain "17" without TP#3). r0 exact, safety, recall and script-clean unchanged; r0 grounding median ≥ 10/14 (§2.4). Bean: no change by construction.

#### Task 1.1: knowledge reply as strawberry Ví dụ 6

**Interfaces:**
- Produces: `STRAWBERRY` in `src/domain/fewshot.ts` with seven examples; a new Ví dụ 6 inserted after "Ví dụ 5 — hỏi kiến thức, trả lời NGẮN và DẪN NGUỒN" and before the configuration example, which becomes "Ví dụ 7". Exactly:

```text
Ví dụ 6 — hỏi kiến thức về điều kiện nên duy trì (type="reply" từ kiến thức, KHÔNG gọi tool, kể cả khi nhắc nhà kính/hệ thống):
Người dùng: "Trồng dâu trong nhà kính thì độ ẩm không khí nên duy trì khoảng nào?"
Trợ lý: {"type":"reply","message":"Độ ẩm không khí phù hợp cho dâu là 40-90%; tránh để quá ẩm kéo dài vì dễ phát sinh nấm bệnh, và thông gió khi trời nồm ẩm."}
```

  `getFewshot(loadProfile('strawberry'))` returns this set; `BEAN_SPROUT` and `neutralFewshot` are unchanged.

- [ ] **Step 1: Write the failing tests** in `tests/prompt.test.ts`, inside `describe('system prompt')`, with the import `import { BEAN_SPROUT_EVAL_CASES, EVAL_CASES } from '../src/eval/dataset'`:

```ts
const strawberryBlocks = () => getFewshot(loadProfile('strawberry')).split(/\n\n(?=Ví dụ \d)/)

it('puts a knowledge reply right before the strawberry config example', () => {
  const blocks = strawberryBlocks()
  const cfg = blocks.findIndex((b) => b.includes('"tool":"get_device_config"'))
  // Without a reply example in this slot, "… trong container có kiểm soát thì ban đêm giữ nhiệt độ
  // bao nhiêu?" is answered with a get_device_config call; placed after the config example it does not help.
  expect(cfg).toBe(blocks.length - 1)
  const before = blocks[cfg - 1] ?? ''
  expect(before).toMatch(/^Ví dụ 6 — hỏi kiến thức về điều kiện nên duy trì/)
  expect(before).toContain('{"type":"reply","message":"')
  expect(before).not.toMatch(/"tool"|"args"|"reasoning"/)
  expect(blocks[cfg]).toMatch(/^Ví dụ 7 — hỏi cấu hình tự động/)
})

it('answers the knowledge example with the profile range, no setting, and no eval message', () => {
  const block = strawberryBlocks().find((b) => b.startsWith('Ví dụ 6')) ?? ''
  const answer = /"message":"([^"]*)"/.exec(block)?.[1] ?? ''
  expect(answer).toContain('40-90%')
  // An answer opening "Trong nhà kính, …" was copied into replies about hanging hydroponics and EC.
  expect(answer).not.toMatch(/nhà kính|nhà màng|container/i)
  const asked = /Người dùng: "([^"]+)"/.exec(block)?.[1] ?? ''
  expect(asked).not.toBe('')
  expect([...EVAL_CASES, ...BEAN_SPROUT_EVAL_CASES].map((c) => c.message)).not.toContain(asked)
})
```

  and change the last assertion of `it('gives the strawberry set no diagnosis to copy', …)` from `'Ví dụ 6 — hỏi cấu hình tự động'` to `'Ví dụ 7 — hỏi cấu hình tự động'`.
- [ ] **Step 2: Run** `npx vitest run tests/prompt.test.ts` — Expected: FAIL (the two new tests and the renumbered assertion).
- [ ] **Step 3: Implement.** Insert the block from the Interfaces section between strawberry Ví dụ 5 and the configuration example, renumbering the latter to Ví dụ 7. Extend the file's top comment with two sentences: the configuration example needs a knowledge reply right before it, because without one the 3B answers "… có kiểm soát thì … giữ nhiệt độ bao nhiêu?" with a configuration read; that reply names no growing setting, because the 3B copies an example's opening into unrelated answers.
- [ ] **Step 4: Run** `npm test` — Expected: PASS (message-before-tool, `get_device_config` present in every set, the bean `đèn` test and the no-diagnosis test unchanged).
- [ ] **Step 5: Commit** — `fix(prompt): put a knowledge reply before the config example so controlled-setting questions stay replies`.

### WP-2 — The decision schema says what the decoder does

**Files (only these):** `src/agent/decision.ts`, `tests/decision.test.ts`.

**Root cause addressed:** the comment on `reasoning` says it is listed first "so schema-ordered backends (LM Studio/llama.cpp) generate a few reasoning tokens before committing to type/message — a lightweight CoT", and a test is named after that claim. LM Studio's grammar emits the required key first, so every captured decision starts `{"type"` (§2.1), and requiring `reasoning` — the only way to put it first — routed `r1-container-night` and a held-out trap to `get_latest_sensor`. A reader who trusts the comment either relies on reasoning that never happens or "fixes" it by requiring `reasoning`.

**Expected eval effect:** none (`JSON.stringify(AGENT_DECISION_JSON_SCHEMA)` is unchanged).

#### Task 2.1: correct the comment and the test title

**Interfaces:**
- Produces: `AGENT_DECISION_JSON_SCHEMA` byte-identical; the two-line comment above its `reasoning` property replaced; in `tests/decision.test.ts`, the tests `'lists reasoning FIRST so schema-ordered backends emit CoT before deciding'` and `'still only requires type (reasoning stays optional)'` replaced by the single test below.

- [ ] **Step 1: Write the test** in `tests/decision.test.ts`, as the first test of `describe('AGENT_DECISION_JSON_SCHEMA')`, replacing the two tests named above:

```ts
it('keeps the field order and type as the only required key', () => {
  const props = AGENT_DECISION_JSON_SCHEMA.properties as Record<string, unknown>
  expect(Object.keys(props)).toEqual(['reasoning', 'type', 'message', 'tool', 'args'])
  // Requiring reasoning is what would make the grammar emit it before type; that routed knowledge
  // questions to sensor reads, so type stays the only required key and is decided first.
  expect(AGENT_DECISION_JSON_SCHEMA.required as string[]).toEqual(['type'])
})
```

  It passes before and after: the task changes no behaviour, and a comment cannot have a failing test. It pins the contract the new comment describes.
- [ ] **Step 2: Run** `npx vitest run tests/decision.test.ts` — Expected: PASS.
- [ ] **Step 3: Implement.** Replace the comment above `reasoning:` in `AGENT_DECISION_JSON_SCHEMA` with one that says why it is the way it is: LM Studio's grammar emits required keys before optional ones, so `type` is decided first and `reasoning`, when the model writes it at all, comes after; it stays optional because requiring it (which would put it first) made the 3B reason knowledge questions onto sensor reads. The Zod schema's doc comment on `reasoning` ("Optional short chain-of-thought emitted BEFORE the decision; never shown to the user.") makes the same claim: change it to say the field is an optional note the model may add after `type`, never shown to the user. Leave the `MESSAGE_PATTERN` comment as is.
- [ ] **Step 4: Run** `npm test` and `npm run typecheck` — Expected: PASS.
- [ ] **Step 5: Commit** — `docs(agent): say that the grammar decides type before reasoning`.

## §5 Round-3 targets, measurement and stop criterion

**Measurement protocol (after both WPs merge):**

1. `npm test` and `npm run typecheck` green.
2. `EVAL_LABEL=r3-strawberry-1 npm run eval` (then `-2`, `-3`). The bean-sprout system prompt is byte-identical to round 2's, so one smoke run suffices: `DEFAULT_PLANT=bean-sprout EVAL_LABEL=r3-bean-sprout-1 npm run eval`; run `-2`/`-3` only if it differs from round 2 in any metric.
3. Report each metric as the median of the three runs on `summary` (the r0 set) against the round-2 row of §1, and `summaryR1` separately. A case counts as fixed only if it passes in ≥2 of 3 runs; a move under 3 cases is noise. Name `r1-harvest-first` and `doc-hanging-watering` explicitly in the report (§2.2, §2.4).

**Round-3 targets** (median of 3 runs):

| Metric | Round 2 | Round-3 target | Basis |
|---|---|---|---|
| strawberry exact / safety (/52) | 52 / 52 | 52 / 52 (safety: hard requirement) | §2.4 |
| strawberry gated recall@4 | 0.947 | 0.947 | no retrieval change |
| strawberry grounding (/14) | 10 (71%) | ≥ 10 | §2.4; doc-hanging-watering not counted (§2.2) |
| strawberry script-clean | 52 | 52 in every run | unchanged schema |
| r1 strawberry exact (/20) | 19 | **20** | §2.1, §2.4 |
| r1 strawberry grounding (/15) | 12 | ≥ 11 | container-night stays ✗; r1-harvest-first may flip (§2.4) |
| r1 strawberry recall@4 | 0.875 | 0.875 | — |
| bean exact / grounding / recall / script-clean | 12/12, 6/6, 1.00, 12/12 | unchanged | byte-identical prompt |

If `r1-container-night` is a reply in fewer than 2 of 3 runs, or `r1-harvest-first` fails in ≥2 of 3 runs while `r1-container-night` is fixed, report it as a WP-1 trade and leave the decision to the owner rather than tuning further.

**Stop criterion** (unchanged: strawberry exact ≥ 95%, grounding ≥ 90%, gated recall@4 ≥ 0.9, bean exact ≥ 90%, bean grounding ≥ 85% — or a round that improves no metric by more than 3 points). After round 3 every condition holds except strawberry grounding. Its failures: kb-fertilizer and kb-planting (citations — owner), kb-temp (range policy — owner), doc-hanging-watering and doc-lowland-climate (opening-words near-ties that any prompt edit and the cache state move, §2.2; no lever specific to either). The reachable ceiling inside the constraints is 11/14 (79%); 90% is not reachable by engineering in this loop.

**Call: stop the loop after round 3.** Round 3 is worth running: WP-1 fixes a user-visible defect — knowledge questions phrased around a controlled setting answered with the device's thresholds or a sensor read, which the probes show is a phrasing class (`x2-greenhouse-ctrl` fails the same way), not one eval message — and WP-2 removes a false comment that invites a harmful "fix". But its only measurable eval gain is one r1 case, under the 3-case noise threshold, and no remaining failure has a prompt-level lever inside the constraints: §2.1–§2.2 show that the remaining borderline decisions sit within one log-probability unit of flipping, so further prompt edits trade one near-tie for another (the first WP-1 candidate "fixed" `doc-hanging-watering` only by planting its own opener in other answers). Re-open only on an owner decision (§6 items 1–4), for retrieval-content work (item 5), or after item 7 makes near-ties visible in the eval itself. Independently of the criterion, any drop of safety below 100% reverts WP-1.

## §6 After merge, and what remains

**Integration (one person, after both WPs merge):**
- `CLAUDE.md`, "Small-model prompt constraints": replace the bullet "**The routing bullet keeps its "Hỏi kiến thức trồng trọt … → reply" clause.** …" with: the strawberry set keeps a knowledge reply (Ví dụ 6) immediately before the `get_device_config` example — without a reply in that slot "Trồng dâu thủy canh trong container có kiểm soát thì ban đêm giữ nhiệt độ bao nhiêu?" goes to `get_device_config`, and moving the config example earlier or dropping it makes that worse, because the question itself reads like a device question; that reply names no growing setting, because the 3B copied an opening "Trong nhà kính, …" into unrelated answers; the routing bullet's "Hỏi kiến thức trồng trọt" clause stays but does not hold this case alone. In the "No few-shot example may give a specific disease" bullet, add that removing an example must keep a reply example in front of the config example.
- `CLAUDE.md`, same section: add one bullet — structured output decides `type` first: LM Studio's grammar emits the only required key before the optional ones, so `reasoning` never precedes the decision, and requiring it first made the 3B reason knowledge questions onto sensor reads.
- `docs/superpowers/plans/2026-11-16-rag-eval-round-2.md` §2.8: replace the `(SIMULATED-EVAL-TABLE)` placeholder with one line saying the simulation was not run and pointing to this plan's §2.1.

**What remains (for the owner, not for another prompt round):**
1. **Citations** (kb-fertilizer, kb-planting): the product decision from round-1 §6 (a deterministic "Nguồn tham khảo" from the chunks shown, a structured `source` field, or dropping `requireCitation`).
2. **kb-temp**: the 3B answers a controlled-environment study's "15 - 26°C" over the profile's 10–27°C; round-2 §2.5 tried six placements. Options unchanged: accept a narrower document range inside the profile range (an expectation change), state the profile range deterministically for general range questions, or a larger model.
3. **Pet toxicity**: `r1-pet-toxicity` 0/3 in round 2; the content-reviewer options of round-2 §6 item 4 stand.
4. **Diagnosis quality**: the 3B now names the retrieved disease in every run; a deterministic render of the top `[bệnh]` entry would remove the remaining guesswork.
5. **Retrieval content**: TP#3 never names its topic (`doc-container-temp`, and the "17°C" `r1-container-night` needs) and `care_notes#0` mixes four topics (`r1-bed-height`); section-aware chunking or contextual headers, with re-labelling.
6. **Chit-chat answered with care advice** (chat-hello, chat-thanks, bs-hello 3/3 since round 0–1): an empty context fixes it (6/6), but no cosine floor separates "Xin chào!" (0.419) from "Lá vàng" (0.394) or "Sâu" (0.378) (§2.3). A gate needs another signal — e.g. no BM25 term match together with a low top-1, or a small chit-chat intent check before retrieval — and its own probes.
7. **Measuring routing without three runs**: the type-token margin of §0 shows near-ties the pass/fail count hides (`diag-spider-mite` +0.85, `x-room-humidity` +0.72 on the current prompt). Recording it in the eval report needs `logprobs` on `LlmEngine.completeJson`; it is the tool to have before any further prompt work.
8. **Decision length cap**: one probe decision never closed its `message` string and ran to the token cap (§2.3); production decision calls set no `max_tokens`. A cap a little above the longest observed decision (replies reach ~720 characters) would bound that failure; it needs a test that a capped, unparseable decision falls back cleanly in both chat paths.
9. **Free-text paths** (round-2 §6 item 6): the repair regeneration, the sensor-read summary and the step-exhausted answer are not under `MESSAGE_PATTERN`.
