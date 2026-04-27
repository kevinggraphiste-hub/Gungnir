"""
Forge — API routes (CRUD per-user + run).

Strict per-user via `request.state.user_id` + filtre `ForgeWorkflow.user_id == uid`
sur chaque requête. Un user ne peut JAMAIS voir/lancer le workflow d'un autre.
"""
from __future__ import annotations

import logging
from datetime import datetime
from typing import Any, Optional

import asyncio
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy import select, delete as _sqldelete
from sqlalchemy.ext.asyncio import AsyncSession

from backend.core.db.engine import get_session
from backend.core.api.auth_helpers import open_mode_fallback_user_id

from .models import (
    ForgeWorkflow, ForgeWorkflowRun, ForgeTrigger, ForgeWorkflowVersion,
    ForgeMarketplaceTemplate, ForgeGlobal, ForgeStatic,
)
from .runner import run_workflow, parse_workflow_yaml
from .n8n_import import n8n_to_forge
from . import streams as forge_streams
from . import webhook_history as forge_history
from .templates import list_templates as _list_tpls, get_template as _get_tpl
from backend.core.agents.wolf_tools import (
    WOLF_TOOL_SCHEMAS,
    set_user_context,
    get_user_context,
)
import json
import secrets
import yaml as _yaml

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
    folder: Optional[str] = None


class RunIn(BaseModel):
    inputs: Optional[dict] = None


class TriggerIn(BaseModel):
    type: str  # 'webhook' | 'cron' | 'manual'
    config: Optional[dict] = None
    enabled: Optional[bool] = None


class ImportIn(BaseModel):
    """Import flexible : soit `yaml` (texte natif Forge), soit `n8n_json`
    (dict export N8N), soit `data` qu'on auto-détecte."""
    yaml: Optional[str] = None
    n8n_json: Optional[dict] = None
    data: Optional[str] = None  # raw text / JSON, auto-détection


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
        "folder": getattr(w, "folder", "") or "",
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


@router.get("/templates")
async def templates_list():
    """Catalogue de templates pré-construits (sans YAML — usage liste)."""
    return {"ok": True, "templates": _list_tpls()}


@router.get("/templates/{tid}")
async def templates_get(tid: str):
    t = _get_tpl(tid)
    if not t:
        raise HTTPException(status_code=404, detail="Template introuvable")
    return {"ok": True, "template": t}


# ── Globals (variables user-scoped) — endpoints REST pour UI ────────────


class GlobalIn(BaseModel):
    key: str
    value: Any = None


@router.get("/globals")
async def list_globals(request: Request,
                       session: AsyncSession = Depends(get_session)):
    uid = await _uid(request, session)
    _require_uid(uid)
    rs = await session.execute(
        select(ForgeGlobal).where(ForgeGlobal.user_id == uid)
        .order_by(ForgeGlobal.key)
    )
    return {"ok": True, "globals": [
        {"id": g.id, "key": g.key, "value": g.value_json,
         "updated_at": g.updated_at.isoformat() if g.updated_at else None}
        for g in rs.scalars().all()
    ]}


@router.post("/globals")
async def upsert_global(body: GlobalIn, request: Request,
                        session: AsyncSession = Depends(get_session)):
    uid = await _uid(request, session)
    _require_uid(uid)
    if not body.key.strip():
        raise HTTPException(status_code=400, detail="Clé vide")
    rs = await session.execute(
        select(ForgeGlobal).where(
            ForgeGlobal.user_id == uid, ForgeGlobal.key == body.key.strip(),
        )
    )
    g = rs.scalar_one_or_none()
    if g:
        g.value_json = body.value
    else:
        g = ForgeGlobal(user_id=uid, key=body.key.strip(), value_json=body.value)
        session.add(g)
    await session.commit()
    await session.refresh(g)
    return {"ok": True, "global": {"id": g.id, "key": g.key, "value": g.value_json}}


@router.delete("/globals/{gid}")
async def delete_global(gid: int, request: Request,
                        session: AsyncSession = Depends(get_session)):
    uid = await _uid(request, session)
    _require_uid(uid)
    await session.execute(
        _sqldelete(ForgeGlobal).where(
            ForgeGlobal.id == gid, ForgeGlobal.user_id == uid,
        )
    )
    await session.commit()
    return {"ok": True}


# ── Static data (workflow-scoped) — endpoints REST pour UI ──────────────


@router.get("/workflows/{wf_id}/static")
async def list_static(wf_id: int, request: Request,
                      session: AsyncSession = Depends(get_session)):
    uid = await _uid(request, session)
    _require_uid(uid)
    rs = await session.execute(
        select(ForgeWorkflow).where(
            ForgeWorkflow.id == wf_id, ForgeWorkflow.user_id == uid,
        )
    )
    if not rs.scalar_one_or_none():
        raise HTTPException(status_code=404, detail="Workflow introuvable")
    rs = await session.execute(
        select(ForgeStatic).where(
            ForgeStatic.user_id == uid, ForgeStatic.workflow_id == wf_id,
        ).order_by(ForgeStatic.key)
    )
    return {"ok": True, "static": [
        {"id": s.id, "key": s.key, "value": s.value_json,
         "updated_at": s.updated_at.isoformat() if s.updated_at else None}
        for s in rs.scalars().all()
    ]}


