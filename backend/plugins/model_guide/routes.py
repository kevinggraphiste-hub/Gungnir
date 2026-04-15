"""
Gungnir Plugin — Model Guide

Catalog of available models across all configured providers.
Fetches live pricing from OpenRouter API, enriches with metadata.
Self-contained — reads core config (read-only), no mutations.
"""
import logging
import time
from typing import Optional

import httpx
from fastapi import APIRouter, Depends, Query, Request
from sqlalchemy.ext.asyncio import AsyncSession

from backend.core.config.settings import Settings
from backend.core.db.engine import get_session
from backend.core.api.auth_helpers import get_user_settings, get_user_provider_key
from backend.core.providers import get_provider

logger = logging.getLogger("gungnir.plugins.model_guide")
router = APIRouter()


# ── French descriptions for popular models ───────────────────────────────────

MODEL_DESC_FR: dict[str, str] = {
    # Anthropic
    "anthropic/claude-opus-4": "Modele flagship Anthropic — raisonnement avance, code complexe, analyse approfondie",
    "anthropic/claude-opus-4.1": "Opus 4.1 — raisonnement avance, code, analyse approfondie",
    "anthropic/claude-opus-4.5": "Opus 4.5 — intelligence hybride, raisonnement et creativite",
    "anthropic/claude-opus-4.6": "Opus 4.6 — dernier flagship, contexte 1M, raisonnement superieur",
    "anthropic/claude-sonnet-4": "Sonnet 4 — equilibre performance/cout, code et agents",
    "anthropic/claude-sonnet-4.6": "Sonnet 4.6 — rapide et polyvalent, bon rapport qualite/prix",
    "anthropic/claude-3.7-sonnet": "Sonnet 3.7 — raisonnement etendu, code, multimodal",
    "anthropic/claude-3.7-sonnet:thinking": "Sonnet 3.7 mode reflexion — raisonnement pas a pas",
    "anthropic/claude-3.5-sonnet": "Sonnet 3.5 — generation precedente, encore performant",
    "anthropic/claude-3.5-haiku": "Haiku 3.5 — rapide et economique, taches simples",
    "anthropic/claude-haiku-4.5": "Haiku 4.5 — ultra-rapide, ideal pour le volume",
    "anthropic/claude-3-haiku": "Haiku 3 — tres rapide, classification et Q&A",
    "anthropic/claude-3-opus": "Opus 3 — ancien flagship, analyse complexe",
    "anthropic/claude-2": "Claude 2 — generation legacy, encore disponible",
    # OpenAI
    "openai/gpt-4o": "GPT-4o — multimodal rapide, vision et audio natifs",
    "openai/gpt-4o-mini": "GPT-4o Mini — rapide et economique, bon pour le volume",
    "openai/gpt-4-turbo": "GPT-4 Turbo — performant, contexte 128K",
    "openai/gpt-4": "GPT-4 — modele de reference, contexte 8K",
    "openai/gpt-3.5-turbo": "GPT-3.5 Turbo — rapide et pas cher, taches simples",
    "openai/o1": "o1 — raisonnement avance, maths et logique complexe",
    "openai/o1-mini": "o1 Mini — raisonnement rapide, plus economique",
    "openai/o3": "o3 — dernier modele de raisonnement OpenAI",
    "openai/o3-mini": "o3 Mini — raisonnement compact et rapide",
    "openai/gpt-4.1": "GPT-4.1 — code et instructions longues, contexte 1M",
    "openai/gpt-4.1-mini": "GPT-4.1 Mini — rapide, bon en code, economique",
    "openai/gpt-4.1-nano": "GPT-4.1 Nano — ultra-rapide, cout minimal",
    "openai/gpt-4.5-preview": "GPT-4.5 — creativite et ecriture, derniere generation",
    # Google
    "google/gemini-2.5-pro": "Gemini 2.5 Pro — reference production, contexte 1M, code avance",
    "google/gemini-2.5-flash": "Gemini 2.5 Flash — meilleur rapport qualite/prix, contexte 1M",
    "google/gemini-2.5-flash-preview": "Gemini 2.5 Flash Preview — version experimentale",
    "google/gemini-2.0-flash": "Gemini 2.0 Flash — bon equilibre vitesse/qualite, multimodal",
    "google/gemini-2.0-flash-lite-001": "Gemini 2.0 Flash Lite — ultra-rapide, quasi-gratuit",
    "google/gemini-3-flash": "Gemini 3 Flash — derniere generation rapide",
    "google/gemini-3.1-pro": "Gemini 3.1 Pro — intelligence #1 mondial, contexte 1M",
    "google/gemma-3-27b-it": "Gemma 3 27B — modele open-source Google, performant",
    "google/gemma-3-12b-it": "Gemma 3 12B — open-source leger, bon pour l'inference locale",
    "google/gemma-3-4b-it": "Gemma 3 4B — ultra-compact, ideal embarque",
    # DeepSeek
    "deepseek/deepseek-r1": "DeepSeek R1 — raisonnement profond, maths et logique",
    "deepseek/deepseek-chat": "DeepSeek V3 — polyvalent au 1/10e du prix des grands modeles",
    "deepseek/deepseek-v3-0324": "DeepSeek V3 (mars 2024) — attention sparse, code et maths",
    "deepseek/deepseek-r1-0528": "DeepSeek R1 (mai 2025) — raisonnement ameliore",
    # Meta
    "meta-llama/llama-4-maverick": "Llama 4 Maverick — dernier Meta, open-source performant",
    "meta-llama/llama-4-scout": "Llama 4 Scout — compact et rapide, open-source",
    "meta-llama/llama-3.3-70b-instruct": "Llama 3.3 70B — open-source equilibre, bon en code",
    "meta-llama/llama-3.1-405b-instruct": "Llama 3.1 405B — le plus gros open-source, flagship",
    "meta-llama/llama-3.1-70b-instruct": "Llama 3.1 70B — polyvalent open-source",
    "meta-llama/llama-3.1-8b-instruct": "Llama 3.1 8B — leger et rapide, taches simples",
    # Mistral
    "mistralai/mistral-large": "Mistral Large — flagship francais, multilingue",
    "mistralai/mistral-small": "Mistral Small — rapide, bon en francais",
    "mistralai/mistral-medium": "Mistral Medium — equilibre, bonne comprehension",
    "mistralai/codestral-2501": "Codestral — specialise code, completions rapides",
    "mistralai/ministral-8b": "Ministral 8B — compact et economique",
    "mistralai/pixtral-large-2411": "Pixtral Large — vision + texte, multimodal Mistral",
    # Perplexity
    "perplexity/sonar": "Sonar — recherche web rapide, actualites et faits",
    "perplexity/sonar-pro": "Sonar Pro — recherche approfondie, sources multiples",
    "perplexity/sonar-reasoning": "Sonar Reasoning — raisonnement + recherche web",
    "perplexity/sonar-reasoning-pro": "Sonar Reasoning Pro — analyse complexe + sources web",
    # Qwen
    "qwen/qwen-2.5-72b-instruct": "Qwen 2.5 72B — Alibaba, performant en multilingue",
    "qwen/qwen-turbo": "Qwen Turbo — rapide, contexte ultra-long",
    "qwen/qwen3-235b-a22b": "Qwen 3 235B — flagship Alibaba, MoE massif",
    "qwen/qwen3-32b": "Qwen 3 32B — equilibre, bon en code et maths",
    "qwen/qwen3-30b-a3b": "Qwen 3 30B — MoE compact, rapide",
    # Cohere
    "cohere/command-r-plus": "Command R+ — RAG et recherche, documents longs",
    "cohere/command-r": "Command R — generation et recherche, economique",
    # xAI
    "x-ai/grok-3": "Grok 3 — flagship xAI, raisonnement avance",
    "x-ai/grok-3-mini": "Grok 3 Mini — rapide et economique, raisonnement",
    "x-ai/grok-2": "Grok 2 — xAI, bon en conversation",
    # Xiaomi
    "xiaomi/mimo-v2-pro": "MiMo V2 Pro — Xiaomi, vision et texte, multimodal",
    # Others
    "microsoft/phi-4": "Phi 4 — Microsoft, compact et performant pour sa taille",
    "microsoft/mai-ds-r1": "MAI DS R1 — Microsoft, raisonnement specialise",
    "nvidia/llama-3.1-nemotron-70b-instruct": "Nemotron 70B — NVIDIA, optimise pour l'instruction",
}


