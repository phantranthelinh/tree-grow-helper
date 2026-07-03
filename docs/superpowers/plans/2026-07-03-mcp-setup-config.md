# Thêm cấu hình MCP server vào /setup

## Context (bối cảnh)

Hiện tại chỉ LLM là cấu hình được lúc runtime qua UI `/setup` (probe → lưu `data/llm-config.json` → auto-reconnect khi boot). **MCP URL thì chỉ đọc từ env `MCP_URL`** (`src/config.ts:24-26`) và được truyền tĩnh vào `runInitPipeline` (`src/setup/init.ts:94`) — không có UI, không lưu, không đổi được khi chạy.

**Quyết định đã chốt:**
1. Thêm ô **MCP URL** vào form `/setup` hiện có — một luồng connect duy nhất (LLM + MCP). Đổi MCP = vào lại `/setup` chạy lại (form prefill sẵn). KHÔNG làm đường reconnect MCP riêng, KHÔNG swap orchestrator.
2. Có nút **"Kiểm tra MCP"** (probe `listTools`, hiện "✓ tìm thấy N tool" / lỗi) trước khi kết nối. MCP hỏng **không chặn** connect — giữ graceful degradation (step `mcp` failed → fallback `KNOWN_TOOLS`).
3. MCP config đã lưu tự áp dụng khi boot (như LLM); env `MCP_URL` chỉ là prefill/fallback. **Backward compat**: chưa có file config → dùng env, deployment cũ chạy y nguyên không cần làm gì.

## Thiết kế chính

- **Persistence**: file riêng `data/mcp-config.json` `{ url }` qua module mới `src/setup/mcpConfig.ts` — copy nguyên mẫu `src/setup/llmConfig.ts`. Không đụng `LlmConfigSchema` (thêm field required vào đó sẽ làm file llm-config.json cũ fail validation).
- **Luồng URL**: resolve trong `applyLlmConfig` — `opts.mcpUrl ?? loadMcpConfig(path)?.url ?? appCfg.mcp.url` — rồi truyền **tham số tường minh** vào `runInitPipeline(cfg, mcpUrl, ...)`. Pipeline không đọc fs; `src/index.ts` boot **không cần sửa** (auto-pickup qua resolution nội bộ).
- **Chỉ lưu khi user chủ động**: `saveMcpConfig` chỉ gọi khi `opts.mcpUrl !== undefined` (connect từ UI/API) — boot auto-reconnect không ghi file.
- **Probe MCP**: `testMcpConnection(buildMcp, url, {timeoutMs})` trong `src/setup/probe.ts`, tái dùng seam `deps.buildMcp` có sẵn (không thêm member mới vào `SetupDeps`), timeout dùng `setup.probeTimeoutMs` (10s) có sẵn.

## Các bước triển khai (theo thứ tự)

### 1. MỚI `src/setup/mcpConfig.ts`
Theo template `llmConfig.ts`:
- `McpConfigSchema = z.object({ url: z.string().url() })` + type `McpConfig`
- `loadMcpConfig(path): McpConfig | null` — file thiếu → null im lặng; JSON/schema hỏng → `console.warn` tiếng Việt (`... — bỏ qua, dùng MCP_URL từ env.`) → null
- `saveMcpConfig(path, cfg)` — `mkdirSync(dirname, {recursive:true})` + `writeFileSync`

### 2. `src/config.ts`
Block `mcp` thêm `configPath: process.env.MCP_CONFIG_PATH ?? 'data/mcp-config.json'`; sửa comment: `url` giờ chỉ là prefill/fallback (giống comment `llmDefaults` dòng 11).

### 3. `src/setup/probe.ts` — probe MCP
```ts
export type McpProbeResult =
  | { ok: true; toolCount: number; tools: string[] }   // tools = tên tool
  | { ok: false; code: ProbeErrorCode; message: string } // chỉ 'unreachable'|'timeout'
export async function testMcpConnection(
  buildMcp: (url: string) => McpGateway, url: string, opts?: { timeoutMs?: number },
): Promise<McpProbeResult>
```
- `Promise.race` giữa `gw.listTools()` và timeout — **`clearTimeout` trong `finally`** (timer sống sẽ treo vitest).
- Timeout → `{code:'timeout', message:'MCP không phản hồi sau <N>ms'}`; lỗi khác → `unreachable` + `err.message` (không over-classify).
- `finally`: close duck-typed — `McpGateway` không khai báo `close()` nhưng `PlantMcpClient` có (`src/mcp/client.ts:66-70`); fake test không có → check `typeof === 'function'`, nuốt lỗi close.
- Import `McpGateway` type từ `../mcp/client` (không tạo cycle).

