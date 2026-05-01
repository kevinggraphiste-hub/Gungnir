/**
 * Gungnir — détection des modèles agentiques.
 *
 * **Source autoritative** : flag `supported_parameters` exposé par
 * OpenRouter (et certains autres providers) sur chaque modèle. Quand
 * cette liste contient "tools" / "tool_choice", le modèle supporte
 * officiellement le function calling natif. Le backend récupère cette
 * info via `OpenRouterProvider.list_models_with_metadata()` et la
 * passe au frontend dans la réponse `/api/models/{provider}` sous
 * la forme `{ agentic_models: [id1, id2, ...] }`. Le runtime Set
 * `_runtimeAgenticIds` ci-dessous est alimenté à chaque fetch et
 * consulté EN PRIORITÉ par `classifyModel`.
 *
 * **Fallback** : regex hardcodés sur les noms de modèles connus.
 * Utile quand le provider ne fournit pas de metadata (Anthropic
 * direct, OpenAI direct, providers custom OpenAI-compat). Couvre
 * les familles courantes — agentique reconnu par observation prod
 * + benchs publics (BFCL, ToolBench).
 */

const AGENTIC_PATTERNS: RegExp[] = [
  // Anthropic — Claude 3 et au-delà supportent le tool use natif
  // (claude-3-haiku-20240307 a été le premier à introduire `tools`)
  /\bclaude-3(-5|-7)?\b/i,
  /\bclaude-(opus|sonnet|haiku)-[3-9]/i,
  // OpenAI — GPT-3.5-turbo (function calling depuis 2023), GPT-4+, o-series
  /\bgpt-3\.5-turbo/i,
  /\bgpt-[45-9](\.[0-9]+)?(-?(o|mini|nano|turbo))?\b/i,
  /\bo[1-9](-mini|-pro|-preview)?\b/i,
  // Google — Gemini 1.5/2.x/3.x+ Pro/Flash (sauf Flash-8B trop léger)
  /\bgemini-([12]\.[0-9]+|[3-9](\.[0-9]+)?)-(pro|flash)(?!-8b)/i,
  // Mistral — Large, Medium, Small récents + Mixtral 8x*, Ministral,
  // Pixtral, Codestral. Mixtral 8x7B/8x22B instruct ont du tool use.
  /\bmistral-(large|medium|small|tiny|nemo|saba)-/i,
  /\bmixtral-8x(7b|22b)/i,
  /\bministral-(3b|8b)/i,
  /\bcodestral-/i,
  /\bpixtral-/i,
  // Mistral Devstral — modèle entraîné spécifiquement pour l'agentic
  // coding (SWE-bench, multi-step reasoning). Toutes les variantes
  // (small, medium, dated 2507/2512, etc.) sont agentic-natives.
  /\bdevstral-/i,
  // Llama 3.0/3.1/3.3 — tool use depuis 3.1 8B (officiel Meta).
  // Les versions 3B et inférieures rateront, mais ≥ 8B sont OK.
  /\bllama-3(\.[013])?-(8b|70b|405b)/i,
  /\bmeta-llama\/(Meta-)?Llama-3(\.[013])?-(8B|70B|405B)/i,
  // Llama 4 (Maverick / Scout / Behemoth) — tous agentic
  /\bllama-4-(maverick|scout|behemoth)/i,
  /\bmeta-llama\/Llama-4-/i,
  // Qwen 2 / 2.5 / 3 — function calling depuis Qwen2 7B+
  /\bqwen-?2(\.5)?-(7b|14b|32b|72b)/i,
  /\bQwen2(\.5)?-(7B|14B|32B|72B)/,
  /\bqwen-?2\.5-coder/i,
  /\bqwen-?3-/i,
  /\bQwen3-/,
  /\bqwq-/i,
  // DeepSeek — V2.5+, V3, R1, Coder, Chat
  /\bdeepseek-(v[23](\.[0-9]+)?|r[12]|chat|coder)/i,
  // xAI Grok 3+ (Grok 2 avait du function calling mais peu fiable)
  /\bgrok-[3-9]/i,
  // MiniMax M1/M2.x + MiMo (Xiaomi MiMo, agentic-oriented).
  // Pattern mimo permissif : tous les "mimo-*" sont agentic — la
  // famille entière (V1, V2, V2.5, V2.5-Pro, V3, V3-Pro, mini, max…)
  // est annoncée agentic-oriented par Xiaomi.
  /\bminimax-m[12](\.[0-9]+)?/i,
  /\bMiniMax-M[12](\.[0-9]+)?/,
  /\bmimo[-/]/i,
  /\bMiMo[-/]/,
  // Poolside AI Laguna (M.1, XS.2, futures L/XL) — agentic coding models
  // MoE entraînés sur SWE-bench. Tool use + reasoning natifs.
  /\blaguna[- ](xs|s|m|l|xl)\.?[0-9]/i,
  /\bpoolside\/laguna/i,
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
  // AI21 Jamba (1.5 Large/Mini, 2.x) — function calling depuis fin 2024
  /\bjamba-(1\.5|2)-/i,
  /\bjamba-(large|mini|instruct)/i,
  // Baidu ERNIE 4.x (function calling natif)
  /\bernie-(4|x[0-9])/i,
  // Tencent Hunyuan (Pro/Standard/Lite — tool use depuis 2024)
  /\bhunyuan-(pro|standard|lite|turbo|large)/i,
  // ByteDance Doubao (Pro 32k/128k — agentic)
  /\bdoubao-(pro|lite)-/i,
  // StepFun Step (step-1, step-2 — function calling)
  /\bstep-[12]-/i,
  // Baichuan (Baichuan2-Turbo, Baichuan3+, Baichuan4)
  /\bbaichuan-?[234]/i,
  // 360 Zhinao (function calling)
  /\b360gpt-(pro|turbo)/i,
  // SenseTime SenseChat (Sense-V5, V6+)
  /\bsensechat-v[5-9]/i,
  // 01.AI Yi-Lightning (en plus de Yi-Large)
  /\byi-lightning/i,
  // Snowflake Arctic Instruct (tool use limité mais OK)
  /\barctic-instruct/i,
  // Nous Research Hermes 2/3 (function calling natif fine-tuné)
  /\bhermes-[234]-/i,
  /\bnous(research)?\/.*hermes/i,
  // WizardLM 2 (8x22b, 7b — function calling)
  /\bwizardlm-2-(7b|8x22b)/i,
  // OpenChat 3.5+ (function calling)
  /\bopenchat-3\.[5-9]/i,
  // Solar Mini (Upstage, function calling)
  /\bsolar-(mini|pro)/i,
  // Falcon 3 (TII) — function calling depuis novembre 2024
  /\bfalcon3?-(7b|10b|40b|180b)/i,
  // DBRX Instruct (Databricks)
  /\bdbrx-instruct/i,
  // Phind CodeLlama / Phind-V*
  /\bphind-(v[0-9]+|codellama)/i,
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

// Providers pour lesquels on a une source AUTORITATIVE par-modèle
// (flag `supported_parameters` exposé). Pour ces providers, on
// considère exclusivement le runtime Set — on n'applique PAS les
// regex hardcodés par-dessus, sinon on tagge agentic des modèles que
// le provider amont a explicitement marqués chat-only.
const AUTHORITATIVE_PROVIDERS = new Set<string>([
  'openrouter',
  // Aliases OpenAI-compat routés via OpenRouter — tous bénéficient
  // de la même source quand l'user les configure derrière OpenRouter.
  // (Si l'user les configure en provider direct sans OpenRouter,
  // le Set runtime sera vide et on retombera en 'unknown'.)
])

// Runtime store des IDs agentic découverts via l'API provider (ex:
// OpenRouter `supported_parameters`). Mis à jour par
// `registerAgenticIds` à chaque fetch /api/models/{provider}.
const _runtimeAgenticIds = new Set<string>()

export function registerAgenticIds(ids: string[] | undefined | null): void {
  if (!Array.isArray(ids)) return
  for (const id of ids) {
    if (typeof id === 'string' && id) _runtimeAgenticIds.add(id)
  }
}

export function classifyModel(model: string, providerHint?: string): AgenticTier {
  if (!model) return 'unknown'
  const m = model.trim()
  const provider = (providerHint || '').toLowerCase()

  // Cas autoritatif : si on connaît la source officielle pour ce
  // provider, on s'y tient strictement. Pas de fallback regex —
  // le provider amont a déjà décidé. Si l'ID n'est pas dans le Set,
  // c'est que le modèle n'est pas agentic (ou qu'on a fetch trop
  // tôt et le Set est vide → 'unknown' est plus honnête que
  // d'inventer via regex).
  if (provider && AUTHORITATIVE_PROVIDERS.has(provider)) {
    return _runtimeAgenticIds.has(m) ? 'agentic' : 'unknown'
  }

  // Cas best-effort : 1) Set runtime, 2) non-agentic explicite,
  // 3) regex agentic hardcodé. Utilisé pour les providers directs
  // (Anthropic, OpenAI, Google, Mistral, MiniMax) qui n'exposent pas
  // de metadata par-modèle utilisable.
  if (_runtimeAgenticIds.has(m)) return 'agentic'
  if (NON_AGENTIC_PATTERNS.some(re => re.test(m))) return 'chat-only'
  if (AGENTIC_PATTERNS.some(re => re.test(m))) return 'agentic'
  return 'unknown'
}

export function isAgentic(model: string, providerHint?: string): boolean {
  return classifyModel(model, providerHint) === 'agentic'
}
