# Deck "Nuôi một bộ não biết nghề ươm giá" Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dựng `docs/presentation/gia-do-deck.html`: 21 slide tiếng Việt, animation từng bước bằng GSAP, slide demo
gọi trực tiếp LM Studio và AI server, có bản ghi dự phòng thật.

**Architecture:** Một file HTML tự chứa. Logic thuần (điều hướng, giải mã SSE, reducer khung chat) nằm trong
`<script id="deck-logic">` không đụng DOM và gắn vào `globalThis.DeckLogic`, nên test vitest chạy được nó bằng
`node:vm`. Mỗi slide đăng ký một hàm dựng GSAP timeline có nhãn `step0…stepN`. Cấu hình demo và bản ghi là hai khối
`<script type="application/json">` mà script `npm run deck:record` đọc và ghi lại.

**Tech Stack:** HTML/CSS/inline SVG, GSAP 3.13.0 (nhúng inline), vitest + `node:vm` cho test, tsx cho script ghi.

**Spec:** [docs/superpowers/specs/2026-11-19-gia-do-presentation-design.md](../specs/2026-11-19-gia-do-presentation-design.md)

## Global Constraints

- Toàn bộ chữ trên slide và speaker notes là **tiếng Việt** (`<html lang="vi">`).
- Mọi con số và câu trả lời mẫu lấy từ repo (spec mục 7) hoặc đo lại; ghi rõ nguồn trong speaker notes.
- Một file HTML tự chứa, không bước build: CSS, JS, SVG viết inline. Chỉ được tải ngoài từ Google Fonts, kèm font
  dự phòng hỗ trợ tiếng Việt (`"Segoe UI", system-ui, sans-serif`).
- GSAP **3.13.0**, bản `gsap.min.js` nhúng nguyên văn (giữ comment license đầu file) trong `<script id="gsap">`.
- Trình chiếu bằng `file://`; sân khấu 16:9 canvas 1280×720 scale vừa cửa sổ; xem được trên điện thoại (thu nhỏ có viền).
- `prefers-reduced-motion: reduce`: mỗi bước hiện thẳng trạng thái cuối (`seek`, không `tweenTo`).
- Phản mục tiêu: không bịa câu trả lời/số đo; không ngụ ý đã fine-tune; slide ít chữ, không code dài; animation
  phải giải thích cơ chế; demo luôn có lối thoát.
- Không sửa code server (`src/**`). Script ghi được phép **import** từ `src/` (ví dụ `summarizeAction`).
- Hình minh hoạ cơ chế ở slide 4, 9, 15 mang nhãn nhỏ "minh hoạ".
- Comment trong code: không mã ticket, chỉ viết khi giải thích được lý do.
- Artifact contract (skill `artifact-design`): `<title>` 2–4 chữ là **"Bộ não ươm giá"**; màu là token trên `:root`,
  có bản tối dưới `@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) }` và `:root[data-theme="dark"]`;
  `body` có nền tường minh.
- Commit: không thêm dòng attribution. Nhánh `feat/gia-do-deck` tách từ `main` (chờ Linh đồng ý commit).

## Review Focus

1. **Model khởi động chậm** (chữ đầu tiên đến sau 20 giây): khung đã chuyển sang bản ghi thì chữ live đến muộn
   **không được trộn vào**. Test: Task 7 `ignores live frames after fallback`.
2. **Gõ câu hỏi trong ô nhập** mà bấm Space/←/→: phải gõ chữ, không chuyển slide. Test: Task 1 `shouldHandleKey`.
3. **Bấm → liên tục khi animation đang chạy**: slide phải dừng đúng ở trạng thái cuối của bước cuối được bấm,
   không chồng hình. Test: Task 1 bước kiểm tra trình duyệt "bấm nhanh".
4. **Phòng họp không có mạng**: không còn tài nguyên ngoài nào ngoài font; chữ tiếng Việt vẫn đủ dấu bằng font dự
   phòng. Test: Task 1 `has no external resources except Google Fonts`, Task 10 kiểm tra offline.
5. **SSE bị cắt giữa dòng / giữa ký tự nhiều byte / có dòng `: ping` / `\r\n`**: chữ vẫn ráp đúng. Test: Task 7
   `decodes frames across every split point`.

---

## Bảng slide (dùng chung cho mọi task)

| # | `id` | `data-part` | `data-steps` | `data-min` (notes) |
|---|---|---|---|---|
| 1 | `s01-title` | `mo-dau` | 1 | 0.5 |
| 2 | `s02-question` | `mo-dau` | 2 | 1 |
| 3 | `s03-local` | `mo-dau` | 2 | 1.5 |
| 4 | `s04-next-word` | `bo-nao` | 3 | 2 |
| 5 | `s05-train-or-read` | `bo-nao` | 2 | 2 |
| 6 | `s06-rag` | `thu-vien` | 3 | 1.5 |
| 7 | `s07-ingest` | `thu-vien` | 2 | 1 |
| 8 | `s08-chunk` | `thu-vien` | 2 | 1 |
| 9 | `s09-embed` | `thu-vien` | 3 | 1.5 |
| 10 | `s10-hybrid` | `thu-vien` | 3 | 1.5 |
| 11 | `s11-select` | `thu-vien` | 2 | 1 |
| 12 | `s12-profile` | `thu-vien` | 3 | 1.5 |
| 13 | `s13-sources` | `thu-vien` | 2 | 1 |
| 14 | `s14-fewshot` | `cu-xu` | 3 | 1.5 |
| 15 | `s15-structured` | `cu-xu` | 2 | 1 |
| 16 | `s16-mcp` | `cu-xu` | 2 | 1.5 |
| 17 | `s17-guardrails` | `cu-xu` | 2 | 1 |
| 18 | `s18-eval` | `cham-bai` | 2 | 2 |
| 19 | `s19-demo` | `cham-bai` | 0 | 4 |
| 20 | `s20-still-wrong` | `cham-bai` | 2 | 1.5 |
| 21 | `s21-recap` | `ket` | 3 | 2 |

