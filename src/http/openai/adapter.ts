import { createPendingAction } from '../../agent/confirmation'
import type { PendingActionView } from '../../agent/orchestrator'
import type { ChatMessage } from '../../llm'
import type { PendingAction } from '../../memory/sessions'
import { confirmsBeforeRead } from '../../mcp/policy'

export interface OpenAiToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export interface OpenAiMessage {
  role: string
  content?: string | Array<{ type: string; text?: string }> | null
  tool_calls?: OpenAiToolCall[]
}

/** Signals a client mistake the route maps to HTTP 400 with the OpenAI error shape. */
export class BadRequestError extends Error {}

/** Flatten OpenAI message content (string or content-parts array) to plain text. */
export function extractText(content: OpenAiMessage['content']): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter((p) => p.type === 'text' && typeof p.text === 'string')
      .map((p) => p.text as string)
      .join('')
  }
  return ''
}

export interface ParsedThread {
  history: ChatMessage[]
  lastUserMessage: string
  priorAssistant: OpenAiMessage | null
}

/**
 * Translate an OpenAI messages[] into the agent's view: prior user/assistant
 * turns become history (system dropped — the agent's own system prompt wins;
 * tool_calls stripped to content-only), the trailing user turn is the input,
 * and the assistant turn right before it is exposed for pending recovery.
 * Throws BadRequestError when empty or not terminated by a user message.
 */
export function parseMessages(messages: OpenAiMessage[]): ParsedThread {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new BadRequestError('messages must be a non-empty array')
  }
  const last = messages[messages.length - 1]
  if (last.role !== 'user') {
    throw new BadRequestError('the last message must have role "user"')
  }
  const prev = messages[messages.length - 2]
  const priorAssistant = prev && prev.role === 'assistant' ? prev : null
  const history: ChatMessage[] = messages
    .slice(0, -1)
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({ role: m.role as 'user' | 'assistant', content: extractText(m.content) }))
  return { history, lastUserMessage: extractText(last.content), priorAssistant }
}

/**
 * Rebuild a pending action from an echoed assistant tool_call. Lossless: only
 * (tool, args) need to survive — `summary` is recomputed and `kind` is derived
 * (confirm-before-read sensor tools → 'read', everything else → 'control').
 */
export function recoverPending(priorAssistant: OpenAiMessage | null): PendingAction | null {
  const call = priorAssistant?.tool_calls?.[0]
  if (!call?.function?.name) return null
  let args: Record<string, unknown>
  try {
    args = call.function.arguments ? JSON.parse(call.function.arguments) : {}
  } catch {
    return null
  }
  const kind = confirmsBeforeRead(call.function.name) ? 'read' : 'control'
  return createPendingAction(call.function.name, args, kind)
}

/** Encode a pending action as an OpenAI tool_call so it round-trips in the thread. */
export function encodePending(p: PendingActionView): OpenAiToolCall[] {
  return [{ id: p.id, type: 'function', function: { name: p.tool, arguments: JSON.stringify(p.args) } }]
}
