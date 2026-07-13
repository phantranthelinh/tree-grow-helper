# Spec: Persistence cho session/pendingAction + CI test gate

> [!NOTE] Meta
> **Ticket:** — · **Date:** 2026-07-13 · **Author:** Linh Phan

---

## Problem

> [!WARNING] Problem Statement
> Người vận hành `ai-server` (mục tiêu 1–5 user nội bộ/demo) mất trạng thái hội thoại mỗi lần restart, và có thể publish image từ commit hỏng test.
>
> - **Persistence**: `SessionStore` (`src/memory/sessions.ts`) là `Map` in-memory thuần. Restart process → mất toàn bộ history **và** `pendingAction` đang chờ xác nhận. Nếu server restart giữa lúc user chờ confirm, thao tác "có"/`/chat/confirm` kế tiếp sẽ lỗi vì pending đã biến mất.
> - **Footgun an toàn**: pendingAction hiện sống vô thời hạn tới khi confirm/clear. Nếu được persist, một lệnh điều khiển cũ có thể bị "có" nhiều giờ/ngày sau vô tình kích hoạt.
> - **CI**: chỉ có `.github/workflows/docker-publish.yml` (build+push image), **không chạy `npm test`/`npm run typecheck`**. Các test prompt (`tests/prompt.test.ts`) là lá chắn duy nhất cho quirk của model 3B mà lại regress trong im lặng — không có CI thì lá chắn dễ vỡ, và image hỏng vẫn publish.

---

## Goals

- Session history + pendingAction **sống sót qua restart**, ghi ra file JSON (`data/sessions.json`), **zero dependency mới**.
- Persistence là **opt-in qua constructor** → interface public + mọi test hiện có **không đổi**.
- Đóng footgun: pendingAction có **TTL ~30 phút**; quá hạn coi như không còn.
- CI chạy `typecheck` + `test` trên PR và push main; **image chỉ publish khi test PASS**.
- **Không** đổi interface sang async, **không** thêm auth/eviction session/đa-instance (ngoài phạm vi).

---

## User Stories

| As a… | I want to… | So that… |
|-------|-----------|----------|
| Người dùng cuối (chat VN) | restart server giữa lúc chờ xác nhận vẫn confirm được | không mất lệnh đang chờ, không phải hỏi lại |
| Người vận hành | history không bay khi deploy/restart | hội thoại multi-turn liền mạch qua các lần khởi động |
| Dev bảo trì | PR bị chặn merge/publish nếu test đỏ | quirk model 3B không regress âm thầm, image luôn xanh |

---

## Functional Requirements

### FR1 — `SessionStore` opt-in persistence (`src/memory/sessions.ts`)

Giữ nguyên **5 method sync** (`getHistory`/`append`/`getPending`/`setPending`/`clearPending`) và ngữ nghĩa hiện tại. Constructor mở rộng:

```ts
new SessionStore({
  maxTurns?: number,       // như cũ, default 20 (→ maxMessages = 40)
  path?: string,           // CÓ → bật persistence; KHÔNG → in-memory thuần (hành vi cũ)
  pendingTtlMs?: number,   // default 30 * 60 * 1000
  now?: () => number,      // default () => Date.now(); inject để test TTL
})
```

- **Không `path`** → thuần in-memory, không đọc/ghi đĩa (giữ 100% hành vi cũ; mọi test hiện có dựng `new SessionStore()` không đổi).
- **Có `path`** → load lúc khởi tạo, ghi lại sau **mọi** mutation.

### FR2 — Định dạng file & ghi atomic

File `data/sessions.json` (tự tạo thư mục cha bằng `mkdirSync(dirname(path), { recursive: true })`, y như `src/rag/embedCache.ts`):

```jsonc
{
  "version": 1,
  "sessions": {
    "u1::s1": {
      "history": [{ "role": "user", "content": "..." }],
      "pending": { "action": { /* PendingAction nguyên vẹn */ }, "createdAt": 1720000000000 }
    }
  }
}
```

- `createdAt` (epoch ms) bọc **bên trong** wrapper `{ action, createdAt }` → type `PendingAction` và JSON trả cho client **không lộ** field mới.
- **Ghi**: flush **đồng bộ trên mọi mutation** (`append`, `setPending`, `clearPending`, và khi TTL loại pending lúc đọc). File nhỏ ở quy mô 1–5 user nên chi phí không đáng kể; đơn giản hơn debounce (không timer, không cần flush-lúc-shutdown) và không mất lượt nào khi crash.
- **Atomic**: ghi ra `${path}.tmp` rồi `renameSync(tmp, path)` (rename thay thế file cũ, an toàn cả trên Windows qua Node). Crash giữa lúc ghi không để lại file hỏng.

### FR3 — Load lúc boot

- File thiếu → khởi tạo rỗng.
- File tồn tại → `readFileSync` + `JSON.parse`, nạp vào `Map`. Loại ngay các pending đã quá TTL khi nạp.
- File hỏng/parse lỗi/`version` lạ → **log cảnh báo, khởi tạo rỗng, KHÔNG throw** (đúng tinh thần graceful-degradation của repo: chỉ throw bất ngờ mới tới phase `error`).

### FR4 — TTL cho pendingAction

