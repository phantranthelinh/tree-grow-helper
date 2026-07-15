import { z } from 'zod'

const ContentPart = z.object({ type: z.string(), text: z.string().optional() }).passthrough()

const ToolCall = z
  .object({
    id: z.string(),
    type: z.literal('function'),
    function: z.object({ name: z.string(), arguments: z.string() }),
  })
  .passthrough()

const Message = z
  .object({
    role: z.string(),
    content: z.union([z.string(), z.array(ContentPart), z.null()]).optional(),
    tool_calls: z.array(ToolCall).optional(),
  })
  .passthrough()

/** Subset of the OpenAI Chat Completions request we act on; extra fields tolerated. */
export const OpenAiChatRequestSchema = z
  .object({
    model: z.string().min(1),
    messages: z.array(Message).min(1),
    stream: z.boolean().optional(),
  })
  .passthrough()

export type OpenAiChatRequest = z.infer<typeof OpenAiChatRequestSchema>
