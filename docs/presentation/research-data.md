# Data layer — tư liệu slide-ready ("Tôi train data cho LLM local như thế nào")

---

## SLIDE 0 — Kết luận bắt buộc: CÓ fine-tune hay KHÔNG?

**KHÔNG.** Repo `ai-server` không có bất kỳ fine-tuning/LoRA/QLoRA nào. Đã verify bằng:

- Grep toàn repo (`.ts/.js/.md/.json/.py/.yml`) cho `fine-?tune|finetun|lora|unsloth|axolotl|gguf|adapter|peft|qlora|sft|rlhf|weights\.bin|checkpoint`: **chỉ khớp `adapter.ts`** — đây là file *response adapter* của OpenAI-compat HTTP layer (`src/http/openai/adapter.ts`, dịch request/response JSON), **không liên quan** model weights.
- `git log --all --grep="train|lora|finetune|adapter|gguf"`: chỉ ra 1 commit — `af32084 docs: document /chat/stream SSE contract and 3B prompt constraints` (nói về *prompt* constraints, không phải training).
- Không có script train, không có checkpoint dir, không có `requirements.txt`/`transformers`/`peft` Python train stack.
- README + CLAUDE.md tự mô tả kiến trúc là: LLM local (LM Studio/Ollama/Gemini-compat) qua OpenAI SDK, **không đề cập train weights**.

**Vậy "train" ở đây thực chất là gì?** 4 lớp kỹ thuật thay thế cho fine-tuning:
1. **Prompt engineering** có kỷ luật (system prompt tối ưu riêng cho model 3B, xem Slide 2).
2. **Few-shot examples** trong prompt (in-context "training data" — Slide 3).
3. **RAG** (domain knowledge tách khỏi trọng số model — Slide 1).
4. **Eval-driven iteration**: đo tool-selection accuracy + grounding, sửa prompt/few-shot theo số đo thật, lặp lại (Slide 4 + 5).

**Speaker notes:** Đây là câu mở đầu quan trọng nhất của phần trình bày — nói thẳng để không ai hiểu lầm là có fine-tune. Điểm nhấn: với model nhỏ (3-4B) chạy local, 4 lớp trên **rẻ hơn và lặp nhanh hơn** train, và mọi thay đổi đều versioned trong git (xem code, không phải blackbox weights).

---

## SLIDE 1 — Nguồn dữ liệu RAG: 3 đường vào, một cổng người duyệt

- **3 nguồn** hợp nhất vào một `InMemoryVectorStore` (`src/rag/buildStore.ts:24-69`, hàm `ingestAll`):
  1. **Profile** `src/domain/knowledge/strawberry.json` → `ingestProfile` (`src/rag/ingest.ts:68-92`) — 11 text field (`watering`, `fertilizer`, `pests`, `diseases`, `growth_stages`, `planting`, `harvest`, `propagation`, `care_notes`, `light_description`, `toxicity`) + `varieties`.
  2. **Disease KB** `src/domain/knowledge/strawberry-diseases.json` → `ingestDiseases` (`src/rag/ingestDiseases.ts:33-54`) — **10 bệnh/sâu hại** (đếm thực tế trong file), mỗi bệnh có `symptoms[]`, `favorable_conditions`, `treatment`, `prevention`, `severity`.
  3. **Reviewed docs** `data/docs/*.jsonl` → `ingestDocs` + `readReviewedDocs` (`src/rag/ingestDocs.ts:36-113`).
- **Sự thật cần nói thẳng khi present**: hiện tại `data/docs/` **KHÔNG tồn tại** trong repo (không có commit nào từng thêm file vào đó — verify bằng `git log --all --diff-filter=A --name-only | grep data/`), và `src/rag/buildStore.test.ts:39` assert thẳng `expect(res.counts.docs).toBe(0) // empty docs dir`. Nghĩa là **pipeline "reviewed docs" đã code xong nhưng đang có 0 record thật** — chỉ profile + disease KB (dữ liệu mồi) đang chạy trong production.
- **Vì sao có human-review gate**: `npm run scrape` → ghi thô vào `data/staging/*.raw.jsonl` (gitignored, không đụng vector store) → người đọc/cắt rác → copy sang `data/docs/*.jsonl` → `ingestDocs` mới nạp. Allowlist host cứng ở `src/rag/scrape/sources.ts` (10 URL nguồn chính thống .gov.vn/.edu.vn/tạp chí khoa học VN, host lạ bị chặn cứng ở tầng scraper).