@router.post("/workflows/{wf_id}/static")
async def upsert_static(wf_id: int, body: GlobalIn, request: Request,
                        session: AsyncSession = Depends(get_session)):
    uid = await _uid(request, session)
    _require_uid(uid)
    rs = await session.execute(
        select(ForgeWorkflow).where(
            ForgeWorkflow.id == wf_id, ForgeWorkflow.user_id == uid,
        )
    )
    if not rs.scalar_one_or_none():
        raise HTTPException(status_code=404, detail="Workflow introuvable")
    rs = await session.execute(
        select(ForgeStatic).where(
            ForgeStatic.user_id == uid, ForgeStatic.workflow_id == wf_id,
            ForgeStatic.key == body.key.strip(),
        )
    )
    s = rs.scalar_one_or_none()
    if s:
        s.value_json = body.value
    else:
        s = ForgeStatic(user_id=uid, workflow_id=wf_id,
                        key=body.key.strip(), value_json=body.value)
        session.add(s)
    await session.commit()
    await session.refresh(s)
    return {"ok": True, "static": {"id": s.id, "key": s.key, "value": s.value_json}}


@router.delete("/workflows/{wf_id}/static/{sid}")
async def delete_static(wf_id: int, sid: int, request: Request,
                        session: AsyncSession = Depends(get_session)):
    uid = await _uid(request, session)
    _require_uid(uid)
    await session.execute(
        _sqldelete(ForgeStatic).where(
            ForgeStatic.id == sid, ForgeStatic.user_id == uid,
            ForgeStatic.workflow_id == wf_id,
        )
    )
    await session.commit()
    return {"ok": True}


# ── Marketplace communautaire ────────────────────────────────────────────


def _serialize_marketplace(t: ForgeMarketplaceTemplate, include_yaml: bool = False) -> dict:
    rating = (t.rating_sum / t.rating_count) if (t.rating_count or 0) > 0 else None
    out = {
        "id": t.id,
        "author_id": t.author_id,
        "name": t.name,
        "description": t.description or "",
        "category": t.category or "Autre",
        "tags": list(t.tags_json or []),
        "public": bool(t.public),
        "downloads": t.downloads or 0,
        "rating": round(rating, 2) if rating else None,
        "rating_count": t.rating_count or 0,
        "created_at": t.created_at.isoformat() if t.created_at else None,
        "updated_at": t.updated_at.isoformat() if t.updated_at else None,
    }
    if include_yaml:
        out["yaml_def"] = t.yaml_def or ""
    return out


@router.get("/marketplace")
async def marketplace_list(category: Optional[str] = None,
                           q: Optional[str] = None,
                           limit: int = 50,
                           session: AsyncSession = Depends(get_session)):
    """Liste publique des templates partagés. Pas d'auth requise (public).
    Filtres optionnels par catégorie ou substring nom/description."""
    query = select(ForgeMarketplaceTemplate).where(ForgeMarketplaceTemplate.public.is_(True))
    if category:
        query = query.where(ForgeMarketplaceTemplate.category == category)
    query = query.order_by(ForgeMarketplaceTemplate.downloads.desc()).limit(min(200, max(1, limit)))
    rs = await session.execute(query)
    items = [_serialize_marketplace(t) for t in rs.scalars().all()]
    if q:
        ql = q.lower()
        items = [it for it in items
                 if ql in it["name"].lower() or ql in it["description"].lower()
                 or any(ql in tag.lower() for tag in it["tags"])]
    return {"ok": True, "templates": items}


@router.get("/marketplace/{tid}")
async def marketplace_get(tid: int, session: AsyncSession = Depends(get_session)):
    rs = await session.execute(
        select(ForgeMarketplaceTemplate).where(
            ForgeMarketplaceTemplate.id == tid,
            ForgeMarketplaceTemplate.public.is_(True),
        )
    )
    t = rs.scalar_one_or_none()
    if not t:
        raise HTTPException(status_code=404, detail="Template introuvable")
    return {"ok": True, "template": _serialize_marketplace(t, include_yaml=True)}


class PublishIn(BaseModel):
    workflow_id: int
    name: Optional[str] = None
    description: Optional[str] = None
    category: Optional[str] = None
    tags: Optional[list] = None


@router.post("/marketplace/publish")
async def marketplace_publish(body: PublishIn, request: Request,
                              session: AsyncSession = Depends(get_session)):
    """Publie un de ses workflows sur la marketplace publique."""
    uid = await _uid(request, session)
    _require_uid(uid)
    rs = await session.execute(
        select(ForgeWorkflow).where(
            ForgeWorkflow.id == body.workflow_id, ForgeWorkflow.user_id == uid,
        )
    )
    w = rs.scalar_one_or_none()
    if not w:
        raise HTTPException(status_code=404, detail="Workflow introuvable")
    t = ForgeMarketplaceTemplate(
        author_id=uid,
        name=(body.name or w.name or "Workflow")[:200],
        description=(body.description or w.description or "")[:2000],
        yaml_def=w.yaml_def or "",
        category=(body.category or "Autre")[:80],
        tags_json=list(body.tags or w.tags_json or []),
        public=True,
    )
    session.add(t)
    await session.commit()
    await session.refresh(t)
    return {"ok": True, "marketplace_id": t.id, "name": t.name}


