import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { SessionStore } from '../memory/sessions'
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

// The ephemeral store is per-request, so a constant key is safe (no cross-talk).
const UID = 'openai'
const SID = 'openai'

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
  },
  example: {
    model: 'plant-assistant',
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
        summary: 'Chat completions tương thích OpenAI (chạy toàn bộ agent)',
        description:
          'Endpoint OpenAI-compatible, **stateless**: gửi cả `messages[]` mỗi lần. Chạy qua toàn bộ agent ' +
          '(RAG + điều khiển IoT + xác nhận).\n\n' +
          '**Điều khiển thiết bị (turnkey):** khi cần xác nhận, response trả `content` là câu hỏi "(Có/Không)" ' +
          '**và** một `tool_calls` mã hoá hành động. Ở lượt sau, **giữ nguyên object assistant (kèm `tool_calls`)** ' +
          'trong `messages[]` rồi thêm câu trả lời của người dùng ("có"/"không") — server sẽ thực thi hoặc huỷ. ' +
          'Nếu không giữ `tool_calls`, "có" sẽ bị coi là yêu cầu mới (an toàn: không thực thi nhầm).\n\n' +
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

      // Stateless: rebuild a throwaway session from the thread, then run the
      // unchanged agent core against it.
      const ephemeral = new SessionStore()
      if (thread.history.length) ephemeral.append(UID, SID, ...thread.history)
      const pending = recoverPending(thread.priorAssistant)
      if (pending) ephemeral.setPending(UID, SID, pending)
      const scoped = orch.withSessions(ephemeral)

      const id = `chatcmpl-${randomUUID()}`
      const created = Math.floor(Date.now() / 1000)

      if (!body.stream) {
        try {
          const result = await scoped.handleChat(UID, SID, thread.lastUserMessage)
          return toCompletion(result, body.model, id, created)
        } catch (err) {
          req.log.error(err)
          reply.code(500)
          return oaiError((err as Error).message, 'server_error', 'internal_error')
        }
      }

      // Streaming (OpenAI SSE). From here Fastify hands off the raw socket.
      reply.hijack()
      const raw = reply.raw
      writeSseHead(raw)
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
        for await (const event of scoped.handleChatStream(UID, SID, thread.lastUserMessage, {
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