# ── Live OpenRouter cache ────────────────────────────────────────────────────

_openrouter_cache: dict = {}
_openrouter_cache_ts: float = 0
_CACHE_TTL = 300  # 5 min


async def _fetch_openrouter_models() -> dict[str, dict]:
    """
    Fetch full model data from OpenRouter API (public, no key required).
    Returns dict keyed by model ID with pricing + metadata.
    Cached for 5 minutes.
    """
    global _openrouter_cache, _openrouter_cache_ts

    if _openrouter_cache and (time.time() - _openrouter_cache_ts) < _CACHE_TTL:
        return _openrouter_cache

    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.get("https://openrouter.ai/api/v1/models")
            resp.raise_for_status()
            data = resp.json()

        result = {}
        for m in data.get("data", []):
            mid = m.get("id", "")
            pricing = m.get("pricing", {})

            # Convert per-token pricing to per-1M-tokens
            prompt_per_token = float(pricing.get("prompt", "0") or "0")
            completion_per_token = float(pricing.get("completion", "0") or "0")

            input_1m = round(prompt_per_token * 1_000_000, 4)
            output_1m = round(completion_per_token * 1_000_000, 4)

            arch = m.get("architecture", {})
            input_modalities = arch.get("input_modalities", [])

            result[mid] = {
                "name": m.get("name", mid.split("/")[-1]),
                "description": m.get("description", ""),
                "context_window": m.get("context_length") or 0,
                "input_1m": input_1m,
                "output_1m": output_1m,
                "vision": "image" in input_modalities,
                "modality": arch.get("modality", "text->text"),
            }

        _openrouter_cache = result
        _openrouter_cache_ts = time.time()
        logger.info(f"OpenRouter cache refreshed: {len(result)} models")
        return result

    except Exception as e:
        logger.warning(f"OpenRouter fetch failed: {e}")
        return _openrouter_cache  # return stale cache if available


