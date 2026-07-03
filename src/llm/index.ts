import OpenAI from 'openai'

export type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam

export interface CompleteOptions {
  temperature?: number
}

/** Abstraction over the local LLM so the agent can be tested with fakes. */
export interface LlmEngine {
  /** Plain text completion. */
  complete(messages: ChatMessage[], opts?: CompleteOptions): Promise<string>
  /** Structured completion constrained to a JSON schema; returns the raw JSON string. */
  completeJson(
    messages: ChatMessage[],
    jsonSchema: Record<string, unknown>,
    schemaName: string,
    opts?: CompleteOptions,
  ): Promise<string>
  /** Embed one or more texts (for RAG). */
  embed(texts: string[]): Promise<number[][]>
}

export interface EngineOptions {
  baseURL: string
  apiKey: string
  model: string
  embedModel: string
}

/** LlmEngine backed by any OpenAI-compatible server (LM Studio, Ollama, Gemini, …). */
export class OpenAICompatEngine implements LlmEngine {
  private readonly client: OpenAI

  constructor(private readonly opts: EngineOptions) {
    this.client = new OpenAI({ baseURL: opts.baseURL, apiKey: opts.apiKey })
  }

  async complete(messages: ChatMessage[], opts?: CompleteOptions): Promise<string> {
    const res = await this.client.chat.completions.create({
      model: this.opts.model,
      messages,
      temperature: opts?.temperature ?? 0.3,
    })
    return res.choices[0]?.message?.content ?? ''
  }

  async completeJson(
    messages: ChatMessage[],
    jsonSchema: Record<string, unknown>,
    schemaName: string,
    opts?: CompleteOptions,
  ): Promise<string> {
    const res = await this.client.chat.completions.create({
      model: this.opts.model,
      messages,
      temperature: opts?.temperature ?? 0.1,
      response_format: {
        type: 'json_schema',
        json_schema: { name: schemaName, strict: false, schema: jsonSchema },
      },
    })
    return res.choices[0]?.message?.content ?? ''
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return []
    const res = await this.client.embeddings.create({
      model: this.opts.embedModel,
      input: texts,
    })
    return res.data.map((d) => d.embedding as number[])
  }
}