Tên phần hiển thị: `mo-dau` Mở đầu · `bo-nao` Bộ não · `thu-vien` Thư viện · `cu-xu` Cư xử · `cham-bai` Chấm bài · `ket` Kết.
Nội dung từng bước lấy theo cột "Animation" của spec mục 5.3. Câu chữ là quyết định của người dựng (spec mục 8).

---

### Task 1: Khung deck, điều hướng, GSAP

**Files:**
- Create: `docs/presentation/gia-do-deck.html`
- Create: `scripts/deck-blocks.ts`
- Test: `tests/presentation/deckBlocks.test.ts`, `tests/presentation/giaDoDeck.test.ts`

**Interfaces:**
- Produces (`scripts/deck-blocks.ts`):
  - `extractScriptBlock(html: string, id: string): string`: nội dung bên trong `<script … id="ID" …>`; throw nếu
    thiếu hoặc trùng id.
  - `replaceScriptBlock(html: string, id: string, content: string): string`: thay nội dung, giữ nguyên thẻ mở; throw
    nếu thiếu.
  - `toJsonBlock(value: unknown): string`: `JSON.stringify(value, null, 2)` với mọi `<` đổi thành `\u003c`.
- Produces (`DeckLogic`, trong `<script id="deck-logic">`, script thường, không DOM):
  - `createNavigator(steps: number[]): { state(): {slide, step}; next(): Move; prev(): Move; goto(slide: number): Move }`
    với `Move = { slide: number; step: number; kind: 'enter' | 'play' | 'seek' | 'enter-end' | 'none' }`.
  - `shouldHandleKey(e: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; target: { tagName?: string; isContentEditable?: boolean } | null }): boolean`.
- Produces (runtime trong `<script id="deck-runtime">`): `Deck.register(slideId: string, build: (el: HTMLElement, gsap: object) => Timeline)`.
  Timeline phải có nhãn `step0`…`step{N}` (N = `data-steps`). Runtime xử lý `Move`: `enter` → `tl.pause(0); tl.tweenTo('step0')`;
  `play` → `tl.seek('step'+(k-1)); tl.tweenTo('step'+k)`; `seek`/`enter-end` → `tl.pause(); tl.seek('step'+k)`.
  Reduced motion: mọi trường hợp đều `seek`. Slide chưa đăng ký builder thì tĩnh.
- Produces (test helper trong `tests/presentation/giaDoDeck.test.ts`): `loadDeck(): { html: string; logic: DeckLogic; slides: SlideInfo[] }`.
  Đọc file, chạy khối `deck-logic` trong `vm.createContext({})`, và tách mỗi `<section class="slide">` thành
  `{ id, part, steps, min, text, notes }` (text = chữ đã bỏ thẻ, không gồm notes; `min` đọc từ `data-min` của
  notes). Kèm hai helper `text(id: string): string` và `notes(id: string): string` (throw nếu không có slide đó).
  Các task sau thêm test vào file này.

- [ ] **Step 1: Tạo nhánh**

Run: `git switch -c feat/gia-do-deck main`
Expected: `Switched to a new branch 'feat/gia-do-deck'`. File spec và plan chưa track đi theo.

- [ ] **Step 2: Viết test thất bại cho `deck-blocks`**

```ts
it('extracts and replaces a block by id', () => {
  const html = '<p></p><script id="a" type="application/json">{"x":1}</script>'
  expect(extractScriptBlock(html, 'a')).toBe('{"x":1}')
  expect(replaceScriptBlock(html, 'a', '{}')).toBe('<p></p><script id="a" type="application/json">{}</script>')
})
it('throws on a missing or duplicated id', () => {
  expect(() => extractScriptBlock('<p></p>', 'b')).toThrow()
  expect(() => extractScriptBlock('<script id="a"></script><script id="a"></script>', 'a')).toThrow()
  expect(() => replaceScriptBlock('<p></p>', 'b', '{}')).toThrow()
})
it('escapes < so a value cannot close the script tag', () => {
  expect(toJsonBlock({ t: '</script>' })).not.toContain('</')
  expect(JSON.parse(toJsonBlock({ t: '</script>' })).t).toBe('</script>')
})
```

- [ ] **Step 3: Viết test thất bại cho khung deck** (`giaDoDeck.test.ts`)

