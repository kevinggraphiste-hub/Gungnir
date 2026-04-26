"""
Analytics — agent_tools.py : permet à Gungnir de répondre aux questions
budget / coûts depuis le chat (« combien j'ai dépensé ce mois ? »).

Sans ces tools, ces données étaient lisibles uniquement via le dashboard
Analytics — l'agent ne pouvait pas les rapporter en langage naturel.

Convention auto-découverte : `TOOL_SCHEMAS` + `EXECUTORS` agrégés par
`backend/core/agents/wolf_tools.py` au boot.
"""
from __future__ import annotations

from typing import Any

from backend.core.agents.wolf_tools import get_user_context


# ── Schémas ──────────────────────────────────────────────────────────────

TOOL_SCHEMAS: list[dict] = [
    {
        "type": "function",
        "function": {
            "name": "cost_summary",
            "description": (
                "Renvoie le résumé de coûts (depuis le début) : coût total USD, "
                "tokens cumulés, nombre de messages, coût moyen par message. "
                "Pour des questions type « combien j'ai dépensé en tout »."
            ),
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "cost_by_model",
            "description": "Coûts ventilés par modèle (top dépensiers en haut). Pour « quel modèle me coûte le plus ».",
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "cost_by_provider",
            "description": "Coûts ventilés par provider (anthropic, openai, openrouter, ...). Top dépensiers en haut.",
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "cost_recent",
            "description": "Coûts journaliers des N derniers jours (default 7). Pour « combien j'ai dépensé cette semaine ».",
            "parameters": {
                "type": "object",
                "properties": {
                    "days": {"type": "integer", "description": "Nombre de jours à remonter (default 7).", "default": 7},
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "budget_status",
            "description": (
                "État budgétaire courant : limites mensuelle/hebdo, alertes "
                "(80%, 90%, 100%), should_block. Pour « est-ce que je suis "
                "près de mon budget ? »."
            ),
            "parameters": {"type": "object", "properties": {}},
        },
    },
]


# ── Helpers ──────────────────────────────────────────────────────────────

async def _with_session(fn):
    """Open a fresh DB session for one query, scoped to the calling user."""
    from backend.core.db.engine import async_session
    uid = get_user_context()
    if not uid:
        return {"ok": False, "error": "Utilisateur non authentifié."}
    async with async_session() as session:
        try:
            data = await fn(session, int(uid))
            return {"ok": True, **(data if isinstance(data, dict) else {"data": data})}
        except Exception as e:
            return {"ok": False, "error": str(e)[:300]}


def _cm():
    from backend.plugins.analytics.manager import get_cost_manager
    return get_cost_manager()


# ── Executors ────────────────────────────────────────────────────────────

async def _cost_summary() -> dict:
    async def _q(session, uid):
        return {"summary": await _cm().get_summary(session, uid)}
    return await _with_session(_q)


async def _cost_by_model() -> dict:
    async def _q(session, uid):
        return {"by_model": await _cm().get_by_model(session, uid)}
    return await _with_session(_q)


async def _cost_by_provider() -> dict:
    async def _q(session, uid):
        return {"by_provider": await _cm().get_by_provider(session, uid)}
    return await _with_session(_q)


async def _cost_recent(days: int = 7) -> dict:
    async def _q(session, uid):
        return {"days": int(days), "daily": await _cm().get_daily(session, int(days), uid)}
    return await _with_session(_q)


async def _budget_status() -> dict:
    async def _q(session, uid):
        budget = await _cm().get_budget(session, user_id=uid)
        check = await _cm().check_budgets(session, user_id=uid)
        return {"budget": budget, "alerts": check.get("alerts", []),
                "should_block": check.get("should_block", False),
                "block_reason": check.get("block_reason", "")}
    return await _with_session(_q)


EXECUTORS: dict[str, Any] = {
    "cost_summary": _cost_summary,
    "cost_by_model": _cost_by_model,
    "cost_by_provider": _cost_by_provider,
    "cost_recent": _cost_recent,
    "budget_status": _budget_status,
}
