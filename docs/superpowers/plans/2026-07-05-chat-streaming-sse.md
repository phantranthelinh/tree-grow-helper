# Thêm streaming response (SSE) cho chat API

## Context (bối cảnh)

Câu hỏi gốc: API chat hiện tại nối với app chat dùng streaming có ổn không, và muốn streaming thật thì sửa gì?

**Hiện trạng**: `POST /chat` trả về một JSON trọn gói `{ reply, pendingAction }` — handler `await orch.handleChat(...)` rồi serialize một lần (`src/http/routes.chat.ts:136`). Toàn bộ pipeline buffer đến cuối: `runAgentLoop` chỉ return ở dòng cuối, `LlmEngine` chỉ có `complete`/`completeJson` dạng `Promise<string>`, không set `stream: true` (SDK openai@4.104.0 đang dùng hỗ trợ sẵn). Câu trả lời cuối nằm **bên trong JSON decision** (`{reasoning, type, message, ...}` — `reasoning` đứng trước để ép CoT nhẹ), nên không thể stream token thô mà không lộ cấu trúc JSON + reasoning. Ngoài ra **chưa có CORS** — app chat chạy trên browser ở origin khác sẽ bị chặn ngay cả khi không streaming.

App chat streaming vẫn nối được với API hiện tại (nhận nguyên câu một cục, tự làm hiệu ứng gõ chữ), nhưng chữ đầu tiên chỉ xuất hiện sau khi model 3B sinh xong toàn bộ — UX kém với model chậm.

**Quyết định đã chốt:**
1. Giao thức: **SSE trên endpoint mới `POST /chat/stream`**. Giữ nguyên `/chat` + `/chat/confirm` cũ (buffered, không đổi behavior kể cả ở tầng provider).
2. Mức độ: **streaming thật từng token** — gọi LLM với `stream: true`, parse dần JSON decision, đẩy nội dung field `message` ra client ngay khi model sinh. Không fake chunking, không gọi LLM 2 lượt.
3. `/chat/confirm/stream`: **chưa làm** — phần streamable duy nhất (summary sau read-confirm) đã stream được qua đường free-text "có" trên `/chat/stream`; thêm sau ~40 dòng nếu cần.

## Thiết kế chính

3 tầng thay đổi, từ dưới lên:
- **LlmEngine**: thêm 2 method streaming yield raw delta, giữ nguyên method cũ.
- **Orchestrator**: refactor `handleChat`/`runAgentLoop` thành một event-generator core dùng chung; mode `'buffered'` (`/chat`) vẫn gọi `completeJson`/`complete` non-streaming; mode `'stream'` dùng method mới + bộ parse JSON tăng dần.
- **HTTP**: route SSE mới + `@fastify/cors` (dependency mới — browser stream bằng `fetch` + POST nên có preflight; EventSource không POST được).

### SSE wire contract

Request: `POST /chat/stream`, body y hệt `/chat` (`ChatRequestSchema`). Lỗi trước khi stream trả JSON thường: `503 {error:'not_configured'}`, `400 {error:'invalid_request'}`. Thành công: `200`, headers `Content-Type: text/event-stream; charset=utf-8`, `Cache-Control: no-cache, no-transform`, `Connection: keep-alive`, `X-Accel-Buffering: no`. Frame `event: <type>\ndata: <json 1 dòng>\n\n`, heartbeat comment `: ping\n\n` mỗi 15s.

| event | data | Ý nghĩa |
|---|---|---|
| `token` | `{"text":"…"}` | Append vào bubble trả lời |
| `tool_status` | `{"tool":"…","note":"Đang đọc dữ liệu (…)…"}` | Trạng thái tạm khi chạy read tool, không thuộc reply |
| `reset` | `{}` | Client xóa text đã hiện của lượt này (parse decision fail → retry) |
| `done` | `{"reply":"…","pendingAction":{…}\|null}` | Kết thúc; `reply` là bản chuẩn để client đối chiếu — cùng shape `ChatResult` |
| `error` | `{"message":"Có lỗi xảy ra, bạn thử lại giúp mình nhé."}` | Kết thúc lỗi (chi tiết chỉ log server) |

Server luôn đóng connection sau `done`/`error`.

## Các bước triển khai (theo thứ tự)

### 1. LlmEngine streaming seam — `src/llm/index.ts`

```ts
export interface StreamOptions extends CompleteOptions { signal?: AbortSignal }

// thêm vào LlmEngine (required, không optional — giữ DI seam trung thực):
completeStream(messages: ChatMessage[], opts?: StreamOptions): AsyncGenerator<string, void, unknown>
completeJsonStream(messages: ChatMessage[], jsonSchema: Record<string, unknown>, schemaName: string, opts?: StreamOptions): AsyncGenerator<string, void, unknown>
```

