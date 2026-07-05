import type { PlantProfile } from '../domain/profiles'
import type { ChatMessage, LlmEngine } from '../llm'
import { assembleMessages, buildSystemPrompt } from '../llm/prompt'
import { sanitizeArgs } from '../mcp/args'
import type { McpGateway, McpTool } from '../mcp/client'
import { classifyTool, confirmsBeforeRead } from '../mcp/policy'
import type { PendingAction, SessionStore } from '../memory/sessions'
import type { InMemoryVectorStore } from '../rag/store'
import { retrieve } from '../rag/retrieve'
import {
  AGENT_DECISION_JSON_SCHEMA,
  AGENT_DECISION_SCHEMA_NAME,
  AgentDecisionSchema,
  type AgentDecision,
} from './decision'
import { createPendingAction, detectConfirmation, executeAction } from './confirmation'
import { JsonStringFieldStreamer } from './streamParser'

export interface PendingActionView {
  id: string
  summary: string
  tool: string
  args: Record<string, unknown>
}

export interface ChatResult {
  reply: string
  pendingAction: PendingActionView | null
}

/** One chat turn as an incremental event stream (SSE-friendly). */
export type ChatStreamEvent =
  | { type: 'token'; text: string }
  | { type: 'tool_status'; tool: string; note: string }
  | { type: 'reset' }
  | { type: 'done'; reply: string; pendingAction: PendingActionView | null }

/** What a decision turn produced: the parsed decision plus the text already sent to the client. */
interface DecisionOutcome {
  decision: AgentDecision | null
  emittedText: string
}

export interface OrchestratorDeps {
  llm: LlmEngine
  mcp: McpGateway
  store: InMemoryVectorStore
  sessions: SessionStore
  profile: PlantProfile
  tools: McpTool[]
  fewshot?: string
  maxToolSteps: number
  ragTopK: number
  /** Drop retrieved chunks below this cosine score. Defaults to 0 (off) when unset. */
  ragMinScore?: number
  /** Temperature for the JSON decision call. Defaults to 0.1 when unset. */
  decisionTemp?: number
  /** Temperature for the free-text fallback answer. Defaults to 0.3 when unset. */
  replyTemp?: number
}

const FALLBACK_REPLY = 'Xin lỗi, mình chưa xử lý được yêu cầu. Bạn nói rõ hơn giúp mình nhé.'
const READ_SUMMARY_FALLBACK = 'Mình đã đọc số liệu nhưng chưa tóm tắt được, bạn thử lại giúp mình nhé.'
const EXHAUSTED_FALLBACK = 'Mình đã xem dữ liệu nhưng chưa thể kết luận, bạn hỏi cụ thể hơn nhé.'
const RETRY_NUDGE = 'Chỉ trả về đúng MỘT JSON hợp lệ theo schema, không thêm chữ nào khác.'

/**
 * Emit whatever part of the final reply the live stream didn't already cover.
 * The streamed text is normally a strict prefix of the reply (or empty in
 * buffered mode); anything else means the stream diverged, so tell the client
 * to start over with the authoritative text.
 */
function* emitRemainder(target: string, emitted: string): Generator<ChatStreamEvent> {
  if (emitted === target) return
  if (emitted && target.startsWith(emitted)) {
    yield { type: 'token', text: target.slice(emitted.length) }
    return
  }
  if (emitted) yield { type: 'reset' }
  yield { type: 'token', text: target }
}

function extractJson(raw: string): string {
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  return start >= 0 && end > start ? raw.slice(start, end + 1) : raw
}

