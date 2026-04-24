"""
Model router — sélection automatique du meilleur modèle LLM dispo par profil de tâche.

Chaque sous-agent déclare un `model_profile` (reasoning_heavy, fast_cheap, code,
vision, long_context, research, general). Ce module résout le profil en un
modèle concret parmi ceux que l'utilisateur a configurés dans ses providers.

Priorité :
1. Si l'agent a un `model` explicite et que le provider est configuré → utiliser tel quel.
2. Sinon, prendre la liste de préférences du profil et filtrer sur ce qui est accessible.
3. Fallback final sur le default_model du provider par défaut.

Chaque profil contient une liste ordonnée (du meilleur au fallback) de couples
(provider, model_slug). Le resolver parcourt la liste et retourne le premier
couple dont le provider a une clé API chez l'utilisateur.
"""
from __future__ import annotations

from dataclasses import dataclass


# Table maîtresse des profils. Les slugs sont ceux utilisés par OpenRouter ou
# par les providers natifs. Ordre : du plus capable au plus économique.
_PROFILE_PREFERENCES: dict[str, list[tuple[str, str]]] = {
    # Raisonnement lourd : décomposition, planification, arbitrage, synthèse
    # multi-sources. On veut la meilleure qualité de reasoning dispo.
    "reasoning_heavy": [
        ("anthropic", "claude-opus-4-7"),
        ("openrouter", "anthropic/claude-opus-4.7"),
        ("anthropic", "claude-sonnet-4-6"),
        ("openrouter", "anthropic/claude-sonnet-4.6"),
        ("openai", "gpt-5"),
        ("openrouter", "openai/gpt-5"),
        ("google", "gemini-2.5-pro"),
        ("openrouter", "google/gemini-2.5-pro"),
        ("openrouter", "deepseek/deepseek-r1"),
    ],

    # Rapide et bon marché : classification, résumé court, Q&A simple, routing.
    "fast_cheap": [
        ("openrouter", "google/gemini-2.5-flash-lite"),
        ("google", "gemini-2.5-flash-lite"),
        ("openrouter", "openai/gpt-5-nano"),
        ("openai", "gpt-5-nano"),
        ("openrouter", "anthropic/claude-haiku-4.5"),
        ("anthropic", "claude-haiku-4-5"),
        ("openrouter", "google/gemini-2.5-flash"),
        ("google", "gemini-2.5-flash"),
    ],

    # Code : génération, refactoring, debug, review.
    "code": [
        ("anthropic", "claude-sonnet-4-6"),
        ("openrouter", "anthropic/claude-sonnet-4.6"),
        ("openrouter", "openai/gpt-5"),
        ("openai", "gpt-5"),
        ("openrouter", "qwen/qwen3-coder"),
        ("openrouter", "deepseek/deepseek-v3.2"),
        ("anthropic", "claude-opus-4-7"),
    ],

    # Vision : images en input (screenshots, diagrammes, docs scannés).
    "vision": [
        ("openrouter", "google/gemini-2.5-pro"),
        ("google", "gemini-2.5-pro"),
        ("openrouter", "anthropic/claude-sonnet-4.6"),
        ("anthropic", "claude-sonnet-4-6"),
        ("openrouter", "openai/gpt-5"),
        ("openai", "gpt-5"),
    ],

    # Long contexte : analyse de docs volumineux, conversations très longues.
    "long_context": [
        ("openrouter", "google/gemini-2.5-pro"),     # 1M+ tokens
        ("google", "gemini-2.5-pro"),
        ("openrouter", "openai/gpt-5"),              # 1M
        ("openrouter", "anthropic/claude-sonnet-4.6"),  # 200k
        ("anthropic", "claude-sonnet-4-6"),
    ],

    # Recherche : web search + synthèse. Privilégier rapide + bon general knowledge.
    "research": [
        ("openrouter", "google/gemini-2.5-flash"),
        ("google", "gemini-2.5-flash"),
        ("openrouter", "openai/gpt-5-mini"),
        ("openai", "gpt-5-mini"),
        ("openrouter", "anthropic/claude-sonnet-4.6"),
    ],

    # Général : équilibre qualité/coût pour tâches variées.
    "general": [
        ("openrouter", "anthropic/claude-sonnet-4.6"),
        ("anthropic", "claude-sonnet-4-6"),
        ("openrouter", "openai/gpt-5-mini"),
        ("openai", "gpt-5-mini"),
        ("openrouter", "google/gemini-2.5-flash"),
        ("google", "gemini-2.5-flash"),
    ],
}


VALID_PROFILES = tuple(_PROFILE_PREFERENCES.keys())


@dataclass
class ResolvedModel:
    provider: str
    model: str
    api_key: str
    base_url: str | None
    source: str  # "explicit" | "profile:<name>" | "fallback"


async def resolve_model_for_agent(agent, user_id: int | None, session) -> ResolvedModel | None:
    """Résout quel modèle utiliser pour un sous-agent donné.

    Retourne None si aucun provider n'est configuré chez l'utilisateur — dans
    ce cas le caller doit renvoyer une erreur claire à l'utilisateur.

    Ordre de résolution :
    1. `agent.model` explicite + provider configuré chez l'user → tel quel
    2. `agent.model_profile` → parcours des préférences, premier provider dispo
    3. Fallback : provider par défaut du agent avec son default_model global
    """
    from backend.core.config.settings import Settings
    from backend.core.api.auth_helpers import get_user_settings, get_user_provider_key

    settings = Settings.load()
    if not user_id:
        return None

    try:
        user_settings = await get_user_settings(user_id, session)
    except Exception:
        return None

    def _lookup_key(prov: str) -> tuple[str | None, str | None]:
        try:
            prov_cfg = get_user_provider_key(user_settings, prov)
            if prov_cfg and prov_cfg.get("api_key"):
                return prov_cfg["api_key"], prov_cfg.get("base_url")
        except Exception:
            pass
        return None, None

    # 1. Modèle explicite prioritaire
    if agent.model:
        api_key, base_url = _lookup_key(agent.provider)
        if api_key:
            return ResolvedModel(
                provider=agent.provider,
                model=agent.model,
                api_key=api_key,
                base_url=base_url,
                source="explicit",
            )
        # Modèle explicite mais provider non configuré → on tente quand même
        # le fallback profil (peut-être qu'un autre provider peut servir).

    # 2. Via profil
    profile = getattr(agent, "model_profile", None) or "general"
    if profile not in _PROFILE_PREFERENCES:
        profile = "general"
    for provider, model_slug in _PROFILE_PREFERENCES[profile]:
        api_key, base_url = _lookup_key(provider)
        if api_key:
            return ResolvedModel(
                provider=provider,
                model=model_slug,
                api_key=api_key,
                base_url=base_url,
                source=f"profile:{profile}",
            )

    # 3. Fallback : n'importe quel provider configuré avec son default_model
    for prov_name, prov_cfg in settings.providers.items():
        api_key, base_url = _lookup_key(prov_name)
        if api_key and prov_cfg.default_model:
            return ResolvedModel(
                provider=prov_name,
                model=prov_cfg.default_model,
                api_key=api_key,
                base_url=base_url,
                source="fallback",
            )

    return None
