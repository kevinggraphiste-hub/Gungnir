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
  // Anthropic — toutes les Sonnet/Opus/Haiku depuis 3.5 sont solides en tool use
  /\bclaude-(3-5|3-7|opus-4|sonnet-4|haiku-4)\b/i,
  /\bclaude-(opus|sonnet|haiku)-[45]/i,
  // OpenAI — GPT-4, GPT-4.x, GPT-5, GPT-4o, o-series
  /\bgpt-[45](\.[0-9]+)?(-?(o|mini|nano|turbo))?\b/i,
  /\bo[1-9](-mini|-pro)?\b/i,
  // Google — Gemini 1.5/2.x/3.x Pro/Flash (sauf Flash-8B trop léger)
  /\bgemini-([12]\.[0-9]+|[3-9](\.[0-9]+)?)-(pro|flash)(?!-8b)/i,
  // Mistral — Large, Medium, Small récents + Pixtral, Codestral
  /\bmistral-(large|medium|small|pixtral)-/i,
  /\bcodestral-/i,
  /\bpixtral-/i,
  // Llama 3.1/3.3 70B+ et 405B (les <70B function-call inégalement)
  /\bllama-3\.[13]-(70b|405b)/i,
  /\bmeta-llama\/Meta-Llama-3\.[13]-(70B|405B)/i,
  // Llama 4 (Maverick / Scout / Behemoth) — tous agentic
  /\bllama-4-(maverick|scout|behemoth)/i,
  /\bmeta-llama\/Llama-4-/i,
  // Qwen 2.5 32B+, Qwen3 (toutes tailles), QwQ (raisonnement+tools)
  /\bqwen-?2\.5-(32b|72b)/i,
  /\bQwen2\.5-(32B|72B)/,
  /\bqwen-?2\.5-coder/i,
  /\bqwen-?3-/i,
  /\bQwen3-/,
  /\bqwq-/i,
  // DeepSeek — V2.5+, V3, R1, Coder, Chat
  /\bdeepseek-(v[23](\.[0-9]+)?|r[12]|chat|coder)/i,
  // xAI Grok 3+ (Grok 2 avait du function calling mais peu fiable)
  /\bgrok-[3-9]/i,
  // MiniMax M1/M2.x + MiMo (Xiaomi MiMo-V2/V2.5/V3, agentic-oriented)
  /\bminimax-m[12](\.[0-9]+)?/i,
  /\bMiniMax-M[12](\.[0-9]+)?/,
  /\bmimo-(v[12](\.[0-9]+)?|pro)/i,
  /\bMiMo-/,
  // Cohere Command R / R+ (function-calling natif)
  /\bcommand-r(-plus)?(-08-2024|-04-2024)?\b/i,
  /\bcommand-(a|r7b)/i,
  // Moonshot Kimi (k1.5, k2 — agentic réputés sur le code)
  /\bkimi-k[12](\.[0-9]+)?/i,
  /\bmoonshot(ai)?\/(kimi|moonshot-)/i,
  // Zhipu GLM-4, GLM-4-Plus, ChatGLM tool-call
  /\bglm-4(\.[0-9]+)?(-plus|-flash|-air|-long)?\b/i,
  // Amazon Nova Pro / Lite (Bedrock function-calling)
  /\bnova-(pro|lite|micro)/i,
  /\bamazon\.nova-/i,
  // Yi-Large (01.AI) — function calling depuis novembre 2024
  /\byi-large/i,
  // Inflection Pi 3.x (function calling depuis pi-3.1)
  /\bpi-3\.[1-9]/i,
  // Reka Flash/Core — agentic confirmé
  /\breka-(flash|core)/i,
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
