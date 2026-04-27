"""
Model Guide — wolf_tools pour la consultation et le switch de modèle.

Trois tools exposés à l'agent :
- model_get_info : consulte le catalog pour donner prix/tier/contexte
- model_list_available : liste les modèles configurés chez l'user
- model_switch : change le modèle actif (avec garde-fou Premium/Flagship)

Contexte : un user a remonté que :
1. L'agent ne pouvait pas changer de modèle via une commande conversationnelle
   → c'est en fait `provider_manage` qui le fait, mais tool peu connu.
   On expose model_switch comme alias plus naturel.
2. L'agent ne consultait pas le model_guide pour donner les prix
   → ce tool dédié rend ça naturel pour le LLM.
3. Pas d'avertissement avant un switch sur un modèle Premium/Flagship coûteux
   → garde-fou : si tier in (premium, flagship) et pas de confirm_premium=True,
   on retourne requires_confirmation avec le message d'alerte.
"""
from __future__ import annotations

import logging
from typing import Any, Optional

from backend.core.agents.wolf_tools import get_user_context

logger = logging.getLogger("gungnir.plugins.model_guide.agent_tools")


TOOL_SCHEMAS: list[dict] = [
    {
        "type": "function",
        "function": {
            "name": "model_get_info",
            "description": (
                "Consulte le guide des modèles pour récupérer les infos d'un modèle LLM : "
                "prix par 1M tokens (input + output), tier (free/cheap/budget/mid/premium/flagship), "
                "fenêtre de contexte, support vision. À utiliser quand l'user demande combien "
                "coûte un modèle, ou avant de proposer un switch pour informer du coût."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "model_id": {"type": "string", "description": "ID du modèle (ex: 'anthropic/claude-sonnet-4-6', 'gpt-5', 'gemini-2.5-pro')."},
                    "provider": {"type": "string", "description": "Provider optionnel (openrouter/anthropic/openai/google/...). Si absent, recherche dans tous."},
                },
                "required": ["model_id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "model_list_available",
            "description": (
                "Liste les modèles disponibles chez l'utilisateur (providers configurés avec leurs clés API), "
                "avec pour chacun le prix et le tier. À utiliser quand l'user demande quels modèles il a, "
                "lesquels sont les moins chers, ou quand l'agent veut comparer avant un switch."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "max_tier": {"type": "string", "description": "Filtre optionnel sur le tier max (cheap/budget/mid/premium/flagship). Ex: 'mid' = exclut premium et flagship."},
                    "provider": {"type": "string", "description": "Filtre optionnel par provider."},
                },
                "required": [],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "model_switch",
            "description": (
                "Change le modèle LLM actif pour les prochains messages. "
                "GARDE-FOU PRIX : si le modèle cible est Premium ou Flagship (modèles coûteux), "
                "le tool retourne requires_confirmation=true avec un avertissement de prix ; "
                "l'agent doit alors demander confirmation à l'user et rappeler avec confirm_premium=true. "
                "Pour les modèles cheap/budget/mid, le switch est immédiat sans confirmation."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "model_id": {"type": "string", "description": "ID du modèle cible (ex: 'anthropic/claude-opus-4-7', 'gpt-5', 'gemini-2.5-pro')."},
                    "provider": {"type": "string", "description": "Provider (openrouter/anthropic/openai/google/...). Si absent, déduit du préfixe model_id ou cherche."},
                    "confirm_premium": {"type": "boolean", "description": "Mettre à true SEULEMENT après que l'user a explicitement validé le coût d'un modèle premium/flagship.", "default": False},
                },
                "required": ["model_id"],
            },
        },
    },
]


# ── Helpers ──────────────────────────────────────────────────────────────

_TIER_ORDER = {"free": 0, "cheap": 1, "budget": 2, "mid": 3, "premium": 4, "flagship": 5}
_TIER_LABELS_FR = {
    "free": "Gratuit",
    "cheap": "Très bon marché",
    "budget": "Économique",
    "mid": "Standard",
    "premium": "Premium (cher)",
    "flagship": "Flagship (très cher)",
}


