import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Tool as McpTool } from '@modelcontextprotocol/sdk/types.js'

export type { McpTool }

export interface McpToolResult {
  /** Text content joined from the tool's content blocks (fed back to the LLM). */
  text: string
  /** Optional machine-readable structured content. */
  structured?: unknown
  isError: boolean
}

/**
 * Minimal gateway the agent depends on. Implemented by PlantMcpClient in
 * production and by fakes in tests.
 */
export interface McpGateway {
  listTools(): Promise<McpTool[]>
  callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult>
}

interface TextBlock {
  type: string
  text?: string
}

/** MCP client for the plant-tree MCP over Streamable HTTP. */
export class PlantMcpClient implements McpGateway {
  private readonly client: Client
  private connected = false

  constructor(private readonly url: string) {
    this.client = new Client({ name: 'ai-server', version: '0.1.0' })
  }

  async connect(): Promise<void> {
    if (this.connected) return
    const transport = new StreamableHTTPClientTransport(new URL(this.url))
    await this.client.connect(transport)
    this.connected = true
  }

  async listTools(): Promise<McpTool[]> {
    await this.connect()
    const res = await this.client.listTools()
    return res.tools
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
    await this.connect()
    const res = await this.client.callTool({ name, arguments: args })
    const content = (res.content ?? []) as TextBlock[]
    const text = content
      .filter((c) => c.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text as string)
      .join('\n')
    return {
      text,
      structured: (res as { structuredContent?: unknown }).structuredContent,
      isError: Boolean((res as { isError?: boolean }).isError),
    }
  }

  async close(): Promise<void> {
    if (!this.connected) return
    await this.client.close()
    this.connected = false
  }
}
