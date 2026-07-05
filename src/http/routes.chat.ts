import type { FastifyInstance } from 'fastify'
import type { AppState } from '../setup/state'
import { ChatRequestSchema, ConfirmRequestSchema } from './dto'
import { startHeartbeat, writeSseEvent, writeSseHead } from './sse'

const SSE_ERROR_MESSAGE = 'Có lỗi xảy ra, bạn thử lại giúp mình nhé.'
const HEARTBEAT_MS = 15_000

// --- OpenAPI/JSON schemas (documentation + Swagger "Try it out") ---------------
// These mirror the Zod DTOs. We keep Zod as the actual validator (via
// `attachValidation: true`), so invalid bodies still return the existing
// `{ error: 'invalid_request', details }` envelope instead of Fastify's default.

const pendingActionSchema = {
  type: 'object',
  nullable: true,
  description: 'Hành động điều khiển đang chờ xác nhận (null nếu không có).',
  properties: {
    id: { type: 'string' },
    summary: { type: 'string' },
    tool: { type: 'string' },
    args: { type: 'object', additionalProperties: true },
  },
  additionalProperties: true,
} as const

const chatResultSchema = {
  type: 'object',
  additionalProperties: true,
  properties: {
    reply: { type: 'string', description: 'Câu trả lời (tiếng Việt) cho người dùng.' },
    pendingAction: pendingActionSchema,
  },
} as const

const errorSchema = {
  type: 'object',
  additionalProperties: true,
  properties: {
    error: { type: 'string', description: "'invalid_request' (400) hoặc 'internal_error' (500)." },
    message: { type: 'string' },
    details: { type: 'object', additionalProperties: true },
  },
} as const

const chatBodySchema = {
  type: 'object',
  required: ['userId', 'sessionId', 'message'],
  additionalProperties: false,
  properties: {
    userId: { type: 'string', minLength: 1, description: 'Định danh người dùng.' },
    sessionId: { type: 'string', minLength: 1, description: 'Định danh phiên hội thoại (multi-turn).' },
    message: { type: 'string', minLength: 1, description: 'Câu chat của người dùng.' },
  },
  example: {
    userId: 'u1',
    sessionId: 's1',
    message: 'Cây dâu của mình bị vàng lá, mình nên làm gì?',
  },
} as const

const confirmBodySchema = {
  type: 'object',
  required: ['userId', 'sessionId', 'actionId', 'approved'],
  additionalProperties: false,
  properties: {
    userId: { type: 'string', minLength: 1 },
    sessionId: { type: 'string', minLength: 1 },
    actionId: { type: 'string', minLength: 1, description: 'Lấy từ `pendingAction.id` của phản hồi /chat.' },
    approved: { type: 'boolean', description: 'true = thực thi, false = huỷ.' },
  },
  example: { userId: 'u1', sessionId: 's1', actionId: '<pendingAction.id từ /chat>', approved: true },
} as const

