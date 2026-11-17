import OpenAI from 'openai'

export type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam

export interface CompleteOptions {
  temperature?: number
  /** Upper bound on generated tokens; unset (or 0) leaves the provider's default. */
  maxTokens?: number
}

export interface StreamOptions extends CompleteOptions {
  /** Abort the underlying HTTP request (e.g. client disconnected). */
  signal?: AbortSignal
}

/** One generated token with its log-probability and the most likely tokens at that position. */
export interface TokenLogprob {
  token: string
  logprob: number
  top: Array<{ token: string; logprob: number }>
}

export interface JsonCompleteOptions extends CompleteOptions {
  /**
   * Asks the provider for per-token log-probabilities and hands them over. Only measurement code (the eval) sets
   * it, so chat requests are unchanged.
   */
  onLogprobs?: (tokens: TokenLogprob[]) => void
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
    opts?: JsonCompleteOptions,
  ): Promise<string>
  /** Streaming twin of complete(): yields raw content deltas as generated. */
  completeStream(messages: ChatMessage[], opts?: StreamOptions): AsyncGenerator<string, void, unknown>
  /** Streaming twin of completeJson(): yields raw JSON-text deltas; caller reassembles. */
  completeJsonStream(
    messages: ChatMessage[],
    jsonSchema: Record<string, unknown>,
    schemaName: string,
    opts?: StreamOptions,
  ): AsyncGenerator<string, void, unknown>
  /** Embed one or more texts (for RAG). */
  embed(texts: string[]): Promise<number[][]>
}

export interface EngineOptions {
  baseURL: string
  apiKey: string
  model: string
  embedModel: string
}

const TOP_LOGPROBS = 5

const capOf = (opts?: CompleteOptions): { max_tokens?: number } =>
  opts?.maxTokens && opts.maxTokens > 0 ? { max_tokens: opts.maxTokens } : {}

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
      ...capOf(opts),
    })
    return res.choices[0]?.message?.content ?? ''
  }

  async completeJson(
    messages: ChatMessage[],
    jsonSchema: Record<string, unknown>,
    schemaName: string,
    opts?: JsonCompleteOptions,
  ): Promise<string> {
    const res = await this.client.chat.completions.create({
      model: this.opts.model,
      messages,
      temperature: opts?.temperature ?? 0.1,
      ...capOf(opts),
      ...(opts?.onLogprobs ? { logprobs: true, top_logprobs: TOP_LOGPROBS } : {}),
      response_format: {
        type: 'json_schema',
        json_schema: { name: schemaName, strict: false, schema: jsonSchema },
      },
    })
    const choice = res.choices[0]
    opts?.onLogprobs?.(
      (choice?.logprobs?.content ?? []).map((t) => ({
        token: t.token,
        logprob: t.logprob,
        top: (t.top_logprobs ?? []).map((a) => ({ token: a.token, logprob: a.logprob })),
      })),
    )
    return choice?.message?.content ?? ''
  }

  async *completeStream(messages: ChatMessage[], opts?: StreamOptions): AsyncGenerator<string, void, unknown> {
    const stream = await this.client.chat.completions.create(
      {
        model: this.opts.model,
        messages,
        temperature: opts?.temperature ?? 0.3,
        ...capOf(opts),
        stream: true,
      },
      { signal: opts?.signal },
    )
    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content
      if (delta) yield delta
    }
  }

  async *completeJsonStream(
    messages: ChatMessage[],
    jsonSchema: Record<string, unknown>,
    schemaName: string,
    opts?: StreamOptions,
  ): AsyncGenerator<string, void, unknown> {
    const stream = await this.client.chat.completions.create(
      {
        model: this.opts.model,
        messages,
        temperature: opts?.temperature ?? 0.1,
        ...capOf(opts),
        response_format: {
          type: 'json_schema',
          json_schema: { name: schemaName, strict: false, schema: jsonSchema },
        },
        stream: true,
      },
      { signal: opts?.signal },
    )
    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content
      if (delta) yield delta
    }
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return []
    // Without an explicit format the SDK requests base64 and decodes it as float32;
    // LM Studio ignores that and sends float arrays, which decode to zero vectors.
    const res = await this.client.embeddings.create({
      model: this.opts.embedModel,
      input: texts,
      encoding_format: 'float',
    })
    const vectors = [...res.data].sort((a, b) => a.index - b.index).map((d) => d.embedding as number[])
    if (vectors.some((v) => v.length === 0 || v.every((x) => x === 0))) {
      throw new Error(`embed model "${this.opts.embedModel}" trả về vector rỗng hoặc toàn số 0`)
    }
    return vectors
  }
}
