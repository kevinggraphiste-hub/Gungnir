/**
 * Gungnir — détection des modèles agentiques.
 *
 * Un modèle est dit "agentique" quand il supporte de manière fiable le
 * function calling / tool use natif. Ça importe parce que Gungnir est
 * conçu autour des outils (bash, code_*, web_fetch, scheduler…) — un
 * modèle qui ne sait pas appeler les outils nativement va répondre en
 * texte là où on attend un tool call, et l'utilisateur a l'impression
 * que "ça ne marche pas" alors que c'est juste un mauvais choix de
 * modèle.
 *
 * La taxonomie ici est basée sur l'observation production + les benchs
 * publics (BFCL, ToolBench). Critères :
 *  - Modèle annoncé "function calling" par son provider ✓
 *  - Score BFCL > 75 % sur tools simples
 *  - Famille connue pour bien tenir sur les boucles multi-tool
 *
 * Les "petits modèles" (≤ 3B params, hors Phi-3.5 mini-instruct qui
 * gère décemment) sont marqués non-agentiques par défaut — ils peuvent
 * répondre correctement en chat mais ratent souvent l'appel d'outil.
 */

const AGENTIC_PATTERNS: RegExp[] = [
  // Anthropic — toutes les Sonnet/Opus depuis 3.5 sont solides en tool use
  /\bclaude-(3-5|3-7|opus-4|sonnet-4|haiku-4)\b/i,
  /\bclaude-(opus|sonnet|haiku)-4/i,
  // OpenAI — GPT-4, GPT-4o, o-series
  /\bgpt-4(\.[0-9]+)?(-?(o|mini|nano|turbo))?\b/i,
  /\bo[134](-mini|-pro)?\b/i,
  // Google — Gemini 1.5/2.x Pro/Flash (sauf Flash-8B trop léger)
  /\bgemini-(1\.5|2(\.[0-9]+)?)-(pro|flash)(?!-8b)/i,
  // Mistral — Large, Medium, Small récents (codestral aussi)
  /\bmistral-(large|medium|small)-/i,
  /\bcodestral-/i,
  // Llama 3.1/3.3 70B+ et 405B (les <70B function-call de manière inégale)
  /\bllama-3\.[13]-(70b|405b)/i,
  /\bmeta-llama\/Meta-Llama-3\.[13]-(70B|405B)/i,
  // Qwen 2.5 32B+
  /\bqwen-?2\.5-(32b|72b)/i,
  /\bQwen2\.5-(32B|72B)/,
  // Qwen 3 (toutes tailles annoncées agentic)
  /\bqwen-?3-/i,
  /\bQwen3-/,
  // DeepSeek — V3 et R1 ont du tool use
  /\bdeepseek-(v3|r1|chat)/i,
  // xAI Grok 3+
  /\bgrok-[34]/i,
  // MiniMax M1/M2.x
  /\bminimax-m[12](\.[0-9]+)?/i,
  /\bMiniMax-M[12](\.[0-9]+)?/,
]

const NON_AGENTIC_PATTERNS: RegExp[] = [
  // Petits Llama 3.2 (1B, 3B) — chat uniquement
  /\bllama-3\.2-(1b|3b)/i,
  /\bMeta-Llama-3\.2-(1B|3B)/,
  // Gemma small / Gemini Flash 8B
  /\bgemma-2-2b/i,
  /\bgemini-.*-8b/i,
  // Phi-3 mini (chat OK mais tool use bancal)
  /\bphi-3(\.5)?-mini/i,
  // abab MiniMax legacy (pré-M1) — chat seulement
  /\babab[0-9.]+-/i,
  // Llama 3.2 vision (multimodal mais pas tool-calling)
  /\bllama-3\.2-(11b|90b)-vision/i,
]

export type AgenticTier = 'agentic' | 'chat-only' | 'unknown'

export function classifyModel(model: string): AgenticTier {
  if (!model) return 'unknown'
  const m = model.trim()
  // Order: explicit non-agentic > agentic > unknown. Un nom qui
  // matche les deux (rare) tombe en non-agentic par sécurité — on
  // préfère sous-promettre qu'induire l'utilisateur en erreur.
  if (NON_AGENTIC_PATTERNS.some(re => re.test(m))) return 'chat-only'
  if (AGENTIC_PATTERNS.some(re => re.test(m))) return 'agentic'
  return 'unknown'
}

export function isAgentic(model: string): boolean {
  return classifyModel(model) === 'agentic'
}
