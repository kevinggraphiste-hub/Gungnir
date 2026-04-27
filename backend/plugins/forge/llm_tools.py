"""
Forge — wolf_tools LLM (appel direct d'un modèle dans un workflow).

Permet d'utiliser un LLM comme un node de workflow, à la N8N + AI :
- llm_call : appel one-shot avec prompt + system optionnel → texte
- llm_extract : extrait un JSON structuré depuis du texte (selon une consigne)
- llm_classify : choisit une catégorie parmi une liste fournie

Tous résolvent le provider/model via les user_settings (BYO keys),
strict per-user. Si l'user n'a aucune clé compatible configurée, le tool
retourne {ok: False, error} explicite — pas de fallback global.

Ces tools sont concaténés dans `forge/agent_tools.py` pour être
auto-découverts. Du coup ils sont dispo aussi pour les sous-agents et
le super-agent en chat normal — pas seulement Forge.
"""
from __future__ import annotations

import json
import logging
import re
from typing import Any, Optional

from backend.core.agents.wolf_tools import get_user_context

logger = logging.getLogger("gungnir.plugins.forge.llm_tools")


# ── Schemas ──────────────────────────────────────────────────────────────

LLM_TOOL_SCHEMAS: list[dict] = [
    {
        "type": "function",
        "function": {
            "name": "llm_call",
            "description": (
                "Appelle un LLM avec un prompt simple et retourne sa réponse texte. "
                "Idéal comme node de workflow pour générer/résumer/transformer du contenu. "
                "Utilise par défaut le provider/modèle préféré de l'utilisateur ; sinon spécifier "
                "explicitement (ex: model='claude-sonnet-4-6')."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "prompt": {"type": "string", "description": "Le message utilisateur à envoyer au modèle."},
                    "system": {"type": "string", "description": "Prompt système optionnel (rôle/consigne)."},
                    "model": {"type": "string", "description": "Modèle à utiliser (ex: 'claude-sonnet-4-6'). Si absent, défaut user."},
                    "provider": {"type": "string", "description": "Provider (anthropic/openai/google/openrouter/mistral/xai/minimax/ollama). Si absent, déduit du modèle ou défaut user."},
                    "temperature": {"type": "number", "description": "Créativité 0-2. Défaut 0.7."},
                    "max_tokens": {"type": "integer", "description": "Limite de tokens en sortie. Défaut 1024."},
                },
                "required": ["prompt"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "llm_extract",
            "description": (
                "Extrait un objet JSON structuré depuis du texte libre, selon une consigne. "
                "Utilise un LLM en arrière-plan + parse le JSON. Pratique pour transformer "
                "du texte non structuré en données exploitables dans la suite du workflow."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "text": {"type": "string", "description": "Le texte source à analyser."},
                    "instruction": {"type": "string", "description": "Que doit-on extraire ? (ex: 'extrait le titre, l'auteur et la date au format JSON {title, author, date}')"},
                    "schema_hint": {"type": "string", "description": "Optionnel : exemple JSON attendu (le LLM s'y conforme)."},
                    "model": {"type": "string"},
                    "provider": {"type": "string"},
                },
                "required": ["text", "instruction"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "llm_classify",
            "description": (
                "Classifie un texte parmi une liste de catégories fournies. Retourne {category, "
                "confidence}. Utile pour le routage conditionnel dans un workflow."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "text": {"type": "string"},
                    "categories": {"type": "array", "items": {"type": "string"}, "description": "Liste de catégories possibles (ex: ['bug', 'feature', 'question'])."},
                    "instruction": {"type": "string", "description": "Optionnel : contexte sur le critère de classification."},
                    "model": {"type": "string"},
                    "provider": {"type": "string"},
                },
                "required": ["text", "categories"],
            },
        },
    },
]


# ── Helpers de résolution provider/model ──────────────────────────────────

# Heuristique très simple : préfixes communs de model names → provider.
# Override possible via param explicite. Vérifié seulement si le user a
# bien la clé pour ce provider, sinon on retombe sur son défaut.
_MODEL_PREFIX_TO_PROVIDER: list[tuple[str, str]] = [
    ("claude-",          "anthropic"),
    ("gpt-",             "openai"),
    ("o1-",              "openai"),
    ("o3-",              "openai"),
    ("gemini-",          "google"),
    ("grok-",            "xai"),
    ("mistral-",         "mistral"),
    ("codestral-",       "mistral"),
    ("ministral-",       "mistral"),
    ("minimax-",         "minimax"),
    ("abab",             "minimax"),
    ("llama",            "ollama"),
    ("qwen",             "ollama"),
]


def _guess_provider(model: str) -> Optional[str]:
    if not model:
        return None
    m = model.lower()
    for prefix, prov in _MODEL_PREFIX_TO_PROVIDER:
        if m.startswith(prefix):
            return prov
    if "/" in m:  # openrouter style "anthropic/claude-..."
        return "openrouter"
    return None


async def _resolve_provider(user_id: int,
                             provider_hint: Optional[str],
                             model_hint: Optional[str]) -> Optional[dict]:
    """Retourne {provider_name, api_key, base_url, model} ou None.

    Stratégie :
    1. Si provider_hint explicite + clé user dispo → on l'utilise
    2. Sinon, si model_hint suggère un provider via _guess_provider → on tente
    3. Sinon, on prend le 1er provider activé chez l'user (premier par
       ordre alpha pour stabilité). Le model fallback est le `default_model`
       de la config provider de l'user, ou le modèle de l'app sinon.
    """
    from backend.core.db.engine import async_session
    from backend.core.api.auth_helpers import get_user_settings, get_user_provider_key
    from backend.core.config.settings import Settings

    async with async_session() as session:
        user_settings = await get_user_settings(user_id, session)

    settings = Settings.load()

    def _try(prov: str) -> Optional[dict]:
        ucfg = get_user_provider_key(user_settings, prov)
        if not ucfg or not ucfg.get("enabled", True) or not ucfg.get("api_key"):
            return None
        meta = settings.providers.get(prov)
        model = (model_hint or ucfg.get("default_model")
                 or (meta.default_model if meta else None))
        if not model:
            return None
        return {
            "provider": prov, "api_key": ucfg["api_key"],
            "base_url": ucfg.get("base_url") or (meta.base_url if meta else None),
            "model": model,
        }

    # 1. Hint explicite
    if provider_hint:
        r = _try(provider_hint)
        if r: return r

    # 2. Devine depuis le model
    if model_hint:
        guessed = _guess_provider(model_hint)
        if guessed:
            r = _try(guessed)
            if r: return r

    # 3. Premier provider activé (ordre stable)
    keys = sorted((user_settings.provider_keys or {}).keys())
    for prov in keys:
        r = _try(prov)
        if r: return r

    return None


async def _chat(messages: list[dict], model: str, provider_name: str,
                api_key: str, base_url: Optional[str],
                temperature: float = 0.7, max_tokens: int = 1024) -> tuple[str, dict]:
    """Appel LLM bas-niveau. Retourne (text, meta_dict)."""
    from backend.core.providers import get_provider
    from backend.core.providers.base import ChatMessage as CM
    llm = get_provider(provider_name, api_key, base_url)
    cm_msgs = [CM(role=m["role"], content=m["content"]) for m in messages]
    resp = await llm.chat(cm_msgs, model, temperature=temperature, max_tokens=max_tokens)
    text = (resp.content or "").strip() if resp else ""
    meta = {
        "model": model,
        "provider": provider_name,
        "tokens_input": getattr(resp, "tokens_input", 0) or 0,
        "tokens_output": getattr(resp, "tokens_output", 0) or 0,
    }
    return text, meta


# ── Executors ────────────────────────────────────────────────────────────

async def _llm_call(prompt: str, system: Optional[str] = None,
                    model: Optional[str] = None, provider: Optional[str] = None,
                    temperature: float = 0.7, max_tokens: int = 1024) -> dict:
    uid = get_user_context()
    if not uid:
        return {"ok": False, "error": "Utilisateur non authentifié."}
    if not (prompt or "").strip():
        return {"ok": False, "error": "Prompt vide."}
    resolved = await _resolve_provider(uid, provider, model)
    if not resolved:
        return {"ok": False, "error": "Aucun provider LLM compatible n'est configuré (Paramètres → Providers)."}
    msgs: list[dict] = []
    if system: msgs.append({"role": "system", "content": system})
    msgs.append({"role": "user", "content": prompt})
    try:
        text, meta = await _chat(msgs, resolved["model"], resolved["provider"],
                                 resolved["api_key"], resolved["base_url"],
                                 temperature=float(temperature), max_tokens=int(max_tokens))
    except Exception as e:
        logger.exception("[forge.llm] llm_call failed")
        return {"ok": False, "error": f"Appel LLM échoué : {e}"}
    return {"ok": True, "text": text, **meta}


# Capture le premier bloc JSON dans une réponse texte (le LLM ajoute
# souvent du blabla autour). On accepte aussi les fences ```json ... ```.
_JSON_BLOCK_RE = re.compile(r"```(?:json)?\s*(\{.*?\}|\[.*?\])\s*```", re.S | re.I)


def _extract_json(text: str) -> Any:
    """Tente plusieurs stratégies pour parser un JSON depuis une réponse LLM."""
    s = (text or "").strip()
    if not s:
        return None
    # 1. Fence ```json ... ```
    m = _JSON_BLOCK_RE.search(s)
    if m:
        try: return json.loads(m.group(1))
        except Exception: pass
    # 2. Le texte commence directement par { ou [
    if s[0] in "{[":
        try: return json.loads(s)
        except Exception: pass
    # 3. Cherche le premier { ou [ et tente jusqu'à la fin
    for ch in ("{", "["):
        i = s.find(ch)
        if i >= 0:
            for j in range(len(s), i, -1):
                try: return json.loads(s[i:j])
                except Exception: continue
    return None


async def _llm_extract(text: str, instruction: str,
                       schema_hint: Optional[str] = None,
                       model: Optional[str] = None,
                       provider: Optional[str] = None) -> dict:
    uid = get_user_context()
    if not uid:
        return {"ok": False, "error": "Utilisateur non authentifié."}
    resolved = await _resolve_provider(uid, provider, model)
    if not resolved:
        return {"ok": False, "error": "Aucun provider LLM compatible configuré."}
    sys_msg = (
        "Tu extrais des données structurées depuis du texte. Tu réponds UNIQUEMENT "
        "avec un objet JSON valide, sans aucun texte autour, sans markdown."
    )
    user_msg = f"Consigne : {instruction}\n\n"
    if schema_hint:
        user_msg += f"Format attendu (exemple) :\n{schema_hint}\n\n"
    user_msg += f"Texte source :\n{text}"
    msgs = [{"role": "system", "content": sys_msg}, {"role": "user", "content": user_msg}]
    try:
        raw, meta = await _chat(msgs, resolved["model"], resolved["provider"],
                                resolved["api_key"], resolved["base_url"],
                                temperature=0.0, max_tokens=2048)
    except Exception as e:
        return {"ok": False, "error": f"Appel LLM échoué : {e}"}
    parsed = _extract_json(raw)
    if parsed is None:
        return {"ok": False, "error": "Le modèle n'a pas retourné de JSON parsable.",
                "raw": raw[:500], **meta}
    return {"ok": True, "data": parsed, "raw": raw, **meta}


async def _llm_classify(text: str, categories: list,
                        instruction: Optional[str] = None,
                        model: Optional[str] = None,
                        provider: Optional[str] = None) -> dict:
    uid = get_user_context()
    if not uid:
        return {"ok": False, "error": "Utilisateur non authentifié."}
    if not isinstance(categories, list) or not categories:
        return {"ok": False, "error": "Liste de catégories vide ou invalide."}
    cat_clean = [str(c).strip() for c in categories if str(c).strip()]
    if not cat_clean:
        return {"ok": False, "error": "Catégories invalides après nettoyage."}
    resolved = await _resolve_provider(uid, provider, model)
    if not resolved:
        return {"ok": False, "error": "Aucun provider LLM compatible configuré."}
    cat_list = ", ".join(f'"{c}"' for c in cat_clean)
    sys_msg = (
        "Tu es un classifieur. Tu choisis EXACTEMENT une catégorie dans la liste fournie, "
        "et tu réponds UNIQUEMENT en JSON {\"category\": \"...\", \"confidence\": 0..1, "
        "\"reason\": \"...\"}. Pas de markdown, pas de texte autour."
    )
    user_msg = (
        f"Catégories possibles : [{cat_list}]\n"
        + (f"Critère : {instruction}\n" if instruction else "")
        + f"\nTexte à classifier :\n{text}"
    )
    msgs = [{"role": "system", "content": sys_msg}, {"role": "user", "content": user_msg}]
    try:
        raw, meta = await _chat(msgs, resolved["model"], resolved["provider"],
                                resolved["api_key"], resolved["base_url"],
                                temperature=0.0, max_tokens=200)
    except Exception as e:
        return {"ok": False, "error": f"Appel LLM échoué : {e}"}
    parsed = _extract_json(raw)
    if not isinstance(parsed, dict) or not parsed.get("category"):
        # Fallback : si le modèle a juste retourné une string proche d'une catégorie
        m_lower = raw.strip().lower()
        for c in cat_clean:
            if c.lower() in m_lower:
                return {"ok": True, "category": c, "confidence": 0.5,
                        "reason": "fallback string match", **meta}
        return {"ok": False, "error": "Réponse LLM non parsable.", "raw": raw[:300], **meta}
    cat = str(parsed.get("category", "")).strip()
    if cat not in cat_clean:
        # Le modèle a inventé une catégorie hors liste ; on tente un match approchant.
        for c in cat_clean:
            if cat.lower() == c.lower():
                cat = c
                break
        else:
            return {"ok": False, "error": f"Catégorie hors liste : '{cat}'", "raw": raw[:300], **meta}
    return {
        "ok": True,
        "category": cat,
        "confidence": float(parsed.get("confidence") or 0.5),
        "reason": parsed.get("reason") or "",
        **meta,
    }


LLM_EXECUTORS: dict[str, Any] = {
    "llm_call":     _llm_call,
    "llm_extract":  _llm_extract,
    "llm_classify": _llm_classify,
}
