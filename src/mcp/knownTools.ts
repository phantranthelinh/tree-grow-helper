import type { McpTool } from './client'

/**
 * Static definition of the plant-tree MCP tool catalog. Used as a fallback tool
 * catalog when the live MCP is unreachable (degraded mode) and by the eval
 * harness so tool-selection can be measured without a running MCP.
 *
 * At runtime the LIVE MCP schema (from listTools) takes precedence — this is
 * only a best-effort mirror of the Python server's signatures. If the MCP is
 * reachable, reconcile against `npm run mcp:catalog` (the handoff cited 13 tools;
 * set_device_config lists 15 thresholds — only the common ones are mirrored here).
 */
const obj = (properties: Record<string, object>, required: string[] = []) => ({
  type: 'object' as const,
  properties,
  required,
})

const str = { type: 'string' as const }
const num = { type: 'number' as const }
const bool = { type: 'boolean' as const }

export const KNOWN_TOOLS: McpTool[] = [
  { name: 'list_devices', description: 'Liệt kê tất cả thiết bị.', inputSchema: obj({}) },
  { name: 'get_device_info', description: 'Thông tin chi tiết một thiết bị.', inputSchema: obj({ device_id: str }, ['device_id']) },
  { name: 'get_latest_sensor', description: 'Số liệu cảm biến mới nhất (độ ẩm đất, nhiệt độ, ánh sáng...).', inputSchema: obj({ device_id: str }, ['device_id']) },
  { name: 'get_sensor_history', description: 'Lịch sử số liệu cảm biến (limit bản ghi gần nhất, mặc định 10).', inputSchema: obj({ device_id: str, limit: num }, ['device_id']) },
  { name: 'get_recent_commands', description: 'Nhật ký các lệnh đã publish tới thiết bị (không phải hàng đợi poll).', inputSchema: obj({ device_id: str }, ['device_id']) },
  { name: 'get_device_config', description: 'Xem toàn bộ ngưỡng cấu hình auto của thiết bị (soil_on_pct, lux_on...).', inputSchema: obj({ device_id: str }, ['device_id']) },
  { name: 'set_pump', description: 'Bật/tắt bơm nước. Không có duration — thiết bị tự tắt sau pump_max_run_s.', inputSchema: obj({ device_id: str, on: bool }, ['device_id', 'on']) },
  { name: 'set_light', description: 'Bật/tắt đèn (on) hoặc đặt độ sáng (pwm 0..255).', inputSchema: obj({ device_id: str, on: bool, pwm: num }, ['device_id']) },
  { name: 'set_mode', description: 'Chuyển chế độ tự động (auto=true) hoặc thủ công (auto=false).', inputSchema: obj({ device_id: str, auto: bool }, ['device_id', 'auto']) },
  { name: 'show_message', description: 'Hiển thị dòng chữ lên màn hình thiết bị (secs: số giây hiển thị, tùy chọn).', inputSchema: obj({ device_id: str, text: str, secs: num }, ['device_id', 'text']) },
  { name: 'set_device_config', description: 'Đặt ngưỡng cấu hình auto (soil_on_pct, soil_off_pct, lux_on, lux_off, pump_max_run_s...).', inputSchema: obj({ device_id: str, soil_on_pct: num, soil_off_pct: num, lux_on: num, lux_off: num, pump_max_run_s: num }, ['device_id']) },
  { name: 'refresh_device_config', description: 'Yêu cầu thiết bị nạp lại cấu hình (publish MQTT {"config":{}}).', inputSchema: obj({ device_id: str }, ['device_id']) },
]
