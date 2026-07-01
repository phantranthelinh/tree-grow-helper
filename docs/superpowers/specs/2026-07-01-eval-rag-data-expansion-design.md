# Spec: Mở rộng eval dataset & enrich RAG knowledge (strawberry)

> [!NOTE] Meta
> **Ticket:** — · **Date:** 2026-07-01 · **Author:** Linh Phan

---

## Problem

> [!WARNING] Problem Statement
> Người vận hành `ai-server` — không đủ dữ liệu để (a) **đo** chất lượng chọn tool của model nhỏ và (b) **trả lời** câu hỏi kiến thức về cây dâu.
>
> - **Eval**: `src/eval/dataset.ts` mới có **12 case**. 5/12 tool của MCP **chưa từng được test** (`get_device_info`, `get_moisture_rule`, `get_light_rule`, `auto_light`, `set_light_rule`), không có biến thể cách nói, số case kiến thức ít → con số accuracy không phản ánh thực tế.
> - **RAG**: `src/domain/knowledge/strawberry.json` còn 5 field `null`/rỗng (`scientific_name`, `aliases`, `light_description`, `toxicity`, `care_notes`). 3 field trong đó (`light_description`, `toxicity`, `care_notes`) nằm trong `TEXT_FIELDS` của `src/rag/ingest.ts` nên **đang bị bỏ qua khi embed** → RAG không trả lời được các chủ đề này.

---

## Goals

- Tăng độ phủ eval để `npm run eval` đo sát thực tế: phủ **đủ 12 tool** + biến thể cách nói + câu kiến thức.
- Lấp 5 field trống của `strawberry.json` bằng dữ liệu web-sourced (exa), ưu tiên 3 field được embed để tăng recall của RAG.
- **Chỉ đổi data, không đổi code/schema/harness.** Giữ giai đoạn 1 = strawberry-only.

---

## User Stories

| As a… | I want to… | So that… |
|-------|-----------|----------|
| Dev bảo trì ai-server | chạy `npm run eval` trên bộ case phủ đủ tool | biết model 3b/7b sai ở tool nào để chỉnh prompt/few-shot |
| Người dùng cuối (chat VN) | hỏi "dâu cần mấy giờ nắng", "chó ăn lá dâu có sao không" | nhận câu trả lời đúng nhờ RAG có dữ liệu |

---

## Functional Requirements

### FR1 — Eval dataset (`src/eval/dataset.ts`)
Giữ nguyên interface `EvalCase`/`EvalExpect`. Thêm **20 case** (12 → **32**), mọi case là **quyết định-đầu-tiên deterministic**, luôn nêu rõ `esp32-01` để không rơi vào nhánh phải gọi `list_devices` trước.

**Nhóm A1 — tool chưa được phủ (5):**
| id | message | expect.tool | safety |
|---|---|---|---|
| `device-info` | Cho xem thông tin chi tiết thiết bị esp32-01. | `get_device_info` | read |
| `get-moisture-rule` | Luật tưới theo độ ẩm của esp32-01 đang đặt thế nào? | `get_moisture_rule` | read |
| `get-light-rule` | Xem luật chiếu sáng hiện tại của esp32-01. | `get_light_rule` | read |
| `auto-light` | Bật đèn tự động cho esp32-01 khi trời tối. | `auto_light` | control |
| `set-light-rule` | Đặt luật bật đèn khi ánh sáng dưới 300 lux cho esp32-01. | `set_light_rule` | control |

**Nhóm A2 — biến thể cách nói, tool cũ (7):**
| id | message | expect.tool | safety |
|---|---|---|---|
| `sensor-temp` | Nhiệt độ hiện tại của esp32-01 là bao nhiêu? | `get_latest_sensor` | read |
| `list-devices-alt` | Có những thiết bị nào đang kết nối? | `list_devices` | read |
| `sensor-history-12h` | Cho xem số liệu độ ẩm 12 giờ qua của esp32-01. | `get_sensor_history` | read |
| `pending-alt` | esp32-01 còn lệnh nào chưa chạy không? | `get_pending_commands` | read |
| `light-off` | Tắt đèn thiết bị esp32-01. | `send_command` | control |
| `fan-on` | Bật quạt cho esp32-01. | `send_command` | control |
| `water-15s` | Mở nước tưới esp32-01 trong 15 giây. | `send_command` | control |

**Nhóm A3 — câu kiến thức → `reply` (kéo RAG) (8):**
| id | message | expect |
|---|---|---|
| `kb-fertilizer` | Nên bón phân gì cho dâu khi cây ra hoa? | reply |
| `kb-botrytis` | Dâu bị mốc xám (nấm Botrytis) thì xử lý sao? | reply |
| `kb-harvest` | Khi nào thì thu hoạch dâu được? | reply |
| `kb-propagation` | Dâu tây nhân giống bằng cách nào? | reply |
| `kb-planting` | Trồng dâu nên để khoảng cách cây bao nhiêu? | reply |
| `kb-toxicity` | Chó ăn phải lá dâu có sao không? | reply |
| `kb-light-hours` | Dâu tây cần mấy giờ nắng mỗi ngày? | reply |
| `kb-ph` | Đất trồng dâu nên có pH khoảng bao nhiêu? | reply |

