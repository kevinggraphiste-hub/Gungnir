"""
Conscience — agent_tools.py : permet à Gungnir de manipuler sa propre
conscience via tool-calling.

Sans ces tools, l'agent peut LIRE l'état (via le bloc conscience injecté dans
son system prompt) mais ne peut pas ÉCRIRE — donc « ajoute en mémoire que… »
restait du verbal sans persistance. Ces 6 tools comblent le gap.

Convention auto-découverte : `TOOL_SCHEMAS` + `EXECUTORS` agrégés par
`backend/core/agents/wolf_tools.py` au boot.
"""
from __future__ import annotations

from typing import Any

from backend.core.agents.wolf_tools import get_user_context


# ── Schémas OpenAI-compatible exposés au LLM ──────────────────────────────

TOOL_SCHEMAS: list[dict] = [
    {
        "type": "function",
        "function": {
            "name": "consciousness_remember",
            "description": (
                "Stocke un souvenir / une préférence / un fait dans la "
                "mémoire de travail de Gungnir. Sera retrouvé automatiquement "
                "via recall sémantique aux échanges futurs. Utilise dès que "
                "l'utilisateur dit « note que… », « rappelle-toi de… », "
                "« j'aime / je n'aime pas… », ou tout fait pertinent à "
                "long-terme."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "key": {"type": "string", "description": "Identifiant court (snake_case) du souvenir, ex: `prefere_python`."},
                    "value": {"type": "string", "description": "Contenu textuel du souvenir, en français, complet et auto-suffisant."},
                    "category": {"type": "string", "description": "Catégorie libre (ex: preference, fact, context, decision)", "default": "context"},
                },
                "required": ["key", "value"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "consciousness_recall",
            "description": (
                "Cherche des souvenirs sémantiquement proches d'une requête "
                "dans la mémoire vectorielle (Qdrant). Renvoie jusqu'à `top_k` "
                "souvenirs avec score de similarité. Utilise quand tu as "
                "besoin de retrouver un fait passé que tu ne vois pas dans "
                "le contexte courant."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "Texte de la requête sémantique."},
                    "top_k": {"type": "integer", "description": "Nombre max de souvenirs à retourner (default 5).", "default": 5},
                    "collection": {"type": "string", "description": "Collection cible (`memories`, `thoughts`, `interactions`)", "default": "memories"},
                },
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "consciousness_list_goals",
            "description": "Liste les goals actifs de Gungnir (objectifs moyen/long terme dérivés des besoins persistants).",
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "consciousness_list_findings",
            "description": "Liste les findings récents du Challenger (auto-critiques : biais, contradictions, verbosity, etc.). Inclut les résolus si `include_resolved=true`.",
            "parameters": {
                "type": "object",
                "properties": {
                    "limit": {"type": "integer", "description": "Nombre max (default 10).", "default": 10},
                    "include_resolved": {"type": "boolean", "description": "Inclure les findings déjà résolus.", "default": False},
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "consciousness_status",
            "description": "Renvoie l'état actuel : mood, top besoins (urgence × priorité), kill-switch tier, pending_impulse, stats.",
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "consciousness_trigger_need",
            "description": (
                "Déclenche manuellement un trigger d'événement (ex: `new_pattern`, "
                "`contradiction_found`, `feature_needed`). Pousse l'urgence du "
                "besoin associé. À utiliser quand tu observes un signal pertinent "
                "que le bus d'events automatique ne capte pas."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "trigger": {"type": "string", "description": "Nom du trigger (ex: `new_pattern`, `error_in_logs`, `feature_needed`, etc.)"},
                    "entity_id": {"type": "string", "description": "Identifiant optionnel pour cooldown par entité (ex: une carte Valkyrie)."},
                },
                "required": ["trigger"],
            },
        },
    },
]


# ── Executors ────────────────────────────────────────────────────────────

def _engine():
    from backend.plugins.consciousness.engine import consciousness_manager
    uid = get_user_context()
    if not uid:
        return None, "Utilisateur non authentifié."
    eng = consciousness_manager.get(int(uid))
    if not eng.enabled:
        return None, "Conscience désactivée pour cet utilisateur."
    return eng, None


async def _consciousness_remember(key: str, value: str, category: str = "context") -> dict:
    eng, err = _engine()
    if err:
        return {"ok": False, "error": err}
    try:
        eng.add_to_working_memory(key=key, value=value, category=category)
        return {"ok": True, "stored": {"key": key, "category": category, "value": value[:200]}}
    except Exception as e:
        return {"ok": False, "error": str(e)[:300]}


async def _consciousness_recall(query: str, top_k: int = 5, collection: str = "memories") -> dict:
    eng, err = _engine()
    if err:
        return {"ok": False, "error": err}
    try:
        results = await eng.vector_recall(query, top_k=top_k, collection=collection)
        return {
            "ok": True,
            "count": len(results),
            "results": [
                {
                    "text": r.get("text") or r.get("content") or "",
                    "metadata": r.get("metadata") or {},
                    "score": r.get("score"),
                }
                for r in results
            ],
        }
    except Exception as e:
        return {"ok": False, "error": str(e)[:300]}


async def _consciousness_list_goals() -> dict:
    eng, err = _engine()
    if err:
        return {"ok": False, "error": err}
    try:
        goals = eng.get_active_goals(limit=20) if hasattr(eng, "get_active_goals") else []
        return {"ok": True, "count": len(goals), "goals": goals}
    except Exception as e:
        return {"ok": False, "error": str(e)[:300]}


async def _consciousness_list_findings(limit: int = 10, include_resolved: bool = False) -> dict:
    eng, err = _engine()
    if err:
        return {"ok": False, "error": err}
    try:
        findings = eng.get_recent_findings(limit=limit) if hasattr(eng, "get_recent_findings") else []
        if not include_resolved:
            findings = [f for f in findings if not f.get("resolved_at")]
        return {"ok": True, "count": len(findings), "findings": findings}
    except Exception as e:
        return {"ok": False, "error": str(e)[:300]}


async def _consciousness_status() -> dict:
    eng, err = _engine()
    if err:
        return {"ok": False, "error": err}
    try:
        urgencies = eng.calculate_urgencies() or {}
        # Top 3 besoins par score (priority × urgency)
        top_needs = list(urgencies.items())[:3]
        state = eng.state or {}
        return {
            "ok": True,
            "mood": state.get("mood", "neutre"),
            "top_needs": [
                {"name": name, "urgency": data.get("urgency"), "priority": data.get("priority"), "score": data.get("score")}
                for name, data in top_needs
            ],
            "pending_impulse": (state.get("volition") or {}).get("pending_impulse"),
            "kill_switch_tier": state.get("safety_tier", "OK"),
            "stats": state.get("stats", {}),
        }
    except Exception as e:
        return {"ok": False, "error": str(e)[:300]}


async def _consciousness_trigger_need(trigger: str, entity_id: str | None = None) -> dict:
    uid = get_user_context()
    if not uid:
        return {"ok": False, "error": "Utilisateur non authentifié."}
    try:
        from backend.plugins.consciousness.triggers import emit_trigger
        emitted = await emit_trigger(int(uid), trigger, entity_id=entity_id)
        return {"ok": True, "emitted": bool(emitted), "trigger": trigger, "entity_id": entity_id}
    except Exception as e:
        return {"ok": False, "error": str(e)[:300]}


EXECUTORS: dict[str, Any] = {
    "consciousness_remember": _consciousness_remember,
    "consciousness_recall": _consciousness_recall,
    "consciousness_list_goals": _consciousness_list_goals,
    "consciousness_list_findings": _consciousness_list_findings,
    "consciousness_status": _consciousness_status,
    "consciousness_trigger_need": _consciousness_trigger_need,
}
