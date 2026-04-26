import re
from typing import Tuple

# Pricing per 1M tokens (USD) — updated April 2026
MODEL_PRICING = {
    # ── Anthropic ─────────────────────────────────────────────────────────────
    "anthropic/claude-opus-4-6": {"input": 15.0, "output": 75.0},
    "anthropic/claude-sonnet-4-6": {"input": 3.0, "output": 15.0},
    "anthropic/claude-4-opus": {"input": 15.0, "output": 75.0},
    "anthropic/claude-4-sonnet": {"input": 3.0, "output": 15.0},
    "anthropic/claude-sonnet-4-5-20250514": {"input": 3.0, "output": 15.0},
    "anthropic/claude-3.5-sonnet": {"input": 3.0, "output": 15.0},
    "anthropic/claude-3.5-haiku": {"input": 0.8, "output": 4.0},
    "anthropic/claude-3-opus": {"input": 15.0, "output": 75.0},
    "anthropic/claude-3-sonnet": {"input": 3.0, "output": 15.0},
    "anthropic/claude-3-haiku": {"input": 0.25, "output": 1.25},
    "claude-opus-4-6": {"input": 15.0, "output": 75.0},
    "claude-sonnet-4-6": {"input": 3.0, "output": 15.0},
    "claude-sonnet-4-5-20250514": {"input": 3.0, "output": 15.0},
    "claude-haiku-4-5-20251001": {"input": 0.8, "output": 4.0},
    "claude-3-7-sonnet-20250219": {"input": 3.0, "output": 15.0},
    "claude-3-5-sonnet-20241022": {"input": 3.0, "output": 15.0},
    "claude-3-5-haiku-20241022": {"input": 0.8, "output": 4.0},
    "claude-3-opus-20240229": {"input": 15.0, "output": 75.0},
    "claude-3-sonnet-20240229": {"input": 3.0, "output": 15.0},
    "claude-3-haiku-20240307": {"input": 0.25, "output": 1.25},
    # ── OpenAI ────────────────────────────────────────────────────────────────
    "openai/gpt-4.1": {"input": 2.0, "output": 8.0},
    "openai/gpt-4.1-mini": {"input": 0.4, "output": 1.6},
    "openai/gpt-4.1-nano": {"input": 0.1, "output": 0.4},
    "openai/gpt-4o": {"input": 2.5, "output": 10.0},
    "openai/gpt-4o-mini": {"input": 0.15, "output": 0.6},
    "openai/gpt-4-turbo": {"input": 10.0, "output": 30.0},
    "openai/gpt-4": {"input": 30.0, "output": 60.0},
    "openai/gpt-3.5-turbo": {"input": 0.5, "output": 1.5},
    "openai/o1": {"input": 15.0, "output": 60.0},
    "openai/o1-mini": {"input": 3.0, "output": 12.0},
    "openai/o1-pro": {"input": 150.0, "output": 600.0},
    "openai/o3": {"input": 10.0, "output": 40.0},
    "openai/o3-mini": {"input": 1.1, "output": 4.4},
    "openai/o4-mini": {"input": 1.1, "output": 4.4},
    # ── Google ────────────────────────────────────────────────────────────────
    "google/gemini-2.5-pro": {"input": 1.25, "output": 10.0},
    "google/gemini-2.5-pro-preview": {"input": 1.25, "output": 10.0},
    "google/gemini-2.5-flash": {"input": 0.15, "output": 0.6},
    "google/gemini-2.5-flash-preview": {"input": 0.15, "output": 0.6},
    "google/gemini-2.0-flash": {"input": 0.1, "output": 0.4},
    "google/gemini-2.0-flash-exp": {"input": 0.1, "output": 0.4},
    "google/gemini-2.0-flash-lite": {"input": 0.075, "output": 0.3},
    "google/gemini-1.5-pro": {"input": 1.25, "output": 5.0},
    "google/gemini-1.5-flash": {"input": 0.075, "output": 0.3},
    # ── MiniMax ───────────────────────────────────────────────────────────────
    "minimax/minimax-m2.7": {"input": 0.1, "output": 0.1},
    # ── Meta / Llama ──────────────────────────────────────────────────────────
    "meta-llama/llama-4-maverick": {"input": 0.5, "output": 0.8},
    "meta-llama/llama-4-scout": {"input": 0.2, "output": 0.3},
    "meta-llama/llama-3.3-70b-instruct": {"input": 0.5, "output": 0.8},
    "meta-llama/llama-3.1-70b-instruct": {"input": 0.7, "output": 1.2},
    "meta-llama/llama-3.1-8b-instruct": {"input": 0.2, "output": 0.3},
    "meta-llama/llama-3.1-405b-instruct": {"input": 3.5, "output": 4.5},
    # ── DeepSeek ──────────────────────────────────────────────────────────────
    "deepseek/deepseek-r1": {"input": 0.55, "output": 2.19},
    "deepseek/deepseek-v3": {"input": 0.27, "output": 1.10},
    "deepseek/deepseek-chat": {"input": 0.27, "output": 1.10},
    # ── Mistral ───────────────────────────────────────────────────────────────
    "mistralai/mistral-large": {"input": 2.0, "output": 6.0},
    "mistralai/mistral-medium": {"input": 2.7, "output": 8.1},
    "mistralai/mistral-small": {"input": 0.2, "output": 0.6},
    "mistralai/codestral": {"input": 0.3, "output": 0.9},
    "mistralai/mixtral-8x7b-instruct": {"input": 0.24, "output": 0.24},
    # ── Xiaomi ────────────────────────────────────────────────────────────────
    "xiaomi/mimo-v2-pro": {"input": 0.1, "output": 0.3},
    "xiaomi/mimo-v2-omni": {"input": 0.2, "output": 0.6},
    "xiaomi/mimo-v2.5-pro": {"input": 0.15, "output": 0.45},
    "xiaomi/mimo-v2.5-omni": {"input": 0.3, "output": 0.9},
    # ── Qwen ──────────────────────────────────────────────────────────────────
    "qwen/qwen-2.5-72b-instruct": {"input": 0.4, "output": 0.4},
    "qwen/qwen-2.5-coder-32b-instruct": {"input": 0.2, "output": 0.2},
    "qwen/qwq-32b": {"input": 0.2, "output": 0.2},
    # ── Ollama (free, local) ──────────────────────────────────────────────────
    "ollama/llama3.2": {"input": 0.0, "output": 0.0},
    "ollama/llama3.1": {"input": 0.0, "output": 0.0},
    "ollama/mistral": {"input": 0.0, "output": 0.0},
    "ollama/codellama": {"input": 0.0, "output": 0.0},
    "ollama/qwen2.5": {"input": 0.0, "output": 0.0},
}


