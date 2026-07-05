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

  /** Handle one chat turn. */
  async handleChat(userId: string, sessionId: string, message: string): Promise<ChatResult> {
    const { sessions, mcp } = this.deps

    // 1) Resolve any pending confirmation via free-text yes/no.
    const pending = sessions.getPending(userId, sessionId)
    if (pending) {
      const intent = detectConfirmation(message)
      if (intent === 'affirm') {
        const text = await this.runConfirmedAction(userId, sessionId, pending)
        sessions.clearPending(userId, sessionId)
        this.remember(userId, sessionId, message, text)
        return { reply: text, pendingAction: null }
      }
      if (intent === 'negate') {
        sessions.clearPending(userId, sessionId)
        const reply = `Đã hủy: ${pending.summary}.`
        this.remember(userId, sessionId, message, reply)
        return { reply, pendingAction: null }
      }
      // Unknown -> treat as a new request; drop the stale pending action.
      sessions.clearPending(userId, sessionId)
    }

    // 2) Normal agent loop.
    return this.runAgentLoop(userId, sessionId, message)
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

  /** Execute a confirmed sensor read and turn the raw result into a Vietnamese answer. */
  private async executeReadPending(userId: string, sessionId: string, pending: PendingAction): Promise<string> {
    const { llm, sessions, profile, tools, fewshot } = this.deps
    const resultText = await this.callReadTool(pending.tool, pending.args)
    const system = buildSystemPrompt({ profile, tools, fewshot })
    const history = sessions.getHistory(userId, sessionId)
    const messages: ChatMessage[] = [
      { role: 'system', content: system },
      ...history,
      {
        role: 'user',
        content: `[Kết quả ${pending.tool}]\n${resultText}\nHãy tóm tắt và trả lời người dùng bằng tiếng Việt, ngắn gọn, so với khoảng tối ưu của dâu nếu phù hợp.`,
      },
    ]
    const text = await llm.complete(messages, { temperature: this.deps.replyTemp })
    return text || 'Mình đã đọc số liệu nhưng chưa tóm tắt được, bạn thử lại giúp mình nhé.'
  }

  private async runAgentLoop(userId: string, sessionId: string, message: string): Promise<ChatResult> {
    const { llm, mcp, store, sessions, profile, tools, fewshot, maxToolSteps, ragTopK, ragMinScore } = this.deps

    const system = buildSystemPrompt({ profile, tools, fewshot })
    const rag = await retrieve(store, llm, message, ragTopK, ragMinScore)
    const history = sessions.getHistory(userId, sessionId)
    const messages: ChatMessage[] = assembleMessages({ system, history, ragContext: rag.contextText, userMessage: message })

    let finalReply: string | undefined
    let pendingView: PendingActionView | null = null

    for (let step = 0; step < maxToolSteps; step++) {
      const decision = await this.decide(messages)
      if (!decision) {
        finalReply = FALLBACK_REPLY
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
          break
        }
        finalReply = decision.message || FALLBACK_REPLY
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
        break
      }

      // User-facing sensor read requested directly: OFFER it (anchor as a pending)
      // instead of running inline, so a follow-up "có" runs it via the confirm path.
      if (confirmsBeforeRead(toolName)) {
        const offer = this.anchorReadOffer(userId, sessionId, toolName, args, decision.message)
        finalReply = offer.reply
        pendingView = offer.view
        break
      }

      // Internal read-only tool: execute automatically and feed the result back.
      const resultText = await this.callReadTool(toolName, args)
      messages.push({ role: 'assistant', content: JSON.stringify({ type: 'tool', tool: toolName, args }) })
      messages.push({
        role: 'user',
        content: `[Kết quả ${toolName}]\n${resultText}\nHãy tiếp tục xử lý hoặc trả lời người dùng.`,
      })
    }

    if (finalReply === undefined) {
      // Ran out of tool steps: force a final text answer.
      const text = await llm.complete(
        [
          ...messages,
          { role: 'user', content: 'Dựa trên dữ liệu ở trên, hãy trả lời người dùng bằng tiếng Việt, ngắn gọn.' },
        ],
        { temperature: this.deps.replyTemp },
      )
      finalReply = text || 'Mình đã xem dữ liệu nhưng chưa thể kết luận, bạn hỏi cụ thể hơn nhé.'
    }

    this.remember(userId, sessionId, message, finalReply)
    return { reply: finalReply, pendingAction: pendingView }
  }

  private async decide(messages: ChatMessage[]): Promise<AgentDecision | null> {
    const opts = { temperature: this.deps.decisionTemp }
    const raw = await this.deps.llm.completeJson(messages, AGENT_DECISION_JSON_SCHEMA, AGENT_DECISION_SCHEMA_NAME, opts)
    const decision = parseDecision(raw)
    if (decision) return decision
    // one retry with a stricter nudge
    const raw2 = await this.deps.llm.completeJson(
      [...messages, { role: 'user', content: 'Chỉ trả về đúng MỘT JSON hợp lệ theo schema, không thêm chữ nào khác.' }],
      AGENT_DECISION_JSON_SCHEMA,
      AGENT_DECISION_SCHEMA_NAME,
      opts,
    )
    return parseDecision(raw2)
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