# ── Price tier classification ────────────────────────────────────────────────

def _price_tier(input_1m: float, output_1m: float) -> str:
    """
    Classify pricing into tiers (Muninn-inspired + extra level):
    ∅ = free, ¢ = ultra-cheap, $ = budget, $$ = standard, $$$ = premium, $$$$ = flagship
    Based on average of input+output per 1M tokens.
    """
    if input_1m == 0 and output_1m == 0:
        return "free"
    avg = (input_1m + output_1m) / 2
    if avg < 0.5:
        return "cheap"      # ¢
    if avg < 3:
        return "budget"     # $
    if avg < 10:
        return "mid"        # $$
    if avg < 30:
        return "premium"    # $$$
    return "flagship"       # $$$$


# ── Static metadata for non-OpenRouter providers ────────────────────────────

STATIC_MODELS = {
    # Google (direct API)
    "gemini-2.5-pro": {"name": "Gemini 2.5 Pro", "context": 1000000, "vision": True, "input_1m": 1.25, "output_1m": 10.0, "description": "Reference production stable — code, donnees, contexte 1M"},
    "gemini-2.5-flash": {"name": "Gemini 2.5 Flash", "context": 1000000, "vision": True, "input_1m": 0.075, "output_1m": 0.30, "description": "Meilleur rapport qualite/prix — rapide, contexte 1M, usage quotidien"},
    "gemini-2.0-flash": {"name": "Gemini 2.0 Flash", "context": 1000000, "vision": True, "input_1m": 0.10, "output_1m": 0.40, "description": "Bon equilibre vitesse/qualite — images, conversations longues"},
    "gemini-2.0-flash-lite": {"name": "Gemini 2.0 Flash Lite", "context": 1000000, "vision": True, "input_1m": 0.0, "output_1m": 0.0, "description": "Ultra-rapide et gratuit — classification, Q&A simple"},
    "gemini-1.5-pro": {"name": "Gemini 1.5 Pro", "context": 2000000, "vision": True, "input_1m": 1.25, "output_1m": 5.0, "description": "Contexte 2M tokens, analyse de documents longs"},
    "gemini-1.5-flash": {"name": "Gemini 1.5 Flash", "context": 1000000, "vision": True, "input_1m": 0.075, "output_1m": 0.30, "description": "Generation precedente rapide, encore fiable"},
    # MiniMax (direct API)
    "MiniMax-M1": {"name": "MiniMax M1", "context": 1000000, "vision": False, "input_1m": 0.80, "output_1m": 4.0, "description": "Modele chinois haute capacite, contexte 1M"},
    # Ollama (local)
    "llama3.2": {"name": "Llama 3.2", "context": 128000, "vision": False, "input_1m": 0, "output_1m": 0, "description": "Meta Llama local, rapide pour taches simples"},
    "llama3.1": {"name": "Llama 3.1", "context": 128000, "vision": False, "input_1m": 0, "output_1m": 0, "description": "Meta Llama local, generation precedente"},
    "mistral": {"name": "Mistral", "context": 32000, "vision": False, "input_1m": 0, "output_1m": 0, "description": "Mistral local via Ollama"},
    "codellama": {"name": "Code Llama", "context": 16000, "vision": False, "input_1m": 0, "output_1m": 0, "description": "Specialise code, local via Ollama"},
    "qwen2.5": {"name": "Qwen 2.5", "context": 128000, "vision": False, "input_1m": 0, "output_1m": 0, "description": "Alibaba Qwen local, bon en multilingue"},
}


