"""
Gungnir Plugin — Model Guide

Catalog of available models across all configured providers.
Fetches live pricing from OpenRouter API, enriches with metadata.
Self-contained — reads core config (read-only), no mutations.
"""
import json
import logging
import time
from pathlib import Path
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
_PLUGIN_DIR = Path(__file__).parent


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
        """Return (api_key, base_url) for the current user, or (None, None).

        Un provider compte comme configuré s'il a SOIT une api_key SOIT un
        base_url (cas d'Ollama qui tourne en local sans clé, ou d'un proxy
        auto-hébergé). Sans ça, le catalogue masquait Ollama partout alors
        qu'il était bien réglé dans les provider keys utilisateur.
        """
        if user_settings_row is None:
            return None, None
        decoded = get_user_provider_key(user_settings_row, pname) or {}
        api_key = decoded.get("api_key") or None
        base_url = decoded.get("base_url") or None
        if api_key or base_url:
            return api_key, base_url
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
                "has_api_key": bool(_uapi_key or _ubase_url),
                "default_model": provider_config.default_model,
                "model_count": len(enriched),
                "models": sorted(enriched, key=lambda x: x["name"].lower()),
            }
        else:
            # Non-OpenRouter: try dynamic listing with the user's own key first.
            # Ollama est keyless : un base_url suffit à autoriser le listing.
            dynamic_models = []
            if _uapi_key or _ubase_url:
                try:
                    _bu = _ubase_url or provider_config.base_url
                    provider = get_provider(provider_name, _uapi_key or "", _bu)
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
                "has_api_key": bool(_uapi_key or _ubase_url),
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


# ── Benchmarks ───────────────────────────────────────────────────────────────
# Même pattern que /catalog : résout les providers configurés par l'utilisateur
# et ne retourne que les modèles auxquels il a accès. Sources combinées :
#
#   LIVE  — OpenRouter (/api/v1/models)     — pricing, context, metadata
#   LIVE  — Aider edit leaderboard (YAML)   — pass_rate_1/2 édition de code
#   LIVE  — Aider polyglot leaderboard      — pass_rate polyglot multi-lang
#   SNAP  — benchmarks_static.json          — LMArena Elo, MMLU-Pro, GPQA, LiveCodeBench
#
# Les 3 premières sont fetchées live (cache mémoire 1h), la 4e est un snapshot
# curé bundled (hot-swap toutes les 60s). LMArena et Artificial Analysis ne
# publient plus de feed gratuit en 2026 — le snapshot est une approximation,
# les liens officiels sont affichés côté UI pour cross-check.

_benchmarks_static: dict | None = None
_benchmarks_static_ts: float = 0.0
_BENCHMARKS_FILE_TTL = 60

_aider_cache: dict | None = None
_aider_cache_ts: float = 0.0
_AIDER_CACHE_TTL = 3600  # 1h

AIDER_EDIT_URL = "https://raw.githubusercontent.com/Aider-AI/aider/main/aider/website/_data/edit_leaderboard.yml"
AIDER_POLYGLOT_URL = "https://raw.githubusercontent.com/Aider-AI/aider/main/aider/website/_data/polyglot_leaderboard.yml"


def _load_benchmarks_static() -> dict:
    """Charge le snapshot JSON avec cache de 60s (hot-swap permis)."""
    global _benchmarks_static, _benchmarks_static_ts
    if _benchmarks_static and (time.time() - _benchmarks_static_ts) < _BENCHMARKS_FILE_TTL:
        return _benchmarks_static
    try:
        data = json.loads((_PLUGIN_DIR / "benchmarks_static.json").read_text(encoding="utf-8"))
        _benchmarks_static = data
        _benchmarks_static_ts = time.time()
        return data
    except Exception as e:
        logger.warning(f"Benchmarks static load failed: {e}")
        return _benchmarks_static or {"schema_version": 0, "sources": [], "models": []}


def _provider_from_id(model_id: str) -> str:
    if "/" in model_id:
        return model_id.split("/", 1)[0]
    return "unknown"


