# Spec: Endpoint OpenAI-compatible cho AI Server

> [!NOTE] Meta
> **Ticket:** N/A · **Date:** 2026-07-15

---

## Problem

> [!WARNING] Problem Statement
> Một server khác muốn tương tác với AI Server này **giống như gọi vào LM Studio** — trỏ một OpenAI
> SDK vào và gọi `POST /v1/chat/completions`, coi toàn bộ trợ lý chăm cây (RAG + điều khiển IoT qua
> MCP + xác nhận) như **một "model" duy nhất**. Hiện AI Server chỉ có API riêng (`POST /chat`,
> `/chat/stream`, `/chat/confirm`) với contract **có state** (`{userId, sessionId, message}` →
> `{reply, pendingAction}`), không tương thích OpenAI, nên không dùng chung được với hệ sinh thái
> OpenAI SDK.

---

## Goals

- Phơi bày một **facade OpenAI-compatible** đứng trước `Orchestrator` hiện có, **tái dùng 100%** agent
  (RAG + MCP + confirmation) — không fork logic.
- **Stateless thuần OpenAI**: caller gửi cả `messages[]` mỗi request; server không giữ session cho
  endpoint này. State hội thoại (kể cả hành động đang chờ xác nhận) nằm trong chính thread.
- Giữ nguyên **invariant an toàn**: control tool không bao giờ chạy inline — luôn xác nhận trước.
  Trải nghiệm **turnkey** (hỏi "(Có/Không)" → thực thi khi caller gửi "có") y hệt `/chat` + `/chat/confirm`.
- Hỗ trợ cả **buffered** và **streaming** (`stream:true`, SSE đúng định dạng OpenAI).
- Thay đổi tối thiểu code agent: chỉ thêm một method nhỏ; không đụng `chatEvents`, `routes.chat.ts`,
  `SessionStore`.

**Non-goals (v1):** `/v1/embeddings`; xác thực API key (mở như LM Studio mặc định — thêm sau dễ);
theo dõi token usage thật; hỗ trợ nhiều plant profile qua field `model`.

---

## User Stories

| As a… | I want to… | So that… |
|-------|-----------|----------|
| Dev của server khác | Trỏ OpenAI SDK vào AI Server và gọi `/v1/chat/completions` | Tích hợp trợ lý chăm cây như một LLM thường, không phải học API riêng |
| Server tích hợp | Gửi lại `messages[]` (kèm assistant `tool_calls`) và nhận lệnh điều khiển được thực thi sau khi người dùng đồng ý | Có trải nghiệm turnkey đầy đủ mà không cần tự gọi MCP |
| Client OpenAI | Gọi `GET /v1/models` trước khi chat | Dò/kiểm tra model có sẵn theo thói quen OpenAI |

---

## Functional Requirements

1. **`POST /v1/chat/completions` (buffered)**: nhận body kiểu OpenAI Chat Completions; chạy agent;
   trả object `chat.completion` chuẩn (`choices[0].message.{role,content,tool_calls?}`, `finish_reason`,
   `usage`).
2. **`POST /v1/chat/completions` (streaming)**: khi `stream:true`, trả `text/event-stream` gồm các
   `chat.completion.chunk` (`choices[0].delta.content`), kết bằng `data: [DONE]`.
3. **`GET /v1/models`**: trả `{object:"list", data:[{id:"plant-assistant", object:"model", created,
   owned_by:"ai-server"}]}`.
4. **Full agent phía sau**: mọi request chạy qua `Orchestrator` (RAG + MCP + confirmation), không phải
   passthrough tới LLM.
5. **Stateless**: không đọc/ghi `SessionStore` bền vững; state lấy từ `messages[]` của request.
6. **Turnkey control**: control tool tạo câu hỏi "(Có/Không)" + `tool_calls` mã hoá hành động; lượt sau
   caller echo lại thread + "có" → server tái dựng và thực thi. Hành vi khớp `/chat` + `/chat/confirm`.
7. **Parity đầy đủ**: luồng "đề nghị đọc cảm biến (Có/Không)" cũng chạy qua đúng cơ chế round-trip này
   (không có ngoại lệ "read chạy inline" riêng cho endpoint).
8. **Error shape OpenAI**: lỗi trả `{error:{message,type,code}}` với HTTP status đúng.

---

## Kiến trúc & Data flow

