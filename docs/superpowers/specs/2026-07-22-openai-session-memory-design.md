# Spec: Server-side session memory cho `/v1/chat/completions`

> [!NOTE] Meta
> **Ticket:** N/A · **Date:** 2026-07-22

---

## Problem

> [!WARNING] Problem Statement
> Endpoint OpenAI-compatible `POST /v1/chat/completions` hiện **stateless thuần**: mỗi request client
> phải gửi lại **cả `messages[]`** thì trợ lý mới nhớ được ngữ cảnh. Client muốn hành vi **giống
> ChatGPT** — chỉ cần đính một định danh phiên (`sessionId`) và gửi **message mới**, còn **server tự
> nhớ** phần còn lại của hội thoại. Ngoài ra client không phải lúc nào cũng có sẵn sessionId, nên khi
> thiếu, server phải tự cấp một phiên mới và báo lại để client tiếp nối.

---

## Goals

- Thêm **trí nhớ hội thoại server-side** cho `/v1/chat/completions`, khóa theo `(userId, sessionId)`,
  tái dùng đúng **persistent `SessionStore`** mà `/chat*` đang dùng — server là nguồn sự thật.
- **Luôn stateful, một nhánh duy nhất**: bỏ hẳn cơ chế dựng `SessionStore` tạm per-request. Thiếu
  `session_id` → server tự sinh `uuidv4`.
- Trả `sessionId` (dù client gửi hay server tự sinh) về client qua header **`X-Session-Id`** ở **cả**
  buffered lẫn streaming, để client dùng cho lượt sau.
- Giữ **tương thích ngược**: client OpenAI cũ gửi full `messages[]` (chưa biết `session_id`) vẫn chạy
  đúng nhờ **seed-on-empty**.
- Giữ nguyên **invariant an toàn**: control tool không chạy inline — xác nhận trước. Trong stateful
  mode, pending sống server-side; client chỉ cần trả `"có"/"không"` (giống `/chat`).
- Thay đổi tối thiểu agent core: chỉ thêm một getter; không đụng `chatEvents`, `routes.chat.ts`,
  `SessionStore`.

**Non-goals:** dọn dẹp / hết hạn session cũ trong `sessions.json` (file phình dần theo thời gian —
để lần sau); xác thực API key; đếm token thật; multi-process/multi-instance safety (đã là giới hạn
sẵn có của `SessionStore`).

---

## User Stories

| As a… | I want to… | So that… |
|-------|-----------|----------|
| Dev client chat | Đính `session_id` + gửi **một** message mới mỗi lượt | Server tự nhớ hội thoại, không phải gửi lại full history như ChatGPT |
| Dev client chat | Gọi lần đầu không có `session_id` và nhận lại `X-Session-Id` | Tiếp nối đúng phiên ở các lượt sau mà không cần tự sinh id |
| Client OpenAI cũ | Gửi full `messages[]` như trước (chưa biết `session_id`) | Vẫn hoạt động đúng, không vỡ tích hợp hiện có |
| Người dùng cuối | Trả lời "có" ở lượt sau để xác nhận điều khiển IoT | Không phải giữ/echo lại `tool_calls` — server nhớ hành động đang chờ |

---

## Functional Requirements

1. **Định danh phiên**:
   - `userId = body.user ?? 'openai'` (dùng field `user` chuẩn OpenAI).
   - `sessionId = body.session_id?.trim() || randomUUID()` — trống/whitespace/thiếu đều coi là thiếu
     và sinh `uuidv4`.
2. **Stateful, server-authoritative**: chạy agent trên **persistent `Orchestrator`** (`state.orchestrator`),
   chỉ lấy **message user cuối** trong `messages[]` làm input. Trí nhớ tích lũy tự động qua
   `remember()` sẵn có trong `chatEvents`.
3. **Seed-on-empty**: nếu phiên `(userId, sessionId)` **chưa có lịch sử** → nạp prefix `messages[]`
   (các message trừ message cuối) làm history ban đầu, và khôi phục pending từ `tool_calls` của
   assistant liền trước (qua `recoverPending`). Nếu phiên **đã có lịch sử** → **bỏ qua** history client
   gửi, chỉ lấy message cuối.
