import type OpenAI from 'openai'
import type { McpTool } from './client'
import { classifyTool, type ToolSafety } from './policy'

export type OpenAiTool = OpenAI.Chat.Completions.ChatCompletionTool

/** Map MCP tools to OpenAI-style function tools for the chat completions API. */
export function toOpenAiTools(mcpTools: McpTool[]): OpenAiTool[] {
  return mcpTools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description ?? '',
      parameters: (t.inputSchema ?? { type: 'object', properties: {} }) as Record<string, unknown>,
    },
  }))
}

export interface ToolInfo {
  name: string
  description: string
  safety: ToolSafety
}

/** Human/LLM-readable catalog with safety classification. */
export function describeTools(mcpTools: McpTool[]): ToolInfo[] {
  return mcpTools.map((t) => ({
    name: t.name,
    description: t.description ?? '',
    safety: classifyTool(t.name),
  }))
}
