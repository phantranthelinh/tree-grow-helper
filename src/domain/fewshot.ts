/**
 * Vietnamese few-shot examples injected into the system prompt. They teach the
 * small model the decision-JSON format, when to read vs control, and the
 * confirmation discipline. Keep short — every token costs latency on CPU.
 */
const FEWSHOT = `
Ví dụ 1 — hỏi triệu chứng/tư vấn (trả lời từ kiến thức, KHÔNG gọi cảm biến):
Người dùng: "Cây dâu của mình bị vàng lá, mình nên làm gì?"
Trợ lý: {"type":"reply","message":"Lá dâu vàng thường do tưới quá nhiều/úng nước, thiếu dinh dưỡng (đặc biệt đạm) hoặc bệnh đốm lá. Bạn kiểm tra đất có thoát nước tốt không, tránh để úng, bón phân cân đối và loại bỏ lá bệnh. Nếu muốn, mình có thể kiểm tra độ ẩm/nhiệt độ hiện tại của cây giúp bạn."}

Ví dụ 2 — hỏi trạng thái (dùng tool ĐỌC):
Người dùng: "Độ ẩm đất của cây thế nào?"
Trợ lý: {"type":"tool","tool":"get_latest_sensor","args":{"device_id":"esp32-01"},"message":"Để mình kiểm tra cảm biến."}
[Kết quả get_latest_sensor] soil_moisture=62
Trợ lý: {"type":"reply","message":"Độ ẩm đất đang 62%, hơi thấp so với mức tối ưu 75-80% của dâu. Bạn có muốn tưới không?"}

Ví dụ 3 — chưa biết thiết bị (gọi list_devices trước):
Người dùng: "Bật đèn cho cây."
Trợ lý: {"type":"tool","tool":"list_devices","args":{},"message":"Để mình xem có thiết bị nào."}
[Kết quả list_devices] [{"device_id":"esp32-01","name":"Khu A"}]
Trợ lý: {"type":"tool","tool":"send_command","args":{"device_id":"esp32-01","command":"LIGHT_ON"},"message":"Mình sẽ bật đèn khu A."}

Ví dụ 4 — điều khiển (KHÔNG nói đã xong, chờ xác nhận):
Người dùng: "Tưới nước 10 giây đi."
Trợ lý: {"type":"tool","tool":"send_command","args":{"device_id":"esp32-01","command":"WATER_ON","duration":10000},"message":"Mình chuẩn bị bật bơm tưới 10 giây."}

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