| Nguồn | File | Ghi vào store lúc nào | Số lượng hiện tại |
|---|---|---|---|
| Profile | `src/domain/knowledge/strawberry.json` | Luôn (init + rebuild) | 11 field text + varieties |
| Disease KB | `src/domain/knowledge/strawberry-diseases.json` | Luôn (fail-safe: lỗi thì skip, không crash) | 10 bệnh/sâu hại |
| Reviewed docs | `data/docs/*.jsonl` | Chỉ nếu người đã duyệt & copy vào | **0 (chưa có, thư mục không tồn tại)** |

**Speaker notes:** Nhấn mạnh "cổng người duyệt" là chủ đích, không phải thiếu sót: README ghi rõ "Databank — cào tài liệu vào RAG ... có cổng review của con người, không nạp thẳng dữ liệu web vào bot". Đồng thời trung thực rằng cổng đó *hiện đang trống* — đây là điểm khác giữa "kiến trúc đã sẵn sàng" và "dữ liệu đã sẵn sàng".

---

## SLIDE 2 — Pipeline xử lý: chunk → embed → cache → dedupe → store

- **Chunking** (`src/rag/textChunk.ts:37-59`, `chunkDocument`): word-boundary, `size=600` ký tự, `overlap=80` ký tự (default; cấu hình qua `RAG_CHUNK_SIZE`/`RAG_CHUNK_OVERLAP` trong `src/config.ts:53-54`). `dropShortChunks` loại chunk < `minChunkLen=60` ký tự (boilerplate/mảnh vụn).
- **Embedding**: model **`bge-m3`** (`.env.example` → `EMBED_MODEL=text-embedding-bge-m3`), phục vụ qua LM Studio/Ollama (OpenAI-compat `embed` endpoint). Chọn `bge-m3` vì **cross-lingual** (hỏi tiếng Việt, tài liệu tiếng Anh vẫn retrieve được — README).
- **Cache trên đĩa** (`src/rag/embedCache.ts`): key = FNV-1a hash của `(embedModel + text)` — **namespace theo model** (commit `73b71cc fix(rag): namespace embed-cache by model to stop stale/wrong-dim reuse`) để đổi embed model không tái dùng nhầm vector sai chiều. File JSONL tại `data/cache/embeddings.jsonl` (gitignored, sinh lại được).
- **Dedupe near-duplicate** (`src/rag/dedupe.ts:9-19`, `dedupeByEmbedding`): ngưỡng cosine mặc định **0.95** — item nào giống > 0.95 với item đã giữ thì bị loại (giữ item xuất hiện trước). Chỉ áp dụng cho `ingestDocs` (scraped docs hay trùng lặp nội dung giữa các site copy nhau); **disease KB không dedupe** (dữ liệu curated tay).
- **Store**: brute-force cosine in-memory (`src/rag/store.ts:31-69`, `InMemoryVectorStore`) — **không dùng vector DB** (Pinecone/pgvector/OpenSearch...). Lý do ghi thẳng trong code comment: "Fine for the curated per-plant KB (a few hundred chunks) and has zero native dependencies." Giới hạn: O(n) mỗi query, không scale ngoài vài trăm-nghìn chunk, không persist giữa restart (rebuild từ cache mỗi lần init).

```ts
// src/rag/dedupe.ts:9-19
export function dedupeByEmbedding<T extends { embedding: number[] }>(
  items: T[],
  threshold = 0.95,
): T[] {
  const kept: T[] = []
  for (const item of items) {
    const isDup = kept.some((k) => cosineSimilarity(item.embedding, k.embedding) > threshold)
    if (!isDup) kept.push(item)
  }
  return kept
}
```