async def _resolve_model_meta(model_id: str, provider: Optional[str] = None) -> Optional[dict]:
    """Cherche les metadata d'un modèle dans le catalog (OpenRouter live + STATIC_MODELS)."""
    from .routes import _fetch_openrouter_models, STATIC_MODELS, MODEL_DESC_FR, _price_tier
    # 1. OpenRouter cache
    try:
        or_models = await _fetch_openrouter_models()
        if model_id in or_models:
            data = or_models[model_id]
            return {
                "id": model_id,
                "name": data.get("name", model_id),
                "provider": "openrouter",
                "context_window": data.get("context", 0),
                "input_1m": data.get("input_1m", 0),
                "output_1m": data.get("output_1m", 0),
                "tier": _price_tier(data.get("input_1m", 0), data.get("output_1m", 0)),
                "vision": data.get("vision", False),
                "description": MODEL_DESC_FR.get(model_id, data.get("description", "")),
            }
    except Exception as e:
        logger.warning("OpenRouter cache lookup failed: %s", e)
    # 2. STATIC_MODELS (Google/MiniMax/Ollama)
    if model_id in STATIC_MODELS:
        meta = STATIC_MODELS[model_id]
        return {
            "id": model_id,
            "name": meta["name"],
            "provider": provider or "unknown",
            "context_window": meta.get("context", 0),
            "input_1m": meta.get("input_1m", 0),
            "output_1m": meta.get("output_1m", 0),
            "tier": _price_tier(meta.get("input_1m", 0), meta.get("output_1m", 0)),
            "vision": meta.get("vision", False),
            "description": MODEL_DESC_FR.get(model_id, meta.get("description", "")),
        }
    return None


def _format_price(meta: dict) -> str:
    inp = meta.get("input_1m", 0)
    out = meta.get("output_1m", 0)
    tier = meta.get("tier", "?")
    label = _TIER_LABELS_FR.get(tier, tier)
    if inp == 0 and out == 0:
        return f"Gratuit ({label})"
    return f"${inp}/M input, ${out}/M output — tier: {label}"


# ── Executors ────────────────────────────────────────────────────────────

async def _model_get_info(model_id: str, provider: Optional[str] = None) -> dict:
    """Retourne les infos détaillées d'un modèle (prix + tier + contexte)."""
    meta = await _resolve_model_meta(model_id, provider)
    if not meta:
        return {
            "ok": False,
            "error": f"Modèle '{model_id}' introuvable dans le guide. Vérifie l'orthographe ou utilise model_list_available pour voir les modèles dispo.",
        }
    return {
        "ok": True,
        "model_id": meta["id"],
        "name": meta["name"],
        "provider": meta["provider"],
        "tier": meta["tier"],
        "tier_label": _TIER_LABELS_FR.get(meta["tier"], meta["tier"]),
        "input_per_1m_tokens": meta["input_1m"],
        "output_per_1m_tokens": meta["output_1m"],
        "context_window": meta["context_window"],
        "vision": meta["vision"],
        "description": meta["description"],
        "summary": f"{meta['name']} ({meta['provider']}) — {_format_price(meta)} — contexte {meta['context_window']:,} tokens",
    }


