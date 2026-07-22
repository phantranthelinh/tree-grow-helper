import Fastify, { type FastifyInstance } from 'fastify'
import fastifyCors from '@fastify/cors'
import fastifySwagger from '@fastify/swagger'
import fastifySwaggerUi from '@fastify/swagger-ui'
import type { Config } from '../config'
import type { SetupDeps } from '../setup/init'
import type { AppState } from '../setup/state'
import { registerChatRoutes } from './routes.chat'
import { registerOpenAiRoutes } from './routes.openai'
import { registerSetupRoutes } from './routes.setup'

export interface ServerContext {
  state: AppState
  config: Config
  /** Injectable setup construction seams (fakes in tests). */
  setupDeps?: Partial<SetupDeps>
}

export function buildServer(ctx: ServerContext): FastifyInstance {
  // `example` is an OpenAPI keyword (used to prefill Swagger "Try it out"), not a
  // JSON-Schema validation keyword — register it so AJV strict mode ignores it.
  const app = Fastify({ logger: true, ajv: { customOptions: { keywords: ['example'] } } })

  // Browser chat apps live on another origin and must POST /chat/stream with
  // fetch (EventSource can't POST), which triggers a preflight — allow it.
  app.register(fastifyCors, {
    origin: true,
    methods: ['GET', 'POST', 'OPTIONS'],
    exposedHeaders: ['X-Session-Id'],
  })

  // OpenAPI spec + interactive UI at /docs so you can self-test the chat in a browser.
  // Registered BEFORE the routes: @fastify/swagger installs an `onRoute` hook that must
  // be active when the routes are added. Wrapping the routes in a child plugin (below)
  // guarantees they load after this hook is in place, while keeping buildServer sync.
  app.register(fastifySwagger, {
    openapi: {
      info: {
        title: 'AI Server API',
        description:
          'Trợ lý chăm cây (LLM local qua LM Studio) + điều khiển thiết bị IoT qua MCP.\n\n' +
          'Dùng **Try it out** ở endpoint `POST /v1/chat/completions` (tương thích OpenAI) để tự test hội thoại. ' +
          'Khi cần xác nhận hành động điều khiển, giữ nguyên object assistant (kèm `tool_calls`) trong ' +
          '`messages[]` rồi gửi tiếp "có"/"không". Bản streaming SSE ở `POST /chat/stream`.',
        version: '0.1.0',
      },
      tags: [
        { name: 'setup', description: 'Cấu hình LLM khi khởi động' },
        { name: 'chat', description: 'Hội thoại với trợ lý & xác nhận hành động điều khiển' },
        { name: 'openai', description: 'API tương thích OpenAI (/v1) — server khác gọi như LM Studio' },
        { name: 'system', description: 'Health check & thông tin server' },
      ],
    },
  })

  app.register(fastifySwaggerUi, {
    routePrefix: '/docs',
    uiConfig: { docExpansion: 'list', deepLinking: true, tryItOutEnabled: true },
  })

  app.register(async (instance) => {
    registerSetupRoutes(instance, ctx.state, ctx.config, ctx.setupDeps)
    registerChatRoutes(instance, ctx.state)
    registerOpenAiRoutes(instance, ctx.state)
  })

  return app
}