### FR2 — RAG knowledge (`src/domain/knowledge/strawberry.json`)
Lấp 5 field (nội dung tiếng Anh để đồng bộ field hiện có; `bge-m3` cross-lingual nên hỏi VN vẫn truy hồi được):

- `scientific_name`: `"Fragaria × ananassa"`
- `aliases`: `["dâu tây", "strawberry", "garden strawberry"]`
- `light_description` *(embed)*: full sun, 6–10h nắng trực tiếp/ngày (min ~6h); ambient ~200–800 lux, greenhouse bù LED đỏ-trội ~130–250 µmol m⁻² s⁻¹ trong 14–16h; trong nhà dùng grow light (~1 bóng 60W / 6 m²); quang kỳ ảnh hưởng ra hoa (June-bearer = ngày ngắn, day-neutral không phụ thuộc).
- `toxicity` *(embed)*: non-toxic với chó/mèo/ngựa theo ASPCA (Fragaria spp., họ Rosaceae); quả ăn được với người; không có độc tố, nhưng ăn nhiều lá/thân xơ có thể gây rối loạn tiêu hoá nhẹ ở thú cưng; quả nguyên có thể gây hóc với chó nhỏ.
- `care_notes` *(embed)*: đất tơi thoát nước, hơi chua pH 5.5–6.5; luống cao/chậu để thoát nước & giảm bệnh đất; phủ gốc (rơm/nhựa) giữ ẩm & sạch quả; tưới ~25mm/tuần, tưới **buổi sáng**, tránh làm ướt tâm cây & quả (ngừa mốc xám Botrytis); đặt tâm cây ngang mặt đất; khí hậu kiểu Đà Lạt trồng Nov–Apr ở 18–22°C, tưới nhỏ giọt nước sạch, trồng dày dễ bệnh trong mùa ẩm; ngắt hoa năm đầu của June-bearer để cây khoẻ.
- `sources[]`: thêm ASPCA + UMN Extension + RHS + Old Farmer's Almanac + 2 nguồn VN (Chimi Farm, baoangreen Đà Lạt).

---

## Edge Cases

> [!DANGER] Watch out for
> - **Non-determinism eval**: câu mơ hồ khiến model gọi `list_devices` trước → mọi case điều khiển/đọc phải ghi rõ `esp32-01`.
> - **Field không được embed**: chỉ field trong `TEXT_FIELDS` (`ingest.ts`) mới vào RAG. `scientific_name`/`aliases` KHÔNG embed (đúng ý — chỉ là metadata), 3 field text còn lại thì có.
> - **Ký tự `×`**: `scientific_name` dùng dấu nhân Unicode `×` (U+00D7) — JSON UTF-8, không escape.
> - **Data web-sourced**: giữ ghi chú "review before production" trong `notes`; đây là dữ liệu tham khảo, không phải khuyến cáo thú y/y tế.

---

## Technical Notes

> [!TIP] Dev notes
> - `src/domain/profiles.ts` `PlantProfileSchema` đã cho phép các field này (nullable/default) → điền giá trị không cần đổi schema.
> - `src/rag/ingest.ts` `TEXT_FIELDS` đã bao gồm `care_notes`, `light_description`, `toxicity` → chỉ cần điền là được embed.
> - Nguồn: exa (2026-07-01). ASPCA (toxicity), UMN/RHS/OSU/Almanac/Martha Stewart (light+care), Chimi Farm & baoangreen (VN/Đà Lạt).
> - `npm run eval` cần LM Studio chạy; `npm run typecheck` thì không.

---

## Acceptance Criteria

> [!CHECK] Definition of Done
> - [ ] `EVAL_CASES` có 32 case, đủ 12 tool được đại diện ít nhất 1 lần + ≥8 case `reply`.
> - [ ] `npm run typecheck` pass (dataset & json hợp lệ, `loadProfile('strawberry')` parse OK).
> - [ ] 5 field trống của `strawberry.json` đã điền; `sources[]` có nguồn mới.
> - [ ] `profileToChunks(strawberry)` sinh thêm chunk cho `care_notes`, `light_description`, `toxicity` (kiểm bằng test/thủ công).
> - [ ] `npm run eval` chạy được và in accuracy trên 32 case (khi có LM Studio).
> - [ ] Không đổi **logic** (`.ts` xử lý) nào; chỉ sửa 2 file dữ liệu: `src/eval/dataset.ts` và `src/domain/knowledge/strawberry.json`.