async def _model_list_available(max_tier: Optional[str] = None,
                                 provider: Optional[str] = None) -> dict:
    """Liste les modèles configurés chez l'user (depuis le catalog), filtrable par tier max."""
    uid = get_user_context()
    if not uid:
        return {"ok": False, "error": "Utilisateur non authentifié."}
    try:
        from .routes import _fetch_openrouter_models, STATIC_MODELS, _price_tier, _enrich_static
        from backend.core.config.settings import Settings
        from backend.core.api.auth_helpers import get_user_settings, get_user_provider_key
        from backend.core.db.engine import async_session
    except Exception as e:
        return {"ok": False, "error": f"Catalog indispo : {e}"}

    max_rank = _TIER_ORDER.get((max_tier or "flagship").lower(), 5)

    async with async_session() as session:
        user_settings = await get_user_settings(uid, session)

    settings = Settings.load()
    or_models = await _fetch_openrouter_models()
    out: list[dict] = []

    for prov_name, prov_cfg in settings.providers.items():
        if provider and provider != prov_name:
            continue
        ucfg = get_user_provider_key(user_settings, prov_name)
        has_key = bool(ucfg and ucfg.get("api_key") and ucfg.get("enabled", True))
        # On affiche aussi Ollama même sans clé (local).
        if not has_key and prov_name != "ollama":
            continue
        # Modèles dispos = liste de la config provider, enrichis depuis le catalog
        for mid in (prov_cfg.models or []):
            meta = or_models.get(mid)
            if meta:
                tier = _price_tier(meta.get("input_1m", 0), meta.get("output_1m", 0))
                input_1m = meta.get("input_1m", 0)
                output_1m = meta.get("output_1m", 0)
                ctx = meta.get("context", 0)
            else:
                static = _enrich_static(prov_name, mid)
                if static:
                    tier = static["pricing"]["tier"]
                    input_1m = static["pricing"]["input"]
                    output_1m = static["pricing"]["output"]
                    ctx = static["context_window"]
                else:
                    tier, input_1m, output_1m, ctx = "unknown", 0, 0, 0
            if _TIER_ORDER.get(tier, 99) > max_rank:
                continue
            out.append({
                "model_id": mid,
                "provider": prov_name,
                "tier": tier,
                "tier_label": _TIER_LABELS_FR.get(tier, tier),
                "input_per_1m_tokens": input_1m,
                "output_per_1m_tokens": output_1m,
                "context_window": ctx,
            })
    # Tri : tier croissant (free d'abord), puis prix input
    out.sort(key=lambda x: (_TIER_ORDER.get(x["tier"], 99), x["input_per_1m_tokens"]))
    return {"ok": True, "count": len(out), "models": out}


async def _model_switch(model_id: str, provider: Optional[str] = None,
                        confirm_premium: bool = False) -> dict:
    """Change le modèle actif. Garde-fou si tier premium/flagship sans confirm."""
    uid = get_user_context()
    if not uid:
        return {"ok": False, "error": "Utilisateur non authentifié."}

    # Lookup tier du modèle cible
    meta = await _resolve_model_meta(model_id, provider)
    if not meta:
        return {
            "ok": False,
            "error": f"Modèle '{model_id}' introuvable dans le guide. Utilise model_list_available pour voir les modèles dispo.",
        }
    tier = meta["tier"]
    detected_provider = provider or meta.get("provider") or "openrouter"

    # Garde-fou : si premium/flagship et pas de confirm_premium → demande confirmation
    if tier in ("premium", "flagship") and not confirm_premium:
        cost_warning = (
            f"⚠️ ATTENTION PRIX — '{meta['name']}' est un modèle {_TIER_LABELS_FR.get(tier, tier)} "
            f"(${meta['input_1m']}/M input, ${meta['output_1m']}/M output).  "
            f"Une conversation longue peut coûter plusieurs $/€. "
            f"Demande confirmation explicite à l'utilisateur, puis rappelle "
            f"model_switch avec confirm_premium=true si validation."
        )
        return {
            "ok": False,
            "requires_confirmation": True,
            "tier": tier,
            "tier_label": _TIER_LABELS_FR.get(tier, tier),
            "model_id": model_id,
            "input_per_1m_tokens": meta["input_1m"],
            "output_per_1m_tokens": meta["output_1m"],
            "warning": cost_warning,
        }

    # Pas de garde-fou ou confirm OK → on switch via provider_manage
    from backend.core.agents.wolf_tools import WOLF_EXECUTORS
    pm = WOLF_EXECUTORS.get("provider_manage")
    if not pm:
        return {"ok": False, "error": "Outil provider_manage indisponible."}
    res = await pm(action="switch", provider=detected_provider, model=model_id)
    if isinstance(res, dict) and res.get("ok"):
        # Ajoute les infos tier pour que l'agent puisse résumer à l'user
        res["tier"] = tier
        res["tier_label"] = _TIER_LABELS_FR.get(tier, tier)
        res["price_info"] = _format_price(meta)
    return res


EXECUTORS: dict[str, Any] = {
    "model_get_info":        _model_get_info,
    "model_list_available":  _model_list_available,
    "model_switch":          _model_switch,
}
