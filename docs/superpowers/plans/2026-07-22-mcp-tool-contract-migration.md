# MCP Tool Contract Migration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Realign the AI server from the old `plant-tree-iot` MCP tool contract to the new one across the catalog, safety policy, prompt, few-shot, eval dataset, and all tests.

**Architecture:** Pure contract-alignment refactor. The static fallback catalog ([src/mcp/knownTools.ts](../../../src/mcp/knownTools.ts)) is swapped to the new tool set; classification ([src/mcp/policy.ts](../../../src/mcp/policy.ts)) relies on explicit READ/CONTROL sets (fail-safe fallback keeps unknowns as `control`); prompt/few-shot/eval/tests are updated to match. No change to the agent loop, session memory, RAG, or HTTP wiring. Runtime behavior beyond tool selection is unchanged; the confirm-before-control invariant is preserved.

**Tech Stack:** TypeScript (ESM, run via `tsx` — no build), Vitest, Zod, Fastify. Tests need no external services (DI fakes for `LlmEngine`/`McpGateway`).

## Global Constraints

- **All user-facing text stays Vietnamese** — tool descriptions, confirmation summaries, prompt lines, few-shot copy.
- **ESM, extensionless imports** — no file-extension changes; match existing import style.
- **Small-model field order (do NOT reorder):** every `type:"tool"` few-shot example keeps `type → message → tool → args`. Guarded by [tests/prompt.test.ts](../../../tests/prompt.test.ts).
- **Confirm-before-control invariant:** all six control tools require confirmation; `refresh_device_config` and `show_message` are `control` (decision 3).
- **Behavioral decisions (from the spec):** (1) "tưới N giây" → `set_pump(on=true)` only, no `duration`, reply explains firmware self-stop; (2) "bật auto" → `set_mode(auto=true)` alone; (3) `refresh_device_config` + `show_message` → `control`.
- **Verify commands:** `npm run typecheck` (tsc --noEmit) and `npm test` (vitest run). Single file: `npx vitest run <path>`.
- **No changes to** the `plant-tree-iot`/MCP repo or historical docs under `docs/superpowers/**` / `docs/rag-course-review.md`.

## New tool contract (reference for all tasks)

| Tool | Schema (required in **bold**) | Class |
|------|-------------------------------|-------|
| `list_devices` | — | read |
| `get_device_info` | **device_id** | read |
| `get_latest_sensor` | **device_id** | read (confirm-before-read) |
| `get_sensor_history` | **device_id**, limit | read (confirm-before-read) |
| `get_recent_commands` | **device_id** | read |
| `get_device_config` | **device_id** | read |
| `set_pump` | **device_id**, **on** | control |
| `set_light` | **device_id**, on, pwm | control |
| `set_mode` | **device_id**, **auto** | control |
| `show_message` | **device_id**, **text**, secs | control |
| `set_device_config` | **device_id**, soil_on_pct, soil_off_pct, lux_on, lux_off, pump_max_run_s | control |
| `refresh_device_config` | **device_id** | control |

> **Open item (non-blocking):** the handoff cited "13 tools" but enumerates 12; and `set_device_config` has "15 thresholds" of which only 5 are named. `knownTools.ts` is a best-effort mirror — the live MCP schema wins at runtime. When the MCP is reachable, run `npm run mcp:catalog` and reconcile the count + full `set_device_config` arg list. Not a blocker for this plan.

---

## Task 1: Migrate the tool catalog

**Files:**
- Modify: `src/mcp/knownTools.ts` (full rewrite of the `KNOWN_TOOLS` array + header comment; add a `bool` helper)
- Test: `tests/args.test.ts:6-7,10-26` (swap the removed `send_command` lookup)

**Interfaces:**
- Produces: `KNOWN_TOOLS` with tool names `list_devices, get_device_info, get_latest_sensor, get_sensor_history, get_recent_commands, get_device_config, set_pump, set_light, set_mode, show_message, set_device_config, refresh_device_config` and their schemas. Later tasks (Task 7 arg-sanitization) rely on `set_light` declaring `device_id, on, pwm`.

- [ ] **Step 1: Update the test to the new catalog**

In `tests/args.test.ts`, replace lines 6-7:

```typescript
const setLight = KNOWN_TOOLS.find((t) => t.name === 'set_light')!
const setPump = KNOWN_TOOLS.find((t) => t.name === 'set_pump')!
const listDevices = KNOWN_TOOLS.find((t) => t.name === 'list_devices')!
```

Replace the first two `it(...)` bodies (lines 10-26) with:

```typescript
  it('drops args not declared in the tool schema (the leaked decision message)', () => {
    const out = sanitizeArgs(setLight, {
      device_id: 'esp32-01',
      on: true,
      pwm: 200,
      message: 'Mình sẽ bật đèn thiết bị esp32-01.',
    })
    expect(out).toEqual({ device_id: 'esp32-01', on: true, pwm: 200 })
    expect(out).not.toHaveProperty('message')
  })

  it('keeps only declared keys and preserves their values', () => {
    expect(sanitizeArgs(setPump, { device_id: 'd1', on: true, bogus: true })).toEqual({
      device_id: 'd1',
      on: true,
    })
  })
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/args.test.ts`
Expected: FAIL — `KNOWN_TOOLS.find(... 'set_light')` returns `undefined`, so `sanitizeArgs(undefined, …)` passes args through unchanged and the `toEqual` assertions fail.

- [ ] **Step 3: Rewrite `KNOWN_TOOLS`**

In `src/mcp/knownTools.ts`, replace the header comment (lines 3-10) with:

```typescript
/**
 * Static definition of the plant-tree MCP tool catalog. Used as a fallback tool
 * catalog when the live MCP is unreachable (degraded mode) and by the eval
 * harness so tool-selection can be measured without a running MCP.
 *
 * At runtime the LIVE MCP schema (from listTools) takes precedence — this is
 * only a best-effort mirror of the Python server's signatures. If the MCP is
 * reachable, reconcile against `npm run mcp:catalog` (the handoff cited 13 tools;
 * set_device_config lists 15 thresholds — only the common ones are mirrored here).
 */
```

Add the `bool` helper after line 18 (`const num = ...`):

```typescript
const bool = { type: 'boolean' as const }
```

Replace the entire `KNOWN_TOOLS` array (lines 20-40) with:

```typescript
export const KNOWN_TOOLS: McpTool[] = [
  { name: 'list_devices', description: 'Liệt kê tất cả thiết bị.', inputSchema: obj({}) },
  { name: 'get_device_info', description: 'Thông tin chi tiết một thiết bị.', inputSchema: obj({ device_id: str }, ['device_id']) },
  { name: 'get_latest_sensor', description: 'Số liệu cảm biến mới nhất (độ ẩm đất, nhiệt độ, ánh sáng...).', inputSchema: obj({ device_id: str }, ['device_id']) },
  { name: 'get_sensor_history', description: 'Lịch sử số liệu cảm biến (limit bản ghi gần nhất, mặc định 10).', inputSchema: obj({ device_id: str, limit: num }, ['device_id']) },
  { name: 'get_recent_commands', description: 'Nhật ký các lệnh đã publish tới thiết bị (không phải hàng đợi poll).', inputSchema: obj({ device_id: str }, ['device_id']) },
  { name: 'get_device_config', description: 'Xem toàn bộ ngưỡng cấu hình auto của thiết bị (soil_on_pct, lux_on...).', inputSchema: obj({ device_id: str }, ['device_id']) },
  { name: 'set_pump', description: 'Bật/tắt bơm nước. Không có duration — thiết bị tự tắt sau pump_max_run_s.', inputSchema: obj({ device_id: str, on: bool }, ['device_id', 'on']) },
  { name: 'set_light', description: 'Bật/tắt đèn (on) hoặc đặt độ sáng (pwm 0..255).', inputSchema: obj({ device_id: str, on: bool, pwm: num }, ['device_id']) },
  { name: 'set_mode', description: 'Chuyển chế độ tự động (auto=true) hoặc thủ công (auto=false).', inputSchema: obj({ device_id: str, auto: bool }, ['device_id', 'auto']) },
  { name: 'show_message', description: 'Hiển thị dòng chữ lên màn hình thiết bị (secs: số giây hiển thị, tùy chọn).', inputSchema: obj({ device_id: str, text: str, secs: num }, ['device_id', 'text']) },
  { name: 'set_device_config', description: 'Đặt ngưỡng cấu hình auto (soil_on_pct, soil_off_pct, lux_on, lux_off, pump_max_run_s...).', inputSchema: obj({ device_id: str, soil_on_pct: num, soil_off_pct: num, lux_on: num, lux_off: num, pump_max_run_s: num }, ['device_id']) },
  { name: 'refresh_device_config', description: 'Yêu cầu thiết bị nạp lại cấu hình (publish MQTT {"config":{}}).', inputSchema: obj({ device_id: str }, ['device_id']) },
]
```