**Speaker notes:** Nhấn "zero native deps" là quyết định kiến trúc có chủ đích cho quy mô hiện tại (vài trăm chunk), không phải thiếu hiểu biết — có tài liệu riêng (`docs/rag-course-review.md`) tự nhận diện đây là chỗ sẽ cần nâng cấp (BM25 hybrid, rerank) nếu scale lên. `RAG_MIN_SCORE` (lọc điểm cosine yếu) đang **default = 0 (tắt)** — comment trong `config.ts:46-49` ghi rõ nên bật ~0.3-0.4 sau khi đo eval.

---

## SLIDE 3 — Profile-driven thresholds: domain data thắng default của tool

- Schema profile (`src/domain/profiles.ts:12-43`, Zod): tách rõ **numeric ranges** (điều khiển ngưỡng) vs **text fields** (RAG).
- `deriveControlThresholds` (`src/domain/profiles.ts:69-74`): lấy **cận dưới** của `soil_moisture_range`/`light_range` làm ngưỡng bật bơm/đèn.
- **Ví dụ số liệu thật** (`src/domain/knowledge/strawberry.json:5`): `"soil_moisture_range": [75.0, 80.0]` → ngưỡng tưới = **75%**. MCP mặc định (theo README + comment code) là **30%** — chênh lệch 2.5 lần. Đây là ví dụ "domain data thắng default của tool" dễ trình bày nhất.
- `summarizeRanges` (`src/domain/profiles.ts:77-90`) render thành câu tiếng Việt chèn thẳng vào system prompt (VD: "độ ẩm đất 75-80%; nhiệt độ 10-27°C; ánh sáng 200-800 lux; pH đất 5.5-6.5").
- **Prompt rule khi conflict**: nếu tài liệu RAG mâu thuẫn với range số, **range số thắng** (ghi trong CLAUDE.md, test-guarded gián tiếp qua eval case `kb-moisture` — grounding `forbid: ['30%']`, `mustIncludeAny: ['75','80']`, `src/eval/dataset.ts:38`).

| Field | Nguồn | Vai trò |
|---|---|---|
| `soil_moisture_range: [75, 80]` | `strawberry.json:5` | → ngưỡng tưới 75% (thắng default MCP 30%) |
| `temperature_range: [10, 27]` | `strawberry.json:3` | Chèn prompt, không điều khiển trực tiếp (chưa có tool set nhiệt độ) |
| `light_range: [200, 800]` | `strawberry.json:6` | → ngưỡng bật đèn (cận dưới 200 lux) |
| `soil_ph_range: [5.5, 6.5]` | `strawberry.json:9` | Chèn prompt (tư vấn), test `kb-ph` |
| `ec_range: [0.8, 2.2]` | `strawberry.json:14` | Chèn prompt (chưa có tool điều khiển EC) |

**Speaker notes:** Đây là slide "aha moment" — model nhỏ tự nó không biết dâu tây cần ẩm 75-80%, nó chỉ biết default 30% do tool cung cấp; domain profile ghi đè bằng cách chèn số liệu **explicit vào prompt** mỗi lần gọi, không phải train vào weight.

---

## SLIDE 4 — Few-shot examples: "training data" ở dạng in-context (BẢNG ĐẦY ĐỦ)

`src/domain/fewshot.ts` — 6 ví dụ, tổng cộng nạp vào **mỗi lần gọi LLM** (không phải train một lần). Comment đầu file (`fewshot.ts:1-11`) giải thích rõ ràng buộc riêng cho model 3B: field `message` PHẢI đứng trước `tool`/`args` vì model "đóng JSON ngay sau `args`" — đặt sau thì gần như không bao giờ xuất hiện (~11/12 lead-in xuất hiện khi message-first, ~0/12 khi message-last).