@router.post("/marketplace/{tid}/install")
async def marketplace_install(tid: int, request: Request,
                              session: AsyncSession = Depends(get_session)):
    """Installe un template marketplace : clone le YAML chez l'user courant
    et incrémente le compteur de downloads de l'auteur."""
    uid = await _uid(request, session)
    _require_uid(uid)
    rs = await session.execute(
        select(ForgeMarketplaceTemplate).where(
            ForgeMarketplaceTemplate.id == tid,
            ForgeMarketplaceTemplate.public.is_(True),
        )
    )
    t = rs.scalar_one_or_none()
    if not t:
        raise HTTPException(status_code=404, detail="Template introuvable")
    w = ForgeWorkflow(
        user_id=uid,
        name=t.name + " (installé)",
        description=t.description or "",
        yaml_def=t.yaml_def or "",
        tags_json=list(t.tags_json or []),
        enabled=True,
    )
    session.add(w)
    t.downloads = (t.downloads or 0) + 1
    await session.commit()
    await session.refresh(w)
    return {"ok": True, "workflow_id": w.id, "name": w.name}


class RatingIn(BaseModel):
    rating: int  # 1..5


@router.post("/marketplace/{tid}/rate")
async def marketplace_rate(tid: int, body: RatingIn, request: Request,
                           session: AsyncSession = Depends(get_session)):
    """Note un template (1-5). Pas de système de votes uniques (l'user peut
    noter plusieurs fois — assumé pour MVP, à durcir si abus)."""
    uid = await _uid(request, session)
    _require_uid(uid)
    if not 1 <= body.rating <= 5:
        raise HTTPException(status_code=400, detail="Rating doit être entre 1 et 5")
    rs = await session.execute(
        select(ForgeMarketplaceTemplate).where(
            ForgeMarketplaceTemplate.id == tid,
            ForgeMarketplaceTemplate.public.is_(True),
        )
    )
    t = rs.scalar_one_or_none()
    if not t:
        raise HTTPException(status_code=404, detail="Template introuvable")
    t.rating_sum = (t.rating_sum or 0) + body.rating
    t.rating_count = (t.rating_count or 0) + 1
    await session.commit()
    return {"ok": True}


@router.delete("/marketplace/{tid}")
async def marketplace_delete(tid: int, request: Request,
                             session: AsyncSession = Depends(get_session)):
    """Retire un template publié (seul l'auteur peut)."""
    uid = await _uid(request, session)
    _require_uid(uid)
    rs = await session.execute(
        select(ForgeMarketplaceTemplate).where(
            ForgeMarketplaceTemplate.id == tid,
            ForgeMarketplaceTemplate.author_id == uid,
        )
    )
    t = rs.scalar_one_or_none()
    if not t:
        raise HTTPException(status_code=404, detail="Template introuvable ou non possédé")
    await session.delete(t)
    await session.commit()
    return {"ok": True}


@router.post("/templates/{tid}/use")
async def templates_use(tid: str, request: Request,
                        session: AsyncSession = Depends(get_session)):
    """Crée un workflow chez l'user à partir du template."""
    uid = await _uid(request, session)
    _require_uid(uid)
    t = _get_tpl(tid)
    if not t:
        raise HTTPException(status_code=404, detail="Template introuvable")
    try:
        parse_workflow_yaml(t["yaml"])
    except ValueError as e:
        raise HTTPException(status_code=500, detail=f"Template corrompu : {e}")
    w = ForgeWorkflow(
        user_id=uid,
        name=t["name"],
        description=t["description"],
        yaml_def=t["yaml"],
        tags_json=list(t.get("tags") or []),
        enabled=True,
    )
    session.add(w)
    await session.commit()
    await session.refresh(w)
    return {"ok": True, "workflow_id": w.id, "name": w.name}


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
        folder=(body.folder or "").strip()[:200],
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
    # Snapshot AVANT la modification, si le YAML change réellement et que
    # le dernier snapshot a > 5 min (rate limit pour ne pas spammer la
    # table à chaque keystroke quand l'user édite en live).
    yaml_changing = body.yaml_def is not None and body.yaml_def != (w.yaml_def or "")
    if yaml_changing and (w.yaml_def or "").strip():
        await _maybe_snapshot(session, w, source="auto")
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
    if body.folder is not None:
        w.folder = body.folder.strip()[:200]
    w.updated_at = datetime.utcnow()
    await session.commit()
    await session.refresh(w)
    return {"ok": True, "workflow": _serialize_wf(w)}


# ── Versioning helpers ────────────────────────────────────────────────────

_SNAPSHOT_RATE_LIMIT_MINUTES = 5


async def _last_version_at(session: AsyncSession, workflow_id: int) -> Optional[datetime]:
    rs = await session.execute(
        select(ForgeWorkflowVersion.created_at)
        .where(ForgeWorkflowVersion.workflow_id == workflow_id)
        .order_by(ForgeWorkflowVersion.version_num.desc()).limit(1)
    )
    row = rs.scalar_one_or_none()
    return row


async def _next_version_num(session: AsyncSession, workflow_id: int) -> int:
    rs = await session.execute(
        select(ForgeWorkflowVersion.version_num)
        .where(ForgeWorkflowVersion.workflow_id == workflow_id)
        .order_by(ForgeWorkflowVersion.version_num.desc()).limit(1)
    )
    last = rs.scalar_one_or_none()
    return (last or 0) + 1


