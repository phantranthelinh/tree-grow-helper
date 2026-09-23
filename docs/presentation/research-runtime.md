# Research: "Model trả lời như thế nào" — I/O contract, demo, vận hành

> Tư liệu slide-ready. Mọi khẳng định có dẫn chứng `file:line`. Repo: `D:\workspace\ai-server`.

---

## Slide 1 — Kiến trúc tổng quan (recap nhanh, để mở bài)

- AI Server đứng giữa chat app và MCP điều khiển IoT; LLM local qua lớp OpenAI-compatible (`src/llm/index.ts` `OpenAICompatEngine`).
- Mọi lượt LLM trả **đúng một JSON quyết định**: `{type:"reply"}` hoặc `{type:"tool"}` — đây là "I/O contract" nội bộ giữa orchestrator và model nhỏ (qwen2.5-3b / gemma-4-e4b).
- Ra ngoài, contract lại đổi lớp: client thấy **OpenAI Chat Completions** hoặc **SSE tự định nghĩa** — orchestrator dịch JSON quyết định đó thành 2 hình dạng khác nhau tùy endpoint.
- Nguồn: [README.md](../../README.md) sơ đồ đầu file; [CLAUDE.md](D:\workspace\ai-server\CLAUDE.md) mục "Architecture".

Speaker notes: Nhấn mạnh có **hai tầng contract**: (1) contract nội bộ model↔orchestrator (JSON decision, `src/agent/decision.ts`), (2) contract ngoài orchestrator↔client (OpenAI-compat JSON hoặc SSE). Slide sau đi sâu từng tầng.

---

## Slide 2 — I/O contract nội bộ: JSON decision schema

- File: `src/agent/decision.ts:9-33`. Field order trong schema: `reasoning → type → message → tool → args` — **cố ý**, không phải ngẫu nhiên.
- `reasoning` (optional): 1-2 câu chain-of-thought, **không bao giờ lộ ra người dùng** (`src/agent/decision.ts:26`).
- `type`: `"reply"` (trả lời) hoặc `"tool"` (gọi 1 MCP tool).
- Model nhỏ (3B) đóng JSON ngay sau `args` nếu `message` đặt sau — vì vậy few-shot luôn viết `message` TRƯỚC `tool`/`args` (`src/domain/fewshot.ts:6-10`).
- Rule cuối prompt (đặt SAU CÙNG vì model nhỏ ưu tiên phần gần cuối — "recency"): `type:"reply"` phải là **văn xuôi liền mạch 2-5 câu**, cấm gạch đầu dòng/số thứ tự, cấm kết thúc bằng dấu `:` (`src/llm/prompt.ts` dòng cuối file, xem excerpt dưới).

```ts
// src/llm/prompt.ts (cuối buildSystemPrompt)
'\nQUAN TRỌNG khi type="reply": viết "message" thành ĐOẠN VĂN liền mạch 2-5 câu,
KHÔNG dùng gạch đầu dòng hay danh sách đánh số, và KHÔNG kết thúc "message"
bằng dấu hai chấm ":". Nói thẳng nội dung, không hứa "dưới đây là..." rồi bỏ dở.'
```

Speaker notes: Đây là 2 quirk "trông vô lý nhưng có lý do" của model 3B, được README/CLAUDE.md gọi là "silent regression" — có test riêng bảo vệ (`tests/prompt.test.ts`). Dùng để giải thích tại sao code trông "kỳ lạ" (field order, vị trí rule) lại là chủ đích.

---

## Slide 3 — 6 ví dụ request→response THẬT (từ fixtures test, không bịa)

Tất cả trích từ `tests/orchestrator.test.ts` (test dùng `FakeLlm`/`FakeMcp`, input là JSON quyết định y hệt model thật sẽ trả về; câu tiếng Việt là nguyên văn user input trong test).

**(a) Reply thuần từ RAG/kiến thức — không đụng MCP**
`tests/orchestrator.test.ts:97-103`
```
User:  "xin chào"
Model: {"type":"reply","message":"Chào bạn!"}
→ res.reply = "Chào bạn!"; mcp.calls.length = 0
```