`OpenAICompatEngine`: `this.client.chat.completions.create({..., stream: true}, { signal: opts?.signal })`, `for await` chunk, yield `chunk.choices[0]?.delta?.content` khi có. `completeJsonStream` giữ nguyên `response_format: json_schema` như `completeJson`.

**Cùng commit**: thêm stub vào 4 fake implement `LlmEngine` (`tests/http.test.ts`, `tests/orchestrator.test.ts`, `tests/init.test.ts`, `tests/setup-routes.test.ts`) — tối giản kiểu `async *completeJsonStream(...a) { yield await this.completeJson(...a) }`.

### 2. MỚI `src/agent/streamParser.ts` (+ test colocated `streamParser.test.ts`)

`JsonStringFieldStreamer` — state machine thuần, không dependency:

```ts
export type ScanEvent =
  | { kind: 'message'; text: string }                      // delta đã decode của "message" top-level
  | { kind: 'field'; key: 'type' | 'tool'; value: string } // field string top-level hoàn chỉnh
  | { kind: 'end' }

export class JsonStringFieldStreamer {
  push(delta: string): ScanEvent[]
  raw(): string  // toàn bộ text đã nhận — đưa vào parseDecision ở cuối
}
```

State nội bộ: skip đến `{` đầu tiên (mirror `extractJson`), depth tracking (chỉ key depth-1 — tránh `"message"` lồng trong `args`), phân biệt key/value, in-string + escape state (`\"` `\\` `\n` `\uXXXX` có thể bị cắt giữa chunk, surrogate pair ghép tự nhiên), buffer key/value top-level. Stream cụt giữa chừng không throw.

### 3. Orchestrator refactor + streaming — `src/agent/orchestrator.ts`

Edit blast-radius lớn nhất — **commit riêng**, test cũ + equivalence test là lưới an toàn.

```ts
export type ChatStreamEvent =
  | { type: 'token'; text: string }
  | { type: 'tool_status'; tool: string; note: string }
  | { type: 'reset' }
  | { type: 'done'; reply: string; pendingAction: PendingActionView | null }

// public — signature handleChat KHÔNG đổi
handleChatStream(userId, sessionId, message, opts?: { signal?: AbortSignal }): AsyncGenerator<ChatStreamEvent>
handleChat(...): Promise<ChatResult>  // drain chatEvents('buffered'), trả payload của done

// private core dùng chung (pending fast-path + agent loop hiện tại)
private chatEvents(userId, sessionId, message, mode: 'buffered' | 'stream', signal?): AsyncGenerator<ChatStreamEvent>
private decideStreaming(messages, signal?): AsyncGenerator<ChatStreamEvent, { decision: AgentDecision | null; emittedText: string }>
private executeReadPendingEvents(userId, sessionId, pending, signal?): AsyncGenerator<ChatStreamEvent, string>
```

Điểm quyết định trong core: `mode === 'stream' ? yield* this.decideStreaming(...) : await this.decide(messages)` — mode buffered giữ nguyên đường non-streaming nên `/chat` không đổi behavior với provider.

**Gating trong `decideStreaming`** (ở orchestrator, không phải scanner):
- Buffer token `message` đến khi biết `type` (model có thể emit message trước type); `type === 'reply'` → flush + stream live; `type === 'tool'` → nuốt (không ra wire, vẫn có trong decision đã parse).
- Kết thúc stream → `parseDecision(streamer.raw())` (logic y hệt hiện tại). Parse fail: emit `reset` **chỉ khi attempt 1 đã emit token** (thường không — scanner chỉ emit từ trong string `"message"` hợp lệ), rồi stream attempt 2 (retry + nudge như `decide`); fail cả 2 → `reset` nếu cần + `token` FALLBACK_REPLY.
- Reply kèm confirm-read offer (`anchorReadOffer`): text đã stream là prefix đúng của reply cuối; đuôi `\n\nBạn có muốn mình … (Có/Không)` emit thành 1 `token` bổ sung.

Các nhánh khác:
- Server-composed string (control-tool confirmation prompt, hủy pending, confirm-not-found): 1 `token` + `done`.
- Read tool nội bộ giữa loop: `tool_status` (vd `Đang đọc dữ liệu (get_moisture_rule)…`), không stream message của tool-decision.
- Loop hết bước → fallback qua `completeStream` (stream sạch vì trước đó chưa emit gì — emission chỉ xảy ra khi `type:'reply'`, nhánh đó break loop; đáng ghi comment trong code).
- Pending fast-path "có" trên read-pending: `tool_status` + stream summary qua `executeReadPendingEvents`; "không": 1 `token` `Đã hủy: …`.
- `remember(...)` gọi 1 lần trong core với reply cuối đã ráp; **không** gọi khi lỗi/abort (khớp semantics buffered). `chatEvents` không yield event `error` — exception propagate để route xử lý.
- Mutations session (`setPending`/`clearPending`/`remember`) giữ đúng vị trí logic hiện tại → lượt buffered và stream xen kẽ trên cùng session vẫn an toàn.