async def _maybe_snapshot(session: AsyncSession, w: ForgeWorkflow,
                          *, source: str = "auto", message: str = "",
                          force: bool = False) -> Optional[ForgeWorkflowVersion]:
    """Crée un snapshot du workflow si la rate limit est passée (ou si force=True).

    On commit pas ici — le caller commit dans son propre flow.
    """
    if not force:
        last_at = await _last_version_at(session, w.id)
        if last_at:
            elapsed_min = (datetime.utcnow() - last_at).total_seconds() / 60.0
            if elapsed_min < _SNAPSHOT_RATE_LIMIT_MINUTES:
                return None
    ver = await _next_version_num(session, w.id)
    snap = ForgeWorkflowVersion(
        workflow_id=w.id, user_id=w.user_id, version_num=ver,
        name=w.name or "", description=w.description or "",
        yaml_def=w.yaml_def or "",
        source=source, message=message or "",
    )
    session.add(snap)
    return snap


def _serialize_version(v: ForgeWorkflowVersion, include_yaml: bool = False) -> dict:
    out = {
        "id": v.id,
        "workflow_id": v.workflow_id,
        "version_num": v.version_num,
        "name": v.name or "",
        "description": v.description or "",
        "source": v.source or "auto",
        "message": v.message or "",
        "created_at": v.created_at.isoformat() if v.created_at else None,
    }
    if include_yaml:
        out["yaml_def"] = v.yaml_def or ""
    return out


# ── Versioning routes ────────────────────────────────────────────────────

@router.get("/workflows/{wf_id}/versions")
async def list_versions(wf_id: int, request: Request,
                        session: AsyncSession = Depends(get_session)):
    uid = await _uid(request, session)
    _require_uid(uid)
    rs = await session.execute(
        select(ForgeWorkflow).where(
            ForgeWorkflow.id == wf_id, ForgeWorkflow.user_id == uid,
        )
    )
    if not rs.scalar_one_or_none():
        raise HTTPException(status_code=404, detail="Workflow introuvable")
    rs = await session.execute(
        select(ForgeWorkflowVersion).where(ForgeWorkflowVersion.workflow_id == wf_id)
        .order_by(ForgeWorkflowVersion.version_num.desc())
    )
    return {"ok": True, "versions": [_serialize_version(v) for v in rs.scalars().all()]}


@router.get("/workflows/{wf_id}/versions/{ver_id}")
async def get_version(wf_id: int, ver_id: int, request: Request,
                      session: AsyncSession = Depends(get_session)):
    uid = await _uid(request, session)
    _require_uid(uid)
    rs = await session.execute(
        select(ForgeWorkflowVersion).where(
            ForgeWorkflowVersion.id == ver_id,
            ForgeWorkflowVersion.workflow_id == wf_id,
            ForgeWorkflowVersion.user_id == uid,
        )
    )
    v = rs.scalar_one_or_none()
    if not v:
        raise HTTPException(status_code=404, detail="Version introuvable")
    return {"ok": True, "version": _serialize_version(v, include_yaml=True)}


class SnapshotIn(BaseModel):
    message: Optional[str] = None


@router.post("/workflows/{wf_id}/versions")
async def create_snapshot(wf_id: int, body: SnapshotIn, request: Request,
                          session: AsyncSession = Depends(get_session)):
    """Snapshot manuel (force=True, ignore le rate limit). Permet de marquer
    un point précis de l'historique avec un message custom."""
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
    snap = await _maybe_snapshot(session, w, source="manual",
                                 message=(body.message or "").strip()[:500],
                                 force=True)
    await session.commit()
    if snap is None:
        raise HTTPException(status_code=500, detail="Snapshot a échoué")
    await session.refresh(snap)
    return {"ok": True, "version": _serialize_version(snap)}


@router.post("/workflows/{wf_id}/versions/{ver_id}/restore")
async def restore_version(wf_id: int, ver_id: int, request: Request,
                          session: AsyncSession = Depends(get_session)):
    """Restaure une version antérieure. Crée d'abord un snapshot 'pre_restore'
    de l'état courant pour que l'user puisse annuler le rollback.
    """
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
    rs = await session.execute(
        select(ForgeWorkflowVersion).where(
            ForgeWorkflowVersion.id == ver_id,
            ForgeWorkflowVersion.workflow_id == wf_id,
            ForgeWorkflowVersion.user_id == uid,
        )
    )
    v = rs.scalar_one_or_none()
    if not v:
        raise HTTPException(status_code=404, detail="Version introuvable")
    # Snapshot 'pre_restore' de l'état actuel pour pouvoir undo.
    await _maybe_snapshot(session, w, source="pre_restore",
                          message=f"Avant restauration v{v.version_num}",
                          force=True)
    # Restore.
    w.yaml_def = v.yaml_def or ""
    if v.name: w.name = v.name
    if v.description: w.description = v.description
    w.updated_at = datetime.utcnow()
    await session.commit()
    await session.refresh(w)
    return {"ok": True, "workflow": _serialize_wf(w),
            "restored_from_version": v.version_num}