**(b) READ tool tự chạy rồi model nói tiếp**
`tests/orchestrator.test.ts:123-136`
```
User:  "ngưỡng tưới đang đặt bao nhiêu?"
Turn1: {"type":"tool","tool":"get_device_config","args":{"device_id":"esp32-01"}}
  → orchestrator tự gọi MCP get_device_config → "threshold=75"
Turn2: {"type":"reply","message":"Ngưỡng tưới hiện tại là 75%."}
→ mcp.calls = 1 lần; res.pendingAction = null
```

**(c) CONTROL tool → hỏi confirm → "có" → thực thi**
`tests/orchestrator.test.ts:138-163`
```
User:  "tưới nước cho cây đi"
Model: {"type":"tool","tool":"set_pump","args":{"device_id":"esp32-01","on":true}}
→ mcp.calls = 0 (CHƯA chạy); res.pendingAction.tool = "set_pump"
→ res.reply chứa "Bật bơm nước..." + "(Có/Không)"

User lượt sau: "có"  (hoặc orch.confirm(userId, sessionId, id, true))
→ mcp.calls = 1 (set_pump chạy thật); res.reply chứa "Đã thực hiện"
```

**(d) "không" → hủy**
`tests/orchestrator.test.ts:176-182`
```
User:  "tưới đi" → pendingAction set_pump
User:  "không"
→ mcp.calls = 0; res.reply chứa "Đã hủy"
```

**(e) Multi-step — 2 tool trong 1 lượt hội thoại (chưa biết device_id → list rồi mới điều khiển)**
`src/domain/fewshot.ts:21-25` (ví dụ 3 trong few-shot, dùng để dạy model — luồng y hệt orchestrator thật thực thi qua `MAX_TOOL_STEPS`):
```
User:   "Bật đèn cho cây."
Turn1:  {"type":"tool","message":"Mình sẽ xem danh sách thiết bị...","tool":"list_devices","args":{}}
  [Kết quả list_devices] [{"device_id":"esp32-01","name":"Khu A"}]
Turn2:  {"type":"tool","message":"Mình sẽ bật đèn cho khu A...","tool":"set_light","args":{"device_id":"esp32-01","on":true}}
  → set_light là CONTROL → dừng lại, tạo pendingAction, chờ xác nhận
```
Bằng chứng số bước bị chặn: `tests/orchestrator.test.ts:218-229` — 4 lượt tool liên tiếp bị cắt còn đúng 3 (`MAX_TOOL_STEPS=3`, `src/config.ts:31`), sau đó ép trả lời bằng `llm.complete` fallback.

**(f) Lỗi/degraded — MCP route error lộ thẳng cho user, không giấu**
`tests/orchestrator.test.ts:184-197`
```
User:  "ngưỡng tưới bao nhiêu?" → tool get_device_config
MCP:   throw Error("Error POSTing to endpoint (HTTP 404): Not Found")
→ res.reply chứa "404" và chữ "MCP"; llm.jsonCalls = 1 (KHÔNG lặp lại vòng lặp — short-circuit)
```
và **not_configured 503** khi orchestrator chưa sẵn sàng: `tests/setup-routes.test.ts:111-121`, `tests/openai.http.test.ts:75-85`.

Speaker notes: (a)-(f) đủ dựng demo trực tiếp: reply thuần, read tự động, control có xác nhận, hủy lệnh, multi-step (list rồi control), và lỗi MCP hiển thị rõ ràng thay vì bịa. Tất cả đều là hành vi ĐÃ ĐƯỢC TEST, không phải suy đoán.

---

## Slide 4 — Bản đồ endpoint (method / body / response / mã lỗi)

| Endpoint | Method | Body | Response chính | Mã lỗi |
|---|---|---|---|---|
| `/health` | GET | – | `{status:"ok",phase}` | – | 
| `/setup` | GET | – | HTML trang cấu hình | – |
| `/api/setup/status` | GET | – | `{phase,steps,error,config,defaults}` | – |
| `/api/setup/connect` | POST | `{provider,baseURL,apiKey?,model,embedModel,mcpUrl?}` | `{ok:true,phase}` | 400 invalid_request, 409 busy, 502 (probe fail code) |
| `/api/setup/mcp/test` | POST | `{url}` | `{ok,toolCount,tools[]}` | 400 invalid_request, 502 unreachable |
| `/api/setup/rag/rebuild` | POST | – | `{ok,profile,docs,diseases,storeSize,ms}` | 503 not_configured, 409 busy/rag_disabled, 502 embed_failed |
| `/chat/stream` | POST | `{userId,sessionId,message}` | SSE (xem Slide 5) | 503 not_configured, 400 invalid_request (JSON thường, không SSE) |
| `/v1/chat/completions` | POST | `{model,messages[],stream?,session_id?,user?}` | `chat.completion` hoặc SSE `chat.completion.chunk` | 503 not_configured, 400 invalid_request/invalid_messages, 500 internal_error |
| `/v1/models` | GET | – | `{object:"list",data:[{id:"plant-assistant"...}]}` | – |
| `/docs`, `/docs/json` | GET | – | Swagger UI / OpenAPI spec | – |