```ts
it('navigates steps, then slides, and back to the end state', () => {
  const nav = logic.createNavigator([0, 2, 1])
  expect([nav.next(), nav.next(), nav.next(), nav.next(), nav.next(), nav.next()].map(m => [m.slide, m.step, m.kind]))
    .toEqual([[1,0,'enter'],[1,1,'play'],[1,2,'play'],[2,0,'enter'],[2,1,'play'],[2,1,'none']])
  expect([nav.prev(), nav.prev()].map(m => [m.slide, m.step, m.kind])).toEqual([[2,0,'seek'],[1,2,'enter-end']])
  expect(logic.createNavigator([1]).prev().kind).toBe('none')
})
it('shouldHandleKey ignores typing targets and modifier chords', () => {
  const base = { metaKey: false, ctrlKey: false, altKey: false }
  expect(logic.shouldHandleKey({ ...base, key: 'ArrowRight', target: { tagName: 'BODY' } })).toBe(true)
  expect(logic.shouldHandleKey({ ...base, key: ' ', target: { tagName: 'INPUT' } })).toBe(false)
  expect(logic.shouldHandleKey({ ...base, key: 'ArrowLeft', target: { tagName: 'TEXTAREA' } })).toBe(false)
  expect(logic.shouldHandleKey({ ...base, key: 'n', target: { tagName: 'DIV', isContentEditable: true } })).toBe(false)
  expect(logic.shouldHandleKey({ ...base, ctrlKey: true, key: 'ArrowRight', target: null })).toBe(false)
})
it('matches the slide table', () => {
  expect(slides.map(s => [s.id, s.part, s.steps, s.min])).toEqual(SLIDE_TABLE) // copy of the plan's table
})
it('every slide has speaker notes', () => { for (const s of slides) expect(s.notes.trim().length).toBeGreaterThan(0) })
it('has no external resources except Google Fonts', () => {
  const urls = [...html.matchAll(/\b(?:src|href)="(https?:[^"]+)"/g)].map(m => m[1])
  for (const u of urls) expect(u).toMatch(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//)
})
it('embeds GSAP 3.13.0 and honours reduced motion', () => {
  expect(extractScriptBlock(html, 'gsap')).toContain('3.13.0')
  expect(html).toContain('prefers-reduced-motion')
  expect(html).toMatch(/<html lang="vi"/)
  expect(html).toMatch(/<title>Bộ não ươm giá<\/title>/)
})
```

- [ ] **Step 4: Chạy test, xác nhận thất bại**

Run: `npx vitest run tests/presentation`
Expected: FAIL (`Cannot find module '../../scripts/deck-blocks'` / file deck không tồn tại).

- [ ] **Step 5: Lấy GSAP 3.13.0 vào một thư mục rỗng riêng trong scratchpad**

Run (trong `<scratchpad>/gsap-pkg/`): `npm pack gsap@3.13.0` rồi `tar -xzf gsap-3.13.0.tgz`
Expected: có `package/dist/gsap.min.js`, dòng đầu là comment license chứa `3.13.0`. Không chạy gì trong thư mục đó.

- [ ] **Step 6: Viết `scripts/deck-blocks.ts` và khung `gia-do-deck.html`**

Khung gồm: canvas 1280×720 scale bằng `transform` theo `min(innerWidth/1280, innerHeight/720)`, căn giữa có viền;
21 `<section class="slide" id data-part data-steps>` theo bảng, mỗi slide có tiêu đề tạm từ spec 5.3 và
`<aside class="notes" data-min>` tạm; thanh dưới cùng hiện tên phần đang nói + số slide; phím → Space PageDown /
← PageUp / Home End / `N` notes / `F` fullscreen qua `shouldHandleKey`; `<script id="gsap">` chứa nguyên văn file
ở Step 5; `deck-logic`; `deck-runtime`.

- [ ] **Step 7: Chạy test**

Run: `npx vitest run tests/presentation` rồi `npm test` và `npm run typecheck`
Expected: tất cả PASS, typecheck không lỗi.

- [ ] **Step 8: Kiểm tra trên trình duyệt**

Dùng Playwright MCP (`browser_navigate` tới `file:///D:/workspace/ai-server/docs/presentation/gia-do-deck.html`).
Ở 1280×720, 1024×768 và 390×844: canvas nằm trọn, có viền, không có thanh cuộn ngang. Đăng ký tạm một builder thử
3 bước cho `s04-next-word`, bấm `ArrowRight` 5 lần liên tiếp không chờ: ảnh chụp cuối phải là trạng thái `step3`
của s04 hoặc slide 5 đúng thứ tự, không chồng hình. Bấm ← từ s05 thì s04 hiện ở trạng thái cuối. Gỡ builder thử.

- [ ] **Step 9: Commit**

```bash
git add docs/presentation/gia-do-deck.html scripts/deck-blocks.ts tests/presentation docs/superpowers/specs/2026-11-19-gia-do-presentation-design.md docs/superpowers/plans/2026-11-19-gia-do-deck.md
git commit -m "docs(presentation): scaffold the bean sprout deck with stepped navigation"
```

---

### Task 2: Hệ thống hình ảnh và slide 1–5 (Mở đầu, Bộ não)

**Files:** Modify `docs/presentation/gia-do-deck.html`; Test `tests/presentation/giaDoDeck.test.ts`

**Interfaces:** Consumes `Deck.register`, nhãn `step0…stepN`. Produces: token màu/kiểu chữ trên `:root` và các lớp
dùng lại (thẻ, bong bóng chat, nhãn "minh hoạ" `.illus-tag`) cho Task 3–6 và 8.

- [ ] **Step 1: Nạp skill `artifact-design`** (bắt buộc trước khi viết giao diện), chọn phong cách theo spec 5.6:
  hạt đỗ xanh, cọng giá trắng ngà, nền sáng, có chế độ tối.
