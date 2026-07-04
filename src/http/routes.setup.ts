import type { FastifyInstance } from 'fastify'
import type { Config } from '../config'
import { resolveApiKey } from '../llm/providers'
import { applyLlmConfig, defaultSetupDeps, type SetupDeps } from '../setup/init'
import type { LlmConfig } from '../setup/llmConfig'
import { testMcpConnection } from '../setup/probe'
import { renderSetupPage } from '../setup/page'
import type { AppState } from '../setup/state'
import { SetupConnectRequestSchema, SetupMcpTestRequestSchema } from './dto'

const errorSchema = {
  type: 'object',
  additionalProperties: true,
  properties: {
    error: { type: 'string' },
    stage: { type: 'string' },
    message: { type: 'string' },
    details: { type: 'object', additionalProperties: true },
  },
} as const

const stepSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    status: { type: 'string' },
    detail: { type: 'string' },
  },
} as const

const statusSchema = {
  type: 'object',
  additionalProperties: true,
  properties: {
    phase: { type: 'string', description: 'waiting_config | connecting | initializing | ready | error' },
    steps: { type: 'array', items: stepSchema },
    error: { type: 'object', nullable: true, additionalProperties: true },
    config: { type: 'object', nullable: true, additionalProperties: true },
    defaults: { type: 'object', additionalProperties: true },
  },
} as const

const connectBodySchema = {
  type: 'object',
  required: ['provider', 'baseURL', 'model', 'embedModel'],
  additionalProperties: false,
  properties: {
    provider: { type: 'string' },
    baseURL: { type: 'string' },
    apiKey: { type: 'string' },
    model: { type: 'string' },
    embedModel: { type: 'string' },
    // Must be declared here: with additionalProperties:false AJV strips unknown
    // keys from req.body before the Zod parse ever sees them.
    mcpUrl: { type: 'string' },
  },
} as const

const mcpTestBodySchema = {
  type: 'object',
  required: ['url'],
  additionalProperties: false,
  properties: {
    url: { type: 'string' },
  },
} as const

export function registerSetupRoutes(
  app: FastifyInstance,
  state: AppState,
  appCfg: Config,
  deps: Partial<SetupDeps> = {},
): void {
  app.get(
    '/setup',
    { schema: { tags: ['setup'], summary: 'Trang cấu hình LLM (HTML)' } },
    async (_req, reply) => {
      reply.type('text/html; charset=utf-8')
      return renderSetupPage()
    },
  )

  app.get(
    '/api/setup/status',
    {
      schema: {
        tags: ['setup'],
        summary: 'Trạng thái cấu hình & tiến trình khởi tạo',
        response: { 200: statusSchema },
      },
    },
    async () => ({
      ...state.getStatus(),
      defaults: {
        provider: appCfg.llmDefaults.provider,
        baseURL: appCfg.llmDefaults.baseURL,
        model: appCfg.llmDefaults.model,
        embedModel: appCfg.llmDefaults.embedModel,
        mcpUrl: appCfg.mcp.url,
      },
    }),
  )

  app.post(
    '/api/setup/connect',
    {
      attachValidation: true,
      schema: {
        tags: ['setup'],
        summary: 'Kiểm tra kết nối, lưu cấu hình & khởi tạo',
        description:
          'Probe (models + chat + embed). Thành công → lưu `data/llm-config.json` và chạy pipeline khởi tạo ' +
          '(theo dõi qua `GET /api/setup/status`).',
        body: connectBodySchema,
        response: { 200: { type: 'object', additionalProperties: true }, 400: errorSchema, 409: errorSchema, 502: errorSchema },
      },
    },
    async (req, reply) => {
      const parsed = SetupConnectRequestSchema.safeParse(req.body)
      if (!parsed.success) {
        reply.code(400)
        return { error: 'invalid_request', details: parsed.error.flatten() }
      }
      const { provider, baseURL, apiKey, model, embedModel, mcpUrl } = parsed.data
      const cfg: LlmConfig = {
        provider,
        baseURL,
        apiKey: resolveApiKey(provider, apiKey),
        model,
        embedModel,
      }
      const res = await applyLlmConfig(cfg, state, appCfg, deps, { mcpUrl })
      if (!res.ok) {
        reply.code(res.code === 'busy' ? 409 : 502)
        return { error: res.code, stage: res.stage, message: res.message }
      }
      return { ok: true, phase: state.phase }
    },
  )

  app.post(
    '/api/setup/mcp/test',
    {
      attachValidation: true,
      schema: {
        tags: ['setup'],
        summary: 'Kiểm tra kết nối MCP (không lưu)',
        description:
          'Kết nối thử tới MCP URL và liệt kê tool. Chỉ để kiểm tra — MCP hỏng vẫn kết nối được ' +
          '(init sẽ dùng catalog tool tĩnh đến khi MCP sẵn sàng).',
        body: mcpTestBodySchema,
        response: {
          200: {
            type: 'object',
            properties: {
              ok: { type: 'boolean' },
              toolCount: { type: 'number' },
              tools: { type: 'array', items: { type: 'string' } },
            },
          },
          400: errorSchema,
          502: errorSchema,
        },
      },
    },
    async (req, reply) => {
      const parsed = SetupMcpTestRequestSchema.safeParse(req.body)
      if (!parsed.success) {
        reply.code(400)
        return { error: 'invalid_request', details: parsed.error.flatten() }
      }
      const buildMcp = deps.buildMcp ?? defaultSetupDeps().buildMcp
      const res = await testMcpConnection(buildMcp, parsed.data.url, {
        timeoutMs: appCfg.setup.probeTimeoutMs,
      })
      if (!res.ok) {
        reply.code(502)
        return { error: res.code, message: res.message }
      }
      return { ok: true, toolCount: res.toolCount, tools: res.tools }
    },
  )
}