| # | User input | Decision output (rút gọn) | Dạy điều gì |
|---|---|---|---|
| 1 | "Cây dâu của mình bị vàng lá, mình nên làm gì?" | `type:"reply"` — tư vấn từ kiến thức + kèm gọi `get_latest_sensor` như đề xuất (hệ thống tự hỏi xác nhận) | Triệu chứng/tư vấn → trả lời NGAY từ RAG, không tự eager-fetch sensor |
| 2 | "Độ ẩm đất của cây thế nào?" | `type:"tool"`, `get_latest_sensor` | Hỏi TRỰC TIẾP số liệu → đọc cảm biến ngay, không giả vờ đã có số |
| 3 | "Bật đèn cho cây." (2 lượt) | `type:"tool"`, `list_devices` → (kết quả) → `type:"tool"`, `set_light` | Chưa biết `device_id` → resolve bằng tool đọc trước, rồi mới control |
| 4 | "Tưới nước 10 giây đi." | `type:"tool"`, `set_pump`, message nêu mục đích ("nâng ẩm đất về ~75-80%") — KHÔNG nói đã xong | Control tool luôn chờ xác nhận, message không được bịa là đã thực thi |
| 5 | "Tưới nước cho dâu thế nào là đúng?" | `type:"reply"` ngắn, dẫn nguồn ("theo Khuyến nông Lâm Đồng") | Trả lời kiến thức: NGẮN + có citation |
| 6 | "Thân và cuống dâu có đốm đen, vài quả lõm nâu, cây bị bệnh gì?" | `{"reasoning":..., "type":"reply", "message":...}` — chẩn đoán thán thư + xử lý + phòng ngừa + nguồn | Chẩn đoán bệnh: nghĩ ngắn (CoT field `reasoning`, không lộ ra ngoài) rồi trả lời có nguồn |

**Speaker notes:** Đây chính là "training set" thật sự của model nhỏ trong project này — không update trọng số, mà là 6 ví dụ cố định luôn nằm trong context. Mỗi ví dụ sinh ra từ một bug quan sát được khi chạy model thật (xem timeline Slide 6): ví dụ 1 sinh ra để sửa lỗi model tự động fetch sensor khi user chỉ hỏi triệu chứng (commit `7ecf415`); field order của ví dụ 2-4 sinh ra để sửa lỗi tool message rỗng (commit `3722dd2`).

---

## SLIDE 5 — Eval harness: đo tool-selection accuracy + grounding

- **Dataset**: `src/eval/dataset.ts` — **45 case** hiện tại (test chỉ khoá cứng "≥32", nhưng đếm thực tế trong file = 45), tiếng Việt, theo domain dâu tây.
- **Cách chấm** (`src/eval/run.ts:48-57`, hàm `grade`): 2 chỉ số —
  - **Exact accuracy**: đúng cả `type` (`reply`/`tool`) VÀ đúng tên tool cụ thể nếu là `tool`.
  - **Safety-class accuracy**: tool được chọn có đúng phân loại an toàn (`read`/`control`, qua `classifyTool`) hay không — tách riêng vì chọn sai tool cụ thể (VD `get_device_info` thay vì `get_latest_sensor`) vẫn có thể "an toàn" (cùng là đọc), khác hẳn chọn nhầm sang `control`.
  - **Grounding** (`src/eval/grounding.ts`): heuristic xác định (không LLM-judge) — `requireCitation` (có tên nguồn KB không), `mustIncludeAny`/`mustInclude` (số liệu bắt buộc xuất hiện), `forbid` (số liệu SAI không được xuất hiện, VD cấm "30%" khi hỏi ẩm đất tối ưu).
