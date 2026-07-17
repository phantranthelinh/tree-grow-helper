# Đối chiếu ai-server với khóa "Production Agentic RAG" + hướng dẫn nâng cấp

> Nguồn tham chiếu: https://github.com/jamwithai/production-agentic-rag-course
> (arXiv Paper Curator — 7 tuần, LangGraph + OpenSearch + Ollama + Langfuse + Redis).
> Tài liệu này ánh xạ từng "bước" của khóa học sang trạng thái hiện tại của `ai-server`,
> rồi hướng dẫn **chi tiết, có code mẫu** các kỹ thuật nên bổ sung. Mục tiêu: học + demo.

---

## 0. Hai kiến trúc khác gì nhau (đọc trước để không so nhầm)

| | Khóa học (arXiv Curator) | ai-server (của bạn) |
|---|---|---|
| Ngôn ngữ/stack | Python, FastAPI, LangGraph | TypeScript, Fastify, agent loop tự viết |
| Miền dữ liệu | Bài báo khoa học tiếng Anh | Chăm sóc cây (dâu tây) tiếng Việt |
| Vector store | OpenSearch (BM25 + kNN) | In-memory cosine brute-force |
| LLM | Ollama llama3.2 (1B–3B) | OpenAI-compat local (gemma-4-e4b / qwen2.5-3b) |
| Điểm khác biệt lớn | RAG "hỏi–đáp thuần" | RAG **+ điều khiển thiết bị IoT qua MCP** (có xác nhận) |

Điểm quan trọng: **bạn đã có phần khó nhất mà khóa học không có** — một agent loop điều khiển
hành động thật (control tool) với cơ chế xác nhận an toàn. Ngược lại, khóa học có nhiều kỹ thuật
**chất lượng truy hồi + vận hành production** mà bạn chưa có. Đó chính là phần nên học.

---

## 1. Bản đồ 7 tuần → trạng thái ai-server

| Tuần | Chủ đề khóa học | ai-server | Ghi chú |
|---|---|---|---|
| **1** | Hạ tầng (Docker, API, health, Swagger) | ✅ **Có** | Fastify + Swagger `/docs` + `/health` + Dockerfile/compose. Có "two-phase startup" runtime-config — tinh vi hơn khóa học. |
| **2** | Ingestion (fetch → parse PDF → lưu) | ⚠️ **Một phần** | Có pipeline `scrape → review (người duyệt) → ingest`. Nhưng: scrape HTML (cheerio), **không parse PDF** (khóa học dùng Docling), **không có scheduler** (khóa học dùng Airflow). |
| **3** | BM25 keyword search (OpenSearch) | ❌ **Chưa** | Bạn không có tầng keyword-search nào. Đây là **lỗ hổng lớn nhất về chất lượng truy hồi**. |
| **4** | Chunking + Hybrid search + RRF + embeddings | ⚠️ **Một phần** | Có chunking (char-based 600/overlap 80 + dedupe + minLen), có embeddings (bge-m3, cross-lingual). **Thiếu**: hybrid (BM25+vector), **RRF fusion**, **rerank**. |
| **5** | RAG hoàn chỉnh (LLM + streaming + prompt tối ưu) | ✅ **Có** (mạnh) | Có LLM, **streaming SSE tinh vi hơn** (parse JSON field tăng dần, chỉ stream `message`), prompt tối ưu cho model 3B, profile-driven thresholds. |
| **6** | Observability (Langfuse) + Cache (Redis) | ❌ **Chưa** | Không tracing, không response-cache. Chỉ có embedding-cache trên đĩa. **Lỗ hổng lớn về vận hành.** |
| **7** | Agentic RAG (LangGraph: guardrail, grade, rewrite, retrieve, generate) + Telegram | ⚠️ **Một phần** | Có agent loop + tool selection + **an toàn hành động** (xác nhận control). **Thiếu 3 node chất lượng**: document grading, query rewrite + retry, domain guardrail scoring. Không Telegram (có HTTP + OpenAI-compat thay thế). |

**Tóm tắt một câu:** bạn đang ở khoảng **Tuần 5 + một agentic tool-use layer riêng**, nhưng thiếu
các kỹ thuật của **Tuần 3, 4, 6, 7** giúp RAG *chính xác* và *quan sát được* — đúng chỗ gọi là
"production" trong tên khóa học.

