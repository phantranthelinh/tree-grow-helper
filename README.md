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
2. **[LM Studio](https://lmstudio.ai)** đang chạy server (OpenAI-compatible) tại `http://localhost:1234/v1`, đã **load**:
   - Model chat: `qwen2.5-3b-instruct` (hoặc 7b) — hỗ trợ tool use + structured output.
   - Model embedding: `bge-m3` (hoặc `text-embedding-*`), dùng cho RAG.
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
cp .env.example .env      # chỉnh nếu cần
npm start                 # chạy AI server (http://localhost:8787)
```

Server **vẫn khởi động** nếu LM Studio/MCP chưa sẵn sàng (chế độ degraded):
- MCP offline → dùng catalog tool tĩnh (KNOWN_TOOLS); lệnh điều khiển sẽ báo lỗi cho tới khi MCP lên.
- Embedding offline → chạy không có RAG.

### Lệnh khác

```bash
npm run dev            # chạy watch mode
npm test               # unit + integration test (không cần service ngoài)
npm run typecheck      # kiểm tra kiểu TypeScript
npm run eval           # đo độ chính xác chọn tool của model (cần LM Studio)
npm run mcp:catalog    # in danh sách tool của MCP (cần MCP đang chạy)
```

## API

### `GET /health` → `{ "status": "ok" }`

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
