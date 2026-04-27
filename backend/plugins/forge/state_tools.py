"""
Forge — wolf_tools pour les variables globales et static data.

- Globals : user-scoped, partagés entre tous les workflows de l'user.
  Accessibles dans le runner via `{{ globals.<key> }}`.
- Static : workflow-scoped, persistant entre runs (compteurs, last_id…).
  Accessibles via `{{ static.<key> }}` quand le workflow_id du runner
  est renseigné dans le contexte (passé par routes.py).

Strict per-user pour les deux. Les écritures passent par le tool dédié
(jamais en interpolation YAML, par sécurité).
"""
from __future__ import annotations

import logging
from typing import Any, Optional

from backend.core.agents.wolf_tools import get_user_context

logger = logging.getLogger("gungnir.plugins.forge.state_tools")


STATE_TOOL_SCHEMAS: list[dict] = [
    {
        "type": "function",
        "function": {
            "name": "forge_set_global",
            "description": "Définit (ou met à jour) une variable globale user-scoped, accessible dans tous tes workflows via {{ globals.<key> }}.",
            "parameters": {
                "type": "object",
                "properties": {
                    "key": {"type": "string"},
                    "value": {"description": "Valeur (string/number/object/array)."},
                },
                "required": ["key", "value"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "forge_get_global",
            "description": "Lit une variable globale par clé.",
            "parameters": {
                "type": "object",
                "properties": {"key": {"type": "string"}},
                "required": ["key"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "forge_list_globals",
            "description": "Liste toutes les variables globales de l'user.",
            "parameters": {"type": "object", "properties": {}, "required": []},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "forge_delete_global",
            "description": "Supprime une variable globale.",
            "parameters": {
                "type": "object",
                "properties": {"key": {"type": "string"}},
                "required": ["key"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "forge_set_static",
            "description": "Stocke une donnée persistante scopée à un workflow (compteur, last_id…). Lecture via {{ static.<key> }} pendant l'exécution.",
            "parameters": {
                "type": "object",
                "properties": {
                    "workflow_id": {"type": "integer"},
                    "key": {"type": "string"},
                    "value": {},
                },
                "required": ["workflow_id", "key", "value"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "forge_get_static",
            "description": "Lit une static data par (workflow_id, key).",
            "parameters": {
                "type": "object",
                "properties": {
                    "workflow_id": {"type": "integer"},
                    "key": {"type": "string"},
                },
                "required": ["workflow_id", "key"],
            },
        },
    },
]


# ── Helpers DB ───────────────────────────────────────────────────────────

async def _all_globals_for_user(user_id: int) -> dict:
    """Charge tous les globals de l'user en dict {key: value}.
    Utilisé par le runner pour exposer ctx.globals au YAML."""
    from backend.core.db.engine import async_session
    from .models import ForgeGlobal
    from sqlalchemy import select
    async with async_session() as session:
        rs = await session.execute(
            select(ForgeGlobal).where(ForgeGlobal.user_id == user_id)
        )
        return {g.key: g.value_json for g in rs.scalars().all()}


async def _all_static_for_workflow(user_id: int, workflow_id: int) -> dict:
    from backend.core.db.engine import async_session
    from .models import ForgeStatic
    from sqlalchemy import select
    async with async_session() as session:
        rs = await session.execute(
            select(ForgeStatic).where(
                ForgeStatic.user_id == user_id,
                ForgeStatic.workflow_id == workflow_id,
            )
        )
        return {s.key: s.value_json for s in rs.scalars().all()}


# ── Executors ────────────────────────────────────────────────────────────

async def _set_global(key: str, value: Any) -> dict:
    uid = get_user_context()
    if not uid:
        return {"ok": False, "error": "Utilisateur non authentifié."}
    if not key or not key.strip():
        return {"ok": False, "error": "Clé vide."}
    from backend.core.db.engine import async_session
    from .models import ForgeGlobal
    from sqlalchemy import select
    async with async_session() as session:
        rs = await session.execute(
            select(ForgeGlobal).where(
                ForgeGlobal.user_id == uid, ForgeGlobal.key == key.strip(),
            )
        )
        row = rs.scalar_one_or_none()
        if row:
            row.value_json = value
        else:
            session.add(ForgeGlobal(user_id=uid, key=key.strip(), value_json=value))
        await session.commit()
        return {"ok": True, "key": key.strip()}


async def _get_global(key: str) -> dict:
    uid = get_user_context()
    if not uid:
        return {"ok": False, "error": "Utilisateur non authentifié."}
    from backend.core.db.engine import async_session
    from .models import ForgeGlobal
    from sqlalchemy import select
    async with async_session() as session:
        rs = await session.execute(
            select(ForgeGlobal).where(
                ForgeGlobal.user_id == uid, ForgeGlobal.key == key,
            )
        )
        row = rs.scalar_one_or_none()
        if not row:
            return {"ok": False, "error": "Variable introuvable."}
        return {"ok": True, "key": row.key, "value": row.value_json}


async def _list_globals() -> dict:
    uid = get_user_context()
    if not uid:
        return {"ok": False, "error": "Utilisateur non authentifié."}
    data = await _all_globals_for_user(uid)
    return {"ok": True, "globals": [{"key": k, "value": v} for k, v in data.items()]}


async def _delete_global(key: str) -> dict:
    uid = get_user_context()
    if not uid:
        return {"ok": False, "error": "Utilisateur non authentifié."}
    from backend.core.db.engine import async_session
    from .models import ForgeGlobal
    from sqlalchemy import delete as _del
    async with async_session() as session:
        await session.execute(
            _del(ForgeGlobal).where(
                ForgeGlobal.user_id == uid, ForgeGlobal.key == key,
            )
        )
        await session.commit()
        return {"ok": True}


async def _set_static(workflow_id: int, key: str, value: Any) -> dict:
    uid = get_user_context()
    if not uid:
        return {"ok": False, "error": "Utilisateur non authentifié."}
    from backend.core.db.engine import async_session
    from .models import ForgeStatic, ForgeWorkflow
    from sqlalchemy import select
    async with async_session() as session:
        # Vérifie ownership du workflow
        wf_rs = await session.execute(
            select(ForgeWorkflow).where(
                ForgeWorkflow.id == workflow_id, ForgeWorkflow.user_id == uid,
            )
        )
        if not wf_rs.scalar_one_or_none():
            return {"ok": False, "error": "Workflow introuvable."}
        rs = await session.execute(
            select(ForgeStatic).where(
                ForgeStatic.user_id == uid,
                ForgeStatic.workflow_id == workflow_id,
                ForgeStatic.key == key,
            )
        )
        row = rs.scalar_one_or_none()
        if row:
            row.value_json = value
        else:
            session.add(ForgeStatic(user_id=uid, workflow_id=workflow_id,
                                    key=key, value_json=value))
        await session.commit()
        return {"ok": True}


async def _get_static(workflow_id: int, key: str) -> dict:
    uid = get_user_context()
    if not uid:
        return {"ok": False, "error": "Utilisateur non authentifié."}
    from backend.core.db.engine import async_session
    from .models import ForgeStatic
    from sqlalchemy import select
    async with async_session() as session:
        rs = await session.execute(
            select(ForgeStatic).where(
                ForgeStatic.user_id == uid,
                ForgeStatic.workflow_id == workflow_id,
                ForgeStatic.key == key,
            )
        )
        row = rs.scalar_one_or_none()
        if not row:
            return {"ok": False, "error": "Static introuvable."}
        return {"ok": True, "key": row.key, "value": row.value_json}


STATE_EXECUTORS: dict[str, Any] = {
    "forge_set_global":    _set_global,
    "forge_get_global":    _get_global,
    "forge_list_globals":  _list_globals,
    "forge_delete_global": _delete_global,
    "forge_set_static":    _set_static,
    "forge_get_static":    _get_static,
}
