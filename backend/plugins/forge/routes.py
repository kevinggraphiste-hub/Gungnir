"""
Forge — API routes (CRUD per-user + run).

Strict per-user via `request.state.user_id` + filtre `ForgeWorkflow.user_id == uid`
sur chaque requête. Un user ne peut JAMAIS voir/lancer le workflow d'un autre.
"""
from __future__ import annotations

import logging
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy import select, delete as _sqldelete
from sqlalchemy.ext.asyncio import AsyncSession

from backend.core.db.engine import get_session
from backend.core.api.auth_helpers import open_mode_fallback_user_id

from .models import ForgeWorkflow, ForgeWorkflowRun
from .runner import run_workflow, parse_workflow_yaml
from backend.core.agents.wolf_tools import (
    WOLF_TOOL_SCHEMAS,
    set_user_context,
    get_user_context,
)

logger = logging.getLogger("gungnir.plugins.forge")
router = APIRouter()


async def _uid(request: Request, session: AsyncSession) -> int:
    uid = getattr(request.state, "user_id", None)
    if uid:
        return int(uid)
    fb = await open_mode_fallback_user_id(session)
    return int(fb) if fb else 0


def _require_uid(uid: int):
    if not uid:
        raise HTTPException(status_code=401, detail="Authentification requise")


# ── Pydantic ──────────────────────────────────────────────────────────────

class WorkflowIn(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    yaml_def: Optional[str] = None
    enabled: Optional[bool] = None
    tags: Optional[list] = None
    canvas_state: Optional[dict] = None


class RunIn(BaseModel):
    inputs: Optional[dict] = None


# ── Serialization ─────────────────────────────────────────────────────────

def _serialize_wf(w: ForgeWorkflow) -> dict:
    return {
        "id": w.id,
        "name": w.name,
        "description": w.description or "",
        "yaml_def": w.yaml_def or "",
        "enabled": bool(w.enabled),
        "tags": list(w.tags_json or []),
        "canvas_state": w.canvas_state,
        "created_at": w.created_at.isoformat() if w.created_at else None,
        "updated_at": w.updated_at.isoformat() if w.updated_at else None,
    }


def _serialize_run(r: ForgeWorkflowRun) -> dict:
    return {
        "id": r.id,
        "workflow_id": r.workflow_id,
        "status": r.status,
        "inputs": r.inputs_json or {},
        "output": r.output_json or {},
        "logs": r.logs_json or [],
        "error": r.error or "",
        "trigger_source": r.trigger_source or "manual",
        "started_at": r.started_at.isoformat() if r.started_at else None,
        "finished_at": r.finished_at.isoformat() if r.finished_at else None,
        "duration_ms": (
            int((r.finished_at - r.started_at).total_seconds() * 1000)
            if r.finished_at and r.started_at else None
        ),
    }


# ── Routes ────────────────────────────────────────────────────────────────

@router.get("/health")
async def health():
    return {"ok": True, "plugin": "forge"}


@router.get("/tools")
async def list_available_tools(request: Request,
                               session: AsyncSession = Depends(get_session)):
    """Catalogue des outils disponibles pour les workflows (auto-discovery
    depuis le registre WOLF). Utilisé par l'UI pour proposer l'autocomplete
    sur le champ `tool:` et générer les nodes du futur canvas."""
    uid = await _uid(request, session)
    _require_uid(uid)
    tools = []
    for s in WOLF_TOOL_SCHEMAS:
        fn = s.get("function") or {}
        params = (fn.get("parameters") or {}).get("properties") or {}
        required = (fn.get("parameters") or {}).get("required") or []
        tools.append({
            "name": fn.get("name", ""),
            "description": fn.get("description", ""),
            "params": [
                {"name": k, "type": (v or {}).get("type", "any"),
                 "description": (v or {}).get("description", ""),
                 "required": k in required}
                for k, v in params.items()
            ],
        })
    tools.sort(key=lambda t: t["name"])
    return {"ok": True, "count": len(tools), "tools": tools}


@router.get("/workflows")
async def list_workflows(request: Request,
                         session: AsyncSession = Depends(get_session)):
    uid = await _uid(request, session)
    _require_uid(uid)
    rs = await session.execute(
        select(ForgeWorkflow).where(ForgeWorkflow.user_id == uid)
        .order_by(ForgeWorkflow.updated_at.desc())
    )
    return {
        "ok": True,
        "workflows": [_serialize_wf(w) for w in rs.scalars().all()],
    }


@router.get("/workflows/{wf_id}")
async def get_workflow(wf_id: int, request: Request,
                       session: AsyncSession = Depends(get_session)):
    uid = await _uid(request, session)
    _require_uid(uid)
    rs = await session.execute(
        select(ForgeWorkflow).where(
            ForgeWorkflow.id == wf_id, ForgeWorkflow.user_id == uid,
        )
    )
    w = rs.scalar_one_or_none()
    if not w:
        raise HTTPException(status_code=404, detail="Workflow introuvable")
    return {"ok": True, "workflow": _serialize_wf(w)}


@router.post("/workflows")
async def create_workflow(body: WorkflowIn, request: Request,
                          session: AsyncSession = Depends(get_session)):
    uid = await _uid(request, session)
    _require_uid(uid)
    if body.yaml_def:
        try:
            parse_workflow_yaml(body.yaml_def)
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))
    w = ForgeWorkflow(
        user_id=uid,
        name=body.name or "Nouveau workflow",
        description=body.description or "",
        yaml_def=body.yaml_def or _DEFAULT_YAML,
        enabled=True if body.enabled is None else bool(body.enabled),
        tags_json=list(body.tags or []),
        canvas_state=body.canvas_state,
    )
    session.add(w)
    await session.commit()
    await session.refresh(w)
    return {"ok": True, "workflow": _serialize_wf(w)}


