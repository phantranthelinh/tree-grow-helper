import { createPendingAction } from '../../agent/confirmation'
import type { ChatResult, PendingActionView } from '../../agent/orchestrator'
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

export const MODEL_ID = 'plant-assistant'

function chunk(delta: Record<string, unknown>, finishReason: string | null, model: string, id: string, created: number) {
  return {
    id,
    object: 'chat.completion.chunk' as const,
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  }
}

/** Build the buffered `chat.completion` response from a finished agent turn. */
export function toCompletion(result: ChatResult, model: string, id: string, created: number) {
  const message: { role: 'assistant'; content: string; tool_calls?: OpenAiToolCall[] } = {
    role: 'assistant',
    content: result.reply,
  }
  if (result.pendingAction) message.tool_calls = encodePending(result.pendingAction)
  return {
    id,
    object: 'chat.completion' as const,
    created,
    model,
    choices: [{ index: 0, message, finish_reason: 'stop' as const }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  }
}

/** `GET /v1/models` payload — one synthetic model representing the whole agent. */
export function modelsList(created: number) {
  return { object: 'list' as const, data: [{ id: MODEL_ID, object: 'model' as const, created, owned_by: 'ai-server' }] }
}

export function roleChunk(model: string, id: string, created: number) {
  return chunk({ role: 'assistant' }, null, model, id, created)
}

export function contentChunk(text: string, model: string, id: string, created: number) {
  return chunk({ content: text }, null, model, id, created)
}

/** Terminal streaming chunk: carries the pending tool_call (if any) and finish_reason. */
export function finalChunk(pending: PendingActionView | null, model: string, id: string, created: number) {
  const delta = pending ? { tool_calls: [{ index: 0, ...encodePending(pending)[0] }] } : {}
  return chunk(delta, 'stop', model, id, created)
}

/** Serialize an object as one OpenAI-style SSE data frame. */
export function sseData(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`
}

export const SSE_DONE = 'data: [DONE]\n\n'