@router.delete("/workflows/{wf_id}/versions/{ver_id}")
async def delete_version(wf_id: int, ver_id: int, request: Request,
                         session: AsyncSession = Depends(get_session)):
    uid = await _uid(request, session)
    _require_uid(uid)
    rs = await session.execute(
        select(ForgeWorkflowVersion).where(
            ForgeWorkflowVersion.id == ver_id,
            ForgeWorkflowVersion.workflow_id == wf_id,
            ForgeWorkflowVersion.user_id == uid,
        )
    )
    v = rs.scalar_one_or_none()
    if not v:
        raise HTTPException(status_code=404, detail="Version introuvable")
    await session.delete(v)
    await session.commit()
    return {"ok": True}


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
        res = await run_workflow(w.yaml_def, body.inputs or {},
                                 user_id=uid, workflow_id=w.id)
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


# Worker background pour run async — fait tourner le workflow et met à
# jour la DB hors de la requête HTTP.  La queue de stream est créée par
# le endpoint /run-async avant de spawn la task pour éviter les races.
async def _run_async_worker(run_id: int, user_id: int, workflow_id: int,
                            yaml_text: str, inputs: dict):
    from backend.core.db.engine import async_session
    async def _on_event(evt: dict):
        await forge_streams.push_event(run_id, evt)

    prev_uid = get_user_context()
    set_user_context(user_id)
    try:
        await forge_streams.push_event(run_id, {
            "ts": datetime.utcnow().isoformat(), "type": "run_start", "run_id": run_id,
        })
        try:
            res = await run_workflow(yaml_text, inputs, on_event=_on_event,
                                     user_id=user_id, workflow_id=workflow_id)
        except Exception as e:
            logger.exception("[forge.async] crash run_id=%s", run_id)
            res = type("R", (), {"status": "error", "logs": [], "output": {}, "error": str(e)})

        async with async_session() as session:
            rs = await session.execute(
                select(ForgeWorkflowRun).where(ForgeWorkflowRun.id == run_id)
            )
            run_row = rs.scalar_one_or_none()
            if run_row:
                run_row.status = res.status
                run_row.logs_json = res.logs
                run_row.output_json = res.output if isinstance(res.output, dict) else {"value": res.output}
                run_row.error = res.error or ""
                run_row.finished_at = datetime.utcnow()
                await session.commit()

        await forge_streams.push_event(run_id, {
            "ts": datetime.utcnow().isoformat(), "type": "run_end", "run_id": run_id,
            "status": res.status, "error": res.error or None,
        })
    finally:
        set_user_context(prev_uid)
        forge_streams.mark_finished(run_id)


@router.post("/workflows/{wf_id}/run-async")
async def run_async(wf_id: int, body: RunIn, request: Request,
                    session: AsyncSession = Depends(get_session)):
    """Lance le workflow en background et retourne immédiatement le run_id.
    Le client peut ensuite consommer /runs/{id}/stream pour suivre les
    events en SSE, ou poller /runs/{id} pour le statut final."""
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

    # Crée la queue AVANT de spawn pour qu'aucun event ne soit perdu si
    # le client SSE se connecte très vite après le retour de cet endpoint.
    forge_streams.register_run(run_row.id)
    asyncio.create_task(_run_async_worker(run_row.id, uid, w.id, w.yaml_def, body.inputs or {}))
    return {"ok": True, "run_id": run_row.id, "status": "running"}


@router.get("/runs/{run_id}/stream")
async def run_stream(run_id: int, request: Request,
                     session: AsyncSession = Depends(get_session)):
    """SSE — pousse les events du runner au client en live.

    Format Server-Sent Events standard : `data: <json>\\n\\n` par event.
    Termine sur l'event `run_end` (puis garde la connexion ouverte 5s
    pour laisser le client traiter le dernier message)."""
    uid = await _uid(request, session)
    _require_uid(uid)
    # Vérifie ownership avant de stream.
    rs = await session.execute(
        select(ForgeWorkflowRun).where(
            ForgeWorkflowRun.id == run_id, ForgeWorkflowRun.user_id == uid,
        )
    )
    if not rs.scalar_one_or_none():
        raise HTTPException(status_code=404, detail="Run introuvable")

    forge_streams.cleanup_finished_queues()
    queue = forge_streams.get_queue(run_id)

    async def _gen():
        import json as _json
        if queue is None:
            # Run déjà fini ou queue cleanup → on retourne juste les logs DB
            # en un event `final_state` puis on ferme.
            async with (await session.execute(
                select(ForgeWorkflowRun).where(ForgeWorkflowRun.id == run_id)
            )) as _:
                pass
            yield "data: " + _json.dumps({"type": "final_state", "run_id": run_id}) + "\n\n"
            return
        # Heartbeat toutes les 15s pour que les proxies ne ferment pas la conn.
        last_send = 0.0
        import time as _t
        while True:
            try:
                evt = await asyncio.wait_for(queue.get(), timeout=15.0)
            except asyncio.TimeoutError:
                yield ": ping\n\n"
                last_send = _t.time()
                continue
            yield "data: " + _json.dumps(evt) + "\n\n"
            last_send = _t.time()
            if evt.get("type") == "run_end":
                # Petit délai pour que le client reçoive bien le dernier event
                await asyncio.sleep(0.2)
                return

    return StreamingResponse(_gen(), media_type="text/event-stream", headers={
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no",  # nginx : disable buffering
    })


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


# ── Triggers ──────────────────────────────────────────────────────────────