- [ ] **Step 2: Viết test thất bại**

```ts
it('slides 1-5 carry their pinned facts', () => {
  expect(text('s04-next-word')).toContain('minh hoạ')
  expect(text('s05-train-or-read')).toMatch(/không train/i)
  expect(text('s05-train-or-read')).toContain('3B')
})
```
- [ ] **Step 3: Chạy, xác nhận FAIL**: `npx vitest run tests/presentation -t "slides 1-5"`
- [ ] **Step 4: Dựng slide 1–5** với timeline đúng số bước ở bảng; nội dung theo spec 5.3 hàng 1–5. Slide 2 che hai
  bong bóng trả lời và gieo "đáp án đúng cũng chưa chắc chắn" (dẫn tới slide 12). Notes: câu mở, ý chính, nguồn số
  liệu, câu hỏi có thể gặp ("Sao không fine-tune?" ở slide 5).
- [ ] **Step 5: Chạy test PASS**: `npx vitest run tests/presentation`
- [ ] **Step 6: Kiểm tra trình duyệt**: chụp từng bước của slide 1–5 ở 1280×720, cả chế độ sáng và tối
  (`document.documentElement.dataset.theme = 'dark'`). Chữ không tràn khung, đủ dấu tiếng Việt.
- [ ] **Step 7: Commit**: `git commit -am "docs(presentation): opening and brain slides"`

---

### Task 3: Slide 6–9 (RAG, nhập sách, cắt sách, bản đồ ý nghĩa)

**Files:** Modify `docs/presentation/gia-do-deck.html`; Test `tests/presentation/giaDoDeck.test.ts`

**Interfaces:** Consumes token/lớp của Task 2.

- [ ] **Step 1: Viết test thất bại**

```ts
it('slides 6-9 carry their pinned facts', () => {
  expect(text('s07-ingest')).toMatch(/người duyệt/)
  expect(text('s08-chunk')).toMatch(/600/); expect(text('s08-chunk')).toMatch(/80/)
  expect(text('s09-embed')).toContain('bge-m3'); expect(text('s09-embed')).toContain('1024'); expect(text('s09-embed')).toContain('minh hoạ')
})
```
- [ ] **Step 2: Chạy, xác nhận FAIL**
- [ ] **Step 3: Dựng slide 6–9** theo spec 5.3 hàng 6–9. Slide 7 dùng tên 3 nguồn ở spec mục 7 và đúng sự thật:
  tài liệu `data/docs` đã duyệt. Slide 8 cắt một đoạn văn thật trong `bean-sprout.json` (`watering` hoặc `planting`),
  tô phần gối 80 ký tự. Slide 9: các cụm nhiệt độ / tưới / thu hoạch / an toàn thực phẩm, câu hỏi slide 2 rơi cạnh
  cụm nhiệt độ.
- [ ] **Step 4: Chạy test PASS**
- [ ] **Step 5: Kiểm tra trình duyệt** từng bước, sáng/tối.
- [ ] **Step 6: Commit**: `git commit -am "docs(presentation): library slides - retrieval basics"`

---

### Task 4: Slide 10–13 (hybrid, chọn lọc, hồ sơ cây, ghi nguồn)

**Files:** Modify `docs/presentation/gia-do-deck.html`; Test `tests/presentation/giaDoDeck.test.ts`

- [ ] **Step 1: Viết test thất bại**

```ts
it('slides 10-13 carry their pinned facts', () => {
  expect(text('s10-hybrid')).toContain('BM25'); expect(text('s10-hybrid')).toContain('6-BAP')
  expect(text('s11-select')).toContain('MMR')
  for (const s of ['27–30°C', '22–24°C', 'ĐH Cần Thơ', 'VAAS', 'bản nháp']) expect(text('s12-profile')).toContain(s)
  expect(text('s13-sources')).toContain('Nguồn tham khảo')
})
```
- [ ] **Step 2: Chạy, xác nhận FAIL**
- [ ] **Step 3: Dựng slide 10–13** theo spec 5.3 hàng 10–13. Slide 12 là slide nhấn "Khi hai cuốn sách cãi nhau":
  ĐH Cần Thơ 27–30°C / 60–65% đối với VAAS (trích nguồn nước ngoài) 22–24°C / 95%, hồ sơ giá đỗ vẫn là bản nháp
  (Linh xác nhận 2026-11-19). Slide 11 ghi ngưỡng 0,15 và 4 đoạn. Slide 13 lấy một câu trả lời thật có dòng
  "Nguồn tham khảo" từ bản ghi bên phải (Task 9); trước khi có bản ghi, dùng `reply` của `bs-kb-banned` trong
  `data/eval/r3-bean-sprout-1-…json` (file local, không track).
- [ ] **Step 4: Chạy test PASS**
- [ ] **Step 5: Kiểm tra trình duyệt** từng bước, sáng/tối.
- [ ] **Step 6: Commit**: `git commit -am "docs(presentation): library slides - profile, conflict and sources"`

---

### Task 5: Slide 14–17 (few-shot, khuôn trả lời, MCP, lan can)

**Files:** Modify `docs/presentation/gia-do-deck.html`; Test `tests/presentation/giaDoDeck.test.ts`

- [ ] **Step 1: Viết test thất bại**

