import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import type { AppState } from '../setup/state'
import {
  BadRequestError,
  contentChunk,
  finalChunk,
  modelsList,
  type OpenAiMessage,
  parseMessages,
  recoverPending,
  roleChunk,
  SSE_DONE,
  sseData,
  toCompletion,
} from './openai/adapter'
import { OpenAiChatRequestSchema } from './openai/dto'
import { writeSseHead } from './sse'

// User namespace when the OpenAI `user` field is omitted. Sessions key on (user, session_id).
const DEFAULT_USER = 'openai'

function oaiError(message: string, type: string, code: string) {
  return { error: { message, type, code, param: null } }
}

const chatBodySchema = {
  type: 'object',
  required: ['model', 'messages'],
  additionalProperties: true,
  properties: {
    model: {
      type: 'string',
      description: 'Chấp nhận mọi giá trị; server echo lại. `/v1/models` liệt kê `plant-assistant`.',
    },
    messages: { type: 'array', items: { type: 'object', additionalProperties: true } },
    stream: { type: 'boolean' },
    session_id: {
      type: 'string',
      description:
        'Định danh phiên để server NHỚ hội thoại (như ChatGPT). Trống/thiếu → server tự sinh uuid ' +
        'và trả về ở header `X-Session-Id` (và field `session_id` khi không streaming) để dùng cho lượt sau.',
    },
    user: { type: 'string', description: 'Định danh người dùng (chuẩn OpenAI); mặc định "openai".' },
  },
  example: {
    model: 'plant-assistant',
    session_id: 's1',
    messages: [{ role: 'user', content: 'Cây dâu của mình bị vàng lá, nên làm gì?' }],
  },
} as const

export function registerOpenAiRoutes(app: FastifyInstance, state: AppState): void {
  app.get(
    '/v1/models',
    { schema: { tags: ['openai'], summary: 'Danh sách model (tương thích OpenAI)' } },
    async () => modelsList(Math.floor(Date.now() / 1000)),
  )

  app.post(
    '/v1/chat/completions',
    {
      attachValidation: true,
      schema: {
        tags: ['openai'],
        summary: 'Chat completions tương thích OpenAI (chạy toàn bộ agent, nhớ theo session_id)',
        description:
          'Endpoint OpenAI-compatible chạy qua toàn bộ agent (RAG + điều khiển IoT + xác nhận).\n\n' +
          '**Trí nhớ server-side (như ChatGPT):** đính `session_id` và chỉ gửi **message mới** mỗi lượt — ' +
          'server tự nhớ phần còn lại. Thiếu/trống `session_id` → server sinh uuid và trả về ở header ' +
          '`X-Session-Id` (kèm field `session_id` trong body khi không streaming); dùng lại giá trị đó cho lượt sau. ' +
          '`user` (chuẩn OpenAI) là namespace người dùng, mặc định "openai".\n\n' +
          '**Tương thích ngược:** với một session MỚI (chưa có lịch sử), nếu client gửi cả `messages[]` ' +
          '(kiểu OpenAI cũ) thì toàn bộ thread được nạp làm lịch sử ban đầu; từ lượt sau chỉ message cuối được dùng.\n\n' +
          '**Điều khiển thiết bị:** khi cần xác nhận, response hỏi "(Có/Không)". Ở lượt sau chỉ cần gửi ' +
          '"có"/"không" cùng `session_id` — server nhớ hành động đang chờ (không cần giữ `tool_calls`).\n\n' +
          '**Streaming:** đặt `stream:true` để nhận `chat.completion.chunk` (SSE, kết `data: [DONE]`). ' +
          '`finish_reason` luôn là `stop`. `usage` báo 0 (không đếm token).',
        body: chatBodySchema,
      },
    },
    async (req, reply) => {
      const orch = state.orchestrator
      if (!orch) {
        reply.code(503)
        return oaiError('server not configured; visit /setup', 'server_error', 'not_configured')
      }
      const parsed = OpenAiChatRequestSchema.safeParse(req.body)
      if (!parsed.success) {
        reply.code(400)
        return oaiError('invalid request body', 'invalid_request_error', 'invalid_body')
      }
      const body = parsed.data
      let thread
      try {
        thread = parseMessages(body.messages as unknown as OpenAiMessage[])
      } catch (err) {
        if (err instanceof BadRequestError) {
          reply.code(400)
          return oaiError(err.message, 'invalid_request_error', 'invalid_messages')
        }
        throw err
      }

      // Server-authoritative memory. Resolve identity, minting a session when absent.
      const userId = body.user ?? DEFAULT_USER
      const sessionId = body.session_id?.trim() || randomUUID()

      // Seed ONLY a brand-new session from the caller's thread — this keeps legacy
      // full-history OpenAI clients working (and recovers an echoed pending action).
      // Once the session has history, the caller's prior turns are ignored and only
      // the last user message runs against server memory.
      const sessions = orch.sessions
      if (sessions.getHistory(userId, sessionId).length === 0) {
        if (thread.history.length) sessions.append(userId, sessionId, ...thread.history)
        const pending = recoverPending(thread.priorAssistant)
        if (pending) sessions.setPending(userId, sessionId, pending)
      }

      const id = `chatcmpl-${randomUUID()}`
      const created = Math.floor(Date.now() / 1000)

      if (!body.stream) {
        try {
          reply.header('X-Session-Id', sessionId)
          const result = await orch.handleChat(userId, sessionId, thread.lastUserMessage)
          return { ...toCompletion(result, body.model, id, created), session_id: sessionId }
        } catch (err) {
          req.log.error(err)
          reply.code(500)
          return oaiError((err as Error).message, 'server_error', 'internal_error')
        }
      }

      // Streaming (OpenAI SSE). From here Fastify hands off the raw socket.
      reply.hijack()
      const raw = reply.raw
      writeSseHead(raw, { 'X-Session-Id': sessionId })
      const abort = new AbortController()
      let finished = false
      req.raw.on('close', () => {
        if (!finished) abort.abort()
      })
      raw.on('error', () => {
        if (!finished) abort.abort()
      })
      try {
        raw.write(sseData(roleChunk(body.model, id, created)))
        let pendingView = null
        for await (const event of orch.handleChatStream(userId, sessionId, thread.lastUserMessage, {
          signal: abort.signal,
        })) {
          if (event.type === 'token') {
            raw.write(sseData(contentChunk(event.text, body.model, id, created)))
          } else if (event.type === 'done') {
            pendingView = event.pendingAction
          }
          // 'tool_status' and 'reset' are intentionally dropped (S1 streaming policy).
        }
        raw.write(sseData(finalChunk(pendingView, body.model, id, created)))
        raw.write(SSE_DONE)
      } catch (err) {
        if (!abort.signal.aborted) {
          req.log.error(err)
          raw.write(sseData(oaiError('internal error', 'server_error', 'internal_error')))
        }
      } finally {
        finished = true
        if (!raw.writableEnded) raw.end()
      }
    },
  )
}