def _enrich_static(provider: str, model_id: str) -> dict | None:
    """Enrich a non-OpenRouter model with static data."""
    meta = STATIC_MODELS.get(model_id)
    if not meta:
        return None
    desc = MODEL_DESC_FR.get(model_id) or meta.get("description", "")
    return {
        "id": model_id,
        "name": meta["name"],
        "provider": provider,
        "description": desc,
        "context_window": meta.get("context", 0),
        "pricing": {
            "input": meta.get("input_1m", 0),
            "output": meta.get("output_1m", 0),
            "tier": _price_tier(meta.get("input_1m", 0), meta.get("output_1m", 0)),
        },
        "vision": meta.get("vision", False),
    }


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.get("/health")
async def model_guide_health():
    return {"plugin": "model_guide", "status": "ok", "version": "3.0.0"}


@router.get("/catalog")
async def get_catalog(request: Request, session: AsyncSession = Depends(get_session)):
    """
    Returns all available models grouped by provider for the current user.
    Provider API keys are resolved strictly from the caller's UserSettings so
    the "has_api_key" flag and dynamic model listing reflect the caller's own
    configuration, never another user's.
    """
    settings = Settings.load()
    or_models = await _fetch_openrouter_models()
    catalog = {}

    # Resolve the caller's per-user provider keys
    uid = getattr(request.state, "user_id", None)
    user_settings_row = None
    if uid:
        try:
            user_settings_row = await get_user_settings(uid, session)
        except Exception as e:
            logger.warning(f"Model catalog: user settings lookup failed: {e}")

    def _user_key_for(pname: str) -> tuple[str | None, str | None]:
        """Return (api_key, base_url) for the current user, or (None, None)."""
        if user_settings_row is None:
            return None, None
        decoded = get_user_provider_key(user_settings_row, pname)
        if decoded and decoded.get("api_key"):
            return decoded["api_key"], decoded.get("base_url")
        return None, None

    for provider_name, provider_config in settings.providers.items():
        if not provider_config.enabled:
            continue

        models_list = provider_config.models or []
        _uapi_key, _ubase_url = _user_key_for(provider_name)

        if provider_name == "openrouter":
            # Use live data — filter to only configured + available models
            enriched = []
            seen = set()

            # Merge configured models with live available ones
            all_ids = list(models_list)
            for mid in or_models:
                if mid not in seen:
                    all_ids.append(mid)

            for mid in all_ids:
                if mid in seen:
                    continue
                seen.add(mid)

                or_data = or_models.get(mid)
                if not or_data:
                    continue  # Not available on OpenRouter

                # French description first, then fallback to OpenRouter English
                desc = MODEL_DESC_FR.get(mid, "")
                if not desc:
                    desc = or_data.get("description", "") or ""
                    if desc:
                        for sep in [". ", ".\n", "\n"]:
                            if sep in desc:
                                desc = desc[:desc.index(sep)]
                                break
                        if len(desc) > 120:
                            desc = desc[:117] + "..."

                enriched.append({
                    "id": mid,
                    "name": or_data["name"],
                    "provider": "openrouter",
                    "description": desc,
                    "context_window": or_data["context_window"],
                    "pricing": {
                        "input": or_data["input_1m"],
                        "output": or_data["output_1m"],
                        "tier": _price_tier(or_data["input_1m"], or_data["output_1m"]),
                    },
                    "vision": or_data["vision"],
                })

            catalog[provider_name] = {
                "provider": provider_name,
                "enabled": True,
                "has_api_key": bool(_uapi_key),
                "default_model": provider_config.default_model,
                "model_count": len(enriched),
                "models": sorted(enriched, key=lambda x: x["name"].lower()),
            }
        else:
            # Non-OpenRouter: try dynamic listing with the user's own key first
            dynamic_models = []
            if _uapi_key:
                try:
                    _bu = _ubase_url or provider_config.base_url
                    provider = get_provider(provider_name, _uapi_key, _bu)
                    dynamic_models = await provider.list_models()
                except Exception as e:
                    logger.warning(f"Dynamic model listing failed for {provider_name}: {e}")

            # Merge dynamic + static (dynamic first, add missing static)
            all_model_ids = list(dynamic_models) if dynamic_models else list(models_list)
            if dynamic_models:
                dynamic_set = set(dynamic_models)
                for mid in models_list:
                    if mid not in dynamic_set:
                        all_model_ids.append(mid)

            enriched = []
            for mid in all_model_ids:
                info = _enrich_static(provider_name, mid)
                if info:
                    enriched.append(info)
                else:
                    # Check OpenRouter cache for cross-provider enrichment
                    or_key = f"{provider_name}/{mid}"
                    or_data = or_models.get(or_key)
                    if or_data:
                        desc = MODEL_DESC_FR.get(or_key, or_data.get("description", "") or "")
                        enriched.append({
                            "id": mid,
                            "name": or_data["name"],
                            "provider": provider_name,
                            "description": desc[:120] if desc else "",
                            "context_window": or_data["context_window"],
                            "pricing": {
                                "input": or_data["input_1m"],
                                "output": or_data["output_1m"],
                                "tier": _price_tier(or_data["input_1m"], or_data["output_1m"]),
                            },
                            "vision": or_data["vision"],
                        })
                    else:
                        # Minimal fallback
                        desc = MODEL_DESC_FR.get(or_key) or MODEL_DESC_FR.get(mid, "")
                        enriched.append({
                            "id": mid,
                            "name": mid,
                            "provider": provider_name,
                            "description": desc,
                            "context_window": 0,
                            "pricing": {"input": 0, "output": 0, "tier": "unknown"},
                            "vision": False,
                        })

            catalog[provider_name] = {
                "provider": provider_name,
                "enabled": True,
                "has_api_key": bool(_uapi_key),
                "default_model": provider_config.default_model,
                "model_count": len(enriched),
                "models": sorted(enriched, key=lambda x: x["name"].lower()),
            }

    return catalog