```ts
it('slides 14-17 carry their pinned facts', () => {
  expect(text('s14-fewshot')).toContain('7 ví dụ'); expect(text('s14-fewshot')).toMatch(/bật đèn/)
  expect(text('s15-structured')).toContain('minh hoạ')
  expect(text('s16-mcp')).toContain('Có/Không')
  for (const s of ['часов', '小时', 'giờ']) expect(text('s17-guardrails')).toContain(s)
})
```
- [ ] **Step 2: Chạy, xác nhận FAIL**
- [ ] **Step 3: Dựng slide 14–17** theo spec 5.3 hàng 14–17. Slide 14 trích hai ví dụ thật trong
  `src/domain/fewshot.ts`: "bật đèn" của dâu và "tắt đèn khu ươm giá" của giá đỗ. Slide 16 ghi 12 công cụ, lệnh chờ
  hết hạn sau 30 phút. Slide 17 trích nguyên văn câu `bs-kb-soak` vòng r0 ("…4 часов… 48小时。").
- [ ] **Step 4: Chạy test PASS**
- [ ] **Step 5: Kiểm tra trình duyệt** từng bước, sáng/tối; chữ Cyrillic/Hán hiển thị được bằng font dự phòng.
- [ ] **Step 6: Commit**: `git commit -am "docs(presentation): behaviour slides"`

---

### Task 6: Slide 18, 20, 21 (chấm bài, chỗ vẫn sai, toàn cảnh)

**Files:** Modify `docs/presentation/gia-do-deck.html`; Test `tests/presentation/giaDoDeck.test.ts`

- [ ] **Step 1: Viết test thất bại**

```ts
it('slides 18, 20, 21 carry their pinned facts', () => {
  for (const s of ['12/12', '5/6', '6/6', 'chưa đo', '52/52', 'một lần chạy']) expect(text('s18-eval')).toContain(s)
  expect(text('s20-still-wrong')).toMatch(/ra chợ/)
  for (const s of ['sách đúng', 'quản lý dữ liệu', 'Đo, đừng đoán']) expect(text('s21-recap')).toContain(s)
})
```
- [ ] **Step 2: Chạy, xác nhận FAIL**
- [ ] **Step 3: Dựng slide**. Slide 18 theo spec mục 7, phần "Cách trình bày slide 18": hai mốc r0 và r3 trên 12 câu
  gốc (`summary`), 4 câu thêm một dòng riêng theo `summaryR1` của r3, "sạch chữ lạ" ở r0 là "chưa đo", dâu tây r4
  52/52 và 14/14. Slide 20: 2–3 lỗi r3 ở spec mục 7, trích nguyên văn, gạch chân phần sai và ghi tài liệu nói gì;
  một dòng "câu chiếu đèn vừa thấy ở demo cũng có chỗ sai này" (chỉ giữ nếu bản ghi bên phải của `bs-kb-light` sau
  Task 9 vẫn có lỗi). Slide 21: câu hỏi đi qua các trạm slide 6–17 + 3 điều mang về ở spec 5.3.
- [ ] **Step 4: Chạy test PASS**
- [ ] **Step 5: Kiểm tra trình duyệt** từng bước, sáng/tối.
- [ ] **Step 6: Commit**: `git commit -am "docs(presentation): eval, known errors and recap slides"`

---

### Task 7: Logic demo (thuần, có test)

**Files:** Modify `docs/presentation/gia-do-deck.html` (khối `deck-logic`); Test `tests/presentation/giaDoDeck.test.ts`

**Interfaces (thêm vào `DeckLogic`):**
- `FIRST_TOKEN_TIMEOUT_MS = 20000`
- `createSseDecoder(): { push(chunk: string): SseFrame[]; flush(): SseFrame[] }`, `SseFrame = { event: string; data: string }`.
  Bỏ dòng bắt đầu bằng `:`; `event` mặc định `'message'`; nhiều dòng `data:` nối bằng `\n`; chấp nhận `\r\n`.
- `openAiDeltaText(frame: SseFrame): string | null`: `null` khi `data === '[DONE]'`, ngược lại `choices[0].delta.content ?? ''`.
- `initialPanel(): Panel`, `Panel = { mode: 'idle'|'live'|'recording'|'error'; text: string; status: string|null; pending: boolean; done: boolean; error: string|null; recordedAt: string|null }`.
- `reducePanel(p: Panel, a: PanelAction): Panel`, `PanelAction` =
  `{type:'start'}` | `{type:'delta', text}` | `{type:'chat-frame', frame: SseFrame}` | `{type:'end'}` |
  `{type:'fallback', text, recordedAt}` | `{type:'fail', message}`.
  `chat-frame` theo hợp đồng `/chat/stream`: `token` nối `text`; `tool_status` đặt `status` = `note`; `reset` xoá
  `text`; `done` đặt `text = reply`, `pending = pendingAction != null`, `done = true`, `status = null`; `error` → mode `error`.
  Khi `mode === 'recording'`, mọi action trừ `start` bị bỏ qua.
- `pickRecording(rec: Recordings | null, side: 'left'|'right', presetId: string | null): { text: string; recordedAt: string } | null`.
- `isOnlineCopy(loc: { protocol: string; hostname: string }): boolean`: `true` khi không phải `file:` và hostname
  không thuộc `localhost`, `127.0.0.1`.

- [ ] **Step 1: Viết test thất bại**

