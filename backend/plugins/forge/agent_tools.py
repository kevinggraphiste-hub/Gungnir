"""
Forge — agent_tools.py : outils WOLF pour piloter les workflows depuis le chat.

Auto-découvert par `backend/core/agents/wolf_tools._discover_plugin_tools`.

L'agent peut :
- lister/créer/modifier/supprimer des workflows
- les exécuter avec des inputs
- consulter l'historique des runs

Strict per-user : tous les accès filtrent sur `get_user_context()`.
"""
from __future__ import annotations

from datetime import datetime
from typing import Any, Optional

from backend.core.agents.wolf_tools import get_user_context
from .llm_tools import LLM_TOOL_SCHEMAS, LLM_EXECUTORS


TOOL_SCHEMAS: list[dict] = [
    {
        "type": "function",
        "function": {
            "name": "forge_list_workflows",
            "description": "Liste les workflows Forge de l'utilisateur (id, nom, tags, enabled).",
            "parameters": {"type": "object", "properties": {}, "required": []},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "forge_get_workflow",
            "description": "Récupère un workflow par ID — retourne son YAML complet + metadata.",
            "parameters": {
                "type": "object",
                "properties": {"workflow_id": {"type": "integer"}},
                "required": ["workflow_id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "forge_create_workflow",
            "description": (
                "Crée un nouveau workflow à partir d'un YAML. Le YAML doit contenir "
                "au minimum un champ 'steps' (liste de steps avec 'tool' ou 'parallel'). "
                "Variables : `{{ inputs.X }}` et `{{ steps.<id>.X }}`."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "name": {"type": "string", "description": "Nom du workflow."},
                    "description": {"type": "string"},
                    "yaml_def": {"type": "string", "description": "Définition YAML complète."},
                    "tags": {"type": "array", "items": {"type": "string"}},
                },
                "required": ["name", "yaml_def"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "forge_update_workflow",
            "description": "Met à jour un workflow (n'importe quel champ : name, description, yaml_def, enabled, tags).",
            "parameters": {
                "type": "object",
                "properties": {
                    "workflow_id": {"type": "integer"},
                    "name": {"type": "string"},
                    "description": {"type": "string"},
                    "yaml_def": {"type": "string"},
                    "enabled": {"type": "boolean"},
                    "tags": {"type": "array", "items": {"type": "string"}},
                },
                "required": ["workflow_id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "forge_delete_workflow",
            "description": "Supprime un workflow et tous ses runs (cascade).",
            "parameters": {
                "type": "object",
                "properties": {"workflow_id": {"type": "integer"}},
                "required": ["workflow_id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "forge_run_workflow",
            "description": (
                "Exécute un workflow et retourne le run complet (status, logs, output). "
                "Synchrone : peut prendre jusqu'à 5 minutes. Préférer pour des workflows "
                "courts ; pour des longs, créer puis interroger via forge_get_run."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "workflow_id": {"type": "integer"},
                    "inputs": {
                        "type": "object",
                        "description": "Variables d'entrée (accessibles via {{ inputs.X }} dans le YAML).",
                    },
                },
                "required": ["workflow_id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "forge_list_runs",
            "description": "Historique des exécutions (filtrable par workflow_id).",
            "parameters": {
                "type": "object",
                "properties": {
                    "workflow_id": {"type": "integer", "description": "Optionnel : filtre par workflow."},
                    "limit": {"type": "integer", "description": "Max résultats (default 20)."},
                },
                "required": [],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "forge_get_run",
            "description": "Détails complets d'une exécution (logs step-par-step + output).",
            "parameters": {
                "type": "object",
                "properties": {"run_id": {"type": "integer"}},
                "required": ["run_id"],
            },
        },
    },
]


# ── Helpers ───────────────────────────────────────────────────────────────

def _serialize_wf_summary(w) -> dict:
    return {
        "id": w.id,
        "name": w.name,
        "description": w.description or "",
        "enabled": bool(w.enabled),
        "tags": list(w.tags_json or []),
        "updated_at": w.updated_at.isoformat() if w.updated_at else None,
    }


def _serialize_run(r) -> dict:
    return {
        "id": r.id,
        "workflow_id": r.workflow_id,
        "status": r.status,
        "error": r.error or "",
        "trigger_source": r.trigger_source or "manual",
        "started_at": r.started_at.isoformat() if r.started_at else None,
        "finished_at": r.finished_at.isoformat() if r.finished_at else None,
        "logs": r.logs_json or [],
        "output": r.output_json or {},
    }


# ── Executors ────────────────────────────────────────────────────────────

async def _forge_list_workflows() -> dict:
    uid = get_user_context()
    if not uid:
        return {"ok": False, "error": "Utilisateur non authentifié."}
    from backend.core.db.engine import async_session
    from .models import ForgeWorkflow
    from sqlalchemy import select
    async with async_session() as session:
        rs = await session.execute(
            select(ForgeWorkflow).where(ForgeWorkflow.user_id == uid)
            .order_by(ForgeWorkflow.updated_at.desc())
        )
        return {"ok": True, "workflows": [_serialize_wf_summary(w) for w in rs.scalars().all()]}


async def _forge_get_workflow(workflow_id: int) -> dict:
    uid = get_user_context()
    if not uid:
        return {"ok": False, "error": "Utilisateur non authentifié."}
    from backend.core.db.engine import async_session
    from .models import ForgeWorkflow
    from sqlalchemy import select
    async with async_session() as session:
        rs = await session.execute(
            select(ForgeWorkflow).where(
                ForgeWorkflow.id == workflow_id, ForgeWorkflow.user_id == uid,
            )
        )
        w = rs.scalar_one_or_none()
        if not w:
            return {"ok": False, "error": "Workflow introuvable."}
        return {
            "ok": True,
            "workflow": {
                **_serialize_wf_summary(w),
                "yaml_def": w.yaml_def or "",
            },
        }


async def _forge_create_workflow(name: str, yaml_def: str,
                                 description: str = "",
                                 tags: Optional[list] = None) -> dict:
    uid = get_user_context()
    if not uid:
        return {"ok": False, "error": "Utilisateur non authentifié."}
    from .runner import parse_workflow_yaml
    try:
        parse_workflow_yaml(yaml_def)
    except ValueError as e:
        return {"ok": False, "error": f"YAML invalide : {e}"}
    from backend.core.db.engine import async_session
    from .models import ForgeWorkflow
    async with async_session() as session:
        w = ForgeWorkflow(
            user_id=uid, name=name, description=description or "",
            yaml_def=yaml_def, tags_json=list(tags or []),
        )
        session.add(w)
        await session.commit()
        await session.refresh(w)
        return {"ok": True, "workflow_id": w.id, "name": w.name}


async def _forge_update_workflow(workflow_id: int,
                                 name: Optional[str] = None,
                                 description: Optional[str] = None,
                                 yaml_def: Optional[str] = None,
                                 enabled: Optional[bool] = None,
                                 tags: Optional[list] = None) -> dict:
    uid = get_user_context()
    if not uid:
        return {"ok": False, "error": "Utilisateur non authentifié."}
    from backend.core.db.engine import async_session
    from .models import ForgeWorkflow
    from .runner import parse_workflow_yaml
    from sqlalchemy import select
    if yaml_def is not None:
        try:
            parse_workflow_yaml(yaml_def)
        except ValueError as e:
            return {"ok": False, "error": f"YAML invalide : {e}"}
    async with async_session() as session:
        rs = await session.execute(
            select(ForgeWorkflow).where(
                ForgeWorkflow.id == workflow_id, ForgeWorkflow.user_id == uid,
            )
        )
        w = rs.scalar_one_or_none()
        if not w:
            return {"ok": False, "error": "Workflow introuvable."}
        if name is not None: w.name = name
        if description is not None: w.description = description
        if yaml_def is not None: w.yaml_def = yaml_def
        if enabled is not None: w.enabled = bool(enabled)
        if tags is not None: w.tags_json = list(tags)
        w.updated_at = datetime.utcnow()
        await session.commit()
        return {"ok": True, "workflow_id": w.id}


async def _forge_delete_workflow(workflow_id: int) -> dict:
    uid = get_user_context()
    if not uid:
        return {"ok": False, "error": "Utilisateur non authentifié."}
    from backend.core.db.engine import async_session
    from .models import ForgeWorkflow
    from sqlalchemy import select
    async with async_session() as session:
        rs = await session.execute(
            select(ForgeWorkflow).where(
                ForgeWorkflow.id == workflow_id, ForgeWorkflow.user_id == uid,
            )
        )
        w = rs.scalar_one_or_none()
        if not w:
            return {"ok": False, "error": "Workflow introuvable."}
        await session.delete(w)
        await session.commit()
        return {"ok": True}


async def _forge_run_workflow(workflow_id: int, inputs: Optional[dict] = None) -> dict:
    uid = get_user_context()
    if not uid:
        return {"ok": False, "error": "Utilisateur non authentifié."}
    from backend.core.db.engine import async_session
    from .models import ForgeWorkflow, ForgeWorkflowRun
    from .runner import run_workflow
    from sqlalchemy import select
    async with async_session() as session:
        rs = await session.execute(
            select(ForgeWorkflow).where(
                ForgeWorkflow.id == workflow_id, ForgeWorkflow.user_id == uid,
            )
        )
        w = rs.scalar_one_or_none()
        if not w:
            return {"ok": False, "error": "Workflow introuvable."}
        if not w.enabled:
            return {"ok": False, "error": "Workflow désactivé."}
        run_row = ForgeWorkflowRun(
            workflow_id=w.id, user_id=uid, status="running",
            inputs_json=inputs or {}, trigger_source="agent",
        )
        session.add(run_row)
        await session.commit()
        await session.refresh(run_row)

        res = await run_workflow(w.yaml_def, inputs or {})

        run_row.status = res.status
        run_row.logs_json = res.logs
        run_row.output_json = res.output if isinstance(res.output, dict) else {"value": res.output}
        run_row.error = res.error or ""
        run_row.finished_at = datetime.utcnow()
        await session.commit()
        await session.refresh(run_row)
        return {
            "ok": res.status == "success",
            "run_id": run_row.id,
            "status": res.status,
            "output": run_row.output_json,
            "error": res.error or None,
            "step_count": len([l for l in res.logs if l.get("type") == "end"]),
        }


async def _forge_list_runs(workflow_id: Optional[int] = None,
                           limit: int = 20) -> dict:
    uid = get_user_context()
    if not uid:
        return {"ok": False, "error": "Utilisateur non authentifié."}
    from backend.core.db.engine import async_session
    from .models import ForgeWorkflowRun
    from sqlalchemy import select
    async with async_session() as session:
        q = select(ForgeWorkflowRun).where(ForgeWorkflowRun.user_id == uid)
        if workflow_id:
            q = q.where(ForgeWorkflowRun.workflow_id == workflow_id)
        q = q.order_by(ForgeWorkflowRun.started_at.desc()).limit(min(100, max(1, limit)))
        rs = await session.execute(q)
        rows = rs.scalars().all()
        # Logs allégés ici (l'agent demandera get_run pour le détail).
        return {
            "ok": True,
            "runs": [
                {
                    "id": r.id, "workflow_id": r.workflow_id, "status": r.status,
                    "error": r.error or "",
                    "started_at": r.started_at.isoformat() if r.started_at else None,
                    "finished_at": r.finished_at.isoformat() if r.finished_at else None,
                }
                for r in rows
            ],
        }


async def _forge_get_run(run_id: int) -> dict:
    uid = get_user_context()
    if not uid:
        return {"ok": False, "error": "Utilisateur non authentifié."}
    from backend.core.db.engine import async_session
    from .models import ForgeWorkflowRun
    from sqlalchemy import select
    async with async_session() as session:
        rs = await session.execute(
            select(ForgeWorkflowRun).where(
                ForgeWorkflowRun.id == run_id, ForgeWorkflowRun.user_id == uid,
            )
        )
        r = rs.scalar_one_or_none()
        if not r:
            return {"ok": False, "error": "Run introuvable."}
        return {"ok": True, "run": _serialize_run(r)}


EXECUTORS: dict[str, Any] = {
    "forge_list_workflows":  _forge_list_workflows,
    "forge_get_workflow":    _forge_get_workflow,
    "forge_create_workflow": _forge_create_workflow,
    "forge_update_workflow": _forge_update_workflow,
    "forge_delete_workflow": _forge_delete_workflow,
    "forge_run_workflow":    _forge_run_workflow,
    "forge_list_runs":       _forge_list_runs,
    "forge_get_run":         _forge_get_run,
    # Tools LLM exposés aussi via le forge plugin pour profiter de
    # l'auto-discovery — utiles dans les workflows mais aussi accessibles
    # aux sous-agents et au super-agent en chat normal.
    **LLM_EXECUTORS,
}

# Concatène les schemas LLM pour qu'ils soient découvert au boot.
TOOL_SCHEMAS = TOOL_SCHEMAS + LLM_TOOL_SCHEMAS