@router.put("/workflows/{wf_id}")
async def update_workflow(wf_id: int, body: WorkflowIn, request: Request,
                          session: AsyncSession = Depends(get_session)):
    uid = await _uid(request, session)
    _require_uid(uid)
    rs = await session.execute(
        select(ForgeWorkflow).where(
            ForgeWorkflow.id == wf_id, ForgeWorkflow.user_id == uid,
        )
    )
    w = rs.scalar_one_or_none()
    if not w:
        raise HTTPException(status_code=404, detail="Workflow introuvable")
    if body.name is not None:
        w.name = body.name
    if body.description is not None:
        w.description = body.description
    if body.yaml_def is not None:
        try:
            parse_workflow_yaml(body.yaml_def)
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))
        w.yaml_def = body.yaml_def
    if body.enabled is not None:
        w.enabled = bool(body.enabled)
    if body.tags is not None:
        w.tags_json = list(body.tags)
    if body.canvas_state is not None:
        w.canvas_state = body.canvas_state
    w.updated_at = datetime.utcnow()
    await session.commit()
    await session.refresh(w)
    return {"ok": True, "workflow": _serialize_wf(w)}


@router.delete("/workflows/{wf_id}")
async def delete_workflow(wf_id: int, request: Request,
                          session: AsyncSession = Depends(get_session)):
    uid = await _uid(request, session)
    _require_uid(uid)
    rs = await session.execute(
        select(ForgeWorkflow).where(
            ForgeWorkflow.id == wf_id, ForgeWorkflow.user_id == uid,
        )
    )
    w = rs.scalar_one_or_none()
    if not w:
        raise HTTPException(status_code=404, detail="Workflow introuvable")
    await session.delete(w)
    await session.commit()
    return {"ok": True}