### 4. `src/setup/state.ts`
- `beginInitializing(cfg: LlmConfig, mcpUrl?: string)` — param optional để `tests/setup-state.test.ts` compile không sửa; lưu `private currentMcpUrl`.
- `SetupStatus.config` thêm `mcpUrl: string | null`; `getStatus()` trả về (URL không phải secret — giữ invariant "không leak apiKey").

### 5. `src/setup/init.ts`
- `applyLlmConfig(cfg, state, appCfg, deps = {}, opts: { mcpUrl?: string } = {})`:
  - Sau busy-guard: `const mcpUrl = opts.mcpUrl ?? loadMcpConfig(appCfg.mcp.configPath)?.url ?? appCfg.mcp.url`
  - Sau probe LLM thành công, cạnh `saveLlmConfig`: `if (opts.mcpUrl !== undefined) saveMcpConfig(appCfg.mcp.configPath, { url: mcpUrl })`
  - `state.beginInitializing(cfg, mcpUrl)`; `runInitPipeline(cfg, mcpUrl, state, appCfg, d)`
- `runInitPipeline` (module-private, không churn ngoài): dòng 94 → `deps.buildMcp(mcpUrl)`; **dòng 104 log cũng phải đổi sang `mcpUrl`** (đang log `appCfg.mcp.url` — sẽ log sai URL nếu quên).

### 6. `src/http/dto.ts`
- `SetupConnectRequestSchema` thêm `mcpUrl: z.string().url().optional()` (optional để client/test cũ post body cũ vẫn chạy; UI luôn gửi).
- MỚI `SetupMcpTestRequestSchema = z.object({ url: z.string().url() })`.

### 7. `src/http/routes.setup.ts`
- `connectBodySchema` (JSON schema Swagger) thêm `mcpUrl: { type: 'string' }` vào `properties`. **Bắt buộc, không phải trang trí**: schema có `additionalProperties: false` + AJV mặc định của Fastify `removeAdditional` → key `mcpUrl` không khai báo sẽ bị **xóa im lặng** khỏi `req.body` trước khi Zod parse.
- `/api/setup/status`: `defaults` thêm `mcpUrl: appCfg.mcp.url` (statusSchema đã `additionalProperties: true`, không cần sửa Swagger).
- `/api/setup/connect` handler: destructure `mcpUrl`, gọi `applyLlmConfig(cfg, state, appCfg, deps, { mcpUrl })`.
- MỚI `POST /api/setup/mcp/test` — mô phỏng line-for-line `/api/setup/models` (attachValidation, Zod parse → 400 `invalid_request`; fail → 502 `{error, message}`; ok → `{ok:true, toolCount, tools}`). Dùng `deps.buildMcp ?? defaultSetupDeps().buildMcp` + `testMcpConnection`. **Không busy-guard** (read-only như `/models`). Summary tiếng Việt: `'Kiểm tra kết nối MCP (không lưu)'`.

### 8. `src/setup/page.ts` — UI
HTML chèn giữa `#models-hint` (dòng 90) và `#err` (dòng 92):
```html
<label for="mcpUrl">MCP URL</label>
<div class="row">
  <div><input id="mcpUrl" type="text" placeholder="http://localhost:8000/mcp" autocomplete="off" /></div>
  <button id="btn-mcp-test" class="ghost">Kiểm tra MCP</button>
</div>
<div id="mcp-hint" class="hint">Địa chỉ MCP điều khiển thiết bị. MCP chưa chạy vẫn kết nối được — lệnh điều khiển sẽ lỗi đến khi MCP sẵn sàng.</div>
```
(CSS `.row` sẵn có lo layout — không thêm CSS.)

JS:
- `currentBody()` thêm `mcpUrl: $('mcpUrl').value.trim()`; `connect()` check rỗng như baseURL/model.
- `testMcp()` mô phỏng `loadModels()` (disable nút → 'Đang kiểm tra…' → restore): ok → `#mcp-hint` = `'✓ tìm thấy N tool'`; fail → `'✗ Không kết nối được MCP (msg)'` — hiện inline tại field, KHÔNG dùng `#err` toàn cục (lỗi MCP chỉ mang tính tư vấn).
- `prefill()` thêm `$('mcpUrl').value = src.mcpUrl || (status.defaults && status.defaults.mcpUrl) || ''`.
- `init()` wire `$('btn-mcp-test').onclick = testMcp`.
- `STEP_LABEL` đã có `mcp` — không sửa.

### 9. `src/index.ts` — KHÔNG sửa (resolution nội bộ trong `applyLlmConfig` tự lo).

