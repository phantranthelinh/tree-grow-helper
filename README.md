# AI Server — trợ lý chăm cây & điều khiển thiết bị (LLM local)

AI Server đứng giữa **app chat** và **MCP điều khiển thiết bị** (`plant-tree-iot/mcp-server`).
Nhận câu chat tiếng Việt về cây/tình trạng → hiểu bằng **LLM local (LM Studio)** →
đọc trạng thái hoặc **điều khiển thiết bị qua MCP** (luôn xác nhận trước khi thực thi).

Giai đoạn 1 **chỉ hỗ trợ cây dâu tây (strawberry)**; thêm cây khác = thêm 1 file profile JSON.

```
Chat App ──HTTP──► AI Server ──► Orchestrator ─► LLM (LM Studio, qwen2.5-3b)
                                     │         ─► RAG (profile dâu, embeddings bge-m3)
                                     │         ─► Session memory (multi-turn)
                                     │         ─► Tool policy (đọc = tự chạy / điều khiển = xác nhận)
                                     └─────────► MCP client ─streamable-http→ plant-tree MCP
```

## Yêu cầu

1. **Node.js 18+** (đã test trên Node 22).
2. **Một LLM có API tương thích OpenAI**, đã load 1 model chat + 1 model embedding. Chọn provider ngay trong UI cấu hình (`/setup`):
   - **LM Studio** — `http://localhost:1234/v1` (không cần API key).
   - **Ollama** (≥ 0.5) — `http://localhost:11434/v1` (không cần API key).
   - **Google Gemini** — lớp tương thích OpenAI (`https://generativelanguage.googleapis.com/v1beta/openai/`, cần API key; embedding gợi ý `text-embedding-004`).
   - **OpenAI-compatible khác** (vLLM, LiteLLM, OpenAI…) — nhập Base URL + API key nếu có.
3. **plant-tree MCP** chạy ở chế độ **streamable-http** (xem bên dưới) tại `http://localhost:8000/mcp`.

### Bật MCP ở chế độ streamable-http

Repo `plant-tree-iot/mcp-server/server.py` mặc định chạy **stdio**. Sửa như sau:

```python
# Trước
mcp = FastMCP(MCP_SERVER_NAME)
if __name__ == "__main__":
    mcp.run()

# Sau
mcp = FastMCP(MCP_SERVER_NAME, host="0.0.0.0", port=8000)
if __name__ == "__main__":
    mcp.run(transport="streamable-http")
```

MCP này bridge tới REST API .NET (`http://localhost:5000`) → MQTT → ESP32, nên backend .NET
cũng cần chạy để tool điều khiển hoạt động thật.

## Cài đặt & chạy

```bash
npm install
cp .env.example .env      # tuỳ chọn — env chỉ prefill form cấu hình
npm start                 # chạy AI server (http://localhost:8787)
```

**Lần chạy đầu:** app tự mở trình duyệt vào **http://localhost:8787/setup** — chọn provider,
nhập Base URL/API key, chọn model chat + embedding, bấm **Kết nối**. App kiểm tra kết nối
(list model → 1 chat token → 1 embedding), rồi mới chạy MCP + nạp RAG (hiển thị tiến trình).
Cấu hình được lưu vào `data/llm-config.json`.

**Các lần sau:** app tự đọc `data/llm-config.json`, tự kiểm tra & kết nối lại — bỏ qua UI.
Nếu kết nối lỗi (đổi máy, tắt LLM…) → quay lại `/setup` để cấu hình lại.

- Trước khi cấu hình xong, `POST /chat` và `/chat/confirm` trả **503 `{ "error": "not_configured" }`**.
- MCP offline khi khởi tạo → dùng catalog tool tĩnh (KNOWN_TOOLS); lệnh điều khiển báo lỗi cho tới khi MCP lên.
- Embedding lỗi khi nạp RAG → chạy không có RAG (nhưng bước kiểm tra kết nối đã bắt lỗi embedding sớm).
- `SETUP_OPEN_BROWSER=0` để không tự mở trình duyệt (mặc định trong Docker).
- `SETUP_PROBE_TIMEOUT_MS` (mặc định 10000) — tăng lên nếu Ollama nạp model lần đầu chậm.