def _serialize_trigger(t: ForgeTrigger, base_url: str = "") -> dict:
    out = {
        "id": t.id,
        "workflow_id": t.workflow_id,
        "type": t.type,
        "config": t.config_json or {},
        "enabled": bool(t.enabled),
        "last_fire_at": t.last_fire_at.isoformat() if t.last_fire_at else None,
        "created_at": t.created_at.isoformat() if t.created_at else None,
    }
    if t.type == "webhook" and t.secret_token:
        out["webhook_url"] = f"{base_url}/api/plugins/forge/webhook/{t.secret_token}"
        out["secret_token"] = t.secret_token
    return out


@router.get("/workflows/{wf_id}/triggers")
async def list_triggers(wf_id: int, request: Request,
                        session: AsyncSession = Depends(get_session)):
    uid = await _uid(request, session)
    _require_uid(uid)
    rs = await session.execute(
        select(ForgeWorkflow).where(
            ForgeWorkflow.id == wf_id, ForgeWorkflow.user_id == uid,
        )
    )
    if not rs.scalar_one_or_none():
        raise HTTPException(status_code=404, detail="Workflow introuvable")
    rs = await session.execute(
        select(ForgeTrigger).where(ForgeTrigger.workflow_id == wf_id)
        .order_by(ForgeTrigger.created_at.desc())
    )
    base = str(request.base_url).rstrip("/")
    return {"ok": True, "triggers": [_serialize_trigger(t, base) for t in rs.scalars().all()]}


@router.post("/workflows/{wf_id}/triggers")
async def create_trigger(wf_id: int, body: TriggerIn, request: Request,
                         session: AsyncSession = Depends(get_session)):
    uid = await _uid(request, session)
    _require_uid(uid)
    rs = await session.execute(
        select(ForgeWorkflow).where(
            ForgeWorkflow.id == wf_id, ForgeWorkflow.user_id == uid,
        )
    )
    if not rs.scalar_one_or_none():
        raise HTTPException(status_code=404, detail="Workflow introuvable")
    if body.type not in ("webhook", "cron", "manual"):
        raise HTTPException(status_code=400, detail="Type de trigger invalide")
    # Validation cron : on importe croniter (déjà dans requirements pour
    # le scheduler core) et on tente un parse — rejet immédiat si invalide.
    if body.type == "cron":
        expr = (body.config or {}).get("expression", "").strip()
        if not expr:
            raise HTTPException(status_code=400, detail="Expression cron requise")
        try:
            from croniter import croniter
            if not croniter.is_valid(expr):
                raise ValueError("expression cron invalide")
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"Cron invalide : {e}")
    token = secrets.token_urlsafe(24) if body.type == "webhook" else None
    t = ForgeTrigger(
        workflow_id=wf_id, user_id=uid,
        type=body.type, config_json=body.config or {},
        enabled=True if body.enabled is None else bool(body.enabled),
        secret_token=token,
    )
    session.add(t)
    await session.commit()
    await session.refresh(t)
    base = str(request.base_url).rstrip("/")
    return {"ok": True, "trigger": _serialize_trigger(t, base)}


@router.put("/triggers/{tid}")
async def update_trigger(tid: int, body: TriggerIn, request: Request,
                         session: AsyncSession = Depends(get_session)):
    uid = await _uid(request, session)
    _require_uid(uid)
    rs = await session.execute(
        select(ForgeTrigger).where(
            ForgeTrigger.id == tid, ForgeTrigger.user_id == uid,
        )
    )
    t = rs.scalar_one_or_none()
    if not t:
        raise HTTPException(status_code=404, detail="Trigger introuvable")
    if body.config is not None:
        t.config_json = body.config
    if body.enabled is not None:
        t.enabled = bool(body.enabled)
    await session.commit()
    await session.refresh(t)
    base = str(request.base_url).rstrip("/")
    return {"ok": True, "trigger": _serialize_trigger(t, base)}


@router.get("/triggers/{tid}/history")
async def trigger_history(tid: int, request: Request,
                          session: AsyncSession = Depends(get_session)):
    """Liste les derniers POSTs reçus sur ce webhook (10 max, en mémoire)."""
    uid = await _uid(request, session)
    _require_uid(uid)
    rs = await session.execute(
        select(ForgeTrigger).where(
            ForgeTrigger.id == tid, ForgeTrigger.user_id == uid,
        )
    )
    if not rs.scalar_one_or_none():
        raise HTTPException(status_code=404, detail="Trigger introuvable")
    return {"ok": True, "history": forge_history.list_for_trigger(tid)}


@router.post("/triggers/{tid}/replay/{idx}")
async def trigger_replay(tid: int, idx: int, request: Request,
                         session: AsyncSession = Depends(get_session)):
    """Rejoue un POST historique sur ce webhook (lance le workflow comme si
    la requête arrivait à nouveau). Idéal pour debug une intégration sans
    avoir à demander à l'expéditeur de re-trigger."""
    uid = await _uid(request, session)
    _require_uid(uid)
    rs = await session.execute(
        select(ForgeTrigger).where(
            ForgeTrigger.id == tid, ForgeTrigger.user_id == uid,
            ForgeTrigger.type == "webhook",
        )
    )
    t = rs.scalar_one_or_none()
    if not t:
        raise HTTPException(status_code=404, detail="Trigger introuvable")
    payload = forge_history.get_payload(tid, idx)
    if not payload:
        raise HTTPException(status_code=404, detail="Payload historique introuvable")
    rs = await session.execute(
        select(ForgeWorkflow).where(
            ForgeWorkflow.id == t.workflow_id, ForgeWorkflow.user_id == uid,
        )
    )
    w = rs.scalar_one_or_none()
    if not w:
        raise HTTPException(status_code=404, detail="Workflow introuvable")
    inputs = payload.get("inputs") or {}
    run_row = ForgeWorkflowRun(
        workflow_id=w.id, user_id=uid, status="running",
        inputs_json=inputs, trigger_source="webhook_replay",
    )
    session.add(run_row)
    await session.commit()
    await session.refresh(run_row)
    prev_uid = get_user_context()
    set_user_context(uid)
    try:
        res = await run_workflow(w.yaml_def, inputs,
                                 user_id=uid, workflow_id=w.id)
    finally:
        set_user_context(prev_uid)
    run_row.status = res.status
    run_row.logs_json = res.logs
    run_row.output_json = res.output if isinstance(res.output, dict) else {"value": res.output}
    run_row.error = res.error or ""
    run_row.finished_at = datetime.utcnow()
    await session.commit()
    return {"ok": True, "run_id": run_row.id, "status": res.status}


