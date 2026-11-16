import { type PlantProfile, plantDisplayName } from './profiles'

/**
 * Vietnamese few-shot examples injected into the system prompt. They teach the
 * small model the decision-JSON format, when to read vs control, and the
 * confirmation discipline. Keep short — every token costs latency on CPU.
 *
 * One set per plant: the 3B copies the examples' advice and actions, so a
 * strawberry set served for bean sprouts would have it offer to switch the grow
 * light on, which ruins sprouts that must stay dark.
 *
 * FIELD ORDER MATTERS for type="tool": put "message" BEFORE "tool"/"args". The
 * 3B closes the JSON right after "args", so a "message" placed after "args" is
 * almost never emitted (tool decisions came back with no lead-in). With
 * message-first, ~11/12 tool decisions carry the intended purpose+effect
 * lead-in. Do NOT reorder these back to message-last.
 */
const STRAWBERRY = `
Ví dụ 1 — hỏi triệu chứng/tư vấn (type="reply" từ kiến thức, KÈM đề xuất kiểm tra cảm biến; hệ thống tự hỏi xác nhận, ĐỪNG tự viết câu "Nếu muốn..."):
Người dùng: "Cây dâu của mình bị vàng lá, mình nên làm gì?"
Trợ lý: {"type":"reply","message":"Lá dâu vàng thường do tưới quá nhiều/úng nước, thiếu dinh dưỡng (đặc biệt đạm) hoặc bệnh đốm lá. Bạn kiểm tra đất có thoát nước tốt không, tránh để úng, bón phân cân đối và loại bỏ lá bệnh.","tool":"get_latest_sensor","args":{"device_id":"esp32-01"}}

Ví dụ 2 — hỏi TRỰC TIẾP số liệu hiện tại (tool ĐỌC; hệ thống đọc cảm biến NGAY, đừng nói đã có số liệu trước khi đọc):
Người dùng: "Độ ẩm đất của cây thế nào?"
Trợ lý: {"type":"tool","message":"Mình sẽ đọc số liệu cảm biến mới nhất để so với khoảng tối ưu của dâu rồi tư vấn chính xác hơn.","tool":"get_latest_sensor","args":{"device_id":"esp32-01"}}

Ví dụ 3 — chưa biết thiết bị (gọi list_devices trước):
Người dùng: "Bật đèn cho cây."
Trợ lý: {"type":"tool","message":"Mình sẽ xem danh sách thiết bị để biết cần bật đèn cho thiết bị nào.","tool":"list_devices","args":{}}
[Kết quả list_devices] [{"device_id":"esp32-01","name":"Khu A"}]
Trợ lý: {"type":"tool","message":"Mình sẽ bật đèn cho khu A để bổ sung ánh sáng theo nhu cầu của dâu.","tool":"set_light","args":{"device_id":"esp32-01","on":true}}

Ví dụ 4 — điều khiển (KHÔNG nói đã xong, chờ xác nhận):
Người dùng: "Tưới nước 10 giây đi."
Trợ lý: {"type":"tool","message":"Mình sẽ bật bơm tưới để nâng độ ẩm đất về khoảng tối ưu của dâu (~75-80%); bơm sẽ tự tắt sau thời gian an toàn của thiết bị nên bạn không cần tắt tay, tránh tưới quá gây úng.","tool":"set_pump","args":{"device_id":"esp32-01","on":true}}

Ví dụ 5 — hỏi kiến thức, trả lời NGẮN và DẪN NGUỒN (nêu nguồn nếu có):
Người dùng: "Tưới nước cho dâu thế nào là đúng?"
Trợ lý: {"type":"reply","message":"Dâu nên tưới nhỏ giọt để cấp cả nước lẫn dinh dưỡng, tưới vừa đủ theo nhu cầu và tránh để úng vì đất thoát nước kém dễ gây thối rễ (theo Khuyến nông Lâm Đồng)."}

Ví dụ 6 — chẩn đoán bệnh (nghĩ ngắn trước rồi nêu bệnh + xử lý + phòng ngừa, có nguồn):
Người dùng: "Thân và cuống dâu có đốm đen, vài quả bị lõm nâu, cây bị bệnh gì?"
Trợ lý: {"reasoning":"Đốm đen ở thân/cuống kèm vết lõm nâu trên quả khớp nhất với thán thư (Colletotrichum).","type":"reply","message":"Nhiều khả năng là bệnh thán thư (Colletotrichum spp.), phát mạnh khi nóng ẩm mưa nhiều. Xử lý: loại bỏ và tiêu hủy bộ phận bệnh, tránh thao tác khi cây ướt, phun thuốc phòng-trị theo khuyến cáo. Phòng ngừa: dùng cây giống sạch bệnh, phủ luống hạn chế nước bắn, thoát nước tốt (theo Chi cục BVTV Lâm Đồng)."}
`.trim()

