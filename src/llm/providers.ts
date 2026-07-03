/**
 * Provider presets for the setup UI. All three providers expose an
 * OpenAI-compatible API (chat + embeddings + /models + response_format json_schema),
 * so a single OpenAI-SDK engine serves all of them — the provider only carries
 * the default base URL, whether an API key is required, and display metadata.
 */

export type ProviderId = 'lmstudio' | 'ollama' | 'gemini' | 'openai-compat'

export interface ProviderPreset {
  id: ProviderId
  /** Vietnamese display name shown on the setup card. */
  label: string
  defaultBaseURL: string
  /** true → the UI marks API key required and probing without one is expected to fail. */
  requiresApiKey: boolean
  /** Dummy key substituted when the provider needs none (OpenAI SDK rejects an empty key). */
  defaultApiKey?: string
  /** Vietnamese hint shown under the card. */
  note?: string
}

export const PROVIDERS: Record<ProviderId, ProviderPreset> = {
  lmstudio: {
    id: 'lmstudio',
    label: 'LM Studio',
    defaultBaseURL: 'http://localhost:1234/v1',
    requiresApiKey: false,
    defaultApiKey: 'lm-studio',
    note: 'Chạy model cục bộ qua LM Studio. Không cần API key.',
  },
  ollama: {
    id: 'ollama',
    label: 'Ollama',
    defaultBaseURL: 'http://localhost:11434/v1',
    requiresApiKey: false,
    defaultApiKey: 'ollama',
    note: 'Chạy model cục bộ qua Ollama (cần bản ≥ 0.5). Không cần API key.',
  },
  gemini: {
    id: 'gemini',
    label: 'Google Gemini',
    defaultBaseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    requiresApiKey: true,
    note: 'Dùng lớp tương thích OpenAI của Gemini. Bắt buộc có API key. Model embedding gợi ý: text-embedding-004.',
  },
  'openai-compat': {
    id: 'openai-compat',
    label: 'OpenAI-compatible khác',
    defaultBaseURL: '',
    requiresApiKey: false,
    defaultApiKey: 'no-key',
    note: 'Bất kỳ server nào theo chuẩn OpenAI (vLLM, LiteLLM, OpenAI…). Nhập Base URL và API key nếu có.',
  },
}

/**
 * Resolve the API key actually sent to the OpenAI SDK. Providers that need no key
 * get a non-empty dummy so the SDK doesn't throw; a user-supplied key always wins.
 */
export function resolveApiKey(provider: ProviderId, apiKey?: string): string {
  const trimmed = apiKey?.trim()
  if (trimmed) return trimmed
  const preset = PROVIDERS[provider]
  return preset.defaultApiKey ?? 'no-key'
}
