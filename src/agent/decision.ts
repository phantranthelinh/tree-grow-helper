import { z } from 'zod'

/**
 * Every LLM turn returns exactly one decision:
 *  - reply: answer the user in Vietnamese (advice / info / confirmation wording).
 *  - tool:  call one MCP tool. Read tools run automatically; control tools are
 *           intercepted for user confirmation (never executed directly here).
 */
export const AgentDecisionSchema = z.object({
  /** Optional short chain-of-thought emitted BEFORE the decision; never shown to the user. */
  reasoning: z.string().optional(),
  type: z.enum(['reply', 'tool']),
  message: z.string().optional().default(''),
  tool: z.string().optional(),
  args: z.record(z.unknown()).optional().default({}),
})

export type AgentDecision = z.infer<typeof AgentDecisionSchema>

/**
 * The 3B code-switches mid-sentence (Russian, Chinese) at quantities and Sino-Vietnamese words. LM Studio
 * compiles this pattern into its sampling grammar, so those characters cannot be generated at all.
 * It is an allow-list, not a deny-list: printable ASCII without the backslash, Latin-1 and Latin Extended,
 * combining marks, Vietnamese tone letters, punctuation, super/subscripts and currency, letterlike symbols,
 * arrows and math operators; the only escapes are \" \\ \/ \n \t. A deny-list was bypassed with other
 * scripts and with \u escapes. Plain groups only, because LM Studio rejects (?: . A provider that ignores
 * `pattern` still has the orchestrator's hasForeignScript net.
 */
export const MESSAGE_PATTERN = String.raw`^([ !#-\[\]-~\u00A0-\u024F\u0300-\u036F\u1E00-\u1EFF\u2000-\u206F\u2070-\u20CF\u2100-\u214F\u2190-\u22FF]|\\["\\/nt])*$`

/** JSON schema handed to LM Studio via response_format for structured output. */
export const AGENT_DECISION_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    // Listed FIRST so schema-ordered backends (LM Studio/llama.cpp) generate a few
    // reasoning tokens before committing to type/message — a lightweight CoT.
    reasoning: { type: 'string', description: 'Suy nghĩ ngắn 1-2 câu trước khi quyết định (không hiển thị cho người dùng)' },
    type: { type: 'string', enum: ['reply', 'tool'], description: 'reply hoặc tool' },
    message: {
      type: 'string',
      description: 'Câu trả lời tiếng Việt (reply) hoặc giải thích ngắn (tool)',
      pattern: MESSAGE_PATTERN,
    },
    tool: { type: 'string', description: 'Tên tool khi type=tool' },
    args: { type: 'object', description: 'Tham số của tool khi type=tool' },
  },
  required: ['type'],
}

export const AGENT_DECISION_SCHEMA_NAME = 'agent_decision'