function parseDecision(raw: string): AgentDecision | null {
  try {
    const parsed = AgentDecisionSchema.safeParse(JSON.parse(extractJson(raw)))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

function toView(p: PendingAction): PendingActionView {
  return { id: p.id, summary: p.summary, tool: p.tool, args: p.args }
}

export class Orchestrator {
  constructor(private readonly deps: OrchestratorDeps) {}

  /** Handle one chat turn (buffered: the full reply arrives at once). */
  async handleChat(userId: string, sessionId: string, message: string): Promise<ChatResult> {
    let result: ChatResult = { reply: FALLBACK_REPLY, pendingAction: null }
    for await (const event of this.chatEvents(userId, sessionId, message, 'buffered')) {
      if (event.type === 'done') result = { reply: event.reply, pendingAction: event.pendingAction }
    }
    return result
  }

  /** Handle one chat turn as an event stream (tokens as the LLM generates them). */
  handleChatStream(
    userId: string,
    sessionId: string,
    message: string,
    opts?: { signal?: AbortSignal },
  ): AsyncGenerator<ChatStreamEvent, void, unknown> {
    return this.chatEvents(userId, sessionId, message, 'stream', opts?.signal)
  }

  /** Confirm/cancel a pending action via the explicit endpoint. */
  async confirm(userId: string, sessionId: string, actionId: string, approved: boolean): Promise<ChatResult> {
    const { sessions, mcp } = this.deps
    const pending = sessions.getPending(userId, sessionId)
    if (!pending || pending.id !== actionId) {
      return { reply: 'Không tìm thấy hành động đang chờ xác nhận.', pendingAction: null }
    }
    sessions.clearPending(userId, sessionId)
    if (!approved) {
      const reply = `Đã hủy: ${pending.summary}.`
      this.remember(userId, sessionId, `[huỷ] ${pending.summary}`, reply)
      return { reply, pendingAction: null }
    }
    const text = await this.runConfirmedAction(userId, sessionId, pending)
    this.remember(userId, sessionId, `[xác nhận] ${pending.summary}`, text)
    return { reply: text, pendingAction: null }
  }

  /**
   * Run a confirmed pending action and return the Vietnamese reply. A control
   * action executes the device command; a user-facing read runs the sensor tool
   * then summarizes the result through one LLM turn.
   */
  private async runConfirmedAction(userId: string, sessionId: string, pending: PendingAction): Promise<string> {
    if (pending.kind === 'read') {
      return this.executeReadPending(userId, sessionId, pending)
    }
    const exec = await executeAction(this.deps.mcp, pending)
    return exec.text
  }

  /** Anchor a user-facing sensor read as a pending offer and build the (Có/Không) prompt. */
  private anchorReadOffer(
    userId: string,
    sessionId: string,
    tool: string,
    args: Record<string, unknown>,
    message?: string,
  ): { reply: string; view: PendingActionView } {
    const pending = createPendingAction(tool, args, 'read')
    this.deps.sessions.setPending(userId, sessionId, pending)
    const lead = message ? `${message}\n\n` : ''
    return { reply: `${lead}Bạn có muốn mình ${pending.summary} không? (Có/Không)`, view: toView(pending) }
  }

  /** Prompt for turning a raw sensor result into a Vietnamese answer (shared by both read paths). */
  private buildReadSummaryMessages(
    userId: string,
    sessionId: string,
    pending: PendingAction,
    resultText: string,
  ): ChatMessage[] {
    const { sessions, profile, tools, fewshot } = this.deps
    const system = buildSystemPrompt({ profile, tools, fewshot })
    const history = sessions.getHistory(userId, sessionId)
    return [
      { role: 'system', content: system },
      ...history,
      {
        role: 'user',
        content: `[Kết quả ${pending.tool}]\n${resultText}\nHãy tóm tắt và trả lời người dùng bằng tiếng Việt, ngắn gọn, so với khoảng tối ưu của dâu nếu phù hợp.`,
      },
    ]
  }

  /** Execute a confirmed sensor read and turn the raw result into a Vietnamese answer. */
  private async executeReadPending(userId: string, sessionId: string, pending: PendingAction): Promise<string> {
    const resultText = await this.callReadTool(pending.tool, pending.args)
    const messages = this.buildReadSummaryMessages(userId, sessionId, pending, resultText)
    const text = await this.deps.llm.complete(messages, { temperature: this.deps.replyTemp })
    return text || READ_SUMMARY_FALLBACK
  }

  /** Streaming twin of executeReadPending: yields summary tokens, returns the final text. */
  private async *executeReadPendingEvents(
    userId: string,
    sessionId: string,
    pending: PendingAction,
    signal?: AbortSignal,
  ): AsyncGenerator<ChatStreamEvent, string, unknown> {
    const resultText = await this.callReadTool(pending.tool, pending.args)
    const messages = this.buildReadSummaryMessages(userId, sessionId, pending, resultText)
    let text = ''
    for await (const delta of this.deps.llm.completeStream(messages, { temperature: this.deps.replyTemp, signal })) {
      text += delta
      yield { type: 'token', text: delta }
    }
    if (!text) {
      text = READ_SUMMARY_FALLBACK
      yield { type: 'token', text }
    }
    return text
  }

  /**
   * One chat turn as an event stream — the single core behind both public
   * paths. Buffered mode keeps the original non-streaming LLM calls so
   * POST /chat behavior is unchanged at the provider level; only 'stream'
   * mode uses the streaming LLM methods. The last event on the success path
   * is always `done`; errors propagate to the caller (no error events, and
   * a failed/aborted turn is not remembered).
   */
  private async *chatEvents(
    userId: string,
    sessionId: string,
    message: string,
    mode: 'buffered' | 'stream',
    signal?: AbortSignal,
  ): AsyncGenerator<ChatStreamEvent, void, unknown> {
    const { llm, store, sessions, profile, tools, fewshot, maxToolSteps, ragTopK, ragMinScore } = this.deps

    // 1) Resolve any pending confirmation via free-text yes/no.
    const pending = sessions.getPending(userId, sessionId)
    if (pending) {
      const intent = detectConfirmation(message)
      if (intent === 'affirm') {
        let text: string
        if (mode === 'stream' && pending.kind === 'read') {
          yield { type: 'tool_status', tool: pending.tool, note: `Đang đọc cảm biến (${pending.tool})…` }
          text = yield* this.executeReadPendingEvents(userId, sessionId, pending, signal)
        } else {
          text = await this.runConfirmedAction(userId, sessionId, pending)
          yield { type: 'token', text }
        }
        sessions.clearPending(userId, sessionId)
        this.remember(userId, sessionId, message, text)
        yield { type: 'done', reply: text, pendingAction: null }
        return
      }
      if (intent === 'negate') {
        sessions.clearPending(userId, sessionId)
        const reply = `Đã hủy: ${pending.summary}.`
        this.remember(userId, sessionId, message, reply)
        yield { type: 'token', text: reply }
        yield { type: 'done', reply, pendingAction: null }
        return
      }
      // Unknown -> treat as a new request; drop the stale pending action.
      sessions.clearPending(userId, sessionId)
    }

    // 2) Normal agent loop.
    const system = buildSystemPrompt({ profile, tools, fewshot })
    const rag = await retrieve(store, llm, message, ragTopK, ragMinScore)
    const history = sessions.getHistory(userId, sessionId)
    const messages: ChatMessage[] = assembleMessages({ system, history, ragContext: rag.contextText, userMessage: message })

    let finalReply: string | undefined
    let pendingView: PendingActionView | null = null

    for (let step = 0; step < maxToolSteps; step++) {
      const { decision, emittedText } =
        mode === 'stream'
          ? yield* this.decideStreaming(messages, signal)
          : { decision: await this.decide(messages), emittedText: '' }
      if (!decision) {
        finalReply = FALLBACK_REPLY
        yield* emitRemainder(finalReply, emittedText)
        break
      }

      if (decision.type === 'reply' || !decision.tool) {
        // A reply may still carry a confirm-before-read tool as an OFFER to anchor
        // (symptom question → advice + an offer to check sensors), so a follow-up
        // "có" runs it deterministically. Only sensor reads are anchored this way —
        // a control tool named on a reply is ignored (never executed from a reply).
        if (decision.tool && confirmsBeforeRead(decision.tool)) {
          const args = this.sanitizeToolArgs(decision.tool, decision.args ?? {})
          const offer = this.anchorReadOffer(userId, sessionId, decision.tool, args, decision.message)
          finalReply = offer.reply
          pendingView = offer.view
          // The streamed message is a prefix of the offer reply; only the
          // "(Có/Không)" suffix still needs to go out.
          yield* emitRemainder(finalReply, emittedText)
          break
        }
        finalReply = decision.message || FALLBACK_REPLY
        yield* emitRemainder(finalReply, emittedText)
        break
      }

      const toolName = decision.tool
      const args = this.sanitizeToolArgs(toolName, decision.args ?? {})

      if (classifyTool(toolName) === 'control') {
        const pending = createPendingAction(toolName, args, 'control')
        sessions.setPending(userId, sessionId, pending)
        const lead = decision.message ? `${decision.message}\n\n` : ''
        finalReply = `${lead}Bạn xác nhận thực hiện: "${pending.summary}"? (Có/Không)`
        pendingView = toView(pending)
        yield { type: 'token', text: finalReply }
        break
      }

      // User-facing sensor read requested directly: OFFER it (anchor as a pending)
      // instead of running inline, so a follow-up "có" runs it via the confirm path.
      if (confirmsBeforeRead(toolName)) {
        const offer = this.anchorReadOffer(userId, sessionId, toolName, args, decision.message)
        finalReply = offer.reply
        pendingView = offer.view
        yield { type: 'token', text: finalReply }
        break
      }

      // Internal read-only tool: execute automatically and feed the result back.
      yield { type: 'tool_status', tool: toolName, note: `Đang đọc dữ liệu (${toolName})…` }
      const resultText = await this.callReadTool(toolName, args)
      messages.push({ role: 'assistant', content: JSON.stringify({ type: 'tool', tool: toolName, args }) })
      messages.push({
        role: 'user',
        content: `[Kết quả ${toolName}]\n${resultText}\nHãy tiếp tục xử lý hoặc trả lời người dùng.`,
      })
    }

    if (finalReply === undefined) {
      // Ran out of tool steps: force a final text answer. Nothing has been
      // emitted yet — live tokens only flow on reply decisions, and those
      // break the loop — so this streams onto a blank client turn.
      const promptMessages: ChatMessage[] = [
        ...messages,
        { role: 'user', content: 'Dựa trên dữ liệu ở trên, hãy trả lời người dùng bằng tiếng Việt, ngắn gọn.' },
      ]
      if (mode === 'stream') {
        let text = ''
        for await (const delta of llm.completeStream(promptMessages, { temperature: this.deps.replyTemp, signal })) {
          text += delta
          yield { type: 'token', text: delta }
        }
        finalReply = text || EXHAUSTED_FALLBACK
        if (!text) yield { type: 'token', text: finalReply }
      } else {
        const text = await llm.complete(promptMessages, { temperature: this.deps.replyTemp })
        finalReply = text || EXHAUSTED_FALLBACK
        yield { type: 'token', text: finalReply }
      }
    }

    this.remember(userId, sessionId, message, finalReply)
    yield { type: 'done', reply: finalReply, pendingAction: pendingView }
  }

  private async decide(messages: ChatMessage[]): Promise<AgentDecision | null> {
    const opts = { temperature: this.deps.decisionTemp }
    const raw = await this.deps.llm.completeJson(messages, AGENT_DECISION_JSON_SCHEMA, AGENT_DECISION_SCHEMA_NAME, opts)
    const decision = parseDecision(raw)
    if (decision) return decision
    // one retry with a stricter nudge
    const raw2 = await this.deps.llm.completeJson(
      [...messages, { role: 'user', content: RETRY_NUDGE }],
      AGENT_DECISION_JSON_SCHEMA,
      AGENT_DECISION_SCHEMA_NAME,
      opts,
    )
    return parseDecision(raw2)
  }

  /**
   * Streaming twin of decide(): same two attempts and nudge, but tokens of the
   * decision's message field go out live. A failed attempt that already
   * emitted text is undone with a `reset` before the next attempt (or the
   * fallback) speaks.
   */
  private async *decideStreaming(
    messages: ChatMessage[],
    signal?: AbortSignal,
  ): AsyncGenerator<ChatStreamEvent, DecisionOutcome, unknown> {
    const first = yield* this.streamDecisionAttempt(messages, signal)
    if (first.decision) return first
    if (first.emittedText) yield { type: 'reset' }
    const second = yield* this.streamDecisionAttempt([...messages, { role: 'user', content: RETRY_NUDGE }], signal)
    if (second.decision) return second
    if (second.emittedText) yield { type: 'reset' }
    return { decision: null, emittedText: '' }
  }

  /**
   * One streamed decision attempt. Message text is held back until the
   * scanner reports the decision's `type`: a reply streams live, anything
   * else stays off the wire (the parsed decision still carries it). If the
   * scanner never sees `type` (e.g. the provider buffers the whole JSON into
   * one delta), nothing is emitted here and emitRemainder sends the full
   * reply afterwards.
   */
  private async *streamDecisionAttempt(
    messages: ChatMessage[],
    signal?: AbortSignal,
  ): AsyncGenerator<ChatStreamEvent, DecisionOutcome, unknown> {
    const scanner = new JsonStringFieldStreamer()
    let emittedText = ''
    let held = ''
    let gate: 'pending' | 'open' | 'closed' = 'pending'
    const stream = this.deps.llm.completeJsonStream(messages, AGENT_DECISION_JSON_SCHEMA, AGENT_DECISION_SCHEMA_NAME, {
      temperature: this.deps.decisionTemp,
      signal,
    })
    for await (const delta of stream) {
      for (const event of scanner.push(delta)) {
        if (event.kind === 'message') {
          if (gate === 'open') {
            emittedText += event.text
            yield { type: 'token', text: event.text }
          } else if (gate === 'pending') {
            held += event.text
          }
        } else if (event.kind === 'field' && event.key === 'type' && gate === 'pending') {
          if (event.value === 'reply') {
            gate = 'open'
            if (held) {
              emittedText += held
              yield { type: 'token', text: held }
              held = ''
            }
          } else {
            gate = 'closed'
            held = ''
          }
        }
      }
    }
    return { decision: parseDecision(scanner.raw()), emittedText }
  }

  /** Drop model-hallucinated args not declared by the tool's schema before it reaches the MCP. */
  private sanitizeToolArgs(toolName: string, args: Record<string, unknown>): Record<string, unknown> {
    return sanitizeArgs(
      this.deps.tools.find((t) => t.name === toolName),
      args,
    )
  }

  private async callReadTool(toolName: string, args: Record<string, unknown>): Promise<string> {
    try {
      const res = await this.deps.mcp.callTool(toolName, args)
      if (res.isError) return `Lỗi: ${res.text || 'thiết bị báo lỗi'}`
      return res.text || '(không có dữ liệu)'
    } catch (err) {
      return `Lỗi khi gọi ${toolName}: ${(err as Error).message}`
    }
  }

  private remember(userId: string, sessionId: string, userMessage: string, assistantReply: string): void {
    this.deps.sessions.append(
      userId,
      sessionId,
      { role: 'user', content: userMessage },
      { role: 'assistant', content: assistantReply },
    )
  }
}