- [ ] **Step 4: Run test + typecheck to verify pass**

Run: `npx vitest run tests/args.test.ts && npm run typecheck`
Expected: PASS (args.test.ts green; tsc reports no errors).

- [ ] **Step 5: Commit**

```bash
git add src/mcp/knownTools.ts tests/args.test.ts
git commit -m "refactor(mcp): migrate tool catalog to new MCP contract"
```

---

## Task 2: Update the safety policy

**Files:**
- Modify: `src/mcp/policy.ts:10-26` (`READ_ONLY` and `CONTROL` sets)
- Test: `tests/policy.test.ts:4-14,46,49`

**Interfaces:**
- Consumes: new tool names from Task 1.
- Produces: `classifyTool`/`isReadOnly`/`requiresConfirmation`/`confirmsBeforeRead` behavior unchanged in shape; only the membership sets change.

- [ ] **Step 1: Update the test to the new contract**

In `tests/policy.test.ts`, replace the `READ` array (lines 4-12):

```typescript
const READ = [
  'list_devices',
  'get_device_info',
  'get_latest_sensor',
  'get_sensor_history',
  'get_recent_commands',
  'get_device_config',
]
```

Replace the `CONTROL` array (line 14):

```typescript
const CONTROL = ['set_pump', 'set_light', 'set_mode', 'show_message', 'set_device_config', 'refresh_device_config']
```

Replace the internal-reads loop (line 46):

```typescript
    for (const n of ['list_devices', 'get_device_info', 'get_recent_commands', 'get_device_config']) {
```

Replace line 49:

```typescript
    expect(confirmsBeforeRead('set_pump')).toBe(false)
```

- [ ] **Step 2: Run the test**

Run: `npx vitest run tests/policy.test.ts`
Expected: PASS even before the source edit — `set_*`/`refresh_*` fall through to the fail-safe `control` default and `get_*` matches a read prefix. This test documents intent; the source edit in Step 3 makes the sets explicit and removes dead entries.

- [ ] **Step 3: Update `policy.ts`**

In `src/mcp/policy.ts`, replace `READ_ONLY` (lines 10-18):

```typescript
const READ_ONLY = new Set<string>([
  'list_devices',
  'get_device_info',
  'get_latest_sensor',
  'get_sensor_history',
  'get_recent_commands',
  'get_device_config',
])
```

Replace `CONTROL` (lines 20-26):

```typescript
const CONTROL = new Set<string>([
  'set_pump',
  'set_light',
  'set_mode',
  'show_message',
  'set_device_config',
  'refresh_device_config',
])
```

Leave `CONFIRM_BEFORE_READ`, `READ_PREFIXES`, and all functions unchanged.

- [ ] **Step 4: Run test + typecheck**

Run: `npx vitest run tests/policy.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/policy.ts tests/policy.test.ts
git commit -m "refactor(mcp): update tool safety policy for new contract"
```

---

## Task 3: Update action summaries

**Files:**
- Modify: `src/agent/confirmation.ts:6-42` (remove `COMMAND_LABELS`; rewrite `summarizeAction`)
- Test: `tests/confirmation.test.ts` (lines 12, 16-17, 26, 33, 67, 74)

**Interfaces:**
- Consumes: new tool names.
- Produces: `summarizeAction(tool, args)` returns Vietnamese for `set_pump`/`set_light`/`set_mode`/`show_message`/`set_device_config`/`refresh_device_config`/`get_latest_sensor`/`get_sensor_history`; `createPendingAction`/`detectConfirmation`/`executeAction` signatures unchanged.

- [ ] **Step 1: Update the test**

In `tests/confirmation.test.ts`, replace the first two `it(...)` (lines 11-18):

```typescript
  it('describes a pump command in Vietnamese', () => {
    expect(summarizeAction('set_pump', { device_id: 'esp32-01', on: true })).toBe('Bật bơm nước thiết bị esp32-01')
  })
  it('describes set_mode auto', () => {
    expect(summarizeAction('set_mode', { device_id: 'esp32-01', auto: true })).toContain('auto')
  })
```

