# Spec: Migrate AI server to the new MCP tool contract

**Date:** 2026-07-22
**Status:** Approved (design)
**Repo:** `ai-server` (GitHub: `phantranthelinh/tree-grow-helper`)

## Problem

The AI server still targets the **old** `plant-tree-iot` MCP tool contract. The MCP
server has since migrated to a new tool set, so the AI server's static catalog,
safety policy, system prompt, few-shot examples, eval dataset, and tests all
reference tools that no longer exist (`send_command`, `auto_water`, `auto_light`,
`set_moisture_rule`, `set_light_rule`, `get_moisture_rule`, `get_light_rule`,
`get_pending_commands`, and the `WATER_ON/LIGHT_ON/FAN_*` commands with `duration`).

At runtime the live MCP schema (from `listTools`) takes precedence, so a connected
server would still function — but the **fallback catalog** ([knownTools.ts]), the
**safety classification** ([policy.ts]), the **prompt/few-shot** the small model is
tuned on, and the **eval dataset** are all stale. In degraded mode (MCP unreachable)
the server would offer non-existent tools; the eval would measure accuracy against a
dead contract; and control confirmations would summarize the wrong actions.

## Goal

Realign every place the old contract is encoded so the AI server speaks the new
contract. **No change to runtime behavior beyond tool selection**, and the core
safety invariant is preserved: read tools auto-run, control tools always require an
explicit user confirmation before execution.

## New tool contract

The new contract (per handoff from the `plant-tree-iot` side):

| # | Tool | Args | Class |
|---|------|------|-------|
| 1 | `list_devices` | — | read |
| 2 | `get_device_info` | `device_id` | read |
| 3 | `get_latest_sensor` | `device_id` | read (confirm-before-read) |
| 4 | `get_sensor_history` | `device_id`, `limit=10` | read (confirm-before-read) |
| 5 | `get_recent_commands` | `device_id` | read |
| 6 | `get_device_config` | `device_id` | read |
| 7 | `set_pump` | `device_id`, `on: bool` | control |
| 8 | `set_light` | `device_id`, `on: bool` \| `pwm: 0..255` | control |
| 9 | `set_mode` | `device_id`, `auto: bool` | control |
| 10 | `show_message` | `device_id`, `text`, `secs?` | control |
| 11 | `set_device_config` | `device_id`, + threshold fields | control |
| 12 | `refresh_device_config` | `device_id` (publishes MQTT `{"config":{}}`) | control |

### Mapping (old → new)

| Old | New |
|-----|-----|
| `send_command WATER_ON/OFF` | `set_pump(device_id, on)` — `duration` dropped |
| `send_command LIGHT_ON/OFF` | `set_light(device_id, on)`; brightness `set_light(device_id, pwm=0..255)` |
| `send_command FAN_ON/OFF` | **removed** — no fan hardware |
| `auto_water(threshold)` | `set_mode(device_id, auto=true)` |
| `auto_light(threshold)` | `set_mode(device_id, auto=true)` |
| `set_moisture_rule(threshold)` | `set_device_config(soil_on_pct, soil_off_pct)` |
| `set_light_rule(threshold)` | `set_device_config(lux_on, lux_off)` |
| `get_moisture_rule` / `get_light_rule` | `get_device_config(device_id)` (returns all thresholds) |
| `get_pending_commands` | `get_recent_commands(device_id)` — published log, not a poll queue |
| `get_sensor_history(hours)` | `get_sensor_history(device_id, limit=10)` — arg was wrong |
| — | new: `set_mode`, `show_message`, `refresh_device_config` |

## Resolved behavioral decisions

1. **"Tưới N giây" (water for N seconds)** → `set_pump(device_id, on=true)` only.
   The firmware self-stops after the device's `pump_max_run_s`. The model must NOT
   emit a `duration`, must NOT change config for a one-off water request, and the
   reply text explains the pump stops automatically (drop "trong 10 giây" phrasing).
2. **"Bật tưới/đèn tự động" (turn on auto)** → `set_mode(device_id, auto=true)` alone.
   Setting a specific numeric threshold ("auto khi độ ẩm < 75%", "đèn khi < 300 lux")
   is a *separate* intent → `set_device_config(...)`. Clean 1:1 mapping, one
   confirmation each. Do not couple the two into a two-step control flow.
3. **`refresh_device_config` and `show_message`** → both classified `control`
   (require confirmation). Preserves the "any device write confirms" invariant even
   though the risk is low. `show_message` gets a confirmation step for a screen write;
   accepted as the safe, consistent default.

## Changes by file

### Source

**`src/mcp/knownTools.ts`** — the fallback catalog + eval tool list.
- Add a `bool = { type: 'boolean' as const }` schema helper (only `str`/`num` exist).
- Remove: `send_command`, `auto_water`, `auto_light`, `set_moisture_rule`,
  `set_light_rule`, `get_moisture_rule`, `get_light_rule`, `get_pending_commands`.
- Add: `set_pump`, `set_light`, `set_mode`, `show_message`, `get_recent_commands`,
  `get_device_config`, `set_device_config`, `refresh_device_config`.
- Fix `get_sensor_history`: arg is `limit: num` (default 10), not `hours`.
- Update the header comment (tool count + the `WATER_ON…` description line).

