import type { McpTool } from './client'

/**
 * Static definition of the plant-tree MCP's 12 tools. Used as a fallback tool
 * catalog when the live MCP is unreachable (degraded mode) and by the eval
 * harness so tool-selection can be measured without a running MCP.
 *
 * At runtime the LIVE MCP schema (from listTools) takes precedence — this is
 * only a best-effort mirror based on the Python server's signatures.
 */
const obj = (properties: Record<string, object>, required: string[] = []) => ({
  type: 'object' as const,
  properties,
  required,
})

const str = { type: 'string' as const }
const num = { type: 'number' as const }

export const KNOWN_TOOLS: McpTool[] = [
  { name: 'list_devices', description: 'Liệt kê tất cả thiết bị.', inputSchema: obj({}) },
  { name: 'get_device_info', description: 'Thông tin chi tiết một thiết bị.', inputSchema: obj({ device_id: str }, ['device_id']) },
  { name: 'get_latest_sensor', description: 'Số liệu cảm biến mới nhất (độ ẩm đất, nhiệt độ, ánh sáng...).', inputSchema: obj({ device_id: str }, ['device_id']) },
  { name: 'get_sensor_history', description: 'Lịch sử số liệu cảm biến của thiết bị.', inputSchema: obj({ device_id: str, hours: num }, ['device_id']) },
  { name: 'get_pending_commands', description: 'Danh sách lệnh đang chờ thiết bị thực thi.', inputSchema: obj({ device_id: str }, ['device_id']) },
  { name: 'get_moisture_rule', description: 'Xem luật tưới theo độ ẩm hiện tại.', inputSchema: obj({ device_id: str }, ['device_id']) },
  { name: 'get_light_rule', description: 'Xem luật chiếu sáng hiện tại.', inputSchema: obj({ device_id: str }, ['device_id']) },
  {
    name: 'send_command',
    description: 'Gửi lệnh điều khiển thiết bị. command: WATER_ON, WATER_OFF, LIGHT_ON, LIGHT_OFF, FAN_ON, FAN_OFF. duration (ms) chỉ dùng cho WATER_ON.',
    inputSchema: obj(
      { device_id: str, command: { type: 'string', enum: ['WATER_ON', 'WATER_OFF', 'LIGHT_ON', 'LIGHT_OFF', 'FAN_ON', 'FAN_OFF'] }, duration: num },
      ['device_id', 'command'],
    ),
  },
  { name: 'auto_water', description: 'Bật tưới tự động nếu độ ẩm đất < threshold (%).', inputSchema: obj({ device_id: str, threshold: num }, ['device_id']) },
  { name: 'auto_light', description: 'Bật/tắt đèn tự động theo ngưỡng ánh sáng (lux).', inputSchema: obj({ device_id: str, threshold: num }, ['device_id']) },
  { name: 'set_moisture_rule', description: 'Đặt luật tưới theo ngưỡng độ ẩm đất (%).', inputSchema: obj({ device_id: str, threshold: num }, ['device_id']) },
  { name: 'set_light_rule', description: 'Đặt luật chiếu sáng theo ngưỡng ánh sáng (lux).', inputSchema: obj({ device_id: str, threshold: num }, ['device_id']) },
]