const BEAN_SPROUT = `
Ví dụ 1 — hỏi triệu chứng/tư vấn (type="reply" từ kiến thức, KÈM đề xuất kiểm tra cảm biến; hệ thống tự hỏi xác nhận, ĐỪNG tự viết câu "Nếu muốn..."):
Người dùng: "Giá của mình bị thối, có mùi chua, mình nên làm gì?"
Trợ lý: {"type":"reply","message":"Giá thối và có mùi ủng thường do tưới quá dày làm giá thừa nước, thiếu oxy, hoặc do nhiễm vi sinh vật. Bạn giãn chu kỳ tưới về khoảng 30 phút một lần, mỗi lần 1 phút, giữ buồng ươm thoáng khí, bỏ phần giá hỏng và vệ sinh kỹ khay trước mẻ sau.","tool":"get_latest_sensor","args":{"device_id":"esp32-01"}}

Ví dụ 2 — hỏi TRỰC TIẾP số liệu hiện tại (tool ĐỌC; hệ thống đọc cảm biến NGAY, đừng nói đã có số liệu trước khi đọc):
Người dùng: "Nhiệt độ buồng ươm thế nào?"
Trợ lý: {"type":"tool","message":"Mình sẽ đọc số liệu cảm biến mới nhất để so với khoảng tối ưu của giá đỗ rồi tư vấn chính xác hơn.","tool":"get_latest_sensor","args":{"device_id":"esp32-01"}}

Ví dụ 3 — chưa biết thiết bị (gọi list_devices trước):
Người dùng: "Tắt đèn khu ươm giá."
Trợ lý: {"type":"tool","message":"Mình sẽ xem danh sách thiết bị để biết cần tắt đèn cho thiết bị nào.","tool":"list_devices","args":{}}
[Kết quả list_devices] [{"device_id":"esp32-01","name":"Khu A"}]
Trợ lý: {"type":"tool","message":"Mình sẽ tắt đèn khu A vì giá đỗ cần ươm trong tối, ánh sáng làm mầm đổi màu.","tool":"set_light","args":{"device_id":"esp32-01","on":false}}

Ví dụ 4 — điều khiển (KHÔNG nói đã xong, chờ xác nhận):
Người dùng: "Tưới nước 10 giây đi."
Trợ lý: {"type":"tool","message":"Mình sẽ bật bơm tưới cho khay giá; giá đỗ nên tưới ngắn theo chu kỳ (khoảng 1 phút mỗi 30 phút) để đủ ẩm mà không bị ủng. Bơm sẽ tự tắt sau thời gian an toàn của thiết bị nên bạn không cần tắt tay.","tool":"set_pump","args":{"device_id":"esp32-01","on":true}}

Ví dụ 5 — hỏi kiến thức, trả lời NGẮN và DẪN NGUỒN (nêu nguồn nếu có):
Người dùng: "Ngâm đỗ làm giá bao lâu là đúng?"
Trợ lý: {"type":"reply","message":"Nên ngâm đỗ xanh trong nước khoảng 35°C trong 4 giờ; ngâm quá lâu ở nhiệt độ cao, ví dụ 40°C trong 5 giờ, làm hạt thiếu oxy, dễ nhớt và giảm tỷ lệ nảy mầm (theo Tạp chí VAAS)."}

Ví dụ 6 — chẩn đoán (nghĩ ngắn trước rồi nêu nguyên nhân + cách xử lý, có nguồn):
Người dùng: "Giá nhà mình thân gầy, dài, nhiều rễ, ăn không giòn, bị sao vậy?"
Trợ lý: {"reasoning":"Thân gầy dài, nhiều rễ sợi, kém giòn khớp với buồng ươm quá nóng, gieo quá thưa hoặc tưới thưa.","type":"reply","message":"Nhiều khả năng buồng ươm quá nóng khiến giá mọc nhanh nhưng ốm và nhiều rễ sợi, hoặc gieo quá thưa làm giá dài và gầy, hoặc tưới thưa nên giá kém giòn. Bạn giữ nhiệt độ 27–30°C, gieo khoảng 40 g hạt trên mỗi dm² khay và tưới đều khoảng 30 phút một lần (theo ĐH Cần Thơ và Tạp chí VAAS)."}
`.trim()

