import type { TokenLogprob } from '../llm'

/**
 * Δ = log p("reply") − log p("tool") at the token that sets the decision's type. The grammar emits `type` first,
 * so this single token is the routing choice; |Δ| < 1 marks a case whose verdict can flip between runs or prefix
 * cache states, which a pass/fail count hides. A choice missing from the returned alternatives is given the lowest
 * listed log-probability, so Δ is then a lower bound on the true margin. Null when no type token is found or the
 * provider returned no alternatives.
 */
export function typeMargin(tokens: readonly TokenLogprob[]): number | null {
  let text = ''
  for (const t of tokens) {
    if (/"type"\s*:\s*"$/.test(text)) {
      if (t.top.length === 0) return null
      const lp = (choice: string) => t.top.find((a) => a.token === choice)?.logprob
      const floor = Math.min(...t.top.map((a) => a.logprob))
      return (lp('reply') ?? floor) - (lp('tool') ?? floor)
    }
    text += t.token
  }
  return null
}

/** |Δ| below this is a near-tie: the round-3 probes saw the same request move Δ by up to 1.3 across cache states. */
export const NEAR_TIE = 1