```ts
it('decodes frames across every split point', () => {
  const raw = ': ping\r\nevent: token\r\ndata: {"text":"Giá 🌱 ủ"}\r\n\r\nevent: done\ndata: {"reply":"x","pendingAction":null}\n\n'
  for (let i = 0; i <= raw.length; i++) {
    const d = logic.createSseDecoder()
    const frames = [...d.push(raw.slice(0, i)), ...d.push(raw.slice(i)), ...d.flush()]
    expect(frames).toEqual([{ event: 'token', data: '{"text":"Giá 🌱 ủ"}' }, { event: 'done', data: '{"reply":"x","pendingAction":null}' }])
  }
})
it('reads OpenAI deltas and the DONE sentinel', () => {
  expect(logic.openAiDeltaText({ event: 'message', data: '{"choices":[{"delta":{"content":"27"}}]}' })).toBe('27')
  expect(logic.openAiDeltaText({ event: 'message', data: '{"choices":[{"delta":{}}]}' })).toBe('')
  expect(logic.openAiDeltaText({ event: 'message', data: '[DONE]' })).toBeNull()
})
it('reduces /chat/stream frames', () => {
  const f = (event: string, data: object) => ({ type: 'chat-frame', frame: { event, data: JSON.stringify(data) } })
  let p = logic.reducePanel(logic.initialPanel(), { type: 'start' })
  p = [f('token', { text: 'Sai ' }), f('reset', {}), f('tool_status', { tool: 't', note: 'đang đọc' }), f('token', { text: 'Đúng' })].reduce(logic.reducePanel, p)
  expect([p.text, p.status]).toEqual(['Đúng', 'đang đọc'])
  p = logic.reducePanel(p, f('done', { reply: 'Bạn xác nhận thực hiện: "x"? (Có/Không)', pendingAction: { id: '1' } }))
  expect([p.done, p.pending, p.status]).toEqual([true, true, null])
})
it('ignores live frames after fallback', () => {
  let p = logic.reducePanel(logic.initialPanel(), { type: 'start' })
  p = logic.reducePanel(p, { type: 'fallback', text: 'bản ghi', recordedAt: '2026-11-19' })
  p = logic.reducePanel(p, { type: 'delta', text: ' muộn' })
  expect([p.mode, p.text]).toEqual(['recording', 'bản ghi'])
})
it('picks recordings and detects the online copy', () => {
  const rec = { recordedAt: '2026-11-19', model: 'm', left: { a: 'L' }, right: {} }
  expect(logic.pickRecording(rec, 'left', 'a')).toEqual({ text: 'L', recordedAt: '2026-11-19' })
  expect(logic.pickRecording(rec, 'right', 'a')).toBeNull()
  expect(logic.pickRecording(rec, 'left', null)).toBeNull()
  expect(logic.isOnlineCopy({ protocol: 'file:', hostname: '' })).toBe(false)
  expect(logic.isOnlineCopy({ protocol: 'http:', hostname: 'localhost' })).toBe(false)
  expect(logic.isOnlineCopy({ protocol: 'https:', hostname: 'claude.ai' })).toBe(true)
})
```
- [ ] **Step 2: Chạy, xác nhận FAIL**: `npx vitest run tests/presentation`
- [ ] **Step 3: Cài các hàm trên trong `deck-logic`** (decoder giữ phần dư chưa trọn dòng giữa các lần `push`).
- [ ] **Step 4: Chạy test PASS**: `npx vitest run tests/presentation`
- [ ] **Step 5: Commit**: `git commit -am "docs(presentation): demo stream decoding and panel state"`

---

### Task 8: Slide 19, giao diện demo

**Files:** Modify `docs/presentation/gia-do-deck.html`; Test `tests/presentation/giaDoDeck.test.ts`

**Interfaces:**
- Consumes: `DeckLogic` của Task 7.
- Produces: khối `<script id="demo-config" type="application/json">` (Task 9 đọc) với giá trị chính xác:

```json
{
  "lmUrl": "http://localhost:1234",
  "serverUrl": "http://localhost:8787",
  "model": "qwen2.5-3b-instruct",
  "bareSystemPrompt": "Bạn là trợ lý nông nghiệp. Trả lời ngắn gọn bằng tiếng Việt.",
  "temperature": 0.1,
  "maxTokens": 400,
  "presets": [
    { "id": "bs-kb-temp",   "question": "Ủ giá đỗ cần nhiệt độ bao nhiêu?",                    "sides": ["left", "right"] },
    { "id": "bs-kb-soak",   "question": "Ngâm đỗ xanh làm giá bao lâu, nước bao nhiêu độ?",    "sides": ["left", "right"] },
    { "id": "bs-kb-banned", "question": "Nước kẹo làm giá là gì, có nguy hiểm không?",         "sides": ["left", "right"] },
    { "id": "bs-kb-light",  "question": "Giá đỗ có cần chiếu đèn hay phơi nắng không?",        "sides": ["left", "right"] },
    { "id": "bs-water",     "question": "Tưới khay giá esp32-01 trong 30 giây.",               "sides": ["right"] }
  ]
}
```
- Produces: khối `<script id="demo-recordings" type="application/json">` khởi tạo `{"recordedAt":null,"model":null,"left":{},"right":{}}`.

Ghi chú lệch spec có chủ đích: model mặc định lấy từ `demo-config.model`, không lấy mục đầu của `GET /v1/models`, vì
danh sách của LM Studio có cả model embedding. Đèn trạng thái kiểm tra model đó có trong danh sách.