@router.post("/workflows/{wf_id}/run")
async def run(wf_id: int, body: RunIn, request: Request,
              session: AsyncSession = Depends(get_session)):
    """Exécute un workflow synchroniquement. Phase 2 ajoutera un worker
    async + streaming SSE des logs."""
    uid = await _uid(request, session)
    _require_uid(uid)
    rs = await session.execute(
        select(ForgeWorkflow).where(
            ForgeWorkflow.id == wf_id, ForgeWorkflow.user_id == uid,
        )
    )
    w = rs.scalar_one_or_none()
    if not w:
        raise HTTPException(status_code=404, detail="Workflow introuvable")
    if not w.enabled:
        raise HTTPException(status_code=400, detail="Workflow désactivé")
    run_row = ForgeWorkflowRun(
        workflow_id=w.id, user_id=uid, status="running",
        inputs_json=body.inputs or {}, trigger_source="manual",
    )
    session.add(run_row)
    await session.commit()
    await session.refresh(run_row)

    # Bind le contexte user pour que les wolf_tools héritent du bon uid.
    # On sauvegarde l'ancienne valeur pour ne pas casser un éventuel
    # contexte parent (ex: agent qui appelle Forge via tool-calling).
    prev_uid = get_user_context()
    set_user_context(uid)
    try:
        res = await run_workflow(w.yaml_def, body.inputs or {})
    finally:
        set_user_context(prev_uid)

    run_row.status = res.status
    run_row.logs_json = res.logs
    run_row.output_json = res.output if isinstance(res.output, dict) else {"value": res.output}
    run_row.error = res.error or ""
    run_row.finished_at = datetime.utcnow()
    await session.commit()
    await session.refresh(run_row)
    return {"ok": True, "run": _serialize_run(run_row)}


@router.get("/runs")
async def list_runs(request: Request, workflow_id: Optional[int] = None,
                    limit: int = 50,
                    session: AsyncSession = Depends(get_session)):
    uid = await _uid(request, session)
    _require_uid(uid)
    q = select(ForgeWorkflowRun).where(ForgeWorkflowRun.user_id == uid)
    if workflow_id:
        q = q.where(ForgeWorkflowRun.workflow_id == workflow_id)
    q = q.order_by(ForgeWorkflowRun.started_at.desc()).limit(min(200, max(1, limit)))
    rs = await session.execute(q)
    return {"ok": True, "runs": [_serialize_run(r) for r in rs.scalars().all()]}


@router.get("/runs/{run_id}")
async def get_run(run_id: int, request: Request,
                  session: AsyncSession = Depends(get_session)):
    uid = await _uid(request, session)
    _require_uid(uid)
    rs = await session.execute(
        select(ForgeWorkflowRun).where(
            ForgeWorkflowRun.id == run_id, ForgeWorkflowRun.user_id == uid,
        )
    )
    r = rs.scalar_one_or_none()
    if not r:
        raise HTTPException(status_code=404, detail="Run introuvable")
    return {"ok": True, "run": _serialize_run(r)}


@router.delete("/runs/{run_id}")
async def delete_run(run_id: int, request: Request,
                     session: AsyncSession = Depends(get_session)):
    uid = await _uid(request, session)
    _require_uid(uid)
    await session.execute(
        _sqldelete(ForgeWorkflowRun).where(
            ForgeWorkflowRun.id == run_id, ForgeWorkflowRun.user_id == uid,
        )
    )
    await session.commit()
    return {"ok": True}


# ── Default YAML pour nouveaux workflows ──────────────────────────────────

_DEFAULT_YAML = """\
# Nouveau workflow Forge
#
# Variables : {{ inputs.X }} ou {{ steps.<id>.X }}
# Conditions : if: "{{ steps.s1.ok }}"
# Parallèle : parallel: [{tool: ...}, {tool: ...}]

name: Mon premier workflow
description: Exemple — récupère une URL et affiche le résultat.

inputs:
  url:
    type: string
    default: https://example.com

steps:
  - id: fetch
    tool: web_fetch
    args:
      url: "{{ inputs.url }}"
      max_chars: 500
"""
