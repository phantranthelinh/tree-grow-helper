import type { FastifyInstance } from 'fastify'
import type { Orchestrator } from '../agent/orchestrator'
import { ChatRequestSchema, ConfirmRequestSchema } from './dto'

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

export function registerChatRoutes(app: FastifyInstance, orch: Orchestrator): void {
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
      docs: '/docs',
      endpoints: [
        { method: 'GET', path: '/health' },
        { method: 'POST', path: '/chat' },
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
          200: { type: 'object', properties: { status: { type: 'string' } } },
        },
      },
    },
    async () => ({ status: 'ok' }),
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
        response: { 200: chatResultSchema, 400: errorSchema, 500: errorSchema },
      },
    },
    async (req, reply) => {
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
    '/chat/confirm',
    {
      attachValidation: true,
      schema: {
        tags: ['chat'],
        summary: 'Xác nhận / huỷ một hành động điều khiển đang chờ',
        description: 'Dùng `actionId` lấy từ `pendingAction.id` của phản hồi `/chat`.',
        body: confirmBodySchema,
        response: { 200: chatResultSchema, 400: errorSchema, 500: errorSchema },
      },
    },
    async (req, reply) => {
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