/**
 * Format-only set for a plant without its own examples. It carries no growing
 * advice, so the model cannot borrow another plant's care rules from it.
 */
function neutralFewshot(name: string): string {
  return `
Ví dụ 1 — hỏi triệu chứng/tư vấn (type="reply", KÈM đề xuất kiểm tra cảm biến; hệ thống tự hỏi xác nhận, ĐỪNG tự viết câu "Nếu muốn..."):
Người dùng: "Cây của mình trông yếu, mình nên làm gì?"
Trợ lý: {"type":"reply","message":"Bạn mô tả rõ hơn triệu chứng (màu sắc, đốm, mùi lạ, bộ phận nào bị) để mình tư vấn chính xác. Trước mắt nên xem nhiệt độ và độ ẩm có nằm trong khoảng tối ưu của ${name} không.","tool":"get_latest_sensor","args":{"device_id":"esp32-01"}}

Ví dụ 2 — hỏi TRỰC TIẾP số liệu hiện tại (tool ĐỌC; hệ thống đọc cảm biến NGAY, đừng nói đã có số liệu trước khi đọc):
Người dùng: "Nhiệt độ hiện tại thế nào?"
Trợ lý: {"type":"tool","message":"Mình sẽ đọc số liệu cảm biến mới nhất để so với khoảng tối ưu của ${name} rồi tư vấn chính xác hơn.","tool":"get_latest_sensor","args":{"device_id":"esp32-01"}}

Ví dụ 3 — chưa biết thiết bị (gọi list_devices trước):
Người dùng: "Chuyển thiết bị sang chế độ tự động."
Trợ lý: {"type":"tool","message":"Mình sẽ xem danh sách thiết bị để biết cần chuyển chế độ cho thiết bị nào.","tool":"list_devices","args":{}}
[Kết quả list_devices] [{"device_id":"esp32-01","name":"Khu A"}]
Trợ lý: {"type":"tool","message":"Mình sẽ chuyển khu A sang chế độ tự động để thiết bị tự điều khiển theo ngưỡng đã cài.","tool":"set_mode","args":{"device_id":"esp32-01","auto":true}}

Ví dụ 4 — điều khiển (KHÔNG nói đã xong, chờ xác nhận):
Người dùng: "Tưới nước 10 giây đi."
Trợ lý: {"type":"tool","message":"Mình sẽ bật bơm tưới theo nhu cầu của ${name}; bơm sẽ tự tắt sau thời gian an toàn của thiết bị nên bạn không cần tắt tay.","tool":"set_pump","args":{"device_id":"esp32-01","on":true}}
`.trim()
}

const BY_PLANT: Record<string, string> = {
  strawberry: STRAWBERRY,
  'bean-sprout': BEAN_SPROUT,
}

/** True when `plant` has its own example set (else getFewshot falls back to the neutral one). */
export function hasPlantFewshot(plant: string): boolean {
  return plant in BY_PLANT
}

/** Examples for the profile's plant; strawberry when no profile is given. */
export function getFewshot(profile?: PlantProfile): string {
  if (!profile) return STRAWBERRY
  return BY_PLANT[profile.plant] ?? neutralFewshot(plantDisplayName(profile))
}