_DATE_SUFFIX_RE = __import__("re").compile(r'[-_]?(?:20\d{6}|20\d{2}[-_]\d{2}[-_]\d{2}|\d{4})$')
_VERSION_TAG_RE = __import__("re").compile(r'[-_](?:exp|preview|thinking|latest|instruct|chat|it)(?:[-_].*)?$')
_TRAILING_NUM_RE = __import__("re").compile(r'[-_]\d{3,4}$')


def _normalize_model_key(raw_id: str) -> str:
    """Normalise un id modèle pour matcher entre sources différentes.
    Ex : 'anthropic/claude-3.5-sonnet', 'claude-3-5-sonnet-20241022',
    'Claude 3.5 Sonnet' → tous ramenés à 'claude-3-5-sonnet'.
    """
    if not raw_id:
        return ""
    s = str(raw_id).lower().strip()
    # Provider prefix (anthropic/, openai/, google/, mistralai/…)
    if "/" in s:
        s = s.split("/", 1)[1]
    # Espaces et ponctuation → tirets
    s = __import__("re").sub(r'[\s_\.()]+', '-', s)
    # Dates (YYYYMMDD, YYYY-MM-DD, 4-digit suffix version)
    for _ in range(2):  # boucle car plusieurs suffixes possibles
        s2 = _DATE_SUFFIX_RE.sub('', s)
        if s2 == s:
            break
        s = s2
    # Tags de version courants
    s = _VERSION_TAG_RE.sub('', s)
    # Trailing numeric suffix (002, 0125…)
    s = _TRAILING_NUM_RE.sub('', s)
    # Tirets multiples
    s = __import__("re").sub(r'-+', '-', s).strip('-')
    return s


def _parse_aider_yaml(text: str) -> list[dict]:
    """Parseur YAML minimaliste pour les leaderboards Aider (format stable,
    entrées `- key: value`). Évite une dépendance PyYAML dédiée.
    """
    import re as _re
    entries: list[dict] = []
    current: dict | None = None
    for line in text.splitlines():
        if line.startswith("- "):
            if current is not None:
                entries.append(current)
            current = {}
            # La première ligne peut contenir un champ (- dirname: x)
            m = _re.match(r'- (\w+):\s*(.+)$', line)
            if m:
                current[m.group(1)] = m.group(2).strip().strip('"').strip("'")
        elif line.startswith("  ") and current is not None:
            m = _re.match(r'\s{2}(\w+):\s*(.+)$', line)
            if m:
                k, v = m.group(1), m.group(2).strip().strip('"').strip("'")
                # Cast basique (float / int / bool / str)
                if v.lower() in ("true", "false"):
                    current[k] = (v.lower() == "true")
                else:
                    try:
                        current[k] = float(v) if "." in v else int(v)
                    except ValueError:
                        current[k] = v
    if current:
        entries.append(current)
    return entries


async def _fetch_aider_leaderboards() -> dict:
    """Fetch et parse les deux leaderboards Aider GitHub (edit + polyglot).
    Retourne {normalized_key: {edit_pass2, polyglot_pass2, edit_format,
    released}}. Cache 1h. Fallback cache stale en cas d'échec réseau.
    """
    global _aider_cache, _aider_cache_ts
    if _aider_cache and (time.time() - _aider_cache_ts) < _AIDER_CACHE_TTL:
        return _aider_cache

    merged: dict[str, dict] = {}
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            edit_resp, poly_resp = await _gather_safe(
                client.get(AIDER_EDIT_URL),
                client.get(AIDER_POLYGLOT_URL),
            )

        for kind, resp in (("edit", edit_resp), ("polyglot", poly_resp)):
            if resp is None or getattr(resp, "status_code", 0) != 200:
                continue
            try:
                entries = _parse_aider_yaml(resp.text)
            except Exception as e:
                logger.warning(f"Aider {kind} parse failed: {e}")
                continue
            # Pour chaque modèle, garder l'entrée la plus récente (dernière date)
            best: dict[str, dict] = {}
            for e in entries:
                model_raw = e.get("model")
                if not model_raw:
                    continue
                key = _normalize_model_key(str(model_raw))
                if not key:
                    continue
                date = str(e.get("released") or e.get("date") or e.get("_released") or "")
                if key not in best or date > best[key].get("_date", ""):
                    best[key] = {
                        "_date": date,
                        "pass_rate_2": e.get("pass_rate_2"),
                        "pass_rate_1": e.get("pass_rate_1"),
                        "edit_format": e.get("edit_format"),
                    }
            for k, v in best.items():
                merged.setdefault(k, {})
                merged[k][f"aider_{kind}_pass2"] = v.get("pass_rate_2")
                merged[k][f"aider_{kind}_pass1"] = v.get("pass_rate_1")
                merged[k][f"aider_{kind}_released"] = v.get("_date") or None

        _aider_cache = merged
        _aider_cache_ts = time.time()
        logger.info(f"Aider leaderboards refreshed: {len(merged)} models")
        return merged
    except Exception as e:
        logger.warning(f"Aider fetch failed: {e}")
        return _aider_cache or {}