@router.delete("/triggers/{tid}")
async def delete_trigger(tid: int, request: Request,
                         session: AsyncSession = Depends(get_session)):
    uid = await _uid(request, session)
    _require_uid(uid)
    rs = await session.execute(
        select(ForgeTrigger).where(
            ForgeTrigger.id == tid, ForgeTrigger.user_id == uid,
        )
    )
    t = rs.scalar_one_or_none()
    if not t:
        raise HTTPException(status_code=404, detail="Trigger introuvable")
    await session.delete(t)
    await session.commit()
    return {"ok": True}


# Endpoints webhook publics — PAS d'auth, sécurisés par secret_token.
# Deux modes :
# - /webhook/{token}        → mode prod : déclenche le workflow + stocke historique
# - /webhook/{token}/test   → mode test : stocke l'historique mais NE déclenche PAS
#                              le workflow (utile pour vérifier qu'un webhook
#                              externe envoie bien la bonne payload avant prod)


async def _build_webhook_inputs(request: Request) -> tuple[dict, dict]:
    """Extrait body + inputs depuis la requête HTTP. Retourne (body_raw, inputs)."""
    body_raw: dict = {}
    try:
        if request.headers.get("content-type", "").startswith("application/json"):
            body_raw = await request.json()
        else:
            form = await request.form()
            body_raw = {k: v for k, v in form.items()} if form else {}
    except Exception:
        body_raw = {}
    inputs = {
        "_webhook": {
            "method": request.method,
            "headers": {k: v for k, v in request.headers.items()
                        if k.lower() not in ("authorization", "cookie")},
            "query": dict(request.query_params),
        },
        "body": body_raw,
        **(body_raw if isinstance(body_raw, dict) else {}),
    }
    return body_raw, inputs


@router.api_route("/webhook/{token}/test", methods=["GET", "POST", "PUT"])
async def webhook_test(token: str, request: Request,
                       session: AsyncSession = Depends(get_session)):
    """Mode test : enregistre la payload dans l'historique sans lancer le
    workflow. L'user peut ensuite la replayer manuellement depuis l'UI."""
    rs = await session.execute(
        select(ForgeTrigger).where(
            ForgeTrigger.secret_token == token,
            ForgeTrigger.type == "webhook",
        )
    )
    t = rs.scalar_one_or_none()
    if not t:
        raise HTTPException(status_code=404, detail="Webhook inconnu")
    body_raw, inputs = await _build_webhook_inputs(request)
    await forge_history.push(t.id, {
        "mode": "test", "method": request.method,
        "body": body_raw, "inputs": inputs,
    })
    return {"ok": True, "mode": "test", "stored": True,
            "hint": "Replay depuis l'UI (panel Déclencheurs → bouton Rejouer)"}


@router.api_route("/webhook/{token}", methods=["GET", "POST", "PUT"])
async def webhook_trigger(token: str, request: Request,
                          session: AsyncSession = Depends(get_session)):
    """Déclenche un workflow via webhook. Le body de la requête (JSON ou
    form-data) devient les `inputs` du run. Le run est créé avec
    `trigger_source='webhook'` et l'user_id du propriétaire du trigger."""
    rs = await session.execute(
        select(ForgeTrigger).where(
            ForgeTrigger.secret_token == token,
            ForgeTrigger.type == "webhook",
        )
    )
    t = rs.scalar_one_or_none()
    if not t:
        raise HTTPException(status_code=404, detail="Webhook inconnu")
    if not t.enabled:
        raise HTTPException(status_code=403, detail="Webhook désactivé")

    rs = await session.execute(
        select(ForgeWorkflow).where(
            ForgeWorkflow.id == t.workflow_id, ForgeWorkflow.user_id == t.user_id,
        )
    )
    w = rs.scalar_one_or_none()
    if not w or not w.enabled:
        raise HTTPException(status_code=400, detail="Workflow indisponible")

    body_raw, inputs = await _build_webhook_inputs(request)
    # Stocke l'historique pour replay future
    await forge_history.push(t.id, {
        "mode": "prod", "method": request.method,
        "body": body_raw, "inputs": inputs,
    })

    # Lance le workflow synchroniquement (Phase 2 : sera async via worker).
    run_row = ForgeWorkflowRun(
        workflow_id=w.id, user_id=t.user_id, status="running",
        inputs_json=inputs, trigger_source="webhook",
    )
    session.add(run_row)
    await session.commit()
    await session.refresh(run_row)

    prev_uid = get_user_context()
    set_user_context(t.user_id)
    try:
        res = await run_workflow(w.yaml_def, inputs,
                                 user_id=t.user_id, workflow_id=w.id)
    finally:
        set_user_context(prev_uid)

    run_row.status = res.status
    run_row.logs_json = res.logs
    run_row.output_json = res.output if isinstance(res.output, dict) else {"value": res.output}
    run_row.error = res.error or ""
    run_row.finished_at = datetime.utcnow()
    t.last_fire_at = datetime.utcnow()
    await session.commit()

    return {"ok": res.status == "success", "run_id": run_row.id,
            "status": res.status, "output": run_row.output_json,
            "error": res.error or None}