Replace line 26 and line 27 (both `createPendingAction('send_command', … 'LIGHT_ON')`):

```typescript
    const a = createPendingAction('set_light', { device_id: 'd1', on: true })
    const b = createPendingAction('set_light', { device_id: 'd1', on: true })
```

(Line 29 assertion `expect(a.summary).toBe('Bật đèn thiết bị d1')` stays — the new `set_light` summary matches it.)

Replace lines 33, 67, 74 (each `createPendingAction('send_command', { device_id: 'd1', command: 'WATER_ON' })`) with:

```typescript
    const a = createPendingAction('set_pump', { device_id: 'd1', on: true })
```

(Line 67/74 use `const action =`; keep that binding name — only swap the tool/args:)

```typescript
    const action = createPendingAction('set_pump', { device_id: 'd1', on: true })
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/confirmation.test.ts`
Expected: FAIL — `summarizeAction('set_pump', …)` hits the `default` case and returns `Chạy set_pump…`, not `Bật bơm nước thiết bị esp32-01`.

- [ ] **Step 3: Rewrite `confirmation.ts`**

Delete the `COMMAND_LABELS` block (lines 6-13). Replace `summarizeAction` (lines 15-42) with:

```typescript
/** Build a human-readable Vietnamese summary of an action for confirmation (control + user-facing reads). */
export function summarizeAction(tool: string, args: Record<string, unknown>): string {
  const dev = args.device_id ? ` thiết bị ${String(args.device_id)}` : ''
  switch (tool) {
    case 'set_pump':
      return `${args.on ? 'Bật' : 'Tắt'} bơm nước${dev}`
    case 'set_light':
      if (args.pwm !== undefined) return `Đặt độ sáng đèn${dev} = ${Number(args.pwm)}`
      return `${args.on ? 'Bật' : 'Tắt'} đèn${dev}`
    case 'set_mode':
      return `Chuyển${dev} sang chế độ ${args.auto ? 'tự động (auto)' : 'thủ công (manual)'}`
    case 'show_message':
      return `Hiển thị lên màn hình${dev}: ${String(args.text ?? '')}`
    case 'set_device_config':
      return `Đổi cấu hình ngưỡng${dev}: ${JSON.stringify(args)}`
    case 'refresh_device_config':
      return `Làm mới cấu hình${dev}`
    case 'get_latest_sensor':
      return `kiểm tra số liệu cảm biến mới nhất${dev} (độ ẩm, nhiệt độ, ánh sáng)`
    case 'get_sensor_history': {
      const n = args.limit ? ` ${Number(args.limit)} bản ghi gần nhất` : ''
      return `xem lịch sử cảm biến${dev}${n}`
    }
    default:
      return `Chạy ${tool}${dev} với tham số ${JSON.stringify(args)}`
  }
}
```

- [ ] **Step 4: Run test + typecheck**

Run: `npx vitest run tests/confirmation.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/agent/confirmation.ts tests/confirmation.test.ts
git commit -m "refactor(agent): update action summaries for new tool contract"
```

---

## Task 4: Update the system prompt + few-shot

**Files:**
- Modify: `src/llm/prompt.ts:49` (READ-tools list in rule 4)
- Modify: `src/domain/fewshot.ts:25,29` (Ví dụ 3 → `set_light`, Ví dụ 4 → `set_pump`)
- Test (no edit, must stay green): `tests/prompt.test.ts`

**Interfaces:**
- Consumes: new tool names.
- Produces: few-shot examples keep `type → message → tool → args` order (guarded by `tests/prompt.test.ts`).

- [ ] **Step 1: Update `prompt.ts` rule 4**

In `src/llm/prompt.ts`, replace line 49:

```typescript
    '4. Tool [ĐỌC] (list_devices, get_device_info, get_device_config, get_recent_commands, và cảm biến get_latest_sensor/get_sensor_history khi người dùng hỏi trực tiếp) được hệ thống TỰ CHẠY và trả kết quả lại cho bạn để phân tích tiếp.',
```

- [ ] **Step 2: Update `fewshot.ts` Ví dụ 3 (line 25)**

Replace line 25:

```typescript
Trợ lý: {"type":"tool","message":"Mình sẽ bật đèn cho khu A để bổ sung ánh sáng theo nhu cầu của dâu.","tool":"set_light","args":{"device_id":"esp32-01","on":true}}
```

- [ ] **Step 3: Update `fewshot.ts` Ví dụ 4 (line 29)**

Keep the user line (line 28) `Người dùng: "Tưới nước 10 giây đi."` — it teaches handling the "N giây" phrasing. Replace line 29:

```typescript
Trợ lý: {"type":"tool","message":"Mình sẽ bật bơm tưới để nâng độ ẩm đất về khoảng tối ưu của dâu (~75-80%); bơm sẽ tự tắt sau thời gian an toàn của thiết bị nên bạn không cần tắt tay, tránh tưới quá gây úng.","tool":"set_pump","args":{"device_id":"esp32-01","on":true}}
```

- [ ] **Step 4: Run the prompt guard + typecheck**

Run: `npx vitest run tests/prompt.test.ts && npm run typecheck`
Expected: PASS — the field-order guard (`"type":"tool","message"` present, `"type":"tool","tool"` absent) still holds because both edited examples keep message-first.

- [ ] **Step 5: Commit**

```bash
git add src/llm/prompt.ts src/domain/fewshot.ts
git commit -m "refactor(llm): update prompt and few-shot for new tool contract"
```

---

## Task 5: Update the eval dataset

**Files:**
- Modify: `src/eval/dataset.ts:31-36,43-46,52-55` (remap tools; delete two fan cases)

**Interfaces:**
- Consumes: new tool names + safety classes. No automated test covers this file; verified by `npm run typecheck` + inspection (`npm run eval` needs a live LLM and is out of scope).

- [ ] **Step 1: Remap the tool-expecting cases**

In `src/eval/dataset.ts` apply these exact replacements:

- Line 31 (`pending-cmds`): `tool: 'get_pending_commands'` → `tool: 'get_recent_commands'`
- Line 32 (`water-10s`): `tool: 'send_command'` → `tool: 'set_pump'`
- Line 33 (`light-on`): `tool: 'send_command'` → `tool: 'set_light'`
- Line 35 (`auto-water`): `tool: 'auto_water'` → `tool: 'set_mode'`
- Line 36 (`set-moisture-rule`): `tool: 'set_moisture_rule'` → `tool: 'set_device_config'`
- Line 43 (`get-moisture-rule`): `tool: 'get_moisture_rule'` → `tool: 'get_device_config'`
- Line 44 (`get-light-rule`): `tool: 'get_light_rule'` → `tool: 'get_device_config'`
- Line 45 (`auto-light`): `tool: 'auto_light'` → `tool: 'set_mode'`
- Line 46 (`set-light-rule`): `tool: 'set_light_rule'` → `tool: 'set_device_config'`
- Line 52 (`pending-alt`): `tool: 'get_pending_commands'` → `tool: 'get_recent_commands'`
- Line 53 (`light-off`): `tool: 'send_command'` → `tool: 'set_light'`
- Line 55 (`water-15s`): `tool: 'send_command'` → `tool: 'set_pump'`

- [ ] **Step 2: Delete the two fan cases**

Delete line 34 entirely:

```typescript
  { id: 'fan-off', message: 'Tắt quạt thiết bị esp32-01 giúp mình.', expect: { type: 'tool', tool: 'send_command', safety: 'control' } },
```

Delete line 54 entirely:

```typescript
  { id: 'fan-on', message: 'Bật quạt cho esp32-01.', expect: { type: 'tool', tool: 'send_command', safety: 'control' } },
```

- [ ] **Step 3: Verify no stale names remain + typecheck**

Run: `npx vitest run` (full suite, still green) and:
`git grep -nE "send_command|auto_water|auto_light|set_moisture_rule|set_light_rule|get_moisture_rule|get_light_rule|get_pending_commands|fan-on|fan-off" src/eval/dataset.ts`
Expected: no matches in `dataset.ts`; `npm run typecheck` passes.

- [ ] **Step 4: Commit**

```bash
git add src/eval/dataset.ts
git commit -m "refactor(eval): update eval dataset for new tool contract"
```

---

## Task 6: Update unit-test fixtures (opaque tool names)

**Files:**
- Modify: `src/agent/streamParser.test.ts:48,50`
- Modify: `src/memory/sessions.test.ts:8`