- [ ] **Step 1: Viết test thất bại**

```ts
it('demo config and recordings blocks are valid', () => {
  const cfg = JSON.parse(extractScriptBlock(html, 'demo-config'))
  expect(cfg.presets.map((p: any) => p.id)).toEqual(['bs-kb-temp', 'bs-kb-soak', 'bs-kb-banned', 'bs-kb-light', 'bs-water'])
  expect(cfg.presets.find((p: any) => p.id === 'bs-water').sides).toEqual(['right'])
  expect(cfg.bareSystemPrompt).toBe('Bạn là trợ lý nông nghiệp. Trả lời ngắn gọn bằng tiếng Việt.')
  const rec = JSON.parse(extractScriptBlock(html, 'demo-recordings'))
  expect(rec).toHaveProperty('left'); expect(rec).toHaveProperty('right')
  expect(text('s19-demo')).toMatch(/RAG/); expect(text('s19-demo')).toMatch(/hồ sơ/); expect(text('s19-demo')).toMatch(/ví dụ mẫu/)
})
```
- [ ] **Step 2: Chạy, xác nhận FAIL**
- [ ] **Step 3: Dựng slide 19** theo spec 5.4–5.5. Hai khung "Bộ não trần" / "Bộ não đầy đủ (RAG + hồ sơ cây + ví dụ
  mẫu)", ô nhập chung, nút câu soạn sẵn từ `demo-config`, nút "Phiên mới" (`sessionId` = `crypto.randomUUID()` mỗi
  lần tải trang và mỗi lần bấm, `userId` `"demo"`), nút "Phát bản ghi", bảng cài đặt ẩn (lmUrl, serverUrl, model;
  lưu `localStorage` trong try/catch). Gọi fetch với `AbortController`; watchdog `FIRST_TOKEN_TIMEOUT_MS` hoặc lỗi →
  abort + `fallback` từ `pickRecording`; không có bản ghi → "chưa ghi" (câu soạn sẵn) hoặc "không kết nối được"
  (câu gõ tay). Bản ghi hiện dần như đang gõ, kèm nhãn "Bản ghi ngày …". `isOnlineCopy` → chỉ phát bản ghi, đèn thay
  bằng nhãn "Bản online: phát câu trả lời đã ghi". Nội dung hai khung giữ nguyên khi rời slide rồi quay lại.
- [ ] **Step 4: Chạy test PASS**
- [ ] **Step 5: Kiểm tra trình duyệt khi cả hai dịch vụ đều tắt** (đổi `lmUrl`/`serverUrl` sang cổng không có gì nghe,
  ví dụ `:9`): đèn đỏ; bấm câu soạn sẵn → "chưa ghi" ở cả hai khung; gõ Space/← trong ô nhập không chuyển slide;
  rời slide rồi quay lại thì nội dung còn nguyên.
- [ ] **Step 6: Commit**: `git commit -am "docs(presentation): live two-brain demo slide"`

---

### Task 9: Script ghi bản ghi và ghi thật

**Files:**
- Create: `scripts/record-deck-demo.ts`
- Modify: `package.json` (thêm `"deck:record": "tsx scripts/record-deck-demo.ts"`), `docs/presentation/gia-do-deck.html` (khối `demo-recordings`)
- Test: `tests/presentation/deckBlocks.test.ts`

**Interfaces:**
- Consumes: `extractScriptBlock`, `replaceScriptBlock`, `toJsonBlock` (Task 1); `demo-config` (Task 8);
  `summarizeAction` từ `src/agent/confirmation.ts`.
- Produces: `buildRecordings(cfg: DemoConfig, answer: (side: 'left'|'right', preset: Preset) => Promise<string>, today: string): Promise<Recordings>`
  (thuần, được test), và CLI `npm run deck:record -- [--lm URL] [--server URL] [--right-from-eval PATH]`.
  `Recordings = { recordedAt: string; model: string; left: Record<string,string>; right: Record<string,string>; rightSource: 'live' | 'eval' }`.
  - Bên trái: `POST {lm}/v1/chat/completions` `{ model, messages: [system bareSystemPrompt, user question], temperature, max_tokens: maxTokens, stream: false }` → `choices[0].message.content`.
  - Bên phải: `POST {server}/v1/chat/completions` `{ model: 'plant-assistant', user: 'deck-record', session_id: randomUUID(), messages: [{ role: 'user', content: question }] }` → `choices[0].message.content`.
  - `--right-from-eval PATH`: lấy `reply` của case cùng `id`; riêng `bs-water` ghép lời dẫn đó với câu xác nhận đúng
    như `src/agent/orchestrator.ts` dựng `finalReply` (đọc đoạn quanh dòng 470 để ghép `lead` cho khớp) và
    `summarizeAction(case.got.tool, case.got.args)`; `rightSource: 'eval'`.
  - Câu trả lời lỗi hoặc rỗng thì **không ghi key đó** (deck hiện "chưa ghi"); không bao giờ điền chữ tự viết.

- [ ] **Step 1: Viết test thất bại**