### Lệnh khác

```bash
npm run dev            # chạy watch mode
npm test               # unit + integration test (không cần service ngoài)
npm run typecheck      # kiểm tra kiểu TypeScript
npm run eval           # đo độ chính xác chọn tool của model (cần LM Studio)
npm run mcp:catalog    # in danh sách tool của MCP (cần MCP đang chạy)
```

## API

### Swagger UI — tự test chat trong trình duyệt

Mở **http://localhost:8787/docs** sau khi `npm start`. Đây là Swagger UI tương tác:
bấm **Try it out** ở `POST /chat`, sửa body mẫu (đã điền sẵn `userId`/`sessionId`/`message`)
rồi **Execute** để gọi thật. Nếu phản hồi có `pendingAction`, copy `pendingAction.id`
sang `POST /chat/confirm` (đặt `approved: true`) để xác nhận thực thi.

Spec OpenAPI thô ở **http://localhost:8787/docs/json**.

> Cần cấu hình LLM xong (qua `/setup`) để `/chat` trả lời được; MCP chỉ cần khi thực thi lệnh điều khiển.

### `GET /health` → `{ "status": "ok", "phase": "ready" }`

`phase`: `waiting_config` (chưa cấu hình) → `connecting` → `initializing` → `ready`.

### `POST /chat`
```jsonc
// request
{ "userId": "u1", "sessionId": "s1", "message": "Tưới nước cho esp32-01 10 giây" }

// response — khi cần điều khiển, trả pendingAction (CHƯA thực thi)
{
  "reply": "Bạn xác nhận thực hiện: \"Bật bơm nước thiết bị esp32-01 trong 10s\"? (Có/Không)",
  "pendingAction": {
    "id": "…", "summary": "Bật bơm nước thiết bị esp32-01 trong 10s",
    "tool": "send_command", "args": { "device_id": "esp32-01", "command": "WATER_ON", "duration": 10000 }
  }
}
```

### `POST /chat/confirm`
```jsonc
{ "userId": "u1", "sessionId": "s1", "actionId": "<id từ pendingAction>", "approved": true }
// -> { "reply": "Đã thực hiện. …", "pendingAction": null }
```

App chat có thể render nút **Có/Không** (gọi `/chat/confirm`) **hoặc** chỉ gửi tiếp text
("có"/"không") vào `/chat` — server nhận diện cả hai.

## Cơ chế chính

- **Agent có giới hạn** (`MAX_TOOL_STEPS`, mặc định 3): mỗi lượt LLM trả JSON quyết định
  `reply` hoặc `tool`. Tool **ĐỌC** tự chạy và nạp kết quả lại; tool **ĐIỀU KHIỂN** không chạy
  ngay mà tạo `pendingAction` chờ xác nhận.
- **An toàn**: phân loại tool ở `src/mcp/policy.ts`. Tool lạ mặc định coi là ĐIỀU KHIỂN (cần xác nhận).
- **Profile lái ngưỡng**: dâu cần độ ẩm đất **75–80%** (không dùng default 30% của MCP). Xem
  `src/domain/profiles.ts` (`deriveControlThresholds`).
- **RAG**: `src/domain/knowledge/strawberry.json` → tách ngưỡng số (vào prompt) + field text
  (embed để truy hồi). Cross-lingual: hỏi tiếng Việt, tài liệu tiếng Anh vẫn tìm được nhờ `bge-m3`.

## Thêm cây mới

Tạo `src/domain/knowledge/<plant>.json` theo schema trong `src/domain/profiles.ts`, rồi đặt
`DEFAULT_PLANT=<plant>` trong `.env`. Không cần đổi code.

## Trạng thái & giới hạn

- Dữ liệu dâu là web-sourced (exa) — **review trước production**; một số field còn trống
  (`scientific_name`, `care_notes`, `toxicity`…), có thể bổ sung sau.
- Session memory hiện in-memory (mất khi restart) — đủ cho demo 1–5 người; thay bằng SQLite nếu cần.
- Chất lượng chọn tool phụ thuộc model nhỏ — chạy `npm run eval` để đo và cân nhắc 3b vs 7b.
