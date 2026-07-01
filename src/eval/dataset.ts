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
]