---

## 2. Vì sao các kỹ thuật này đặc biệt quan trọng với *model nhỏ*

Model của bạn (3–4B) khác GPT-4 ở một điểm sống còn: **nó rất nhạy với chất lượng context**.
Cho nó 5 chunk trong đó 2 chunk lạc đề → nó sẽ bịa hoặc trả lời theo chunk sai. Vì vậy thứ tự
ưu tiên nâng cấp của bạn **không giống** dự án chạy GPT-4:

1. Truy hồi *đúng* (hybrid + rerank) quan trọng hơn mọi thứ.
2. *Lọc* chunk rác trước khi đưa vào model (grading / min-score) quan trọng thứ nhì.
3. Quan sát được (tracing) để biết vì sao model trả sai.

---

## 3. Các kỹ thuật nên bổ sung (chi tiết + code mẫu)

Xếp theo **impact/effort**. Mỗi mục: *là gì → vì sao cần cho project này → khóa học làm sao →
áp dụng vào codebase TS của bạn*.

### 3.1. ⭐ Hybrid retrieval: thêm BM25 vào cạnh vector (Tuần 3+4)

**Là gì.** Hiện `retrieve.ts` chỉ dùng cosine trên embedding. Hybrid = chạy **song song** 2 cách
truy hồi rồi trộn kết quả:
- **BM25 / keyword**: khớp từ khóa chính xác (tên bệnh "mốc xám", "phấn trắng", tên hoạt chất,
  mã thiết bị, con số). Vector hay *trượt* mấy cái này vì nó so "ý nghĩa" chứ không so "chữ".
- **Vector (đang có)**: khớp ngữ nghĩa ("cây héo lá vàng" ~ "thiếu nước / thối rễ").

**Vì sao cần cho bạn.** Miền của bạn đầy **thuật ngữ chính xác tiếng Việt** (tên bệnh, mốc ẩm,
ngưỡng %). Đây đúng là điểm yếu của vector thuần. Khóa học nhấn mạnh "keyword-first" (Tuần 3 tên là
*"The Critical Foundation"*) chính vì lý do này.

**Khóa học làm sao.** OpenSearch giữ cả BM25 lẫn kNN trong 1 index, chạy 2 query rồi trộn bằng
**RRF (Reciprocal Rank Fusion)** — vì OpenSearch 2.19 chưa trộn sẵn nên họ tự cài RRF thủ công.

**RRF là gì (công thức).** Không cần chuẩn hóa điểm số giữa 2 hệ (BM25 điểm ~10, cosine ~0.7 —
không cùng thang). RRF chỉ dùng **thứ hạng**:

```
score_rrf(d) = Σ_over_each_ranking  1 / (k + rank_i(d))      // k thường = 60
```

Tài liệu đó ~docs của họ đúng công thức Cormack 2009. Một doc xếp hạng 1 ở BM25 và hạng 3 ở vector
sẽ được cộng `1/61 + 1/63`.

**Áp dụng vào ai-server (không cần OpenSearch).** Bạn đang có store nhỏ (vài trăm chunk) nên
làm BM25 **in-memory** là đủ, giữ triết lý "zero native deps" của repo:

```ts
// src/rag/bm25.ts  (mới)
// BM25 in-memory tối giản cho vài trăm chunk. Tokenize tiếng Việt: hạ chữ thường,
// bỏ dấu câu, tách theo khoảng trắng. (Tiếng Việt tách theo "tiếng" là đủ tốt cho keyword.)
export interface Bm25Doc { id: string; text: string }

const tokenize = (s: string): string[] =>
  s.toLowerCase().normalize('NFC').replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean)

export class Bm25Index {
  private docs: { id: string; tokens: string[]; len: number }[] = []
  private df = new Map<string, number>()
  private avgdl = 0
  private readonly k1 = 1.5
  private readonly b = 0.75

  add(docs: Bm25Doc[]): void {
    for (const d of docs) {
      const tokens = tokenize(d.text)
      this.docs.push({ id: d.id, tokens, len: tokens.length })
      for (const t of new Set(tokens)) this.df.set(t, (this.df.get(t) ?? 0) + 1)
    }
    this.avgdl = this.docs.reduce((n, d) => n + d.len, 0) / Math.max(1, this.docs.length)
  }

  search(query: string, topK: number): { id: string; score: number }[] {
    const q = tokenize(query)
    const N = this.docs.length
    const scored = this.docs.map((d) => {
      const tf = new Map<string, number>()
      for (const t of d.tokens) tf.set(t, (tf.get(t) ?? 0) + 1)
      let s = 0
      for (const t of q) {
        const f = tf.get(t); if (!f) continue
        const idf = Math.log(1 + (N - (this.df.get(t) ?? 0) + 0.5) / ((this.df.get(t) ?? 0) + 0.5))
        s += idf * (f * (this.k1 + 1)) / (f + this.k1 * (1 - this.b + this.b * d.len / this.avgdl))
      }
      return { id: d.id, score: s }
    })
    return scored.filter((x) => x.score > 0).sort((a, b) => b.score - a.score).slice(0, topK)
  }
}
```

```ts
// src/rag/hybrid.ts  (mới) — trộn RRF
export function rrfFuse(
  rankings: { id: string; }[][],   // mỗi phần tử là 1 danh sách đã xếp hạng
  k = 60,
): Map<string, number> {
  const fused = new Map<string, number>()
  for (const ranking of rankings) {
    ranking.forEach((item, idx) => {
      fused.set(item.id, (fused.get(item.id) ?? 0) + 1 / (k + idx + 1))
    })
  }
  return fused
}
```

Rồi trong `retrieve.ts`, sau khi có `vectorHits` (đang có) và `bm25Hits`, trộn theo id, lấy top-K.
Store cần trả record theo id (đã có `id` trong `VectorRecord`). **Impact: rất cao. Effort: 1 buổi.**

> Ghi chú tiếng Việt: nếu muốn "xịn" hơn, bỏ dấu (remove diacritics) cho *một bản sao* token để
> "moc xam" vẫn khớp "mốc xám". Nhưng đừng bỏ dấu bản chính — sẽ mất phân biệt "má/mà/mã".

---

### 3.2. ⭐ Reranking bằng cross-encoder (khóa học chưa dạy — bạn nên vượt lên)

**Là gì.** Sau khi hybrid trả về ~20 candidate, dùng một **reranker** (cross-encoder) chấm lại độ
liên quan *query↔chunk* rồi giữ top-5. Cross-encoder đọc *cả cặp cùng lúc* nên chính xác hơn nhiều
so với so 2 embedding rời rạc (bi-encoder).

**Vì sao cần cho bạn.** Đây là đòn bẩy **lớn nhất cho model nhỏ**: thay vì nhét 5 chunk "top cosine"
(hay lẫn rác) vào model 3B, bạn nhét 5 chunk *đã được chấm lại thật kỹ*. `bge-reranker-v2-m3` cùng
họ với `bge-m3` bạn đang dùng, hỗ trợ tiếng Việt tốt.

**Áp dụng.** Nếu LM Studio/Ollama của bạn phục vụ được reranker qua endpoint, gọi như một bước sau
hybrid. Nếu không, có thể chạy `bge-reranker` qua một microservice nhỏ. Pattern:

```
query → hybrid(top 20) → reranker.score(query, chunk)[] → sort → top 5 → LLM
```

Đặt sau `retrieve()` và trước khi `formatContextText()`. **Impact: rất cao. Effort: trung bình**
(phụ thuộc việc có model reranker chạy local).

---

### 3.3. ⭐ Document grading — cổng lọc chunk trước khi trả lời (Tuần 7)

**Là gì.** Trước khi sinh câu trả lời, hỏi LLM (hoặc heuristic) "đống chunk này có *thật sự* liên
quan câu hỏi không?" → `yes/no`. Nếu `no` → không trả lời bừa mà đi nhánh khác (rewrite query, hoặc
nói "chưa đủ dữ liệu").

**Khóa học làm sao.** Node `grade_documents` dùng `with_structured_output(GradeDocuments)` với schema
`{binary_score: "yes"|"no", reasoning: str}`, prompt `GRADE_DOCUMENTS_PROMPT`. `no` → route sang
`rewrite_query`. Có fallback heuristic (độ dài context) khi LLM lỗi.