> [!INFO] Facade dịch OpenAI ↔ Orchestrator, không fork agent

**Thay đổi agent (duy nhất, additive):**
- `Orchestrator.withSessions(sessions: SessionStore): Orchestrator` → `new Orchestrator({ ...this.deps, sessions })`.
  Cho phép chạy lõi `chatEvents` với một store ephemeral thay cho store bền vững, mà không đụng logic.

**Module mới:**
- `src/http/openai/dto.ts` — Zod schema cho body OpenAI (`messages[]`, `model`, `stream?`, …).
- `src/http/openai/adapter.ts` — hàm thuần (dễ test, không side-effect):
  - `parseMessages(messages)` → `{ history, lastUserMessage, priorAssistant }`.
  - `recoverPending(priorAssistant)` → `PendingAction | null`.
  - `encodePending(pendingAction)` → `tool_calls[]` cho response.
  - `toCompletion(result, model)` → object `chat.completion`.
  - `toChunk(...)` / `doneChunk(...)` → `chat.completion.chunk` cho SSE.
- `src/http/routes.openai.ts` — wiring Fastify (giống style `routes.chat.ts`).
- Đăng ký trong `src/http/server.ts` (cùng child plugin sau Swagger hook); thêm tag Swagger `openai`.

**Luồng một request (buffered):**
1. Route gate trên `state.orchestrator` (giống `/chat`); chưa sẵn sàng → 503 error-shape OpenAI.
2. Validate body (Zod). Message cuối phải role `user`; nếu không → 400 `invalid_request_error`.
3. `parseMessages`: bỏ mọi `system` của caller (system prompt agent tự dựng phải thắng); các turn
   `user`/`assistant` trước → `history` (strip `tool_calls` khi đưa vào history cho LLM); message
   `user` cuối = input.
4. Tạo `ephemeral = new SessionStore()` (in-memory, không path). Seed `history`. Nếu
   `recoverPending(priorAssistant)` ≠ null → `ephemeral.setPending(...)`.
5. `scoped = orch.withSessions(ephemeral)`; gọi `scoped.handleChat(uid, sid, lastUserMessage)`
   (uid/sid hằng số vì store là per-request).
6. `chatEvents` step-1 tự xử pending (affirm→thực thi, negate→huỷ, unknown→bỏ pending, coi như request mới).
7. `toCompletion(result, requestedModel)`: `content = result.reply`; nếu `result.pendingAction` ≠ null →
   gắn `tool_calls` (encode) + `finish_reason:"stop"` (câu hỏi text là turn assistant bình thường; xem
   Technical Notes về lựa chọn finish_reason). Không pending → `finish_reason:"stop"`.

**Luồng streaming:** như trên nhưng gọi `handleChatStream`, map `ChatStreamEvent` → chunk (xem
UI/Streaming Behaviour).

---

## Streaming Behaviour

> [!INFO] Map `ChatStreamEvent` → SSE OpenAI
> - `token {text}` → chunk `{choices:[{delta:{content:text}}]}`
> - `tool_status` → **bỏ** (trạng thái tạm "đang đọc…", không thuộc câu trả lời)
> - `done {reply, pendingAction}` → nếu có `pendingAction`: chunk cuối mang `delta.tool_calls` + set
>   `finish_reason`; rồi phát `data: [DONE]`
> - Chunk đầu theo quy ước OpenAI: `delta:{role:"assistant"}`
> - Giữ kết nối/tương thích lỗi: lỗi trước khi stream (400/503) trả JSON error-shape thường; lỗi giữa
>   stream → kết thúc stream (không có frame `error` kiểu `/chat/stream`).

**Xử lý `reset` — quyết định S1 (live optimistic):**
Stream token trực tiếp giống `/chat/stream` để có TTFT thật. Với provider **enforce `json_schema`**
(LM Studio, v.v.) `reset` gần như không xảy ra nên output luôn đúng. Với provider **không enforce**,
một lần `reset` hiếm hoi không thể rút lại phần đã stream qua SSE OpenAI (không có frame retract) —
đây là hạn chế được ghi nhận; bản `/chat` buffered vẫn sạch. (Phương án thay thế S2 — buffer, chỉ phát
khi chốt ở `done`, luôn đúng nhưng mất TTFT — không chọn cho v1.)

---

## Edge Cases