export function registerChatRoutes(app: FastifyInstance, state: AppState): void {
  app.get(
    '/',
    {
      schema: {
        tags: ['system'],
        summary: 'Thông tin server & danh sách endpoint',
      },
    },
    async () => ({
      name: 'ai-server',
      status: 'ok',
      phase: state.phase,
      docs: '/docs',
      endpoints: [
        { method: 'GET', path: '/setup' },
        { method: 'GET', path: '/health' },
        { method: 'POST', path: '/chat' },
        { method: 'POST', path: '/chat/stream' },
        { method: 'POST', path: '/chat/confirm' },
        { method: 'GET', path: '/docs' },
      ],
    }),
  )

  app.get(
    '/health',
    {
      schema: {
        tags: ['system'],
        summary: 'Health check',
        response: {
          200: { type: 'object', properties: { status: { type: 'string' }, phase: { type: 'string' } } },
        },
      },
    },
    async () => ({ status: 'ok', phase: state.phase }),
  )

  app.post(
    '/chat',
    {
      attachValidation: true,
      schema: {
        tags: ['chat'],
        summary: 'Gửi một câu chat và nhận câu trả lời',
        description:
          'Trả về `reply`. Nếu yêu cầu là hành động **điều khiển thiết bị**, `pendingAction` sẽ khác null ' +
          '(chưa thực thi) — copy `pendingAction.id` sang `POST /chat/confirm` để xác nhận.',
        body: chatBodySchema,
        response: { 200: chatResultSchema, 400: errorSchema, 500: errorSchema, 503: errorSchema },
      },
    },
    async (req, reply) => {
      const orch = state.orchestrator
      if (!orch) {
        reply.code(503)
        return { error: 'not_configured', phase: state.phase, setup: '/setup' }
      }
      const parsed = ChatRequestSchema.safeParse(req.body)
      if (!parsed.success) {
        reply.code(400)
        return { error: 'invalid_request', details: parsed.error.flatten() }
      }
      const { userId, sessionId, message } = parsed.data
      try {
        return await orch.handleChat(userId, sessionId, message)
      } catch (err) {
        req.log.error(err)
        reply.code(500)
        return { error: 'internal_error', message: (err as Error).message }
      }
    },
  )

  app.post(
    '/chat/stream',
    {
      attachValidation: true,
      schema: {
        tags: ['chat'],
        summary: 'Gửi một câu chat và nhận câu trả lời dạng streaming (SSE)',
        description:
          'Phiên bản streaming của `POST /chat`. Phản hồi 200 là `text/event-stream` (Swagger UI không hiển thị ' +
          'được — dùng `curl -N` hoặc fetch + ReadableStream). Các frame `event: <tên>` với `data` là JSON một dòng:\n\n' +
          '- `token` `{text}` — nối vào câu trả lời đang hiện\n' +
          '- `tool_status` `{tool, note}` — trạng thái tạm khi đọc dữ liệu, không thuộc câu trả lời\n' +
          '- `reset` `{}` — xóa phần đã hiện của lượt này (model phải thử lại)\n' +
          '- `done` `{reply, pendingAction}` — kết thúc; `reply` là bản chuẩn (cùng shape với `POST /chat`)\n' +
          '- `error` `{message}` — kết thúc lỗi\n\n' +
          'Dòng chú thích `: ping` được gửi định kỳ để giữ kết nối. Lỗi trước khi stream (400/503) trả JSON thường.',
        body: chatBodySchema,
        response: { 400: errorSchema, 503: errorSchema },
      },
    },
    async (req, reply) => {
      const orch = state.orchestrator
      if (!orch) {
        reply.code(503)
        return { error: 'not_configured', phase: state.phase, setup: '/setup' }
      }
      const parsed = ChatRequestSchema.safeParse(req.body)
      if (!parsed.success) {
        reply.code(400)
        return { error: 'invalid_request', details: parsed.error.flatten() }
      }
      const { userId, sessionId, message } = parsed.data

      // From here on the response is a raw SSE stream — Fastify hands it off.
      reply.hijack()
      const raw = reply.raw
      writeSseHead(raw)
      const stopHeartbeat = startHeartbeat(raw, HEARTBEAT_MS)
      const abort = new AbortController()
      let finished = false
      // 'close' also fires after a normal end — the flag keeps that a no-op.
      req.raw.on('close', () => {
        if (!finished) abort.abort()
      })
      try {
        for await (const event of orch.handleChatStream(userId, sessionId, message, { signal: abort.signal })) {
          switch (event.type) {
            case 'token':
              writeSseEvent(raw, 'token', { text: event.text })
              break
            case 'tool_status':
              writeSseEvent(raw, 'tool_status', { tool: event.tool, note: event.note })
              break
            case 'reset':
              writeSseEvent(raw, 'reset', {})
              break
            case 'done':
              writeSseEvent(raw, 'done', { reply: event.reply, pendingAction: event.pendingAction })
              break
            default: {
              // Compile-time exhaustiveness: a new ChatStreamEvent variant must fail here,
              // not get silently dropped off the wire.
              const unhandled: never = event
              void unhandled
            }
          }
        }
      } catch (err) {
        if (!abort.signal.aborted) {
          req.log.error(err)
          writeSseEvent(raw, 'error', { message: SSE_ERROR_MESSAGE })
        }
      } finally {
        finished = true
        stopHeartbeat()
        raw.end()
      }
    },
  )

  app.post(
    '/chat/confirm',
    {
      attachValidation: true,
      schema: {
        tags: ['chat'],
        summary: 'Xác nhận / huỷ một hành động điều khiển đang chờ',
        description: 'Dùng `actionId` lấy từ `pendingAction.id` của phản hồi `/chat`.',
        body: confirmBodySchema,
        response: { 200: chatResultSchema, 400: errorSchema, 500: errorSchema, 503: errorSchema },
      },
    },
    async (req, reply) => {
      const orch = state.orchestrator
      if (!orch) {
        reply.code(503)
        return { error: 'not_configured', phase: state.phase, setup: '/setup' }
      }
      const parsed = ConfirmRequestSchema.safeParse(req.body)
      if (!parsed.success) {
        reply.code(400)
        return { error: 'invalid_request', details: parsed.error.flatten() }
      }
      const { userId, sessionId, actionId, approved } = parsed.data
      try {
        return await orch.confirm(userId, sessionId, actionId, approved)
      } catch (err) {
        req.log.error(err)
        reply.code(500)
        return { error: 'internal_error', message: (err as Error).message }
      }
    },
  )
}