@router.get("/quickpicks")
async def get_quickpicks():
    """
    Returns recommended models for common use cases.
    Only includes models actually available to the user.
    """
    or_models = await _fetch_openrouter_models()

    # All candidates ordered by preference (first available wins)
    candidates = [
        {"label": "Usage quotidien", "options": ["google/gemini-2.5-flash", "google/gemini-2.0-flash"], "provider_hint": "gemini"},
        {"label": "Code & agents", "options": ["anthropic/claude-sonnet-4", "anthropic/claude-sonnet-4.6", "anthropic/claude-3.7-sonnet"], "provider_hint": "anthropic"},
        {"label": "Raisonnement", "options": ["deepseek/deepseek-r1", "openai/o1", "anthropic/claude-3.7-sonnet:thinking"], "provider_hint": "deepseek"},
        {"label": "Polyvalent eco", "options": ["deepseek/deepseek-chat", "deepseek/deepseek-v3-0324", "meta-llama/llama-4-maverick"], "provider_hint": "deepseek"},
        {"label": "Ultra-rapide", "options": ["google/gemini-2.0-flash-lite-001", "google/gemini-2.0-flash", "openai/gpt-4o-mini"], "provider_hint": "gemini"},
        {"label": "Flagship", "options": ["anthropic/claude-opus-4", "anthropic/claude-opus-4.6", "openai/o1"], "provider_hint": "anthropic"},
        {"label": "Contexte long", "options": ["google/gemini-2.5-pro", "google/gemini-1.5-pro", "anthropic/claude-opus-4.6"], "provider_hint": "gemini"},
        {"label": "Multimodal", "options": ["openai/gpt-4o", "google/gemini-2.5-flash", "anthropic/claude-sonnet-4"], "provider_hint": "openai"},
        {"label": "Recherche web", "options": ["perplexity/sonar", "perplexity/sonar-pro", "perplexity/sonar-reasoning"], "provider_hint": "perplexity"},
        {"label": "Open-source", "options": ["meta-llama/llama-4-maverick", "meta-llama/llama-3.3-70b-instruct", "qwen/qwen-2.5-72b-instruct"], "provider_hint": "meta"},
    ]

    result = []
    for c in candidates:
        for model_id in c["options"]:
            if model_id in or_models:
                result.append({
                    "label": c["label"],
                    "model": model_id,
                    "provider_hint": c["provider_hint"],
                })
                break

    return result


@router.get("/tiers")
async def get_tiers():
    """Returns price tier legend."""
    return {
        "free":     {"symbol": "∅",    "label": "Gratuit",       "description": "Modeles gratuits ou locaux",              "color": "#22c55e"},
        "cheap":    {"symbol": "¢",    "label": "Quasi-gratuit", "description": "Moins de $0.50/M tokens en moyenne",     "color": "#22c55e"},
        "budget":   {"symbol": "$",    "label": "Budget",        "description": "$0.50 - $3/M tokens en moyenne",         "color": "#3b82f6"},
        "mid":      {"symbol": "$$",   "label": "Standard",      "description": "$3 - $10/M tokens en moyenne",           "color": "#ca8a04"},
        "premium":  {"symbol": "$$$",  "label": "Premium",       "description": "$10 - $30/M tokens en moyenne",          "color": "#dc2626"},
        "flagship": {"symbol": "$$$$", "label": "Flagship",      "description": "Plus de $30/M tokens en moyenne",        "color": "#7c2d12"},
        "unknown":  {"symbol": "?",    "label": "Inconnu",       "description": "Prix non disponible",                    "color": "#6b7280"},
    }