These use tool names as opaque strings; a rename keeps them green (no source change).

- [ ] **Step 1: `streamParser.test.ts`**

Replace line 48:

```typescript
    const { events } = collect(['{"args":{"message":"decoy"},"type":"tool","tool":"set_pump","message":"thật"}'])
```

Replace line 50:

```typescript
    expect(events).toContainEqual({ kind: 'field', key: 'tool', value: 'set_pump' })
```

- [ ] **Step 2: `sessions.test.ts`**

Replace line 8:

```typescript
const action = (id: string): PendingAction => ({ id, tool: 'set_pump', args: {}, summary: 's' })
```

- [ ] **Step 3: Run both files**

Run: `npx vitest run src/agent/streamParser.test.ts src/memory/sessions.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/agent/streamParser.test.ts src/memory/sessions.test.ts
git commit -m "test: update unit fixtures to new tool names"
```

---

## Task 7: Update orchestrator integration fixtures

**Files:**
- Modify: `tests/orchestrator.test.ts` (lines 124,128,133,140,145,153,160,167,172,177,185,188,200,201,209,212,220-223,234,270,273,274,279,283,388,425,451)
- Modify: `tests/orchestrator.stream.test.ts` (lines 142,149,150,175,183,237,269,278,310,318)

These are behavior tests over the fake MCP/LLM. Fallback classification keeps them correct after the rename; Task 1's `set_light` schema is required for the arg-sanitization sub-tests.

- [ ] **Step 1: `orchestrator.test.ts` — `get_moisture_rule` → `get_device_config`**

Replace every `get_moisture_rule` with `get_device_config` at lines 124 (comment), 128, 133, 185 (comment), 188, 200 (`'Unknown tool: get_moisture_rule'` → `'Unknown tool: get_device_config'`), 201, 220, 221, 222, 223.

- [ ] **Step 2: `orchestrator.test.ts` — pump/light/mode control fixtures**

Line 140:

```typescript
      '{"type":"tool","tool":"set_pump","args":{"device_id":"esp32-01","on":true}}',
```

Line 145: `expect(res.pendingAction?.tool).toBe('set_pump')`

Line 153:

```typescript
      '{"type":"tool","tool":"set_pump","args":{"device_id":"esp32-01","on":true}}',
```

Line 160: `expect(mcp.calls[0]?.name).toBe('set_pump')`

Line 167:

```typescript
      '{"type":"tool","tool":"set_mode","args":{"device_id":"esp32-01","auto":true}}',
```

Line 172: `expect(mcp.calls[0]?.name).toBe('set_mode')`

Line 177: `llm.jsonQueue = ['{"type":"tool","tool":"set_pump","args":{"device_id":"d1","on":true}}']`

Line 209: `llm.jsonQueue = ['{"type":"tool","tool":"set_pump","args":{"device_id":"d1","on":true}}']`

Line 212: `mcp.error = new McpError(ErrorCode.MethodNotFound, 'Unknown tool: set_pump')`

Line 234: `llm.jsonQueue = ['{"type":"tool","tool":"set_pump","args":{"device_id":"d1","on":true}}']`

- [ ] **Step 3: `orchestrator.test.ts` — arg-sanitization block (268-284)**

Line 270:

```typescript
      '{"type":"tool","tool":"set_light","args":{"device_id":"esp32-01","on":true,"pwm":200,"message":"Mình sẽ bật đèn thiết bị esp32-01."},"message":"Bật đèn nhé."}',
```

Line 273: `expect(res.pendingAction?.tool).toBe('set_light')`

Line 274:

```typescript
    expect(res.pendingAction?.args).toEqual({ device_id: 'esp32-01', on: true, pwm: 200 })
```

Line 279:

```typescript
    llm.jsonQueue = ['{"type":"tool","tool":"set_light","args":{"device_id":"esp32-01","on":true,"message":"x"}}']
```

Line 283:

```typescript
    expect(mcp.calls[0]?.args).toEqual({ device_id: 'esp32-01', on: true })
```

- [ ] **Step 4: `orchestrator.test.ts` — sensor-history arg + reply-carried control**

Line 388: `"hours":24` → `"limit":24`
Line 451: `"hours":24` → `"limit":24`

Line 425:

```typescript
      '{"type":"reply","message":"Mình gợi ý tưới thêm cho cây.","tool":"set_pump","args":{"device_id":"d1","on":true}}',
```

- [ ] **Step 5: `orchestrator.stream.test.ts`**

Lines 142, 149, 237, 310: `get_moisture_rule` → `get_device_config`.

Line 150:

```typescript
      note: 'Đang đọc dữ liệu (get_device_config)…',
```

Line 175:

```typescript
      ['{"type":"tool","tool":"set_pump","args":{"device_id":"d1","on":true},"message":"Mình sẽ bật bơm."}'],
```

Line 183: `expect(doneOf(events).pendingAction?.tool).toBe('set_pump')`

Line 269: `llm.jsonScripts = [['{"type":"tool","tool":"set_pump","args":{"device_id":"d1","on":true}}']]`

Line 278: `llm.jsonScripts = [['{"type":"tool","tool":"set_pump","args":{"device_id":"d1","on":true}}']]`

Line 318:

```typescript
        ['{"type":"tool","tool":"set_pump","args":{"device_id":"d1","on":true},"message":"Mình sẽ bật bơm."}'],
```

- [ ] **Step 6: Run both files**

Run: `npx vitest run tests/orchestrator.test.ts tests/orchestrator.stream.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add tests/orchestrator.test.ts tests/orchestrator.stream.test.ts
git commit -m "test: update orchestrator fixtures to new tool contract"
```

---

## Task 8: Update OpenAI + HTTP integration fixtures

**Files:**
- Modify: `tests/openai.adapter.test.ts` (lines 47,85,103,111,115,117,134,142,144,162,168,193,196)
- Modify: `tests/openai.http.test.ts` (lines 131,138,155,361,376)
- Modify: `tests/openai.stream.test.ts` (lines 102,111)
- Modify: `tests/http.stream.test.ts` (lines 141,151)

- [ ] **Step 1: `openai.adapter.test.ts`**

Replace `send_command` with `set_pump` at lines 47, 85, 134, 142, 144, 162, 168, 193, 196 (tool-name-only renames; leave their `arguments`/`args` unchanged where they are `{}` or `{"device_id":"d1"}`).

Line 103 (test title): `'rebuilds a control pending from a set_pump tool_call'`

Line 111:

```typescript
          function: { name: 'set_pump', arguments: '{"device_id":"d1","on":true}' },
```

Line 115: `expect(p?.tool).toBe('set_pump')`

Line 117:

```typescript
    expect(p?.args).toEqual({ device_id: 'd1', on: true })
```

- [ ] **Step 2: `openai.http.test.ts`**

Line 131:

```typescript
    llm.jsonQueue = ['{"type":"tool","tool":"set_pump","args":{"device_id":"d1","on":true}}']
```

Line 138: `expect(msg1.tool_calls[0].function.name).toBe('set_pump')`
Line 155: `expect(mcp.calls).toEqual(['set_pump'])`

Line 361:

```typescript
    llm.jsonQueue = ['{"type":"tool","tool":"set_pump","args":{"device_id":"d1","on":true}}']
```

Line 376: `expect(mcp.calls).toEqual(['set_pump'])`

- [ ] **Step 3: `openai.stream.test.ts`**

Line 102:

```typescript
    llm.jsonQueue = ['{"type":"tool","tool":"set_pump","args":{"device_id":"d1","on":true}}']
```

Line 111: `expect(toolChunk.choices[0].delta.tool_calls[0].function.name).toBe('set_pump')`

- [ ] **Step 4: `http.stream.test.ts`**

Line 141:

```typescript
    llm.jsonQueue = ['{"type":"tool","tool":"set_pump","args":{"device_id":"d1","on":true}}']
```

Line 151: `expect(done?.data.pendingAction.tool).toBe('set_pump')`

- [ ] **Step 5: Run all four files**

Run: `npx vitest run tests/openai.adapter.test.ts tests/openai.http.test.ts tests/openai.stream.test.ts tests/http.stream.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add tests/openai.adapter.test.ts tests/openai.http.test.ts tests/openai.stream.test.ts tests/http.stream.test.ts
git commit -m "test: update openai/http fixtures to new tool contract"
```

---

## Task 9: Update README + full-suite gate

**Files:**
- Modify: `README.md` (the `send_command` tool_calls example, ~lines 113-114)