4. **Xác nhận IoT server-side**: control tool tạo pending lưu trong store (TTL 30' sẵn có). Lượt sau
   client chỉ gửi message `"có"/"không"` cùng `session_id` → `detectConfirmation` trong `chatEvents`
   tự thực thi/huỷ. Response vẫn kèm `tool_calls` (thông tin thêm, vô hại; client mới không bắt buộc
   giữ).
5. **Trả sessionId về client**:
   - Header **`X-Session-Id: <sessionId>`** ở **cả** buffered lẫn streaming.
   - Thêm field **`session_id`** vào body response ở mode **buffered** (tiện đọc; SSE không có body
     top-level nên chỉ dựa header).
6. **CORS**: expose header `X-Session-Id` để browser (khác origin) đọc được qua fetch.
7. **Hành vi cũ giữ nguyên**: `GET /v1/models`, định dạng `chat.completion`/`chat.completion.chunk`,
   `finish_reason: 'stop'`, `usage` = 0, streaming `data: [DONE]`.

---

## Design

### Luồng xử lý mới (`routes.openai.ts`)

```
POST /v1/chat/completions
  parse body (Zod)  → { model, messages, stream, session_id?, user? }
  parseMessages(messages) → { history, lastUserMessage, priorAssistant }   // tái dùng nguyên
  userId    = body.user ?? 'openai'
  sessionId = body.session_id?.trim() || randomUUID()

  // seed-on-empty — chạy trên PERSISTENT store, không còn ephemeral
  const store = orch.sessions
  if (store.getHistory(userId, sessionId).length === 0) {
    if (history.length) store.append(userId, sessionId, ...history)
    const pending = recoverPending(priorAssistant)
    if (pending) store.setPending(userId, sessionId, pending)
  }

  buffered:
    reply.header('X-Session-Id', sessionId)
    result = await orch.handleChat(userId, sessionId, lastUserMessage)
    return { ...toCompletion(result, ...), session_id: sessionId }

  streaming:
    reply.hijack()
    writeSseHead(raw, { 'X-Session-Id': sessionId })      // header trước body SSE
    for await (event of orch.handleChatStream(userId, sessionId, lastUserMessage, {signal}))
      … (giữ nguyên logic phát token/finalChunk)
```

Khác biệt cốt lõi so với code hiện tại: **không** còn `new SessionStore()` / `orch.withSessions(ephemeral)`;
route thao tác trực tiếp trên persistent store của orchestrator rồi chạy `orch` thẳng.

### Thay đổi theo file

| File | Thay đổi |
|------|----------|
| `src/http/openai/dto.ts` | Thêm `session_id: z.string().optional()`, `user: z.string().optional()` vào `OpenAiChatRequestSchema` (đã `.passthrough()`, thêm để validate + type hoá) |
| `src/agent/orchestrator.ts` | Thêm getter `get sessions(): SessionStore { return this.deps.sessions }` (đồng bộ với getter `engine` đã có) |
| `src/http/sse.ts` | `writeSseHead(raw, extraHeaders?: Record<string,string>)` — merge vào object truyền cho `raw.writeHead`; `/chat/stream` gọi không đổi (tham số optional) |
| `src/http/server.ts` | CORS thêm `exposedHeaders: ['X-Session-Id']` |
| `src/http/routes.openai.ts` | Resolve userId/sessionId (uuid fallback); seed-on-empty vào persistent store; bỏ `UID`/`SID`/ephemeral/`withSessions`; chạy `orch` trực tiếp; set `X-Session-Id` (2 mode) + body `session_id` (buffered); cập nhật `chatBodySchema` + description Swagger (nêu session_id + trí nhớ server-side, bỏ chữ "stateless") |

### Giữ nguyên (không đụng)
- `parseMessages`, `recoverPending`, `toCompletion`, `finalChunk`, `roleChunk`, `contentChunk` — tái dùng.
- Agent core (`chatEvents`, `remember`, `detectConfirmation`), `routes.chat.ts`, `SessionStore`, RAG, MCP.

---

## Data flow

**Lượt 1 (client mới, không session_id):** client gửi `{messages:[{user:"cây dâu vàng lá?"}]}` →
server sinh `sessionId=uuid`, store rỗng nên seed (history rỗng, không pending) → chạy agent → nhớ
(user+reply) vào store → trả reply + header `X-Session-Id: <uuid>` + body `session_id`.

**Lượt 2 (client tiếp nối):** client gửi `session_id=<uuid>` + `{messages:[{user:"vậy tưới bao nhiêu?"}]}`
→ store đã có lịch sử → bỏ qua history client, lấy message cuối, agent thấy đủ ngữ cảnh lượt 1 → trả lời.

**Xác nhận IoT:** lượt N agent quyết định control tool → tạo pending server-side → reply "(Có/Không)".
Lượt N+1 client gửi `session_id` + `{messages:[{user:"có"}]}` → `getPending` trả pending → thực thi.

**Client OpenAI cũ (full history, không session_id):** mỗi request sinh uuid mới, store rỗng → seed
từ full `messages[]` (+ pending từ `tool_calls` nếu có) → tương đương hành vi stateless cũ. (Nếu client
tái dùng `X-Session-Id` trả về thì tự động chuyển sang chế độ nhớ server-side.)

---

## Error handling

- `orchestrator` chưa cấu hình → 503 `{error:{...,code:'not_configured'}}` (giữ nguyên).
- Body sai schema → 400 `invalid_body`; `messages` rỗng / không kết bằng user → 400 `invalid_messages`
  (giữ nguyên qua `parseMessages`/`BadRequestError`).
- Lỗi runtime buffered → 500; streaming → frame lỗi rồi kết. `X-Session-Id` (streaming) đã gửi trong
  head trước khi lỗi phát sinh → client vẫn biết phiên.
- `session_id` rỗng/whitespace → coi như thiếu → sinh uuid (không lỗi).

---

## Testing strategy

Bổ sung vào `tests/openai.http.test.ts` + `tests/openai.stream.test.ts` (fake LLM/MCP, không service ngoài):

1. **Nhớ qua nhiều lượt**: cùng `session_id`, lượt 2 chỉ gửi message mới → agent nhận được history lượt 1
   (assert store/history hoặc reply phụ thuộc ngữ cảnh).
2. **Sinh uuid khi thiếu**: không `session_id` → response có header `X-Session-Id` (uuid hợp lệ) + body
   `session_id`; hai request liên tiếp không session_id → hai uuid khác nhau (phiên độc lập).
3. **Seed-on-empty**: gửi full `messages[]` (nhiều lượt) + không session_id → agent thấy đủ ngữ cảnh
   (tương thích ngược).
4. **Không seed khi đã có lịch sử**: session đã có history + client gửi thêm history rác → history rác
   bị bỏ qua (không nhân đôi/không nhiễm).
5. **Xác nhận server-side**: lượt điều khiển tạo pending; lượt sau gửi "có" cùng session_id → thực thi
   (không cần echo tool_calls).
6. **Streaming trả header**: `stream:true` → head SSE chứa `X-Session-Id`.
7. **CORS**: `exposedHeaders` chứa `X-Session-Id` (assert cấu hình hoặc header trên response).

---

## Rollout / compatibility

- Không breaking change cho client OpenAI hiện có (seed-on-empty bao phủ). Client mới chỉ cần thêm
  `session_id` + đọc `X-Session-Id`.
- Persistent store dùng chung với `/chat*` — va chạm key chỉ khi client `/chat` dùng đúng
  `userId='openai'` + trùng sessionId (hiếm, chấp nhận).
- Lưu ý vận hành: `sessions.json` tích lũy phiên (kể cả uuid tự sinh) → phình dần; cleanup để lần sau
  (non-goal).