- **Chạy thật**: `npm run eval` → chạy CÓ RAG context thật (giống production), build store thật từ profile+docs+disease, gọi LLM thật qua `completeJson`, in PASS/FAIL từng case + 3 dòng % cuối. **Cần LM Studio đang chạy** — không chạy được offline/CI.
- **KHÔNG có số liệu accuracy lưu trong repo** — đã grep toàn bộ `*.md` cho pattern "accuracy/%": chỉ thấy *mô tả cách chạy*, không thấy con số kết quả nào được commit lại. `npm test` (Vitest, CI) chỉ kiểm tra **cấu trúc dataset** (đủ case, đủ coverage tool, an toàn nhãn đúng) — KHÔNG chạy LLM thật, không đo accuracy.
- **Khuyến nghị khi present**: chạy `npm run eval` trước buổi present để có số % thật (script tự in `Tool/reply exact accuracy: X/45 (Y%)`, `Safety-class accuracy: ...`, `Grounding accuracy: ...`).

### Bảng phân bố eval case theo tool (45 case)

| Loại | Tool | Số case | An toàn |
|---|---|---|---|
| Tool | `get_latest_sensor` | 2 | read |
| Tool | `list_devices` | 2 | read |
| Tool | `get_sensor_history` | 2 | read |
| Tool | `get_recent_commands` | 2 | read |
| Tool | `get_device_info` | 1 | read |
| Tool | `get_device_config` | 2 | read |
| Tool | `set_pump` | 2 | control |
| Tool | `set_light` | 2 | control |
| Tool | `set_mode` | 2 | control |
| Tool | `set_device_config` | 2 | control |
| Tool | `show_message` | 1 | control |
| Tool | `refresh_device_config` | 1 | control |
| **Tool subtotal** | (12 tool MCP, mọi tool có ≥1 case — guard bởi `tests/eval-dataset.test.ts`) | **21** | 11 read / 10 control |
| Reply | kiến thức chung (nhiệt độ/sâu bệnh/ẩm/bón phân/thu hoạch/nhân giống/pH...) | 8 | — |
| Reply | chit-chat/trap (chào hỏi, cảm ơn, hỏi tên, thời tiết) | 4 | — |
| Reply | triệu chứng (vàng lá, héo rũ, đốm lá) | 3 | — |
| Reply | chẩn đoán bệnh cụ thể (disease KB) | 4 | — |
| Reply | công dụng (uses) | 2 | — |
| **Reply subtotal** | | **24** | — |
| **TỔNG** | | **45** | |

**Speaker notes:** Nói rõ: KHÔNG có con số accuracy "chốt" nào nằm sẵn trong repo — vì eval cần LLM sống nên không chạy trong CI. Nếu present mà không chạy trước, chỉ nên nói về **cấu trúc/độ phủ** của bộ eval, không bịa % pass.

---

## SLIDE 6 — Timeline "trước → sau": prompt/few-shot sửa vì model nhỏ làm sai

Mọi dòng dưới đây neo vào commit hash + message thật (`git log`), không suy diễn:

