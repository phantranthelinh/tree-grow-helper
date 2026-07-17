# TODO — Nâng cấp ai-server theo khóa Production Agentic RAG

> Checklist rút từ [`rag-course-review.md`](./rag-course-review.md) (mục 4 — Lộ trình).
> Xếp theo impact/effort cho **model nhỏ** (3–4B). Tick `[x]` khi xong.
> Nguyên tắc: mỗi bước có **eval số** chứng minh trước/sau, đi qua brainstorming + TDD theo convention repo.

---

## Ưu tiên 1 — Chất lượng truy hồi (làm trước, đòn bẩy lớn nhất)

- [ ] **B1. Bật ngưỡng lọc chunk yếu** — *5 phút, impact cao*
  - Set `RAG_MIN_SCORE=0.35` (tinh chỉnh bằng eval, đừng chốt số vội).
  - File liên quan: `src/config.ts` (đã chừa sẵn), `src/rag/retrieve.ts` (đã hỗ trợ `minScore`).
  - Xong khi: grounding eval không tụt, và chunk rác điểm thấp bị loại.

- [ ] **B2. Đo lường chất lượng truy hồi (Recall@k, MRR)** — *0.5 ngày, làm trước khi đổi retrieval*
  - Tạo `src/eval/retrieval.ts` + dataset `{query → id_chunk_đúng}` (~20–30 câu gắn nhãn tay).
  - So 3 chế độ: vector-only / bm25-only / hybrid(+rerank).
  - Xong khi: có bảng số baseline để so sánh mọi thay đổi sau.

- [ ] **B3. Hybrid retrieval: BM25 + vector + RRF** — *1 ngày, ⭐ impact #1 cho tiếng Việt*
  - Tạo `src/rag/bm25.ts` (BM25 in-memory, tokenize tiếng Việt) — code mẫu ở review §3.1.
  - Tạo `src/rag/hybrid.ts` (`rrfFuse`, k=60).
  - Sửa `src/rag/retrieve.ts`: chạy vector + bm25 song song → RRF → top-K.
  - Xong khi: Recall@k (B2) cải thiện rõ so với vector-only.

- [ ] **B4. Reranking (bge-reranker-v2-m3)** — *0.5–1 ngày, ⭐ impact #1 cho model nhỏ*
  - hybrid(top ~20) → reranker.score(query, chunk) → top 5 → LLM.
  - Đặt sau `retrieve()`, trước `formatContextText()`.
  - Phụ thuộc: cần reranker chạy local (LM Studio/Ollama endpoint hoặc microservice nhỏ).
  - Xong khi: MRR (B2) tăng so với chỉ hybrid.

## Ưu tiên 2 — Quan sát được (để biết vì sao model trả sai)

- [ ] **B5. Tracing tối giản** — *0.5 ngày, ⭐ impact cao cho học/debug*
  - Tạo `src/obs/trace.ts` (span: name/ms/input/output) — phác thảo ở review §3.6.
  - Bọc quanh `retrieve()`, `decide()`, `callReadTool()` trong orchestrator.
  - Ghi `data/traces/*.jsonl` + (tùy chọn) trang `/debug` đọc lại.
  - Xong khi: nhìn 1 request thấy được chunk nào lấy ra + điểm + tool đã chọn.

## Ưu tiên 3 — Agentic quality (câu khó / ngoài miền)

- [ ] **B6. Document grading (LLM) + query rewrite 1 lần** — *1 ngày*
  - Grading: schema `{relevant: boolean, reason}`; chỉ grade khi `topScore < ngưỡng` (tiết kiệm latency).
  - `false` + còn lượt → rewrite query (dùng `llm.complete`, temp ~0.3) → `retrieve()` lại. Giới hạn 1 lần.
  - Khung có sẵn: vòng lặp `chatEvents` + `MAX_TOOL_STEPS`.
  - Xong khi: câu mơ hồ ("cây bị sao ấy") ra chunk tốt hơn sau rewrite.

- [ ] **B7. Domain guardrail (heuristic → LLM)** — *0.5 ngày*
  - Chặn câu ngoài miền cây trồng → trả lời "ngoài phạm vi" lịch sự (không bịa).
  - Heuristic từ khóa miền trước; LLM scoring sau nếu cần.
  - Lưu ý: **bổ sung** cho guardrail an toàn-hành động đã có (`policy.ts`), không thay thế.

## Ưu tiên 4 — Vận hành

- [ ] **B8. Response cache** — *0.5 ngày, ⚠️ cẩn trọng cao*
  - Cache câu trả lời `reply` thuần (RAG kiến thức). Key = hash(query + plant + profile version).
  - **TUYỆT ĐỐI loại trừ** câu liên quan sensor/control (dữ liệu real-time + hành động nguy hiểm).
  - Không cần Redis: `Map` in-memory + TTL, hoặc `data/cache/replies.jsonl`.

- [ ] **B9. (Tùy chọn) PDF ingestion** — *trung bình, chỉ khi có nguồn PDF*
  - Thêm parser PDF vào pipeline `scrape` nếu cẩm nang khuyến nông ở dạng PDF.
  - Scheduler (Airflow-style): **YAGNI** với quy mô hiện tại — cron chạy `npm run scrape` là đủ.

---

## Ghi chú review
- Không phá 5 điểm đang làm tốt (review §5): an toàn hành động, streaming SSE, eval+grounding, runtime config, profile-driven thresholds.
- Thứ tự khuyên: **B1 → B2 → B3 → B4 → B5** rồi mới tới nhóm agentic (B6–B7) và vận hành (B8).