def get_model_pricing(model: str) -> Tuple[float, float]:
    """Get (input, output) pricing per 1M tokens in USD."""
    pricing = MODEL_PRICING.get(model)
    if not pricing:
        stripped = re.sub(r'-\d{8}$', '', model)
        pricing = MODEL_PRICING.get(stripped)
    if not pricing:
        # Try with common prefixes stripped (openrouter often returns with provider prefix)
        for prefix in ("openrouter/", ""):
            key = f"{prefix}{model}" if prefix else model
            if key in MODEL_PRICING:
                pricing = MODEL_PRICING[key]
                break
    return (pricing["input"], pricing["output"]) if pricing else (0.0, 0.0)


def calculate_cost(model: str, tokens_input: int, tokens_output: int) -> float:
    """Calculate total cost in USD from token usage."""
    input_price, output_price = get_model_pricing(model)
    return (tokens_input / 1_000_000) * input_price + (tokens_output / 1_000_000) * output_price


def extract_model_from_response(response_model: str) -> str:
    """Standardize model name from API response for analytics tracking."""
    if not response_model:
        return "unknown"

    m = response_model.lower()
    stripped = re.sub(r'-\d{8}$', '', m)

    # Direct match
    if stripped in MODEL_PRICING:
        return stripped
    if m in MODEL_PRICING:
        return m

    # Fuzzy matching — ordered from specific to general
    patterns = [
        # Xiaomi — VERSIONS RÉCENTES en premier sinon le catch-all « mimo »
        # mappait mimo-v2.5-pro vers mimo-v2-pro (faux, dans analytics).
        ("mimo-v2.5-pro", "xiaomi/mimo-v2.5-pro"),
        ("mimo-v2.5-omni", "xiaomi/mimo-v2.5-omni"),
        ("mimo-v2-omni", "xiaomi/mimo-v2-omni"),
        ("mimo-omni", "xiaomi/mimo-v2-omni"),
        ("mimo-v2-pro", "xiaomi/mimo-v2-pro"),
        ("mimo", "xiaomi/mimo-v2-pro"),
        # Anthropic (specific first)
        ("claude-opus-4", "anthropic/claude-opus-4-6"),
        ("claude-sonnet-4-6", "anthropic/claude-sonnet-4-6"),
        ("claude-sonnet-4-5", "anthropic/claude-sonnet-4-5-20250514"),
        ("claude-haiku-4-5", "claude-haiku-4-5-20251001"),
        ("claude-4-opus", "anthropic/claude-4-opus"),
        ("claude-4-sonnet", "anthropic/claude-4-sonnet"),
        ("claude-3-7-sonnet", "claude-3-7-sonnet-20250219"),
        ("claude-3.5-sonnet", "anthropic/claude-3.5-sonnet"),
        ("claude-3.5-haiku", "anthropic/claude-3.5-haiku"),
        ("claude-3-opus", "anthropic/claude-3-opus"),
        ("claude-3-sonnet", "anthropic/claude-3-sonnet"),
        ("claude-3-haiku", "anthropic/claude-3-haiku"),
        # OpenAI (specific first)
        ("gpt-4.1-nano", "openai/gpt-4.1-nano"),
        ("gpt-4.1-mini", "openai/gpt-4.1-mini"),
        ("gpt-4.1", "openai/gpt-4.1"),
        ("gpt-4o-mini", "openai/gpt-4o-mini"),
        ("gpt-4o", "openai/gpt-4o"),
        ("gpt-4-turbo", "openai/gpt-4-turbo"),
        ("gpt-4", "openai/gpt-4"),
        ("gpt-3.5-turbo", "openai/gpt-3.5-turbo"),
        ("o4-mini", "openai/o4-mini"),
        ("o3-mini", "openai/o3-mini"),
        ("o3", "openai/o3"),
        ("o1-pro", "openai/o1-pro"),
        ("o1-mini", "openai/o1-mini"),
        ("o1", "openai/o1"),
        # Google (specific first)
        ("gemini-2.5-pro", "google/gemini-2.5-pro"),
        ("gemini-2.5-flash", "google/gemini-2.5-flash"),
        ("gemini-2.0-flash-lite", "google/gemini-2.0-flash-lite"),
        ("gemini-2.0-flash", "google/gemini-2.0-flash"),
        ("gemini-1.5-pro", "google/gemini-1.5-pro"),
        ("gemini-1.5-flash", "google/gemini-1.5-flash"),
        # MiniMax (specific first — pas de catch générique qui lumperait tout)
        ("minimax-m2.7", "minimax/minimax-m2.7"),
        ("minimax-m2", "minimax/minimax-m2.7"),
        ("m2.7", "minimax/minimax-m2.7"),
        # DeepSeek
        ("deepseek-r1", "deepseek/deepseek-r1"),
        ("deepseek-v3", "deepseek/deepseek-v3"),
        ("deepseek-chat", "deepseek/deepseek-chat"),
        # Mistral
        ("codestral", "mistralai/codestral"),
        ("mixtral-8x7b", "mistralai/mixtral-8x7b-instruct"),
        ("mistral-large", "mistralai/mistral-large"),
        ("mistral-medium", "mistralai/mistral-medium"),
        ("mistral-small", "mistralai/mistral-small"),
        # Meta / Llama
        ("llama-4-maverick", "meta-llama/llama-4-maverick"),
        ("llama-4-scout", "meta-llama/llama-4-scout"),
        ("llama-3.3-70b", "meta-llama/llama-3.3-70b-instruct"),
        ("llama-3.1-405b", "meta-llama/llama-3.1-405b-instruct"),
        ("llama-3.1-70b", "meta-llama/llama-3.1-70b-instruct"),
        ("llama-3.1-8b", "meta-llama/llama-3.1-8b-instruct"),
        ("llama3.2", "ollama/llama3.2"),
        ("llama3.1", "ollama/llama3.1"),
        # Qwen
        ("qwq-32b", "qwen/qwq-32b"),
        ("qwen-2.5-coder", "qwen/qwen-2.5-coder-32b-instruct"),
        ("qwen-2.5-72b", "qwen/qwen-2.5-72b-instruct"),
        # Ollama
        ("codellama", "ollama/codellama"),
    ]
    for pattern, name in patterns:
        if pattern in m:
            return name

    # Pas de match : on garde le nom brut. Analytics le regroupera sous son
    # identifiant réel (pas de coût calculé si absent de MODEL_PRICING, mais
    # le modèle reste visible dans le tableau de bord). On évite en particulier
    # de remapper "mistral*" vers "ollama/mistral" — le trafic OpenRouter /
    # Mistral Cloud serait comptabilisé comme du self-host gratuit, FAUX.
    return response_model


