import { randomUUID } from 'node:crypto'
import type { McpGateway } from '../mcp/client'
import { describeMcpError, isRouteErrorText } from '../mcp/errors'
import type { PendingAction } from '../memory/sessions'

/** Build a human-readable Vietnamese summary of an action for confirmation (control + user-facing reads). */
export function summarizeAction(tool: string, args: Record<string, unknown>): string {
  const dev = args.device_id ? ` thiết bị ${String(args.device_id)}` : ''
  switch (tool) {
    case 'set_pump':
      return `${args.on ? 'Bật' : 'Tắt'} bơm nước${dev}`
    case 'set_light':
      if (args.pwm !== undefined) return `Đặt độ sáng đèn${dev} = ${Number(args.pwm)}`
      return `${args.on ? 'Bật' : 'Tắt'} đèn${dev}`
    case 'set_mode':
      return `Chuyển${dev} sang chế độ ${args.auto ? 'tự động (auto)' : 'thủ công (manual)'}`
    case 'show_message':
      return `Hiển thị lên màn hình${dev}: ${String(args.text ?? '')}`
    case 'set_device_config':
      return `Đổi cấu hình ngưỡng${dev}: ${JSON.stringify(args)}`
    case 'refresh_device_config':
      return `Làm mới cấu hình${dev}`
    case 'get_latest_sensor':
      return `kiểm tra số liệu cảm biến mới nhất${dev} (độ ẩm, nhiệt độ, ánh sáng)`
    case 'get_sensor_history': {
      const n = args.limit ? ` ${Number(args.limit)} bản ghi gần nhất` : ''
      return `xem lịch sử cảm biến${dev}${n}`
    }
    default:
      return `Chạy ${tool}${dev} với tham số ${JSON.stringify(args)}`
  }
}

export function createPendingAction(
  tool: string,
  args: Record<string, unknown>,
  kind: 'control' | 'read' = 'control',
): PendingAction {
  return { id: randomUUID(), tool, args, summary: summarizeAction(tool, args), kind }
}

export type ConfirmIntent = 'affirm' | 'negate' | 'unknown'

const BOUNDARY = '(?=$|[\\s,.!?;:])'
const AFFIRM = new RegExp(
  `^(có|ừ|ừm|okie|ok|đồng ý|xác nhận|đúng rồi|đúng|chắc chắn|chắc|tiến hành|thực hiện|làm đi|yes)${BOUNDARY}`,
  'i',
)
const NEGATE = new RegExp(`^(không|khong|hủy|huỷ|đừng|thôi|khoan|dừng|no)${BOUNDARY}`, 'i')

/** Fallback detection of yes/no when the chat app sends confirmation as free text. */
export function detectConfirmation(text: string): ConfirmIntent {
  const t = text.trim().toLowerCase()
  if (AFFIRM.test(t)) return 'affirm'
  if (NEGATE.test(t)) return 'negate'
  return 'unknown'
}

export interface ExecutionResult {
  ok: boolean
  text: string
}

/** Execute a confirmed control action against the MCP. */
export async function executeAction(mcp: McpGateway, action: PendingAction): Promise<ExecutionResult> {
  try {
    const res = await mcp.callTool(action.tool, action.args)
    if (res.isError) {
      const detail = res.text || 'thiết bị báo lỗi'
      const hint = isRouteErrorText(detail) ? ' — route/URL MCP sai hoặc tool không tồn tại.' : ''
      return { ok: false, text: `Không thực hiện được: ${detail}${hint}` }
    }
    return { ok: true, text: res.text ? `Đã thực hiện. ${res.text}` : `Đã thực hiện: ${action.summary}.` }
  } catch (err) {
    const info = describeMcpError(err)
    const hint = info.route ? ' — kiểm tra lại route/URL MCP hoặc tên tool.' : ''
    return { ok: false, text: `Lỗi khi gọi thiết bị: ${info.message}${hint}` }
  }
}