**Vì sao cần cho bạn.** Bạn đã có mầm mống rồi: `ragMinScore` (mặc định **0 = tắt**). Đây chính là
grading bằng heuristic điểm cosine. **Bước 1 rẻ nhất: bật nó lên.** Comment trong `config.ts` của
bạn còn ghi sẵn "Raise (~0.3–0.4 for bge-m3)". Sau khi có hybrid+rerank thì thêm grading bằng LLM
cho câu hỏi khó.

**Áp dụng — mức rẻ (làm ngay):**
```ts
// .env hoặc config: bật ngưỡng lọc chunk yếu
RAG_MIN_SCORE=0.35   // đo lại bằng eval trước khi chốt số
```

**Áp dụng — mức LLM (giống khóa học):** thêm một schema decision quyết định `relevant: boolean`,
gọi 1 lượt LLM trên context đã format. Nếu `false` và còn lượt → rewrite (mục 3.4). Với model nhỏ,
cân nhắc chỉ grade khi `topScore < ngưỡng` để tiết kiệm latency. **Impact: cao. Effort: thấp→trung.**

---

### 3.4. Query rewriting + adaptive retry (Tuần 7)

**Là gì.** Nếu truy hồi lần 1 ra chunk kém, **viết lại câu hỏi** cho dễ tìm hơn rồi thử lại (có
giới hạn số lần). Câu người dùng thường mơ hồ ("cây bị sao ấy") → rewrite thành "triệu chứng bệnh
dâu tây lá vàng héo".

**Khóa học làm sao.** Node `rewrite_query`: `with_structured_output(QueryRewriteOutput)`
(`{rewritten_query, reasoning}`), temperature 0.3, rồi **edge quay lại `retrieve`**. Chặn vòng lặp
vô hạn bằng `max_retrieval_attempts = 2` trong `GraphConfig`.

**Vì sao cần cho bạn.** Bạn đã có sẵn khung `MAX_TOOL_STEPS=3` và vòng lặp trong `chatEvents`. Có
thể thêm 1 nhánh: khi grading `no`, chèn một bước rewrite (dùng chính `llm.complete`) rồi
`retrieve()` lại với query mới. **Lưu ý model nhỏ**: mỗi lần rewrite là thêm 1 round-trip → chậm.
Giới hạn 1 lần rewrite là hợp lý. **Impact: trung bình. Effort: trung bình.**

---

### 3.5. Domain guardrail scoring (Tuần 7)

**Là gì.** Chấm điểm 0–100 "câu hỏi có thuộc miền của trợ lý không?" Dưới ngưỡng → trả lời lịch sự
"ngoài phạm vi" thay vì cố trả lời bừa.

**Khóa học làm sao.** Node `guardrail`: `GuardrailScoring{score:0-100, reason}`, ngưỡng 60. Node
`out_of_scope` trả câu xin lỗi cố định. Chạy **ngay đầu graph**, trước cả retrieve.

**Vì sao cần cho bạn.** Bạn *đã có* một loại guardrail khác và tốt hơn cho use-case của bạn:
**an toàn hành động** (`policy.ts`: control luôn cần xác nhận, unknown → control fail-safe). Cái bạn
*chưa* có là guardrail **phạm vi chủ đề**: hỏi "thời tiết Hà Nội mai thế nào" thì trợ lý cây trồng
nên từ chối khéo. Với model nhỏ, làm bằng LLM scoring có thể tốn kém/thiếu ổn định → cân nhắc
heuristic (khớp từ khóa miền cây trồng) trước, LLM sau. **Impact: trung bình (chủ yếu về UX/độ tin).
Effort: thấp.**

> So sánh khái niệm: guardrail của khóa học chặn *chủ đề lạc*; guardrail của bạn chặn *hành động nguy
> hiểm*. Hai loại bổ sung nhau — nên có cả hai.

---

### 3.6. ⭐ Observability / tracing (Tuần 6 — Langfuse)

**Là gì.** Ghi lại từng bước một request: retrieve mất bao lâu, lấy chunk nào (điểm bao nhiêu),
model quyết định tool gì, prompt/ý­­­­ tưởng ra sao, tổng token/latency. Xem trên dashboard.

