import { randomUUID } from 'node:crypto'
import type { McpGateway } from '../mcp/client'
import type { PendingAction } from '../memory/sessions'

const COMMAND_LABELS: Record<string, string> = {
  WATER_ON: 'Bật bơm nước',
  WATER_OFF: 'Tắt bơm nước',
  LIGHT_ON: 'Bật đèn',
  LIGHT_OFF: 'Tắt đèn',
  FAN_ON: 'Bật quạt',
  FAN_OFF: 'Tắt quạt',
}

/** Build a human-readable Vietnamese summary of a control action for confirmation. */
export function summarizeAction(tool: string, args: Record<string, unknown>): string {
  const dev = args.device_id ? ` thiết bị ${String(args.device_id)}` : ''
  switch (tool) {
    case 'send_command': {
      const cmd = String(args.command ?? '')
      const label = COMMAND_LABELS[cmd] ?? cmd
      const dur = args.duration ? ` trong ${Number(args.duration) / 1000}s` : ''
      return `${label}${dev}${dur}`
    }
    case 'auto_water':
      return `Bật tưới tự động${dev} (ngưỡng độ ẩm đất ${args.threshold ?? '?'}%)`
    case 'auto_light':
      return `Bật đèn tự động${dev} (ngưỡng ${args.threshold ?? '?'} lux)`
    case 'set_moisture_rule':
      return `Đặt luật độ ẩm${dev}: ${JSON.stringify(args)}`
    case 'set_light_rule':
      return `Đặt luật ánh sáng${dev}: ${JSON.stringify(args)}`
    default:
      return `Chạy ${tool}${dev} với tham số ${JSON.stringify(args)}`
  }
}

export function createPendingAction(tool: string, args: Record<string, unknown>): PendingAction {
  return { id: randomUUID(), tool, args, summary: summarizeAction(tool, args) }
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
      return { ok: false, text: `Không thực hiện được: ${res.text || 'thiết bị báo lỗi'}` }
    }
    return { ok: true, text: res.text ? `Đã thực hiện. ${res.text}` : `Đã thực hiện: ${action.summary}.` }
  } catch (err) {
    return { ok: false, text: `Lỗi khi gọi thiết bị: ${(err as Error).message}` }
  }
}