| Ngày | Commit | Vấn đề quan sát được ở model nhỏ | Sửa gì |
|---|---|---|---|
| 2026-07-01 | `7ecf415` fix: advise first on plant-symptom questions instead of eager sensor fetch | qwen2.5-3b chọn `get_latest_sensor` cho câu hỏi chăm sóc/triệu chứng ("cây dâu bị vàng lá") → đọc lỗi → xin lỗi "không truy cập được cảm biến" thay vì tư vấn | Thêm rule phân biệt câu hỏi tư vấn (RAG trực tiếp) vs câu hỏi số liệu hiện tại (dùng tool); thêm ví dụ few-shot #1 (vàng lá → reply); thêm eval case A5 |
| 2026-07-04 | `f2f405b` feat(agent): lightweight CoT, citation few-shot, configurable temperature | Cần model "nghĩ" trước khi quyết định mà không lộ chuỗi suy luận ra user | Thêm field `reasoning` optional đứng ĐẦU JSON schema (schema-ordered backend nghĩ trước khi quyết định), không surface ra ngoài; thêm ví dụ có citation + chẩn đoán |
| 2026-07-04 | `73b71cc` fix(rag): namespace embed-cache by model to stop stale/wrong-dim reuse | Đổi embed model → cache cũ (chiều vector khác) bị tái dùng sai, retrieval âm thầm hỏng | Cache key namespaced theo tên embed model |
| 2026-07-04 | `4bdf65c` feat(eval): measure answer grounding with RAG context | Chưa có cách đo model có "bịa" hay bám sát tài liệu không | Thêm grader heuristic (`hasCitation`, `mustInclude`, `forbid`) + chạy eval CÓ RAG context thật |
| 2026-07-04 | `6a5116f` feat(rag): expand disease KB (5->10) and sub-chunk profile fields | Field profile dài (VD `care_notes`) chiếm hết 1 chunk, một field to lấn hết top-K slot | Sub-chunk field dài bằng chunker chung; disease KB tăng gấp đôi (5→10 bệnh) |
| 2026-07-05 | `3722dd2` fix(prompt): stop 3B truncating replies and emitting empty tool messages | (a) Model nhét cả câu trả lời vào `message` JSON, khi muốn viết list thì viết "đây là danh sách:" rồi ĐÓNG JSON luôn — list không bao giờ xuất hiện (`finish_reason=stop`, không phải cắt do max_tokens). (b) Model đóng JSON ngay sau `args` → `message` đặt sau `args` gần như không bao giờ được viết (~0/12) | (a) Bắt buộc văn xuôi liền mạch, cấm list/dấu hai chấm cuối câu, đặt rule này Ở CUỐI prompt (sau few-shot — vị trí giữa prompt bị model bỏ qua do recency). Kết quả đo được: **0/18 truncation** sau fix. (b) Đổi field order few-shot thành `message` TRƯỚC `tool`/`args` trong toàn bộ ví dụ loại `type="tool"`. Kết quả đo được: **12/12** tool decision giờ có message |
| 2026-07-05 | `af32084` docs: document /chat/stream SSE contract and 3B prompt constraints | — | Ghi lại 2 rule "âm thầm dễ regress" ở trên vào CLAUDE.md, trỏ tới `tests/prompt.test.ts` làm guard |
| 2026-07-13 | `ea35f1c` fix(agent): run directly-requested sensor reads inline instead of confirming | Model/luồng cũ bắt cả câu hỏi số liệu trực tiếp phải chờ xác nhận "(Có/Không)" rồi mới đọc, qua một lượt LLM tóm tắt riêng dễ lạc đề | Đọc cảm biến khi user hỏi trực tiếp = chạy NGAY (đó chính là sự đồng ý), bỏ nhãn gây hiểu lầm `[ĐỌC · hỏi trước]` |

**Test nào sẽ FAIL nếu bỏ từng lớp** (bằng chứng cho bảng trước/sau ở Slide 7):
- Bỏ rule văn xuôi cuối prompt → `tests/prompt.test.ts:15-19` fail (`forces a prose reply and forbids the dangling colon`).
- Đảo lại vị trí rule (đặt giữa prompt) → `tests/prompt.test.ts:21-24` fail (test đo vị trí index trong string).
- Đảo field order few-shot (`tool` trước `message`) → `tests/prompt.test.ts:40-48` fail.
- Xóa/giảm eval dataset dưới 32 case, hoặc thiếu coverage 1 tool MCP nào → `tests/eval-dataset.test.ts` fail (5 assertion khác nhau).
- Gắn `grounding` vào case không phải `reply` → `tests/eval-dataset.test.ts` (`only attaches grounding expectations to reply cases`) fail.

---

## SLIDE 7 — Bảng "trước vs sau": model raw vs 4 lớp augmentation

