# Design: `POST /api/setup/rag/rebuild` — endpoint nạp lại RAG

**Ngày:** 2026-07-22
**Trạng thái:** Đã duyệt thiết kế (chờ review spec)

## 1. Vấn đề & mục tiêu

Hiện RAG store chỉ được build **một lần** trong `runInitPipeline` (lúc `/api/setup/connect`
thành công hoặc boot auto-reconnect). Khi người dùng thêm/sửa dữ liệu tri thức — thêm file vào
`data/docs/`, sửa `src/domain/knowledge/<plant>.json`, cập nhật disease KB — không có cách nào nạp
lại store mà không **khởi động lại cả server** hoặc **connect lại toàn bộ** (reconnect MCP, dựng lại
orchestrator).

**Mục tiêu:** một endpoint gọi được lúc runtime để **rebuild riêng phần tri thức** (RAG store +
profile), hot-swap vào orchestrator đang chạy, **không đụng tới MCP / LLM engine / session**.

**Không thuộc mục tiêu (YAGNI):**
- Không chạy lại scrape (scrape vẫn là pipeline có người duyệt riêng: `scrape → review → ingest`).
- Không có cờ `force` bust cache (embed cache đã keyed theo `model + text`; đổi model tự bust).
- Không dedupe hàm `buildStore` trùng lặp trong `src/eval/run.ts` (ghi chú lại, làm sau).
- Không full re-init (đã có `/api/setup/connect` bằng config đã lưu cho việc đó).

## 2. Hành vi

`POST /api/setup/rag/rebuild` (đồng bộ):

1. Guard (xem §5).
2. Đọc lại dữ liệu **từ đĩa** (nhặt được mọi thay đổi):
   - `loadProfile(appCfg.defaultPlant)` — đọc JSON profile mới nhất.
   - `readReviewedDocs(data/docs)` — đọc docs đã duyệt.
   - `loadDiseases(plant)` — đọc disease KB.
3. Ingest vào **một `InMemoryVectorStore` MỚI**, dùng **LLM engine hiện có** của orchestrator để
   embed (dùng lại embed cache trên đĩa → chỉ re-embed chunk thay đổi).
4. **Swap nguyên tử** cả store **và** profile vào orchestrator:
   `state.orchestrator = state.orchestrator.withRag(newStore, freshProfile)`.
5. Trả về số chunk đã nạp + thời gian.

**Vì sao swap cả profile:** profile có hai vai trò (numeric ranges → system prompt; text fields →
RAG chunks). Nếu chỉ swap store mà giữ profile cũ, một chỉnh sửa `soil_moisture_range` sẽ cập nhật
RAG nhưng **prompt vẫn dùng ngưỡng cũ** → không nhất quán. Reload profile rẻ, nên swap cả hai.

**Không tái tạo LLM engine:** rebuild dùng lại chính engine mà orchestrator đang phục vụ (không dựng
engine mới, không đọc lại `llm-config.json`) — đúng nghĩa "không đụng LLM". MCP và SessionStore giữ
nguyên tham chiếu. Orchestrator (và `/chat`, `/chat/stream`, `/chat/confirm`) tiếp tục phục vụ store
+ profile **cũ** cho tới đúng thời điểm swap.

## 3. Nguyên tắc cốt lõi: build-then-swap

Đây là bất biến quan trọng nhất của thiết kế:

> Ingest phải hoàn tất vào `newStore` **trước khi** gán vào `state.orchestrator`.

Nếu embedding lỗi giữa chừng (LLM/embed endpoint chết) → hàm ném lỗi **trước** bước swap → store +
profile cũ vẫn nguyên vẹn, chat không gián đoạn. Không bao giờ `clear()` store đang phục vụ rồi mới
ingest.

## 4. Thay đổi code (nhỏ, theo pattern sẵn có)

### 4.1. Tách khối build RAG dùng chung
Trích `init.ts:129–169` ra một hàm thuần:

```ts
// src/rag/buildStore.ts (mới) — hoặc đặt trong rag/ingest module hiện có
export interface RagBuildResult {
  store: InMemoryVectorStore
  counts: { profile: number; docs: number; diseases: number }
  detail: string   // "14 profile + 0 doc + 9 disease (store=23)"; kèm cảnh báo mixed-dims nếu có
}

export async function ingestAll(
  llm: LlmEngine,
  appCfg: Config,
  profile: PlantProfile,
): Promise<RagBuildResult>
```

`runInitPipeline` gọi lại `ingestAll` (thay cho khối inline) — **không đổi hành vi init**, chỉ DRY.
Giữ nguyên degrade-to-no-RAG: `runInitPipeline` vẫn bắt lỗi `ingestAll` và set step `rag` = failed.
Nhánh `RAG_DISABLED` giữ nguyên trong `runInitPipeline` (không đưa vào `ingestAll`).

### 4.2. `Orchestrator.withRag`
Mirror `withSessions` đã có, clone deps với store + profile mới:

```ts
withRag(store: InMemoryVectorStore, profile: PlantProfile): Orchestrator {
  return new Orchestrator({ ...this.deps, store, profile })
}
```

Thêm getter để rebuild lấy engine đang dùng (không phá đóng gói phần còn lại):