### 4. HTTP: SSE route + CORS

- `npm i @fastify/cors` (v11, tương thích Fastify 5); register trong `buildServer` (`src/http/server.ts`) với `{ origin: true, methods: ['GET','POST','OPTIONS'] }`.
- MỚI `src/http/sse.ts`: helper `writeSseHead(raw)`, `writeSseEvent(raw, event, data)`, `startHeartbeat(raw, ms)`.
- `POST /chat/stream` trong `src/http/routes.chat.ts`:
  - Guard 503 + Zod 400 trả JSON **trước khi** hijack.
  - `reply.hijack()`, ghi header lên `reply.raw` (guard `if (typeof raw.flushHeaders === 'function')` — mock của inject có thể thiếu), `for await` event từ `handleChatStream`, ghi frame; catch → frame `error`; luôn clear heartbeat + `raw.end()`.
  - `req.raw.on('close')` → `AbortController.abort()` với guard flag `finished` (`close` cũng fire sau end bình thường); abort propagate qua orchestrator vào SDK (`APIUserAbortError` nuốt khi `signal.aborted`).
  - Thêm `/chat/stream` vào danh sách endpoints ở `GET /`; Swagger schema: body + 400/503, mô tả prose là response `text/event-stream` (Swagger UI không render SSE).

### 5. Docs

Cập nhật CLAUDE.md: mục HTTP surface (endpoint mới + CORS) và mục LLM abstraction (2 method streaming; lưu ý provider phải stream được khi kèm `response_format`).

## Tests / Verification

- **`src/agent/streamParser.test.ts`**: decode đủ message == `JSON.parse` với **mọi** vị trí cắt chunk (loop split index); escape cắt giữa chừng (`\uXXXX`, surrogate pair emoji); message-trước-type; `"message"` lồng trong `args` không emit; rác quanh JSON; stream cụt không throw, `raw()` đủ.
- **`tests/orchestrator.stream.test.ts`** (FakeStreamLlm script sẵn mảng delta mỗi lượt gọi): reply thường (token concat == `done.reply`, history có đủ 2 phía); message-trước-type → 0 token trước khi biết type; read tool → `tool_status` + không leak message tool-step; control tool → 1 token + `pendingAction`, MCP không bị gọi; reply + offer; parse-fail → `reset` đúng điều kiện (có/không emit); double-fail → fallback; loop exhaustion → fallback stream; pending có/không; abort → generator dừng, không `remember`; **equivalence**: cùng script qua `handleChat` và `handleChatStream` cho `reply`/`pendingAction` giống hệt.
- **`tests/http.stream.test.ts`** (`app.inject` — inject buffer được response hijacked; nếu flaky, fallback `app.listen({port:0})` + fetch thật, ghi chú trong file test): 503/400 là JSON thường không có SSE header; happy path `content-type: text/event-stream`, parse frame từ body, token concat == `done.reply`, `done` cuối cùng; orchestrator throw → frame `error` terminal; OPTIONS preflight `/chat/stream` có `access-control-allow-origin`.
- **Regression**: 4 file test cũ chỉ thêm stub fake, không đổi assertion. `npm run typecheck` + `npm test` xanh.
- **Smoke thủ công** với LM Studio: `curl -N -X POST localhost:8787/chat/stream -H 'content-type: application/json' -d '{"userId":"u1","sessionId":"s1","message":"Cách chăm dâu mùa hè?"}'` — xác nhận token về nhỏ giọt.

## Rủi ro

1. **Provider buffer structured output khi `stream:true`** (rủi ro chính): LM Studio/llama.cpp stream JSON grammar-constrained token-by-token bình thường; Ollama OpenAI-compat layer từng trả format-constrained thành 1 chunk to ở vài version. Fallback tự nhiên: 1 delta khổng lồ = 1 `token` to rồi `done` — vẫn đúng, chỉ không nhỏ giọt. Verify bằng curl smoke, không cần code fallback riêng.
2. **Refactor core dùng chung `runAgentLoop`**: equivalence test + test orchestrator cũ là lưới an toàn; làm thành commit riêng.
3. **SSE qua reverse proxy** (nginx…) cần `no-transform` / `X-Accel-Buffering: no` — đã có trong header; ghi chú cho người deploy.