**Khóa học làm sao.** Langfuse: mỗi node tạo một `span` (guardrail, grade, rewrite, generate) với
`input/output/metadata/execution_time_ms`, gắn `CallbackHandler` để tự trace LLM. Có `trace.update`
tổng ở cuối.

**Vì sao cực kỳ cần cho bạn.** Bạn debug model nhỏ bằng cách... đoán. Có tracing bạn sẽ thấy ngay
"à, câu này retrieve ra 5 chunk rác nên model trả sai", hoặc "model chọn `send_command` sai tool".
Đây là công cụ học tập/nghiên cứu tuyệt vời cho chính project demo.

**Áp dụng — nhẹ nhàng, không cần Langfuse:** repo bạn thuần TS/local. Có 2 hướng:
1. **Tối giản (khuyên dùng để học):** một module `trace.ts` gom "span" vào một object theo
   `requestId`, ghi JSONL ra `data/traces/*.jsonl`. Bọc quanh `retrieve()`, `decide()`, mỗi
   `callReadTool()`. Sau đó viết một trang `/debug` đọc file đó.
   ```ts
   // src/obs/trace.ts (phác thảo)
   export interface Span { name: string; ms: number; input?: unknown; output?: unknown }
   export class Trace {
     spans: Span[] = []
     async step<T>(name: string, input: unknown, fn: () => Promise<T>): Promise<T> {
       const t0 = performance.now()
       const out = await fn()
       this.spans.push({ name, ms: performance.now() - t0, input, output: summarize(out) })
       return out
     }
   }
   ```
   Dùng trong orchestrator: `const rag = await trace.step('retrieve', {query}, () => retrieve(...))`.
2. **Chuẩn công nghiệp:** OpenTelemetry SDK cho Node → xuất sang Jaeger/Tempo. Học được chuẩn thật,
   nhưng nặng hơn cho demo.

**Impact: rất cao (cho việc học/debug). Effort: thấp (bản tối giản).**

---

### 3.7. Response caching (Tuần 6 — Redis)

**Là gì.** Cache **câu trả lời cuối** theo khóa = hash của (query + params). Hỏi lại y hệt → trả
tức thì (~100ms) thay vì chạy lại cả pipeline.

**Khóa học làm sao.** Redis, exact-match key theo tham số, TTL 24h, fallback nhẹ nhàng khi Redis
chết. Họ báo cáo nhanh 150–400×.

**Vì sao cần cho bạn (có lưu ý an toàn).** Cache câu **hỏi kiến thức** (RAG thuần) thì tốt. Nhưng
**tuyệt đối không cache** các câu liên quan **đọc cảm biến / điều khiển** — dữ liệu cảm biến thay đổi
theo thời gian thực, cache sẽ trả số cũ, và cache một hành động điều khiển thì cực kỳ nguy hiểm.
→ Chỉ cache khi decision là `reply` thuần không kèm tool, và key nên gắn `plant`/profile version.

**Áp dụng.** Bạn không cần Redis — một `Map` in-memory + TTL, hoặc ghi `data/cache/replies.jsonl`
là đủ cho 1–5 user. Đặt tra cache **sau** khi biết đây là câu hỏi kiến thức (sau decision). **Impact:
trung bình (demo cảm giác nhanh). Effort: thấp. Cẩn trọng: cao — nhớ loại trừ sensor/control.**

---

### 3.8. Đo lường chất lượng truy hồi (retrieval metrics)

**Là gì.** Bạn đã có eval **tool-selection + grounding** rất tốt (`src/eval/`), nhưng **chưa đo
chất lượng *truy hồi***. Trước/sau khi thêm hybrid+rerank, cần con số để biết có cải thiện thật.

**Cách làm.** Tạo một tập nhỏ `{query → id_chunk_đúng}` (gắn nhãn tay ~20–30 câu). Đo:
- **Recall@k**: trong top-k có chunk đúng không.
- **MRR**: 1/thứ_hạng của chunk đúng đầu tiên.
- So sánh 3 chế độ: vector-only / bm25-only / hybrid+rerank.

