/**
 * Vietnamese few-shot examples injected into the system prompt. They teach the
 * small model the decision-JSON format, when to read vs control, and the
 * confirmation discipline. Keep short — every token costs latency on CPU.
 *
 * FIELD ORDER MATTERS for type="tool": put "message" BEFORE "tool"/"args". The
 * 3B closes the JSON right after "args", so a "message" placed after "args" is
 * almost never emitted (tool decisions came back with no lead-in). With
 * message-first, ~11/12 tool decisions carry the intended purpose+effect
 * lead-in. Do NOT reorder these back to message-last.
 */
const FEWSHOT = `
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
Trợ lý: {"type":"tool","message":"Mình sẽ bật đèn cho khu A để bổ sung ánh sáng theo nhu cầu của dâu.","tool":"send_command","args":{"device_id":"esp32-01","command":"LIGHT_ON"}}

Ví dụ 4 — điều khiển (KHÔNG nói đã xong, chờ xác nhận):
Người dùng: "Tưới nước 10 giây đi."
Trợ lý: {"type":"tool","message":"Mình sẽ bật bơm tưới trong 10 giây nhằm nâng độ ẩm đất về khoảng tối ưu của dâu (~75-80%), tránh tưới quá gây úng.","tool":"send_command","args":{"device_id":"esp32-01","command":"WATER_ON","duration":10000}}

Ví dụ 5 — hỏi kiến thức, trả lời NGẮN và DẪN NGUỒN (nêu nguồn nếu có):
Người dùng: "Tưới nước cho dâu thế nào là đúng?"
Trợ lý: {"type":"reply","message":"Dâu nên tưới nhỏ giọt để cấp cả nước lẫn dinh dưỡng, tưới vừa đủ theo nhu cầu và tránh để úng vì đất thoát nước kém dễ gây thối rễ (theo Khuyến nông Lâm Đồng)."}

Ví dụ 6 — chẩn đoán bệnh (nghĩ ngắn trước rồi nêu bệnh + xử lý + phòng ngừa, có nguồn):
Người dùng: "Thân và cuống dâu có đốm đen, vài quả bị lõm nâu, cây bị bệnh gì?"
Trợ lý: {"reasoning":"Đốm đen ở thân/cuống kèm vết lõm nâu trên quả khớp nhất với thán thư (Colletotrichum).","type":"reply","message":"Nhiều khả năng là bệnh thán thư (Colletotrichum spp.), phát mạnh khi nóng ẩm mưa nhiều. Xử lý: loại bỏ và tiêu hủy bộ phận bệnh, tránh thao tác khi cây ướt, phun thuốc phòng-trị theo khuyến cáo. Phòng ngừa: dùng cây giống sạch bệnh, phủ luống hạn chế nước bắn, thoát nước tốt (theo Chi cục BVTV Lâm Đồng)."}
`.trim()

export function getFewshot(): string {
  return FEWSHOT
}
