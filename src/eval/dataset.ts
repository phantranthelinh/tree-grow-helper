export interface EvalExpect {
  type: 'reply' | 'tool'
  tool?: string
  safety?: 'read' | 'control'
}

export interface EvalCase {
  id: string
  message: string
  expect: EvalExpect
  note?: string
}

/**
 * Vietnamese evaluation set (strawberry context) for measuring the small model's
 * first-decision tool selection. Grows over time; keep expectations deterministic.
 */
export const EVAL_CASES: EvalCase[] = [
  { id: 'sensor-moisture', message: 'Độ ẩm đất của thiết bị esp32-01 bao nhiêu?', expect: { type: 'tool', tool: 'get_latest_sensor', safety: 'read' } },
  { id: 'list-devices', message: 'Liệt kê các thiết bị đang có.', expect: { type: 'tool', tool: 'list_devices', safety: 'read' } },
  { id: 'sensor-history', message: 'Cho xem lịch sử cảm biến 24 giờ qua của esp32-01.', expect: { type: 'tool', tool: 'get_sensor_history', safety: 'read' } },
  { id: 'pending-cmds', message: 'Thiết bị esp32-01 đang có lệnh nào chờ chạy không?', expect: { type: 'tool', tool: 'get_pending_commands', safety: 'read' } },
  { id: 'water-10s', message: 'Tưới nước cho esp32-01 trong 10 giây.', expect: { type: 'tool', tool: 'send_command', safety: 'control' } },
  { id: 'light-on', message: 'Bật đèn cho thiết bị esp32-01.', expect: { type: 'tool', tool: 'send_command', safety: 'control' } },
  { id: 'fan-off', message: 'Tắt quạt thiết bị esp32-01 giúp mình.', expect: { type: 'tool', tool: 'send_command', safety: 'control' } },
  { id: 'auto-water', message: 'Bật chế độ tưới tự động cho esp32-01.', expect: { type: 'tool', tool: 'auto_water', safety: 'control' } },
  { id: 'set-moisture-rule', message: 'Đặt luật tưới cho esp32-01 khi độ ẩm đất dưới 75%.', expect: { type: 'tool', tool: 'set_moisture_rule', safety: 'control' } },
  { id: 'kb-temp', message: 'Cây dâu tây thích hợp nhiệt độ khoảng bao nhiêu?', expect: { type: 'reply' } },
  { id: 'kb-pests', message: 'Cây dâu hay bị sâu bệnh gì?', expect: { type: 'reply' } },
  { id: 'kb-moisture', message: 'Độ ẩm đất tối ưu cho dâu là bao nhiêu phần trăm?', expect: { type: 'reply' } },

  // --- A1: tools not previously covered ---
  { id: 'device-info', message: 'Cho xem thông tin chi tiết thiết bị esp32-01.', expect: { type: 'tool', tool: 'get_device_info', safety: 'read' } },
  { id: 'get-moisture-rule', message: 'Luật tưới theo độ ẩm của esp32-01 đang đặt thế nào?', expect: { type: 'tool', tool: 'get_moisture_rule', safety: 'read' } },
  { id: 'get-light-rule', message: 'Xem luật chiếu sáng hiện tại của esp32-01.', expect: { type: 'tool', tool: 'get_light_rule', safety: 'read' } },
  { id: 'auto-light', message: 'Bật đèn tự động cho esp32-01 khi trời tối.', expect: { type: 'tool', tool: 'auto_light', safety: 'control' } },
  { id: 'set-light-rule', message: 'Đặt luật bật đèn khi ánh sáng dưới 300 lux cho esp32-01.', expect: { type: 'tool', tool: 'set_light_rule', safety: 'control' } },

  // --- A2: phrasing variants of already-covered tools ---
  { id: 'sensor-temp', message: 'Nhiệt độ hiện tại của esp32-01 là bao nhiêu?', expect: { type: 'tool', tool: 'get_latest_sensor', safety: 'read' } },
  { id: 'list-devices-alt', message: 'Có những thiết bị nào đang kết nối?', expect: { type: 'tool', tool: 'list_devices', safety: 'read' } },
  { id: 'sensor-history-12h', message: 'Cho xem số liệu độ ẩm 12 giờ qua của esp32-01.', expect: { type: 'tool', tool: 'get_sensor_history', safety: 'read' } },
  { id: 'pending-alt', message: 'esp32-01 còn lệnh nào chưa chạy không?', expect: { type: 'tool', tool: 'get_pending_commands', safety: 'read' } },
  { id: 'light-off', message: 'Tắt đèn thiết bị esp32-01.', expect: { type: 'tool', tool: 'send_command', safety: 'control' } },
  { id: 'fan-on', message: 'Bật quạt cho esp32-01.', expect: { type: 'tool', tool: 'send_command', safety: 'control' } },
  { id: 'water-15s', message: 'Mở nước tưới esp32-01 trong 15 giây.', expect: { type: 'tool', tool: 'send_command', safety: 'control' } },

  // --- A3: knowledge questions that should stay a reply (drives RAG) ---
  { id: 'kb-fertilizer', message: 'Nên bón phân gì cho dâu khi cây ra hoa?', expect: { type: 'reply' } },
  { id: 'kb-botrytis', message: 'Dâu bị mốc xám (nấm Botrytis) thì xử lý sao?', expect: { type: 'reply' } },
  { id: 'kb-harvest', message: 'Khi nào thì thu hoạch dâu được?', expect: { type: 'reply' } },
  { id: 'kb-propagation', message: 'Dâu tây nhân giống bằng cách nào?', expect: { type: 'reply' } },
  { id: 'kb-planting', message: 'Trồng dâu nên để khoảng cách cây bao nhiêu?', expect: { type: 'reply' } },
  { id: 'kb-toxicity', message: 'Chó ăn phải lá dâu có sao không?', expect: { type: 'reply' } },
  { id: 'kb-light-hours', message: 'Dâu tây cần mấy giờ nắng mỗi ngày?', expect: { type: 'reply' } },
  { id: 'kb-ph', message: 'Đất trồng dâu nên có pH khoảng bao nhiêu?', expect: { type: 'reply' } },

  // --- A4: trap / chit-chat that should stay a reply (guards against over-triggering tools) ---
  { id: 'chat-hello', message: 'Xin chào!', expect: { type: 'reply' }, note: 'no tool' },
  { id: 'chat-thanks', message: 'Cảm ơn bạn nhiều nhé.', expect: { type: 'reply' }, note: 'no tool' },
  { id: 'chat-name', message: 'Bạn tên gì thế?', expect: { type: 'reply' }, note: 'no tool' },
  { id: 'chat-weather', message: 'Hôm nay trời đẹp nhỉ.', expect: { type: 'reply' }, note: 'no tool' },

  // --- A5: symptom / plant-health questions → reply from knowledge, no sensor fetch ---
  { id: 'symptom-yellow-leaves', message: 'Cây dâu của mình bị vàng lá, mình nên làm gì?', expect: { type: 'reply' }, note: 'advise from knowledge, no sensor' },
  { id: 'symptom-wilting', message: 'Dâu tây bị héo rũ thì xử lý sao?', expect: { type: 'reply' }, note: 'advise from knowledge, no sensor' },
  { id: 'symptom-leaf-spot', message: 'Lá dâu xuất hiện đốm nâu là bị gì?', expect: { type: 'reply' }, note: 'advise from knowledge, no sensor' },

  // --- A6: specific disease diagnosis (disease KB) + uses (databank) — all reply ---
  { id: 'diag-gray-mold', message: 'Quả dâu bị thối mềm, có lớp mốc xám phủ lên là bệnh gì?', expect: { type: 'reply' }, note: 'diagnose from disease KB' },
  { id: 'diag-powdery', message: 'Lá dâu có lớp phấn trắng mặt dưới, mép lá cong tím, cây bị gì?', expect: { type: 'reply' }, note: 'diagnose from disease KB' },
  { id: 'diag-spider-mite', message: 'Lá dâu có chấm li ti vàng và có tơ nhện mảnh, xử lý thế nào?', expect: { type: 'reply' }, note: 'diagnose from disease KB' },
  { id: 'diag-anthracnose', message: 'Quả dâu có vết lõm nâu đen, cây con héo chết là bệnh gì?', expect: { type: 'reply' }, note: 'diagnose from disease KB' },
  { id: 'uses-general', message: 'Dâu tây dùng để làm gì?', expect: { type: 'reply' } },
  { id: 'uses-processing', message: 'Dâu tây chế biến được những món gì?', expect: { type: 'reply' } },
]