Nguồn: `src/http/routes.setup.ts:87-216`, `src/http/routes.chat.ts:40-162`, `src/http/routes.openai.ts:53-172`.

### Vì sao `/v1/chat/completions` là STATEFUL — điểm nhấn quan trọng

- Session key = `(body.user ?? "openai", body.session_id)` — `src/http/routes.openai.ts:106-107,113-118`.
- Thiếu/rỗng `session_id` → server tự sinh `uuidv4()`, trả về ở header `X-Session-Id` (`src/http/routes.openai.ts:107,125,138`) — non-stream còn echo trong body (`session_id: sessionId`, dòng 127).
- **Session MỚI**: nếu client gửi cả `messages[]` (kiểu OpenAI cũ, full-history), toàn bộ thread được nạp làm lịch sử ban đầu (`sessions.append`, dòng 114-115) — giữ tương thích ngược với client stateless cũ.
- **Session đã có lịch sử**: từ lượt sau, server **bỏ qua** `messages[]` gửi lên, chỉ dùng `thread.lastUserMessage` — bằng chứng: `tests/openai.http.test.ts:330-357` ("ignores caller-supplied history once the session already has memory" — gửi `"RÁC lịch sử"` không lọt vào ngữ cảnh model).
- **Tại sao quan trọng cho luồng confirm**: một khi có `pendingAction`, client CHỈ CẦN gửi "có"/"không" + `session_id` — KHÔNG cần echo lại `tool_calls` — server tự nhớ hành động đang chờ phía server-side. Bằng chứng: `tests/openai.http.test.ts:359-378` ("confirms a control action server-side... Client sends ONLY 'có' — no echoed tool_calls").
- Đường lùi tương thích: nếu client VẪN echo object assistant kèm `tool_calls` (client cũ, stateless), `recoverPending()` (`src/http/openai/adapter.ts:69-80`) tái dựng lại `PendingAction` y hệt — chỉ dùng khi session còn trống (turn đầu của 1 session mới).
- Đây là lý do README gọi đây là "trí nhớ server-side (như ChatGPT)" (`README.md` mục `/v1/chat/completions`).

Speaker notes: Khác biệt lớn nhất so với OpenAI API thật: OpenAI API là stateless (client tự giữ toàn bộ `messages[]`); ở đây server **chủ động giữ session** để tránh phải rely vào client echo đúng `tool_calls` (dễ sai, dễ bị bịa nội dung) — an toàn hơn cho hành động điều khiển thiết bị thật.

---

## Slide 5 — SSE contract của `POST /chat/stream`

- Response 200 luôn là `text/event-stream; charset=utf-8`, header `cache-control: no-cache, no-transform`, `x-accel-buffering: no` (chống proxy buffer) — `src/http/sse.ts:8-18`.
- Heartbeat: dòng comment `: ping` mỗi 15s (`HEARTBEAT_MS`, `src/http/routes.chat.ts:7,116`) để giữ kết nối sống khi model đang nghĩ lâu.
- 5 loại frame, mỗi frame `event: <tên>\ndata: <json 1 dòng>\n\n` — `src/http/routes.chat.ts:130-149`:

| event | data | Khi nào |
|---|---|---|
| `token` | `{text}` | Nối dần vào câu trả lời đang hiện — chỉ phần `message` của decision JSON được stream (không có `reasoning`, không có tool call) |
| `tool_status` | `{tool, note}` | Trạng thái tạm khi đang đọc dữ liệu (READ tool tự chạy) — không thuộc nội dung câu trả lời |
| `reset` | `{}` | Xóa phần đã hiện của lượt này — model tự sửa/thử lại (ví dụ phát hiện reply cụt) |
| `done` | `{reply, pendingAction}` | Kết thúc lượt; `pendingAction != null` nếu cần hỏi Có/Không |
| `error` | `{message}` | Kết thúc do lỗi giữa chừng |

