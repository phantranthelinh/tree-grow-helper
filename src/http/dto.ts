import { z } from 'zod'

export const ChatRequestSchema = z.object({
  userId: z.string().min(1),
  sessionId: z.string().min(1),
  message: z.string().min(1),
})
export type ChatRequest = z.infer<typeof ChatRequestSchema>

export const ConfirmRequestSchema = z.object({
  userId: z.string().min(1),
  sessionId: z.string().min(1),
  actionId: z.string().min(1),
  approved: z.boolean(),
})
export type ConfirmRequest = z.infer<typeof ConfirmRequestSchema>

const ProviderEnum = z.enum(['lmstudio', 'ollama', 'gemini', 'openai-compat'])

export const SetupModelsRequestSchema = z.object({
  provider: ProviderEnum,
  baseURL: z.string().url(),
  apiKey: z.string().optional(),
})
export type SetupModelsRequest = z.infer<typeof SetupModelsRequestSchema>

export const SetupConnectRequestSchema = z.object({
  provider: ProviderEnum,
  baseURL: z.string().url(),
  apiKey: z.string().optional(),
  model: z.string().min(1),
  embedModel: z.string().min(1),
  // Optional so pre-existing clients keep working; missing → saved config → MCP_URL env.
  mcpUrl: z.string().url().optional(),
})
export type SetupConnectRequest = z.infer<typeof SetupConnectRequestSchema>

export const SetupMcpTestRequestSchema = z.object({
  url: z.string().url(),
})
export type SetupMcpTestRequest = z.infer<typeof SetupMcpTestRequestSchema>
