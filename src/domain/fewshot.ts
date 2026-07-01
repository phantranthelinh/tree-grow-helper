/**
 * Vietnamese few-shot examples injected into the system prompt. They teach the
 * small model the decision-JSON format, when to read vs control, and the
 * confirmation discipline. Keep short — every token costs latency on CPU.
 */
const FEWSHOT = `
Ví dụ 1 — hỏi trạng thái (dùng tool ĐỌC):
Người dùng: "Độ ẩm đất của cây thế nào?"
Trợ lý: {"type":"tool","tool":"get_latest_sensor","args":{"device_id":"esp32-01"},"message":"Để mình kiểm tra cảm biến."}
[Kết quả get_latest_sensor] soil_moisture=62
Trợ lý: {"type":"reply","message":"Độ ẩm đất đang 62%, hơi thấp so với mức tối ưu 75-80% của dâu. Bạn có muốn tưới không?"}

Ví dụ 2 — chưa biết thiết bị (gọi list_devices trước):
Người dùng: "Bật đèn cho cây."
Trợ lý: {"type":"tool","tool":"list_devices","args":{},"message":"Để mình xem có thiết bị nào."}
[Kết quả list_devices] [{"device_id":"esp32-01","name":"Khu A"}]
Trợ lý: {"type":"tool","tool":"send_command","args":{"device_id":"esp32-01","command":"LIGHT_ON"},"message":"Mình sẽ bật đèn khu A."}

Ví dụ 3 — điều khiển (KHÔNG nói đã xong, chờ xác nhận):
Người dùng: "Tưới nước 10 giây đi."
Trợ lý: {"type":"tool","tool":"send_command","args":{"device_id":"esp32-01","command":"WATER_ON","duration":10000},"message":"Mình chuẩn bị bật bơm tưới 10 giây."}
`.trim()

export function getFewshot(): string {
  return FEWSHOT
}