- Chỉ `message` field của decision JSON lên wire — được quét tăng dần bởi `src/agent/streamParser.ts` (incremental JSON field scanner); `reasoning` và tool call **không bao giờ** ra ngoài.
- Lỗi TRƯỚC khi bắt đầu stream (503 not_configured, 400 invalid_request) vẫn là JSON thường, KHÔNG phải SSE — `tests/http.stream.test.ts:100-120`.
- Một chi tiết đáng chú ý: khi 1 token cắt ngang một surrogate pair (emoji), server vẫn phải escape đúng để không lộ `U+FFFD` trên wire — bằng chứng `tests/http.stream.test.ts:157-172` (test "Dâu 🍓!").

### Transcript SSE mẫu (dựng lại đúng format thật, dùng để chiếu slide)

```
POST /chat/stream
{"userId":"u1","sessionId":"s1","message":"Cây dâu của mình bị vàng lá, nên làm gì?"}

: ping

event: token
data: {"text":"Lá dâu vàng thường do "}

event: token
data: {"text":"tưới quá nhiều hoặc thiếu đạm."}

event: done
data: {"reply":"Lá dâu vàng thường do tưới quá nhiều hoặc thiếu đạm.","pendingAction":null}
```

Trường hợp CONTROL cần xác nhận (`done` mang `pendingAction`), dựng từ `tests/http.stream.test.ts:140-155`:

```
event: token
data: {"text":"Bạn xác nhận thực hiện: \"Bật bơm nước thiết bị d1\"? (Có/Không)"}

event: done
data: {"reply":"Bạn xác nhận thực hiện: \"Bật bơm nước thiết bị d1\"? (Có/Không)","pendingAction":{"tool":"set_pump","id":"...","summary":"Bật bơm nước thiết bị d1","kind":"control","args":{"device_id":"d1","on":true}}}
```

Speaker notes: Nhấn "chỉ message lên wire" — đây là lý do reasoning + tool-calls không lộ ra client dù model có "suy nghĩ" ra chúng nội bộ. Đồng thời nhấn frame `reset` là cơ chế tự phục hồi khi model bắt đầu viết kiểu bị cấm (list/dấu `:`) rồi phải generate lại — một ví dụ cụ thể invariant ở Slide 2 được thực thi runtime.

---

## Slide 6 — Vận hành: two-phase startup & graceful degradation

- **Phase 1**: `src/index.ts:21-30` — Fastify listen NGAY (`waiting_config`), không chờ LLM. Log: "AI server listening..." rồi mở `/setup` (trừ khi `SETUP_OPEN_BROWSER=0`).
- **Phase 2 (auto-reconnect)**: `src/index.ts:32-42` — đọc `data/llm-config.json` nếu có, gọi `applyLlmConfig` lại (không cần UI). Thất bại → log warning, chờ user vào `/setup`.
- `applyLlmConfig` (`src/setup/init.ts:48-78`): probe (models+chat+embed) → lưu config → `state.beginInitializing` → chạy `runInitPipeline` NỀN (không block response), UI poll `GET /api/setup/status`.
- `runInitPipeline` (`src/setup/init.ts:85-154`) — 3 bước tuần tự, mỗi bước ghi `state.setStep(id,status,detail)`:
  1. **MCP connect**: thử `mcp.listTools()`; lỗi → fallback `KNOWN_TOOLS` (catalog tĩnh), log cảnh báo bằng tiếng Việt, "điều khiển sẽ lỗi đến khi MCP sẵn sàng" (dòng 108-113).
  2. **RAG build**: nếu `RAG_DISABLED=1` → bỏ qua hẳn, không embed (dòng 119-122); ngược lại `ingestAll()` lỗi → fallback chạy KHÔNG RAG (dòng 130-134), không crash.
  3. Assemble `Orchestrator`, `state.setReady(orch)` → phase = `ready`.