# ── Import / Export ──────────────────────────────────────────────────────

@router.get("/workflows/{wf_id}/export")
async def export_workflow(wf_id: int, request: Request,
                          session: AsyncSession = Depends(get_session)):
    """Exporte un workflow en YAML enrichi (avec name + description).
    Format : YAML natif Forge, importable tel quel ailleurs."""
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
    # On garantit que name + description sont dans le YAML exporté
    # (sinon perte d'info à l'import). Si déjà présents → no-op.
    try:
        parsed = _yaml.safe_load(w.yaml_def or "") or {}
    except Exception:
        parsed = {}
    if w.name and not parsed.get("name"):
        parsed["name"] = w.name
    if w.description and not parsed.get("description"):
        parsed["description"] = w.description
    out_yaml = _yaml.dump(parsed, allow_unicode=True, sort_keys=False, lineWidth=120) if parsed else (w.yaml_def or "")
    return {
        "ok": True,
        "filename": f"{(w.name or 'workflow').replace(' ', '_')}.forge.yaml",
        "yaml": out_yaml,
    }


@router.post("/workflows/import")
async def import_workflow(body: ImportIn, request: Request,
                          session: AsyncSession = Depends(get_session)):
    """Importe un workflow depuis YAML natif ou JSON N8N (auto-détection
    si `data` est passé). Retourne le workflow créé + warnings éventuels."""
    uid = await _uid(request, session)
    _require_uid(uid)
    yaml_text: Optional[str] = body.yaml
    n8n_json: Optional[dict] = body.n8n_json
    warnings: list[str] = []
    triggers_to_create: list[dict] = []

    # Auto-détection si data brut.
    if not yaml_text and not n8n_json and body.data:
        raw = body.data.strip()
        if raw.startswith("{"):
            try:
                n8n_json = json.loads(raw)
            except Exception as e:
                raise HTTPException(status_code=400, detail=f"JSON invalide : {e}")
        else:
            yaml_text = raw

    # Conversion N8N si applicable.
    if n8n_json is not None:
        if not isinstance(n8n_json, dict):
            raise HTTPException(status_code=400, detail="n8n_json doit être un dict")
        if "nodes" not in n8n_json:
            raise HTTPException(status_code=400, detail="JSON N8N invalide (champ 'nodes' manquant)")
        try:
            converted = n8n_to_forge(n8n_json)
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))
        warnings.extend(converted["warnings"])
        triggers_to_create = converted["triggers"]
        wf_dict = {
            "name": converted["name"],
            "description": converted["description"],
            "steps": converted["yaml_steps"],
        }
        yaml_text = _yaml.dump(wf_dict, allow_unicode=True, sort_keys=False)

    if not yaml_text:
        raise HTTPException(status_code=400, detail="Aucune donnée à importer (yaml ou n8n_json requis)")

    # Validation YAML.
    try:
        wf = parse_workflow_yaml(yaml_text)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=f"YAML invalide : {e}")

    # Création.
    name = wf.get("name") or "Workflow importé"
    description = wf.get("description") or ""
    new_wf = ForgeWorkflow(
        user_id=uid, name=name, description=description,
        yaml_def=yaml_text, enabled=True,
    )
    session.add(new_wf)
    await session.commit()
    await session.refresh(new_wf)

    # Création des triggers détectés à l'import (ex: webhook N8N → trigger Forge).
    created_triggers: list[dict] = []
    for tr in triggers_to_create:
        ttype = tr.get("type", "manual")
        token = secrets.token_urlsafe(24) if ttype == "webhook" else None
        # Mapping config N8N cron → Forge cron expression
        cfg: dict = {}
        if ttype == "cron":
            # N8N exprime le cron de plusieurs façons selon node version ;
            # on prend tout ce qui ressemble à une expression standard.
            n8n_cfg = tr.get("config") or {}
            expr = (n8n_cfg.get("triggerTimes", {}).get("item", [{}])[0].get("expression")
                    if isinstance(n8n_cfg.get("triggerTimes"), dict) else None)
            cfg = {"expression": expr or "0 9 * * *"}
        new_t = ForgeTrigger(
            workflow_id=new_wf.id, user_id=uid,
            type=ttype, config_json=cfg,
            enabled=True, secret_token=token,
        )
        session.add(new_t)
        created_triggers.append({"type": ttype})
    if triggers_to_create:
        await session.commit()

    return {
        "ok": True,
        "workflow_id": new_wf.id,
        "name": new_wf.name,
        "warnings": warnings,
        "triggers_created": created_triggers,
    }


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