```ts
it('buildRecordings asks each preset only on its sides and skips failures', async () => {
  const cfg = { model: 'm', presets: [{ id: 'a', question: 'q', sides: ['left', 'right'] }, { id: 'w', question: 'q2', sides: ['right'] }] }
  const asked: string[] = []
  const rec = await buildRecordings(cfg as any, async (side, p) => {
    asked.push(`${side}:${p.id}`)
    if (side === 'right' && p.id === 'a') throw new Error('down')
    return `${side}-${p.id}`
  }, '2026-11-19')
  expect(asked.sort()).toEqual(['left:a', 'right:a', 'right:w'])
  expect(rec).toEqual({ recordedAt: '2026-11-19', model: 'm', left: { a: 'left-a' }, right: { w: 'right-w' }, rightSource: 'live' })
})
```
- [ ] **Step 2: Chạy, xác nhận FAIL**: `npx vitest run tests/presentation/deckBlocks.test.ts`
- [ ] **Step 3: Viết `scripts/record-deck-demo.ts`** (CLI chỉ chạy khi là entry point; `buildRecordings` export).
- [ ] **Step 4: Chạy test PASS**, `npm run typecheck` sạch.
- [ ] **Step 5: Kiểm tra LM Studio**

Run: `curl -s http://localhost:1234/v1/models`
Expected: JSON có `qwen2.5-3b-instruct` và `text-embedding-bge-m3`. Không có → dừng, nhờ Linh bật server trong
LM Studio (Developer → Start Server, Enable CORS); không đi tiếp bằng dữ liệu tự viết.

- [ ] **Step 6: Chạy server giá đỗ ở cổng riêng** (chạy nền, không sửa `.env`)

Run (PowerShell): `$env:DEFAULT_PLANT='bean-sprout'; $env:PORT='8788'; npm start`
rồi `POST http://localhost:8788/api/setup/connect` với
`{"provider":"lmstudio","baseURL":"http://localhost:1234/v1","model":"qwen2.5-3b-instruct","embedModel":"text-embedding-bge-m3"}`,
chờ `GET /api/setup/status` báo `ready`.
Expected: phase `ready`. Lưu ý: bước này ghi `data/llm-config.json` (đã gitignore), đúng là việc Linh cũng phải làm
trước buổi nói.

- [ ] **Step 7: Ghi**

Run: `npm run deck:record -- --server http://localhost:8788`
Expected: khối `demo-recordings` có 4 key bên trái, 5 key bên phải, `rightSource: "live"`. Đọc từng câu: câu
`bs-water` bên phải kết thúc bằng `(Có/Không)`. Nếu server không lên được ở Step 6: chạy lại với
`--right-from-eval data/eval/r3-bean-sprout-1-2026-11-17T07-01-19-417Z.json`.

- [ ] **Step 8: Đối chiếu bản ghi với slide 13 và 20**: cập nhật slide 13 sang một câu bên phải thật có
  "Nguồn tham khảo" nếu có; giữ hoặc bỏ dòng tham chiếu demo ở slide 20 theo việc câu `bs-kb-light` có còn lỗi.
- [ ] **Step 9: Kiểm tra demo live trên trình duyệt** (server ở 8788 qua bảng cài đặt): hai đèn xanh; câu
  `bs-kb-temp` chảy chữ ở cả hai khung; câu `bs-water` bên phải hiện câu hỏi Có/Không; trả lời "không" → hủy.
  Dừng server 8788 sau khi xong.
- [ ] **Step 10: Commit**: `git add scripts/record-deck-demo.ts package.json docs/presentation/gia-do-deck.html tests/presentation && git commit -m "docs(presentation): record real demo answers for the offline fallback"`

---

### Task 10: Hoàn thiện, kiểm tra toàn bộ, publish

**Files:** Modify `docs/presentation/gia-do-deck.html`; Test `tests/presentation/giaDoDeck.test.ts`

- [ ] **Step 1: Viết test thất bại**

```ts
it('notes are complete and the talk runs about 30 minutes', () => {
  const total = slides.reduce((n, s) => n + s.min, 0)
  expect(total).toBeGreaterThanOrEqual(27); expect(total).toBeLessThanOrEqual(33)
  for (const s of slides) expect(s.notes).not.toMatch(/TODO|tạm/i)
  expect(notes('s19-demo')).toMatch(/DEFAULT_PLANT=bean-sprout/); expect(notes('s19-demo')).toMatch(/Enable CORS/)
})
```
- [ ] **Step 2: Chạy, xác nhận FAIL** (notes còn tạm)
- [ ] **Step 3: Viết đủ notes** cho mọi slide (spec 5.7) và checklist chuẩn bị (spec mục 6) trong notes slide 19.
- [ ] **Step 4: Chạy `npm test` và `npm run typecheck`**: PASS.
- [ ] **Step 5: Đi hết 21 slide trên trình duyệt** ở 1280×720 và 1920×1080: mọi bước, sáng và tối; bật
  `prefers-reduced-motion` (Playwright `browser_emulate_media`) → mỗi bước hiện thẳng trạng thái cuối.
- [ ] **Step 6: Kiểm tra offline**: chặn mạng (hoặc chặn `fonts.googleapis.com`), tải lại: deck chạy, chữ đủ dấu
  bằng font dự phòng, demo phát bản ghi.
- [ ] **Step 7: Nạp skill `artifact-design` nếu chưa nạp trong phiên, rồi publish** bằng công cụ Artifact:
  `file_path` = `docs/presentation/gia-do-deck.html`, `icon` = `presentation`, `description` một câu tiếng Việt.
  Mở link: slide 19 hiện nhãn "Bản online" và phát bản ghi.
- [ ] **Step 8: Commit**: `git commit -am "docs(presentation): speaker notes and final pass"`