- [ ] **Step 1: Update the README example**

Open `README.md` around lines 108-116. Replace the confirmation message line (113) and tool_calls line (114):

```json
      "content": "Bạn xác nhận thực hiện: \"Bật bơm nước thiết bị esp32-01\"? (Có/Không)",
      "tool_calls": [{ "type": "function", "function": { "name": "set_pump", "arguments": "{\"device_id\":\"esp32-01\",\"on\":true}" } }]
```

(If the surrounding prose mentions `WATER_ON`/`duration`, update it to the `set_pump(on=true)`, firmware-self-stop wording. Read the block first to catch any adjacent stale copy.)

- [ ] **Step 2: Final repo-wide staleness sweep**

Run:
`git grep -nE "send_command|auto_water|auto_light|set_moisture_rule|set_light_rule|get_moisture_rule|get_light_rule|get_pending_commands|WATER_ON|WATER_OFF|LIGHT_ON|LIGHT_OFF|FAN_ON|FAN_OFF" -- ':!docs/superpowers' ':!docs/rag-course-review.md'`
Expected: no matches outside the excluded historical docs. If any remain, fix them before continuing.

- [ ] **Step 3: Full typecheck + test suite**

Run: `npm run typecheck && npm test`
Expected: tsc clean; full vitest suite green.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: update README example for new tool contract"
```

---

## Task 10 (optional): Guard against dataset↔catalog drift

A cheap regression test that fails if the eval dataset ever references a tool that is
not in the catalog, or a safety class that disagrees with `policy.ts` — the exact
drift this migration fixed. Not required by the spec; include if you want the guard.

**Files:**
- Create: `tests/dataset.test.ts`

- [ ] **Step 1: Write the guard test**

```typescript
import { describe, expect, it } from 'vitest'
import { EVAL_CASES } from '../src/eval/dataset'
import { KNOWN_TOOLS } from '../src/mcp/knownTools'
import { classifyTool } from '../src/mcp/policy'

describe('eval dataset ↔ tool contract', () => {
  const names = new Set(KNOWN_TOOLS.map((t) => t.name))

  it('every expected tool exists in the catalog', () => {
    for (const c of EVAL_CASES) {
      if (c.expect.type === 'tool' && c.expect.tool) {
        expect(names, `case ${c.id} → ${c.expect.tool}`).toContain(c.expect.tool)
      }
    }
  })

  it('every expected safety class matches policy classification', () => {
    for (const c of EVAL_CASES) {
      if (c.expect.type === 'tool' && c.expect.tool && c.expect.safety) {
        expect(classifyTool(c.expect.tool), `case ${c.id}`).toBe(c.expect.safety)
      }
    }
  })
})
```

- [ ] **Step 2: Run it**

Run: `npx vitest run tests/dataset.test.ts`
Expected: PASS (proves Tasks 1, 2, 5 are mutually consistent).

- [ ] **Step 3: Commit**

```bash
git add tests/dataset.test.ts
git commit -m "test: guard eval dataset against catalog/policy drift"
```

---

## Self-review

- **Spec coverage:** catalog (T1), policy (T2), confirmation summaries (T3), prompt + few-shot (T4), eval dataset (T5), all grep-verified tests including the doc's omissions — `orchestrator.*`, `policy`, `openai.stream`, `prompt` guard (T2/T4/T6/T7/T8) — `src/llm/prompt.ts` (T4, the handoff's miss), README (T9). Decisions 1–3 encoded in T1 (`set_pump` no duration), T3/T5 (`set_mode` for auto), T1/T2 (`refresh_device_config`+`show_message` control). ✓
- **Placeholder scan:** every code step shows exact before/after strings; no TBD/TODO. ✓
- **Type consistency:** tool names (`set_pump`, `set_light`, `set_mode`, `set_device_config`, `get_device_config`, `get_recent_commands`, `refresh_device_config`, `show_message`) and arg keys (`on`, `pwm`, `auto`, `limit`, `text`, `soil_on_pct`…) are used identically across catalog, policy, summaries, fewshot, eval, and every test fixture. `set_light` declares `on`+`pwm` so the T7 arg-sanitization test (`pwm:200` survives) is valid against T1's schema. ✓
- **`tests/http.test.ts`:** grep found no old-contract references — no task needed; the T9 sweep will confirm nothing was missed. ✓
