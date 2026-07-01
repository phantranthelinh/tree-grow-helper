import Fastify, { type FastifyInstance } from 'fastify'
import fastifySwagger from '@fastify/swagger'
import fastifySwaggerUi from '@fastify/swagger-ui'
import type { Orchestrator } from '../agent/orchestrator'
import { registerChatRoutes } from './routes.chat'

export function buildServer(orch: Orchestrator): FastifyInstance {
  const app = Fastify({ logger: true })

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
          'Dùng **Try it out** ở endpoint `POST /chat` để tự test hội thoại. ' +
          'Khi câu trả lời có `pendingAction` (hành động điều khiển cần xác nhận), copy `pendingAction.id` ' +
          'sang `POST /chat/confirm` để xác nhận hoặc huỷ.',
        version: '0.1.0',
      },
      tags: [
        { name: 'chat', description: 'Hội thoại với trợ lý & xác nhận hành động điều khiển' },
        { name: 'system', description: 'Health check & thông tin server' },
      ],
    },
  })

  app.register(fastifySwaggerUi, {
    routePrefix: '/docs',
    uiConfig: { docExpansion: 'list', deepLinking: true, tryItOutEnabled: true },
  })

  app.register(async (instance) => {
    registerChatRoutes(instance, orch)
  })

  return app
}