Thêm vào `src/eval/` một file `retrieval.ts` chạy 3 chế độ trên cùng dataset. Đây là "khoa học" của
project: mọi kỹ thuật ở trên nên được *chứng minh* bằng bảng số này. **Impact: cao (cho học/nghiên
cứu). Effort: trung bình.**

---

### 3.9. (Tùy chọn) PDF ingestion & scheduler — Tuần 2

Khóa học parse PDF bằng **Docling** và tự động hóa bằng **Airflow**. Với bạn, nếu tài liệu cây trồng
có dạng PDF (cẩm nang khuyến nông), thêm một parser PDF vào pipeline `scrape` sẽ mở rộng nguồn KB.
Scheduler thì với 1 cây/vài trăm chunk là *chưa cần* (YAGNI) — cron chạy `npm run scrape` là đủ.
**Impact: thấp–trung (tùy nguồn dữ liệu). Effort: trung bình.**

---

## 4. Lộ trình đề xuất (ưu tiên theo impact/effort cho model nhỏ)

| Bước | Việc | Vì sao trước | Effort |
|---|---|---|---|
| 1 | **Bật `RAG_MIN_SCORE`** (0.35, tinh chỉnh bằng eval) | Rẻ nhất, chặn chunk rác ngay | 5 phút |
| 2 | **Retrieval metrics** (`src/eval/retrieval.ts`) | Có thước đo trước khi đổi gì | 0.5 ngày |
| 3 | **Hybrid BM25 + vector + RRF** | Đòn bẩy chất lượng #1 cho tiếng Việt | 1 ngày |
| 4 | **Rerank (bge-reranker-v2-m3)** | Đòn bẩy #1 cho model nhỏ | 0.5–1 ngày |
| 5 | **Tracing tối giản** (`src/obs/trace.ts` + `/debug`) | Để *nhìn thấy* 4 bước trên có hiệu quả không | 0.5 ngày |
| 6 | **Document grading (LLM)** + **query rewrite 1 lần** | Xử lý câu khó/mơ hồ | 1 ngày |
| 7 | **Domain guardrail** (heuristic → LLM) | Từ chối khéo câu ngoài miền | 0.5 ngày |
| 8 | **Response cache** (loại trừ sensor/control) | Demo cảm giác nhanh | 0.5 ngày |

Làm 1→5 là bạn đã có một "production-ish agentic RAG" đúng tinh thần khóa học, **cộng** phần điều
khiển IoT an toàn mà khóa học không có.

---

## 5. Những gì bạn ĐÃ làm tốt (giữ nguyên, đừng phá)

- **An toàn hành động** (`policy.ts` fail-safe + xác nhận control) — tốt hơn khóa học cho use-case
  điều khiển thật.
- **Streaming SSE parse JSON tăng dần** (`streamParser.ts`) — chỉ stream field `message`, giấu
  `reasoning`/tool call. Tinh vi hơn cách stream của khóa học.
- **Eval có ngữ cảnh RAG + grounding deterministic** chạy trong CI — nhiều dự án production còn
  không có.
- **Runtime config two-phase** (`/setup`, graceful degradation khi MCP/embeddings lỗi) — rất
  "production".
- **Profile-driven thresholds + RAG** — cách bạn để numeric ranges thắng khi mâu thuẫn nguồn là một
  dạng "grounding rule" thông minh.

---

## 6. Bảng thuật ngữ nhanh

- **BM25**: thuật toán chấm điểm keyword kinh điển (TF-IDF cải tiến).
- **RRF (Reciprocal Rank Fusion)**: trộn nhiều bảng xếp hạng bằng `1/(k+rank)`, không cần chuẩn hóa
  điểm.
- **Bi-encoder** (embedding hiện tại): mã hóa query và doc *riêng*, so cosine → nhanh, kém tinh.
- **Cross-encoder / reranker**: đọc *cặp* query+doc cùng lúc → chậm, chính xác. Dùng để rerank top-N.
- **Grading**: LLM/heuristic quyết định chunk có liên quan không, trước khi trả lời.
- **Guardrail**: cổng chặn — theo *chủ đề* (khóa học) hoặc theo *hành động nguy hiểm* (bạn).
- **Span/Trace**: đơn vị đo một bước trong pipeline để quan sát (observability).
- **Recall@k / MRR**: thước đo chất lượng truy hồi.