- `setPending` gán `createdAt = now()`.
- `getPending` nếu `now() - createdAt > pendingTtlMs` → trả `undefined` **và** clear pending (+ flush nếu có path). Logic đặt hoàn toàn trong `SessionStore`; orchestrator/route không đổi.

### FR5 — Wiring cấu hình

- `src/config.ts` thêm khối:
  ```ts
  memory: {
    sessionsPath: process.env.SESSIONS_PATH ?? 'data/sessions.json',
    pendingTtlMs: num(process.env.PENDING_TTL_MS, 30 * 60 * 1000),
  },
  ```
- `src/setup/init.ts:101` → `new SessionStore({ path: appCfg.memory.sessionsPath, pendingTtlMs: appCfg.memory.pendingTtlMs })`.
- `.env.example`: thêm `SESSIONS_PATH` + `PENDING_TTL_MS` (kèm comment tiếng Việt như các key khác).

### FR6 — CI test gate (`.github/workflows/`)

- **`test.yml`** — `on: workflow_call`; 1 job: `checkout@v4` → `setup-node@v4` (node-version 22, `cache: npm`) → `npm ci` → `npm run typecheck` → `npm test`.
- **`ci.yml`** — `on: pull_request` (branches: `main`); job `test` dùng `uses: ./.github/workflows/test.yml`.
- **`docker-publish.yml`** — thêm job `test` (`uses: ./.github/workflows/test.yml`); job `build-and-push` thêm `needs: test`.

`ci.yml` chỉ `pull_request` để tránh chạy test 2 lần trên main (push main đã được `docker-publish` lo). `npm run eval` **không** vào CI (cần LLM sống).

---

## UI Behaviour

> [!INFO] Không có UI mới
> Thay đổi thuần backend/hạ tầng. Response của `/chat`, `/chat/stream`, `/chat/confirm` giữ nguyên shape. `pendingAction` trả cho client không thêm field. Không đổi `/setup`.

---

## Edge Cases

> [!DANGER] Watch out for
> - **Crash giữa lúc ghi** → temp+rename đảm bảo file đích luôn là JSON hợp lệ (bản cũ hoặc bản mới trọn vẹn).
> - **File hỏng lúc load** → khởi tạo rỗng + cảnh báo, không làm sập init.
> - **Pending quá hạn qua restart** → bị loại lúc load và/hoặc lúc `getPending`; "có" sau đó rơi vào nhánh "không có pending" như bình thường.
> - **Test isolation** → `new SessionStore()` không path = in-memory, KHÔNG đụng `data/sessions.json`; test persistence dùng path tạm trong thư mục temp và tự dọn.
> - **Windows rename** → `fs.renameSync` trên Windows (máy dev) thay thế được file đích (Node map sang MoveFileEx replace-existing); nếu EPERM tạm thời do handle khác giữ file, chấp nhận ở quy mô demo.
> - **Ghi đồng thời trong 1 process** → không xảy ra: mutation sync, single-threaded. Đa-instance/đa-process **không** hỗ trợ (ngoài phạm vi).

---

## Technical Notes

> [!TIP] Dev notes
> - Dùng `node:fs` sync (`existsSync`/`readFileSync`/`writeFileSync`/`renameSync`/`mkdirSync`) — mirror `src/rag/embedCache.ts`, zero native dep.
> - `Session.pending` đổi kiểu nội bộ: `PendingAction | undefined` → `{ action: PendingAction; createdAt: number } | undefined`. Type `PendingAction` export **không đổi**.
> - `now: () => number` inject để test TTL deterministic (không phụ thuộc đồng hồ thật).
> - Persistence opt-in giữ seam DI: production truyền `path`, test không truyền.
> - `test.yml` reusable tránh trôi lệch bước test giữa CI và luồng publish. (Phương án gọn hơn nếu muốn: bỏ `test.yml`, nhúng thẳng bước test vào `ci.yml` và lặp ~8 dòng trong `docker-publish.yml`.)

---

## Acceptance Criteria

> [!CHECK] Definition of Done
> - [ ] `new SessionStore({ path })` load lúc tạo, ghi sau mọi mutation; `new SessionStore()` không tạo/đọc file.
> - [ ] History + pendingAction sống sót qua "restart" (dựng store mới cùng path thấy lại dữ liệu).
> - [ ] pendingAction quá `pendingTtlMs` → `getPending` trả `undefined` và đã clear.
> - [ ] File hỏng/thiếu lúc load → khởi tạo rỗng, không throw (có log cảnh báo).
> - [ ] Ghi atomic qua temp+rename; type `PendingAction` và JSON trả client không đổi.
> - [ ] `config.memory` + wiring `init.ts` + `.env.example` cập nhật.
> - [ ] `ci.yml` chạy typecheck+test trên PR; `docker-publish` build `needs: test`; `test.yml` reusable dùng chung.
> - [ ] `npm test` + `npm run typecheck` xanh; test mới cho persistence/TTL/load-lỗi/in-memory ở `src/memory/sessions.test.ts`.
> - [ ] Mọi test hiện có vẫn xanh, không sửa.

---

## Out of Scope

- Auth/rate-limit trên endpoint điều khiển (đề xuất #1 — làm riêng).
- Eviction session cũ theo tuổi; đa-instance/đồng bộ nhiều process.
- Chuyển interface `SessionStore` sang async; đổi sang SQLite.
- Đưa `npm run eval` vào CI (cần LLM sống).
