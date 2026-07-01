import type { PlantProfile } from '../domain/profiles'
import { summarizeRanges } from '../domain/profiles'
import type { McpTool } from '../mcp/client'
import { classifyTool } from '../mcp/policy'
import type { ChatMessage } from './index'

/** Render the MCP tool catalog as a Vietnamese-annotated list for the prompt. */
export function renderToolCatalog(tools: McpTool[]): string {
  if (tools.length === 0) return '(chưa kết nối được tool nào)'
  return tools
    .map((t) => {
      const props = (t.inputSchema?.properties ?? {}) as Record<string, unknown>
      const params = Object.keys(props).join(', ') || 'không tham số'
      const safety = classifyTool(t.name) === 'read' ? 'ĐỌC' : 'ĐIỀU KHIỂN'
      return `- ${t.name}(${params}) [${safety}]: ${t.description ?? ''}`
    })
    .join('\n')
}

export interface SystemPromptInput {
  profile: PlantProfile
  tools: McpTool[]
  fewshot?: string
}

export function buildSystemPrompt({ profile, tools, fewshot }: SystemPromptInput): string {
  const ranges = summarizeRanges(profile)
  const catalog = renderToolCatalog(tools)
  return [
    'Bạn là trợ lý AI chăm sóc cây trồng và điều khiển thiết bị IoT trong vườn.',
    `Giai đoạn hiện tại CHỈ hỗ trợ CÂY DÂU TÂY (strawberry).`,
    '',
    `Khoảng tối ưu của cây dâu: ${ranges}.`,
    '',
    'Các tool có thể dùng (ĐỌC = tự chạy, ĐIỀU KHIỂN = cần xác nhận người dùng):',
    catalog,
    '',
    'QUY TẮC:',
    '1. Luôn trả lời người dùng bằng TIẾNG VIỆT, ngắn gọn, thân thiện.',
    '2. Mỗi lượt trả về đúng JSON quyết định:',
    '   - {"type":"reply","message":"..."} khi chỉ cần trả lời/tư vấn.',
    '   - {"type":"tool","tool":"<tên_tool>","args":{...},"message":"<giải thích ngắn>"} khi cần gọi tool.',
    '3. Tool [ĐỌC] sẽ được hệ thống tự chạy và trả kết quả lại cho bạn để phân tích tiếp.',
    '4. Tool [ĐIỀU KHIỂN] sẽ KHÔNG chạy ngay — hệ thống hỏi xác nhận người dùng trước. Vì vậy TUYỆT ĐỐI không nói rằng đã thực hiện xong; chỉ chọn đúng tool + tham số.',
    '5. Nếu cần device_id mà chưa biết, hãy gọi list_devices trước (tool ĐỌC).',
    '6. Khi tưới/chiếu sáng cho dâu, đặt ngưỡng theo khoảng tối ưu của dâu (vd độ ẩm đất mục tiêu ~75%), KHÔNG dùng giá trị mặc định chung.',
    '7. Chỉ dùng thông tin từ ngữ cảnh và kết quả tool; nếu không chắc, hãy nói rõ và hỏi lại.',
    fewshot ? `\nVÍ DỤ:\n${fewshot}` : '',
  ].join('\n')
}

export interface AssembleInput {
  system: string
  history: ChatMessage[]
  ragContext?: string
  userMessage: string
}

/** Build the full message array for one LLM turn. */
export function assembleMessages({ system, history, ragContext, userMessage }: AssembleInput): ChatMessage[] {
  const messages: ChatMessage[] = [{ role: 'system', content: system }]
  messages.push(...history)
  const content = ragContext
    ? `[Tri thức tham khảo về cây dâu]\n${ragContext}\n\n[Câu hỏi của người dùng]\n${userMessage}`
    : userMessage
  messages.push({ role: 'user', content })
  return messages
}