- **Chỉ throw bất ngờ** mới đưa state vào `error` (`state.crash`, `src/setup/init.ts:73-75`) — mọi lỗi biết trước (MCP, RAG) đều degrade êm.
- **Gate chat không theo `phase` mà theo `orchestrator != null`** (`src/setup/state.ts:45-46` docstring + `routes.chat.ts:100-104`, `routes.openai.ts:83-87`) → khi user vào `/setup` để re-configure, orchestrator CŨ vẫn phục vụ chat bình thường cho tới khi orchestrator MỚI sẵn sàng (không có downtime giữa 2 lần cấu hình).
- **Runtime reconfigure RAG không cần restart**: `POST /api/setup/rag/rebuild` (`src/setup/init.ts:166-195`) — build store MỚI xong mới swap (`orch.withRag(store, profile)`, dòng 183) — build-then-swap: lỗi ingest giữ nguyên store cũ, không có cửa sổ "half-broken". MCP/LLM/session không đụng tới.
- Health check dùng chính route `/health` (Docker `HEALTHCHECK`, `Dockerfile:37-38`) — "healthy" ≠ "ready" (có thể vẫn `waiting_config`).

Speaker notes: Thông điệp chính: **"server luôn up ngay, cấu hình LLM là việc runtime chứ không phải boot-time"** — khác hẳn kiểu app cần đủ env mới start được. Điều này giải thích tại sao Docker container không cần biết trước LLM đang chạy ở đâu lúc build image.

---

## Slide 7 — Bằng chứng chất lượng (test suite)

Chạy thật tại chỗ (`npx vitest run --reporter=basic`, không cần service ngoài — đúng như CLAUDE.md mô tả):

```
Test Files  36 passed (36)
     Tests  263 passed (263)
```

(24 file trong `tests/`, còn lại colocated `src/**/*.test.ts` — đúng 2 glob trong `vitest.config.ts`.) File lớn nhất: `tests/orchestrator.test.ts` (34 test, 513 dòng) — bảo vệ toàn bộ agent loop; `tests/openai.http.test.ts` (17 test) và `tests/setup-routes.test.ts` (13 test) bảo vệ đúng 2 tầng contract nói ở Slide 4-5.

**Các invariant cụ thể đang được test khóa lại** (mỗi dòng = 1 test thật, không phải mô tả suông):
- Control tool KHÔNG BAO GIỜ tự chạy — luôn tạo `pendingAction` trước (`tests/orchestrator.test.ts:138-149`).
- Reasoning field KHÔNG BAO GIỜ lộ ra `res.reply` (`tests/orchestrator.test.ts:105-113`).
- Vòng lặp tool bị chặn cứng ở `MAX_TOOL_STEPS=3` (`tests/orchestrator.test.ts:218-229`).
- Lỗi route MCP (404/-32601/ECONNREFUSED) hiển thị thẳng cho user, KHÔNG được LLM "diễn giải lại" thành câu trả lời bình thường (`tests/mcp-errors.test.ts`, `tests/orchestrator.test.ts:184-216`).
- Field order `message` trước `tool`/`args` trong few-shot — guard hồi quy (`tests/prompt.test.ts:40-48`).
- Rule "văn xuôi, cấm dấu `:` cuối" phải nằm SAU few-shot trong prompt (recency) — `tests/prompt.test.ts:21-24`.
- Session server-side: lịch sử client gửi lên bị bỏ qua một khi session đã có bộ nhớ thật (`tests/openai.http.test.ts:330-357`).
- Xác nhận điều khiển không cần client echo `tool_calls` (`tests/openai.http.test.ts:359-378`).
- RAG rebuild là build-then-swap, không có nửa vời (`tests/rebuild-rag.test.ts`, `src/setup/init.ts:183`).
- 503/409/502/400 đúng mã theo từng nguyên nhân (`tests/setup-routes.test.ts` 13 test bao phủ toàn bộ ma trận lỗi).

Speaker notes: Không phải "chúng tôi nói nó an toàn" — mà "263 test đang khóa hành vi an toàn lại", chạy < 1 phút, không cần LM Studio/MCP thật (toàn bộ dùng `FakeLlm`/`FakeMcp` qua interface `LlmEngine`/`McpGateway`).

---

## Slide 8 — Kịch bản demo live (bắt buộc)

Giả định server đã chạy `npm start` (hoặc container), đã qua `/setup` một lần (phase=ready). 3 bước theo đúng thứ tự để trình chiếu trên máy thật:

**Bước 1 — Reply thuần (RAG), xem SSE token chảy theo thời gian thực**
```bash
curl -N -X POST localhost:8787/chat/stream \
  -H 'content-type: application/json' \
  -d '{"userId":"demo","sessionId":"demo-1","message":"Cây dâu của mình bị vàng lá, nên làm gì?"}'
```
Kết quả mong đợi: nhiều frame `event: token` chảy dần (câu tư vấn dựa trên RAG), rồi 1 frame cuối `event: done` với `data.pendingAction` **có thể khác null** — model có thể kèm đề xuất đọc cảm biến (theo Ví dụ 1 few-shot, `src/domain/fewshot.ts:13-15`); nếu có, đó chính là bước 2.

**Bước 2 — Control tool: yêu cầu điều khiển → server hỏi xác nhận (chưa chạy tool)**
```bash
curl -s -X POST localhost:8787/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"plant-assistant","session_id":"demo-2","messages":[{"role":"user","content":"Tưới nước cho esp32-01 10 giây"}]}'
```
Kết quả mong đợi: HTTP 200, `choices[0].message.content` chứa `"(Có/Không)"`, `choices[0].message.tool_calls[0].function.name = "set_pump"` — **thiết bị CHƯA được tưới** (kiểm tra bằng cách chưa thấy log MCP `callTool`).

**Bước 3 — Xác nhận bằng "có" (chỉ cần session_id, không cần echo tool_calls) → tool thực thi thật**
```bash
curl -s -X POST localhost:8787/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"plant-assistant","session_id":"demo-2","messages":[{"role":"user","content":"có"}]}'
```
Kết quả mong đợi: `choices[0].message.content` chứa `"Đã thực hiện"`; đây là lúc `set_pump` thật sự được gọi qua MCP → ESP32 bơm nước. Nếu muốn demo "hủy" thay vì "thực thi", đổi `"có"` thành `"không"` ở bước 3 → kỳ vọng `"Đã hủy"`, không có lệnh nào được gửi tới MCP.

Speaker notes: Bước 2→3 là màn trình diễn quan trọng nhất của buổi demo: chứng minh **an toàn hành động** (control không tự chạy) VÀ **stateful session** (bước 3 không cần gửi lại toàn bộ `messages[]`/`tool_calls`, chỉ 2 chữ "có"). Nếu MCP thật chưa sẵn sàng lúc demo, bước 3 vẫn trả 200 nhưng nội dung sẽ báo lỗi route (404/-32601) thay vì "Đã thực hiện" — đó CŨNG là một behavior đáng demo (graceful, không giả vờ thành công).

---

## Phụ lục — nguồn tệp đã đọc

- `README.md` (toàn bộ) — sơ đồ kiến trúc, hướng dẫn API, cơ chế chính, databank, giới hạn.
- `src/http/server.ts`, `routes.chat.ts`, `routes.openai.ts`, `routes.setup.ts`, `dto.ts`, `sse.ts`, `openai/adapter.ts`, `openai/dto.ts` — toàn bộ.
- `src/setup/init.ts`, `state.ts`, `mcpConfig.ts`, `src/index.ts`, `src/config.ts` — toàn bộ.
- `src/agent/decision.ts`, `src/domain/fewshot.ts`, `src/mcp/policy.ts`, `src/llm/prompt.ts` (đoạn cuối) — I/O contract + safety policy.
- Tests đọc toàn văn: `tests/orchestrator.test.ts`, `tests/http.stream.test.ts`, `tests/http.test.ts`, `tests/openai.http.test.ts`, `tests/confirmation.test.ts`, `tests/mcp-errors.test.ts`, `tests/init.test.ts`, `tests/setup-routes.test.ts`, `tests/prompt.test.ts`.
- `Dockerfile`, `docker-compose.yml`, `.env.example`, `DEPLOY.md`, `.github/workflows/test.yml`, `.github/workflows/docker-publish.yml` — toàn bộ.
- `docs/rag-course-review.md`, `docs/rag-course-todo.md` — đọc lướt (đầu file): đây là ghi chú so sánh với 1 khóa học RAG bên ngoài + TODO nâng cấp RAG, KHÔNG phải tài liệu kiến trúc/slide sẵn có cho chủ đề I/O contract — không dùng trực tiếp cho slide này ngoài việc xác nhận không có sơ đồ nào khác cần tái sử dụng.
- Test suite chạy thật: `npx vitest run --reporter=basic` → 36 file, 263 test, PASS toàn bộ (một số dòng `EBUSY` là noise cache Windows của Vitest, không phải test fail — xác nhận qua lần chạy lặp lại cho kết quả pass ổn định).