### 10. `scripts/` mcp-catalog (nếu script tồn tại): `loadMcpConfig(config.mcp.configPath)?.url ?? config.mcp.url` để `npm run mcp:catalog` trỏ đúng MCP đã config.

## Tests

### MỚI `tests/mcp-config.test.ts` — clone `tests/llm-config.test.ts`
Round-trip `{url}` + tạo thư mục cha; file thiếu → null; JSON hỏng → null; sai schema (`{url:'not-a-url'}`, `{}`) → null.

### `tests/setup-routes.test.ts` — bổ sung
- `testConfig` thêm `mcp: { ...config.mcp, configPath: join(dir, 'mcp-config.json') }` — **bắt buộc cho hermetic** (không thì `data/mcp-config.json` lạc trên máy dev sẽ rò vào resolution).
- Case mới:
  1. `POST /api/setup/mcp/test` ok → 200 `{ok:true, toolCount:2}`; assert spy `close()` trên fake được gọi.
  2. `listTools` throw → 502 `{error:'unreachable'}`.
  3. `url` thiếu/không phải URL → 400 `invalid_request`.
  4. Connect **có** `mcpUrl` → 200; `await state.initPromise`; assert `mcp-config.json` tồn tại + `loadMcpConfig` khớp; fake `buildMcp` capture URL đúng; `GET /api/setup/status` → `config.mcpUrl` khớp.
  5. Backward compat: connect body cũ (không `mcpUrl`) → 200 ready, file KHÔNG được ghi, `buildMcp` nhận `testConfig.mcp.url` (env fallback).
  6. Mở rộng test status: `defaults.mcpUrl === config.mcp.url`.
- Case hiện có: **không cần sửa** (mọi param mới đều optional).

### `tests/setup-state.test.ts` — không bắt buộc sửa (tùy chọn: assert `beginInitializing(cfg, url)` surface `config.mcpUrl` và vẫn không leak apiKey).

## Edge cases

1. Re-configure khi busy → 409 busy-guard sẵn có (MCP đi cùng luồng); `/mcp/test` không guard (read-only).
2. File lưu hỏng/thiếu → null → fallback env; warn tiếng Việt; boot không crash.
3. Probe timeout → `clearTimeout` trong `finally`; vẫn attempt `close()` (no-op nếu chưa connect).
4. 0 tool vẫn là success: "✓ tìm thấy 0 tool".
5. AJV strip `mcpUrl` nếu quên khai báo trong `connectBodySchema.properties` (bước 7).
6. Test pass xong MCP sập / không test → connect không bao giờ chặn vì MCP; init fallback `KNOWN_TOOLS` như cũ.
7. Ưu tiên env-vs-file: boot không ghi file; sau lần connect UI đầu tiên thì file thắng env (y hệt `llm-config.json`).

## Docs / env (tối thiểu)

- `.env.example`: sửa comment `MCP_URL` (chỉ prefill/fallback khi chưa có `data/mcp-config.json`); thêm `MCP_CONFIG_PATH=data/mcp-config.json`.
- `docker-compose.yml` / `Dockerfile`: chỉ sửa comment (volume persist thêm mcp-config.json). Env `MCP_URL` giữ nguyên.
- `CLAUDE.md` mục "Two-phase startup": thêm 1 câu — MCP URL cũng config runtime qua /setup, lưu `data/mcp-config.json`, env `MCP_URL` chỉ prefill/fallback.
- `DEPLOY.md` (nếu có bảng env): sửa mô tả `MCP_URL`, thêm dòng `MCP_CONFIG_PATH`.

## Verification

1. `npm run typecheck` — pass (cổng compile duy nhất).
2. `npm test` — hermetic; chạy nhắm: `npx vitest run tests/setup-routes.test.ts tests/mcp-config.test.ts tests/setup-state.test.ts tests/llm-config.test.ts`.
3. Walk-through thủ công (`npm start`, LM Studio chạy, MCP **tắt**):
   - Mở `/setup` → ô MCP URL prefill từ env `MCP_URL`.
   - "Kiểm tra MCP" → "✗ Không kết nối được MCP (…)" inline; form vẫn dùng được.
   - Connect luôn → progress: LLM ✓, "Kết nối MCP" ✗ (fallback tool tĩnh), RAG ✓, ready. `data/mcp-config.json` được ghi.
   - Bật MCP, vào lại `/setup` (prefill từ `config.mcpUrl`), "Kiểm tra MCP" → "✓ tìm thấy N tool", Connect → step mcp done.
   - Restart server → boot log `[mcp] connected at <saved url>`; đặt env `MCP_URL` khác → file vẫn thắng; xóa file → dùng lại env.
   - `/docs` hiện `POST /api/setup/mcp/test`; Try-it-out trả envelope 502 khi MCP tắt.