```ts
get engine(): LlmEngine { return this.deps.llm }
```

### 4.3. `rebuildRag`
Trong `src/setup/init.ts`:

```ts
export type RebuildResult =
  | { ok: true; profile: number; docs: number; diseases: number; storeSize: number; ms: number }
  | { ok: false; code: 'not_configured' | 'busy' | 'rag_disabled' | 'embed_failed'; message: string }

export async function rebuildRag(state: AppState, appCfg: Config): Promise<RebuildResult>
```

Luồng:
1. `if (!state.orchestrator)` → `not_configured`.
2. `if (appCfg.rag.disabled)` → `rag_disabled`.
3. `if (state.isBusy() || state.isRebuilding())` → `busy`.
4. `state.beginRebuild()` (đặt cờ + step `rag` = running). Ghi `t0`.
5. `try`:
   - `const llm = state.orchestrator.engine`
   - `const profile = loadProfile(appCfg.defaultPlant)`
   - `const { counts, detail, store } = await ingestAll(llm, appCfg, profile)`
   - `state.orchestrator = state.orchestrator.withRag(store, profile)`
   - `state.finishRebuild(detail)` → trả `{ ok:true, ...counts, storeSize: store.size(), ms }`.
6. `catch (err)`: `state.failRebuild(msg)` (orchestrator cũ giữ nguyên) → `embed_failed`.
7. `finally`: nhả cờ `isRebuilding`.

Không cần `SetupDeps` (không dựng engine/MCP mới) → rebuild nhẹ và dễ test: engine lấy từ
orchestrator (đã fakeable), profile/docs đọc từ đĩa (test trỏ `appCfg` vào thư mục tạm).

### 4.4. `AppState` — khóa rebuild
Thêm `private ragRebuilding = false` + `isRebuilding()`, `beginRebuild()`, `finishRebuild(detail)`,
`failRebuild(msg)`. Ba hàm sau cập nhật step `rag` để `GET /api/setup/status` phản ánh tiến trình.
**Không** đổi `phase` (chat gate trên `orchestrator`; phase giữ `ready`). Swap orchestrator vẫn qua
gán trực tiếp trong `rebuildRag` (giữ `setReady` cho luồng init).

### 4.5. Route
Trong `routes.setup.ts`, thêm `POST /api/setup/rag/rebuild` (Swagger tag `setup`), gọi `rebuildRag`,
map `RebuildResult` → HTTP (xem §5). Không nhận body.

## 5. Guard & mã lỗi

| Tình huống | HTTP | Body |
|---|---|---|
| Chưa cấu hình (chưa có orchestrator) | **503** | `{error:"not_configured"}` |
| `RAG_DISABLED=1` | **409** | `{error:"rag_disabled"}` |
| Đang connect/init hoặc rebuild khác đang chạy | **409** | `{error:"busy"}` |
| Embed/ingest thất bại | **502** | `{error:"embed_failed", message}` (store+profile cũ giữ nguyên) |
| Thành công | **200** | `{ok:true, profile, docs, diseases, storeSize, ms}` |

Chọn 503 cho `not_configured` để khớp với `/chat` (đã trả 503 `not_configured` trước khi cấu hình).

## 6. Test (DI fakes, không cần service thật)

Theo convention repo (`LlmEngine`, `SetupDeps` là interface có fake; `AppState.ready(orch)` helper):

1. **Happy path** — orchestrator dựng với `LlmEngine` fake (embedding tất định); `appCfg.rag.docsDir`
   trỏ thư mục tạm có 1 doc: `rebuildRag` trả counts đúng; `state.orchestrator` là instance MỚI;
   `storeSize > 0`.
2. **Swap có hiệu lực** — sau rebuild, orchestrator mới truy hồi được nội dung doc vừa thêm (hoặc
   `store.size()` tăng so với trước).
3. **not_configured** — `AppState` chưa có orchestrator → `{ok:false, code:'not_configured'}`.
4. **rag_disabled** — `appCfg.rag.disabled = true` → `{ok:false, code:'rag_disabled'}`.
5. **busy** — `state.isBusy()` true (đang connecting) → `{ok:false, code:'busy'}`.
6. **build-then-swap** — `LlmEngine` fake ném lỗi ở `embed()` → `state.orchestrator` **giữ nguyên
   tham chiếu cũ**; kết quả `embed_failed`.
7. **route (tùy)** — test HTTP: 200 body shape; 503/409 theo guard.

## 7. Rủi ro & giảm thiểu

- **Race giữa rebuild và chat đang chạy dở**: swap chỉ đổi tham chiếu `state.orchestrator`; một
  request `/chat` đang chạy đã giữ orchestrator cũ trong closure → nó chạy xong bằng store+profile
  cũ, request kế tiếp dùng bản mới. Không có trạng thái nửa vời.
- **Race hai rebuild song song**: cờ `isRebuilding` chặn cái thứ hai bằng 409.
- **Embed cache lệch chiều (mixed dims)**: `ingestAll` giữ cảnh báo `uniformDims()` như init, đưa
  vào `detail`.
- **Profile bị swap ngoài mong đợi**: có chủ đích (xem §2) — cần thiết để prompt và RAG nhất quán
  sau khi sửa profile. Không đổi MCP/LLM/session.
