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