async def _gather_safe(*coros):
    """asyncio.gather mais renvoie None pour chaque coro qui lève."""
    import asyncio
    results = await asyncio.gather(*coros, return_exceptions=True)
    return tuple(r if not isinstance(r, BaseException) else None for r in results)


@router.get("/benchmarks")
async def get_benchmarks(request: Request, session: AsyncSession = Depends(get_session)):
    """Benchmarks filtrés par les providers configurés de l'utilisateur.

    Même logique que /catalog : on récupère les providers enabled + dont
    l'user a une clé, on liste leurs modèles dynamiques, et on enrichit
    avec les scores benchmarks (Aider live + snapshot curé pour le reste).
    """
    settings = Settings.load()
    static = _load_benchmarks_static()
    or_models = await _fetch_openrouter_models()
    aider = await _fetch_aider_leaderboards()

    # Index du snapshot par clé normalisée — fallback quand pas de source live
    static_by_key: dict[str, dict] = {}
    for row in static.get("models", []):
        key = _normalize_model_key(row.get("id", ""))
        if key:
            static_by_key[key] = row

    # Résolution des providers per-user (copie du pattern de /catalog)
    uid = getattr(request.state, "user_id", None)
    user_settings_row = None
    if uid:
        try:
            user_settings_row = await get_user_settings(uid, session)
        except Exception as e:
            logger.warning(f"Benchmarks: user settings lookup failed: {e}")

    def _user_key_for(pname: str) -> tuple[str | None, str | None]:
        if user_settings_row is None:
            return None, None
        decoded = get_user_provider_key(user_settings_row, pname) or {}
        return (decoded.get("api_key") or None, decoded.get("base_url") or None)

    # Construction de la liste d'IDs accessibles à l'user
    accessible_ids: set[str] = set()
    configured_providers: set[str] = set()
    for pname, pconf in settings.providers.items():
        if not pconf.enabled:
            continue
        api_key, base_url = _user_key_for(pname)
        if not (api_key or base_url):
            continue  # pas de clé user → provider skipped
        configured_providers.add(pname)
        # On prend la liste statique configurée (ultra-rapide).
        for mid in (pconf.models or []):
            accessible_ids.add(mid)

    # Cas OpenRouter : accès à ~500 modèles — on ajoute ceux qui ont au
    # moins une métrique bench (sinon le tableau explose).
    if "openrouter" in configured_providers:
        for mid in or_models.keys():
            norm = _normalize_model_key(mid)
            if norm in static_by_key or norm in aider:
                accessible_ids.add(mid)

    # Union : modèles accessibles user + TOUS les modèles du snapshot (pour
    # voir le classement complet même sans clé provider). Chaque ligne porte
    # un flag `accessible` qui dit si l'user peut vraiment utiliser ce modèle.
    snapshot_ids = {row["id"] for row in static.get("models", [])}
    all_ids = accessible_ids | snapshot_ids

    # Métriques dispo : celles du snapshot + Aider (deux colonnes)
    metrics = [s["metric"] for s in static.get("sources", []) if s.get("metric")]
    metrics += ["aider_edit_pass2", "aider_polyglot_pass2"]

    # Build des rangées
    models_out: list[dict] = []
    for mid in sorted(all_ids):
        norm = _normalize_model_key(mid)
        or_meta = or_models.get(mid, {})
        static_row = static_by_key.get(norm, {})
        aider_row = aider.get(norm, {})

        input_1m = or_meta.get("input_1m")
        output_1m = or_meta.get("output_1m")
        avg_price = (input_1m + output_1m) / 2 if (input_1m is not None and output_1m is not None) else None

        lmarena = static_row.get("lmarena_elo")
        efficiency = None
        if lmarena and avg_price and avg_price > 0:
            efficiency = round(max(lmarena - 1000, 0) / avg_price, 2)
        elif lmarena and avg_price == 0:
            efficiency = round(max(lmarena - 1000, 0) * 100, 2)

        provider = _provider_from_id(mid)
        # Accessible si : dans la liste accessible OU si l'user a le provider
        # direct configuré (même si le modèle précis n'est pas dans sa liste,
        # il peut l'appeler via l'API). Pour OpenRouter, on est déjà strict.
        is_accessible = (
            mid in accessible_ids
            or (provider in configured_providers and provider != "openrouter")
        )

        entry = {
            "id": mid,
            "name": or_meta.get("name") or mid.split("/")[-1],
            "provider": provider,
            "context_window": or_meta.get("context_window") or None,
            "input_1m": input_1m,
            "output_1m": output_1m,
            "avg_price": round(avg_price, 4) if avg_price is not None else None,
            "price_tier": _price_tier(input_1m or 0, output_1m or 0) if (input_1m is not None and output_1m is not None) else "unknown",
            "efficiency": efficiency,
            "accessible": is_accessible,
        }
        # Métriques snapshot
        for m in [s["metric"] for s in static.get("sources", []) if s.get("metric")]:
            entry[m] = static_row.get(m)
        # Métriques Aider (live)
        entry["aider_edit_pass2"] = aider_row.get("aider_edit_pass2")
        entry["aider_polyglot_pass2"] = aider_row.get("aider_polyglot_pass2")

        # Ne garde que les modèles qui ont au moins UNE métrique connue
        if any(entry.get(m) is not None for m in metrics):
            models_out.append(entry)

    accessible_count = sum(1 for m in models_out if m.get("accessible"))

    return {
        "schema_version": static.get("schema_version", 1),
        "last_updated": static.get("last_updated"),
        "notes": static.get("notes"),
        "metrics": metrics,
        "models": models_out,
        "has_user_filter": bool(user_settings_row),
        "accessible_count": accessible_count,
        "total_count": len(models_out),
        "configured_providers": sorted(configured_providers),
        "aider_models_count": len(aider),
    }


@router.get("/benchmarks/sources")
async def get_benchmarks_sources():
    """Métadonnées des sources (URL, description, métrique, statut live/snap)."""
    static = _load_benchmarks_static()
    sources = list(static.get("sources", []))
    # Ajoute les sources live Aider qui ne sont pas dans le JSON statique
    sources.extend([
        {
            "id": "aider_edit",
            "name": "Aider — Code Editing",
            "url": "https://aider.chat/docs/leaderboards/",
            "description": "Pass rate (second try) sur le benchmark d'édition de code Aider. Fetché live depuis GitHub.",
            "metric": "aider_edit_pass2",
            "live": True,
        },
        {
            "id": "aider_polyglot",
            "name": "Aider — Polyglot",
            "url": "https://aider.chat/docs/leaderboards/",
            "description": "Pass rate (second try) sur le benchmark polyglot multi-langages. Live GitHub.",
            "metric": "aider_polyglot_pass2",
            "live": True,
        },
    ])
    # Marque les autres comme snapshot (non-live)
    for s in sources:
        if "live" not in s:
            s["live"] = False
    return {
        "last_updated": static.get("last_updated"),
        "sources": sources,
    }