| | **Trước** (model local raw) | **Sau** (4 lớp: prompt + few-shot + RAG + eval) |
|---|---|---|
| Ngưỡng tưới cây | Dùng default MCP 30% (chung chung, không phân biệt loại cây) | 75-80% từ `strawberry.json` → `deriveControlThresholds` (`src/domain/profiles.ts:69-74`) |
| Câu hỏi triệu chứng ("vàng lá") | Model tự ý gọi `get_latest_sensor`, đọc lỗi → xin lỗi thay vì tư vấn (bug thật, commit `7ecf415`) | Trả lời trực tiếp từ RAG + gợi ý kiểm tra cảm biến (few-shot #1) |
| Câu trả lời dạng danh sách | Cụt giữa chừng — model viết "đây là danh sách:" rồi đóng JSON, không có nội dung list (bug thật, đo được trước fix) | Buộc văn xuôi liền mạch, cấm dấu `:` cuối câu → 0/18 truncation (commit `3722dd2`) |
| Message đi kèm quyết định `tool` | Gần như luôn rỗng (~0/12) vì model đóng JSON ngay sau `args` | Đổi field order `message` trước `tool`/`args` → 12/12 có message (commit `3722dd2`) |
| Trả lời kiến thức có trích nguồn không | Không cơ chế nào bắt buộc — model có thể bịa số liệu | `hasCitation` + `mustIncludeAny`/`forbid` trong eval grounding (`src/eval/grounding.ts`), few-shot #5/#6 làm mẫu trích nguồn |
| Đo lường chất lượng | Không có — chỉ "cảm giác" model trả lời tốt/xấu | `npm run eval`: 45 case, 3 chỉ số (exact / safety-class / grounding), chạy CÓ RAG context thật |
| An toàn hành động điều khiển | Không có gì chặn model tự "thực thi" qua lời nói | `pendingAction` + xác nhận bắt buộc cho mọi `control` tool, fail-safe cho tool lạ (`src/mcp/policy.ts:37-42`) |
| Domain knowledge cross-lingual | Không có, hoặc phải hỏi đúng tiếng nguồn tài liệu | `bge-m3` embedding cho phép hỏi tiếng Việt tìm được tài liệu (hiện tại: profile + disease KB tiếng Việt; docs tiếng Anh — chưa có case nào) |

**Speaker notes:** Mỗi dòng "Sau" đều trỏ vào code/test/commit cụ thể ở các slide trước — không có dòng nào là suy đoán. Dòng "câu trả lời dạng danh sách" và "message đi kèm tool" là 2 ví dụ **đo được bằng số thật** (0/18, 12/12) ghi ngay trong commit message `3722dd2`, không phải ước lượng.

---

## Phụ lục — chi tiết kỹ thuật khác có thể cần khi Q&A

- **Model hiện tại**: chat = `google/gemma-4-e4b` (default, `.env.example` + commit `b759a92 switch default LLM model to gemma-4-e4b`); embedding = `text-embedding-bge-m3`. Lưu ý: comment trong `fewshot.ts`/test/commit message vẫn nhắc "qwen2.5-3b" — đó là model dùng để **phát hiện và fix** các bug prompt ở Slide 6 (lịch sử), model default hiện tại trong `.env.example` đã đổi sang gemma-4-e4b; ràng buộc prompt vẫn giữ nguyên vì cùng là model nhỏ.
- **MCP tool catalog hiện tại**: 12 tool (`src/mcp/knownTools.ts`) — 6 read (`list_devices`, `get_device_info`, `get_latest_sensor`, `get_sensor_history`, `get_recent_commands`, `get_device_config`), 6 control (`set_pump`, `set_light`, `set_mode`, `show_message`, `set_device_config`, `refresh_device_config`).
- **Gap analysis đã tự nhận diện** (`docs/rag-course-review.md`, `docs/rag-course-todo.md` — đối chiếu với 1 khóa học RAG production): chưa có BM25/hybrid retrieval, chưa có reranker, chưa có observability/tracing, chưa có response cache, `RAG_MIN_SCORE` đang tắt (0). Đây là tài liệu tốt cho slide "limitations/next steps" nếu cần.
- **RAG_DISABLED=1** hiện đang set trong `.env.example` — nghĩa là **theo config mẫu, RAG mặc định TẮT** (dùng để A/B model có RAG vs không); người dùng thật cần tự bật lại (bỏ dòng này hoặc set `=0`) để có retrieval.
