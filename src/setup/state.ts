import type { Orchestrator } from '../agent/orchestrator'
import type { LlmConfig } from './llmConfig'

export type SetupPhase = 'waiting_config' | 'connecting' | 'initializing' | 'ready' | 'error'
export type StepStatus = 'pending' | 'running' | 'done' | 'failed'
export type StepId = 'llm' | 'mcp' | 'rag'

export interface InitStep {
  id: StepId
  status: StepStatus
  detail?: string
}

export interface SetupError {
  stage?: string
  code: string
  message: string
}

/** Wire shape returned by GET /api/setup/status. Never contains the API key. */
export interface SetupStatus {
  phase: SetupPhase
  steps: InitStep[]
  error: SetupError | null
  config: { provider: string; baseURL: string; model: string; embedModel: string } | null
}

function freshSteps(): InitStep[] {
  return [
    { id: 'llm', status: 'pending' },
    { id: 'mcp', status: 'pending' },
    { id: 'rag', status: 'pending' },
  ]
}

/**
 * Central runtime state for the setup/init lifecycle. The server starts listening
 * immediately with an empty AppState; the orchestrator is attached once the init
 * pipeline reaches `ready`. Chat routes gate on `orchestrator` (not `phase`), so a
 * runtime re-configure keeps serving the old orchestrator until the new one is ready.
 */
export class AppState {
  orchestrator: Orchestrator | null = null
  /** Set by applyLlmConfig; awaited by startup/tests to know when init settles. */
  initPromise: Promise<void> | null = null

  private _phase: SetupPhase = 'waiting_config'
  private steps: InitStep[] = freshSteps()
  private error: SetupError | null = null
  private currentConfig: LlmConfig | null = null

  get phase(): SetupPhase {
    return this._phase
  }

  isBusy(): boolean {
    return this._phase === 'connecting' || this._phase === 'initializing'
  }

  beginConnecting(): void {
    this.steps = freshSteps()
    this.error = null
    this.setStep('llm', 'running')
    this._phase = 'connecting'
  }

  beginInitializing(cfg: LlmConfig): void {
    this.currentConfig = cfg
    this.setStep('llm', 'done')
    this._phase = 'initializing'
  }

  setStep(id: StepId, status: StepStatus, detail?: string): void {
    const step = this.steps.find((s) => s.id === id)
    if (step) {
      step.status = status
      step.detail = detail
    }
  }

  /** Atomically swap in the newly built orchestrator and mark ready. */
  setReady(orch: Orchestrator): void {
    this.orchestrator = orch
    this._phase = 'ready'
    this.error = null
  }

  /** Probe failed: return to waiting_config but keep the error for the UI. */
  fail(stage: string, code: string, message: string): void {
    this.setStep('llm', 'failed', message)
    this.error = { stage, code, message }
    this._phase = 'waiting_config'
  }

  /** The init pipeline threw unexpectedly (should be rare — MCP/RAG degrade instead). */
  crash(message: string): void {
    this.error = { code: 'init_failed', message }
    this._phase = 'error'
  }

  getStatus(): SetupStatus {
    return {
      phase: this._phase,
      steps: this.steps.map((s) => ({ ...s })),
      error: this.error,
      config: this.currentConfig
        ? {
            provider: this.currentConfig.provider,
            baseURL: this.currentConfig.baseURL,
            model: this.currentConfig.model,
            embedModel: this.currentConfig.embedModel,
          }
        : null,
    }
  }

  /** Test/startup helper: an AppState already in the ready phase with an orchestrator. */
  static ready(orch: Orchestrator): AppState {
    const state = new AppState()
    state.steps = state.steps.map((s) => ({ ...s, status: 'done' as StepStatus }))
    state.setReady(orch)
    return state
  }
}