> [!DANGER] Watch out for
> - **Message cuối không phải `user`** (kết thúc bằng assistant/tool) → 400 `invalid_request_error`.
> - **`messages` rỗng** → 400.
> - **`content` dạng mảng parts (OpenAI multimodal)** → chỉ ghép các part `text`; bỏ phần khác.
> - **Caller không giữ `tool_calls` khi echo** → không tái dựng được pending; nếu user gửi "có" thì bị
>   coi như request mới (an toàn: không thực thi nhầm). Ghi rõ **hợp đồng round-trip** trong Swagger.
> - **User gửi câu mới thay vì "có/không"** khi đang có pending → `chatEvents` bỏ pending, xử như request
>   mới (parity với `/chat`).
> - **`kind` của pending**: suy ra `confirmsBeforeRead(tool) ? 'read' : 'control'` — hai tập rời nhau nên
>   tái dựng đúng; `id` sinh mới (nhánh affirm không kiểm `actionId`), `summary` tái tính từ `(tool,args)`.
> - **MCP chưa kết nối** (degrade sang `KNOWN_TOOLS`) → control báo lỗi khi thực thi, giống `/chat`.
> - **Ephemeral store trim theo `maxTurns`** khi thread quá dài → khớp hành vi `/chat`.
> - **Client OpenAI strict** có thể phàn nàn assistant có `tool_calls` mà không kèm message `role:"tool"`
>   phía sau — ta chấp nhận vì contract của endpoint này do ta định nghĩa; documented.

---

## Technical Notes

> [!TIP] Dev notes
> - **Không đụng** `chatEvents`, `routes.chat.ts`, `SessionStore`; chỉ thêm `Orchestrator.withSessions`.
> - Encode pending **OpenAI-native**: `tool_calls:[{id, type:"function", function:{name:tool,
>   arguments:JSON.stringify(args)}}]`. Recover chỉ cần `(name, arguments)` → lossless.
> - **`finish_reason` cho turn có pending**: dùng `"stop"` (content là câu hỏi để người đọc trả lời;
>   `tool_calls` chỉ đi kèm để round-trip) thay vì `"tool_calls"` — tránh client ẩn `content` khi thấy
>   `finish_reason:"tool_calls"`. Ghi rõ trong Swagger.
> - **`model`**: chat chấp nhận mọi giá trị, echo lại trong response; `/v1/models` liệt kê id
>   `plant-assistant`.
> - **`usage`**: trả `{prompt_tokens:0, completion_tokens:0, total_tokens:0}` (agent không đếm token) —
>   documented.
> - **Error shape**: `{error:{message, type, code}}`. Map: chưa cấu hình (503) → `type:"server_error"`,
>   `code:"not_configured"`; body sai (400) → `type:"invalid_request_error"`; throw nội bộ (500) →
>   `type:"server_error"`.
> - **CORS/Swagger**: đã có sẵn ở `server.ts`; chỉ cần thêm tag + đăng ký route trong child plugin.
> - **DI/test**: dùng lại fake `LlmEngine`/`McpGateway` + `AppState.ready(orch)`; không cần service ngoài.

---

## Acceptance Criteria

> [!CHECK] Definition of Done
> - [ ] `POST /v1/chat/completions` buffered trả object `chat.completion` hợp lệ; chạy qua Orchestrator.
> - [ ] Control round-trip 2 lượt hoạt động: lượt 1 trả `content` "(Có/Không)" + `tool_calls`; lượt 2
>       (echo thread + "có") thực thi qua MCP và trả kết quả. Từ chối ("không") → huỷ.
> - [ ] Read-offer round-trip ("Bạn có muốn mình kiểm tra…?" → "có" → đọc + tóm tắt) hoạt động.
> - [ ] `stream:true` phát `chat.completion.chunk` đúng định dạng, kết `data: [DONE]`; `tool_status` bị bỏ.
> - [ ] `GET /v1/models` trả list với id `plant-assistant`.
> - [ ] System message của caller bị bỏ; system prompt agent thắng.
> - [ ] Message cuối không phải `user` / body sai → 400 error-shape OpenAI; chưa cấu hình → 503 error-shape.
> - [ ] Chỉ thêm `Orchestrator.withSessions`; `chatEvents`/`routes.chat.ts`/`SessionStore` không đổi.
> - [ ] Tests thêm (dùng fakes, không service ngoài) phủ các case trên; `npm test` + `npm run typecheck` xanh.