def format_cost(cost: float) -> str:
    if cost >= 0.01:
        return f"${cost:.3f}"
    elif cost >= 0.001:
        return f"${cost:.4f}"
    return f"${cost:.6f}"


# ─────────────────────────────────────────────────────────────────────────────
# Pricing génération d'images (USD par image, tarifs publics avril 2026)
# ─────────────────────────────────────────────────────────────────────────────
# Format : { canonical_model_id: prix_par_image_1024 }
# Pour les sizes plus grandes (1792x*, 1024x1536, 1536x1024), un multiplicateur
# 1.5x s'applique. Pour les modèles "HD" / "quality=hd", encore 2x. Logique
# simple — exact à 10-20% près, suffisant pour l'analytics.
IMAGE_PRICING_PER_IMAGE = {
    # OpenAI
    "gpt-image-2":                            0.040,
    "gpt-image-1":                            0.040,
    "dall-e-3":                               0.040,
    "dall-e-2":                               0.020,
    # Google
    "gemini-2.5-flash-image-preview":         0.039,
    "gemini-2.0-flash-exp-image-generation":  0.039,
    "imagen-3.0-generate-002":                0.040,
    "imagen-3.0-fast-generate-001":           0.020,
    # OpenRouter slugs (mêmes tarifs que les modèles sources)
    "openai/gpt-5.4-image-2":                 0.040,
    "openai/gpt-image-2":                     0.040,
    "openai/gpt-image-1":                     0.040,
    "openai/dall-e-3":                        0.040,
    "openai/dall-e-2":                        0.020,
    "google/gemini-2.5-flash-image-preview":  0.039,
    "google/imagen-3-generate-002":           0.040,
}


def get_image_cost(model: str, n: int = 1, size: str = "1024x1024", quality: str | None = None) -> float:
    """Renvoie le coût total estimé pour `n` images générées par `model` en `size`.

    - Tarif de base depuis IMAGE_PRICING_PER_IMAGE.
    - Tailles plus grandes que 1024x1024 → x1.5
    - quality == 'hd' → x2 supplémentaire (DALL-E 3, GPT-Image)
    - Modèle inconnu → 0.040 par défaut (estimation conservatrice)
    """
    if not model:
        return 0.0
    m = model.lower().strip()
    base = IMAGE_PRICING_PER_IMAGE.get(m)
    if base is None:
        for k, v in IMAGE_PRICING_PER_IMAGE.items():
            if m.endswith("/" + k) or k.endswith(m):
                base = v
                break
    if base is None:
        base = 0.040

    multiplier = 1.0
    if size and size != "1024x1024":
        try:
            w, h = (int(x) for x in size.lower().split("x"))
            if w * h > 1024 * 1024:
                multiplier *= 1.5
        except Exception:
            pass
    if quality and str(quality).lower() in ("hd", "high", "quality"):
        multiplier *= 2.0

    return float(base) * float(n) * multiplier