**`src/mcp/policy.ts`** — safety classification.
- `READ_ONLY`: remove `get_pending_commands`, `get_moisture_rule`, `get_light_rule`;
  add `get_recent_commands`, `get_device_config`.
- `CONTROL`: remove `send_command`, `auto_water`, `auto_light`, `set_moisture_rule`,
  `set_light_rule`; add `set_pump`, `set_light`, `set_mode`, `show_message`,
  `set_device_config`, `refresh_device_config`.
- `CONFIRM_BEFORE_READ` unchanged (`get_latest_sensor`, `get_sensor_history`).

**`src/domain/fewshot.ts`** — small-model few-shot examples.
- Ví dụ 3 (bật đèn): `send_command`/`LIGHT_ON` → `set_light` `{device_id, on:true}`.
- Ví dụ 4 (tưới): `send_command`/`WATER_ON`/`duration:10000` →
  `set_pump` `{device_id, on:true}`; rewrite the `message` to drop "trong 10 giây"
  and explain the pump self-stops after `pump_max_run_s`.
- **Preserve field order** `type → message → tool → args` (small-model constraint —
  do not reorder).

**`src/agent/confirmation.ts`** — action summaries for the confirm prompt.
- Remove the `COMMAND_LABELS` map (tied to `send_command`, incl. FAN entries).
- Rewrite `summarizeAction` cases:
  - `set_pump` → "Bật/Tắt bơm nước" (from `args.on`).
  - `set_light` → "Bật/Tắt đèn", or "Đặt độ sáng đèn = {pwm}" when `pwm` present.
  - `set_mode` → "Chuyển chế độ auto/manual" (from `args.auto`).
  - `show_message` → "Hiển thị lên màn hình: {text}".
  - `set_device_config` → "Đổi cấu hình ngưỡng: {…}".
  - `refresh_device_config` → "Làm mới cấu hình thiết bị".
- Keep `get_latest_sensor`. Fix `get_sensor_history` to use `limit` (N bản ghi gần
  nhất) instead of `hours`.

**`src/llm/prompt.ts`** — system prompt (missed by the handoff doc).
- Rule #4 lists the READ tools as `... get_*_rule, get_pending_commands ...` →
  update to `get_device_config, get_recent_commands`.

**`src/eval/dataset.ts`** — tool-selection eval set.
- Remap expected tools: `water-10s`/`water-15s` → `set_pump`; `light-on`/`light-off`
  → `set_light`; `pending-cmds`/`pending-alt` → `get_recent_commands`;
  `get-moisture-rule`/`get-light-rule` → `get_device_config`;
  `set-moisture-rule`/`set-light-rule` → `set_device_config`;
  `auto-water`/`auto-light` → `set_mode` (per decision 2).
- Delete the two fan cases: `fan-off`, `fan-on`.

### Tests (grep-verified — the handoff doc under-listed these)

Each encodes the old contract and is part of the migration:
- `tests/args.test.ts`
- `tests/confirmation.test.ts`
- `tests/policy.test.ts`
- `tests/http.stream.test.ts`
- `tests/openai.http.test.ts`
- `tests/openai.adapter.test.ts`
- `tests/openai.stream.test.ts`
- `tests/orchestrator.test.ts` (27 occurrences — heaviest)
- `tests/orchestrator.stream.test.ts` (10 occurrences)
- `src/agent/streamParser.test.ts`
- `src/memory/sessions.test.ts`

`tests/http.test.ts` (listed in the handoff) had **no** matches — likely no change;
confirm during implementation.

### Docs

- `README.md` — one `send_command` example (line ~114) → new contract.
- Historical `docs/superpowers/**` specs/plans and `docs/rag-course-review.md` are
  **left as-is** — they are records of past work, not living contract docs.

## Open items to verify against the live MCP (`npm run mcp:catalog`)

1. **Tool count:** the handoff says "13 tools" but enumerates only 12. Reconcile the
   real count against the live catalog when the MCP is reachable.
2. **`set_device_config` full arg list:** only 5 of the stated "15 thresholds" are
   named (`soil_on_pct`, `soil_off_pct`, `lux_on`, `lux_off`, `pump_max_run_s`).
   `knownTools.ts` is best-effort (live schema wins at runtime), so the plan lists the
   known args and notes the rest come from the live schema — but capture all 15 if the
   catalog is reachable.

Neither blocks the migration: `knownTools.ts` is a fallback mirror and the live schema
overrides it at runtime.

## Testing approach

- `npm run typecheck` and `npm test` must pass (tests need no external services — they
  run against the `LlmEngine`/`McpGateway`/`SetupDeps` fakes).
- Test updates land in the same change: the tests encode the old contract, so they are
  part of the migration, not a follow-up.
- `npm run eval` needs a live LLM and stays a separate manual accuracy check. The eval
  **dataset** is updated here; running the eval is not part of this task.

## Out of scope

- No changes to the agent loop, session memory, RAG pipeline, or HTTP wiring.
- No changes to the `plant-tree-iot` / MCP repo.
- No new few-shot examples for `set_mode`/`show_message` unless a follow-up eval shows
  the small model needs them (YAGNI for now).
