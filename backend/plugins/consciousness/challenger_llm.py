"""
Challenger LLM resolver — pick the best model to run an audit.

The Challenger benefits from using a *different* model than the main chat
agent so it can detect self-complacency and blind spots. Since not every
user has every provider configured, we expose three resolution modes:

- "default" → use the user's main chat model (legacy behavior)
- "auto"    → pick the best low-cost model among the user's configured providers
- "preset"  → an explicit preset (provider + model) chosen in the UI
- "custom"  → free-form (provider + model) for expert users

Presets are curated here (tier: free / mid / high) so the frontend only
has to render them.
"""
from __future__ import annotations

import logging
from typing import Optional

logger = logging.getLogger("gungnir.consciousness.challenger_llm")


# Curated list of recommended models for the Challenger.
# Tier: "free" (no cost or very low), "mid" (modest cost, solid reasoning),
#       "high" (premium, best reasoning).
# The order here is the auto-pick priority inside each tier.
PRESETS: list[dict] = [
    {
        "id": "free_deepseek_r1",
        "label": "DeepSeek R1 (gratuit)",
        "tier": "free",
        "provider": "openrouter",
        "model": "deepseek/deepseek-r1-distill-llama-70b:free",
        "note": "Reasoning gratuit via OpenRouter — excellent rapport qualité/prix pour la critique",
    },
    {
        "id": "free_gemini_flash",
        "label": "Gemini 2.0 Flash (gratuit)",
        "tier": "free",
        "provider": "openrouter",
        "model": "google/gemini-2.0-flash-exp:free",
        "note": "Rapide et gratuit via OpenRouter, bon pour audits fréquents",
    },
    {
        "id": "mid_haiku",
        "label": "Claude Haiku 4.5",
        "tier": "mid",
        "provider": "anthropic",
        "model": "claude-haiku-4-5",
        "note": "Rapide et très fiable, coût modéré",
    },
    {
        "id": "mid_gpt4o_mini",
        "label": "GPT-4o mini",
        "tier": "mid",
        "provider": "openai",
        "model": "gpt-4o-mini",
        "note": "Éprouvé, peu coûteux, bon sens critique",
    },
    {
        "id": "high_sonnet",
        "label": "Claude Sonnet 4.6",
        "tier": "high",
        "provider": "anthropic",
        "model": "claude-sonnet-4-6",
        "note": "Qualité de critique maximale, coût plus élevé",
    },
]


# Auto-pick priority: which provider we prefer when several are configured,
# and the cheapest reasonable model on each. First match wins.
AUTO_PICK_ORDER: list[tuple[str, str]] = [
    # (provider_name, model_name)
    ("anthropic", "claude-haiku-4-5"),
    ("openai", "gpt-4o-mini"),
    ("google", "gemini-2.0-flash-exp"),
    ("openrouter", "deepseek/deepseek-r1-distill-llama-70b:free"),
    ("minimax", "minimax-text-01"),
    ("ollama", "llama3.1"),
]


async def list_configured_providers(user_id: int) -> list[str]:
    """Return the list of provider names configured for this user."""
    if not user_id:
        return []
    try:
        from backend.core.db.engine import engine
        from backend.core.api.auth_helpers import get_user_settings
        from sqlalchemy.ext.asyncio import AsyncSession

        async with AsyncSession(engine) as session:
            us = await get_user_settings(user_id, session)
            if not us or not us.provider_keys:
                return []
            return [
                name for name, cfg in (us.provider_keys or {}).items()
                if (cfg or {}).get("api_key") or (cfg or {}).get("base_url")
            ]
    except Exception as e:
        logger.warning(f"list_configured_providers failed for user {user_id}: {e}")
        return []


async def resolve_challenger_llm(
    user_id: int, challenger_cfg: dict
) -> tuple[Optional[str], Optional[str]]:
    """Return (provider, model) to use for one Challenger audit.

    Returns (None, None) when the caller should fall back to the user's
    default chat model (invoke_llm_for_user handles that implicitly when
    provider/model are None).
    """
    llm_cfg = (challenger_cfg or {}).get("llm", {}) or {}
    mode = str(llm_cfg.get("mode", "default")).lower()

    if mode in ("preset", "custom"):
        provider = (llm_cfg.get("provider") or "").strip() or None
        model = (llm_cfg.get("model") or "").strip() or None
        if provider and model:
            return provider, model
        # Misconfigured — fall through to auto/default

    if mode == "auto":
        configured = set(await list_configured_providers(user_id))
        for provider, model in AUTO_PICK_ORDER:
            if provider in configured:
                return provider, model
        # No provider configured → fall back to default chat model
        return None, None

    # default mode or unknown mode → use the user's default chat model
    return None, None


async def build_llm_options(user_id: int, challenger_cfg: dict) -> dict:
    """Build the payload consumed by the Challenger settings UI."""
    configured = set(await list_configured_providers(user_id))
    presets = []
    for p in PRESETS:
        presets.append({
            **p,
            "available": p["provider"] in configured,
        })
    auto_provider, auto_model = None, None
    for provider, model in AUTO_PICK_ORDER:
        if provider in configured:
            auto_provider, auto_model = provider, model
            break

    llm_cfg = (challenger_cfg or {}).get("llm", {}) or {}
    return {
        "configured_providers": sorted(configured),
        "presets": presets,
        "auto_pick": {
            "provider": auto_provider,
            "model": auto_model,
        } if auto_provider else None,
        "current": {
            "mode": llm_cfg.get("mode", "default"),
            "provider": llm_cfg.get("provider", ""),
            "model": llm_cfg.get("model", ""),
        },
        "priority_order": [{"provider": p, "model": m} for p, m in AUTO_PICK_ORDER],
    }
