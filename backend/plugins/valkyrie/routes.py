"""
Valkyrie — API routes (CRUD per-user).

Chaque endpoint vérifie strictement l'ownership via `request.state.user_id`
(middleware d'auth) + un `ValkyrieProject.user_id == uid` sur la requête.
Aucun fallback global.
"""
from __future__ import annotations

import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from sqlalchemy import select, delete as _sqldelete, update as _sqlupdate
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm.attributes import flag_modified

from backend.core.db.engine import get_session
from backend.core.api.auth_helpers import open_mode_fallback_user_id

from .models import (
    ValkyrieProject, ValkyrieStatus, ValkyrieCard,
    BUILTIN_STATUSES, STATUS_COLOR_PALETTE,
)

logger = logging.getLogger("gungnir.plugins.valkyrie")
router = APIRouter()


# ── Auth helper ────────────────────────────────────────────────────────────

async def _uid(request: Request, session: AsyncSession) -> int:
    """Retourne le user_id authentifié, ou lève 401. En open mode single-user,
    on accepte le fallback sur l'user unique."""
    uid = getattr(request.state, "user_id", None)
    if uid:
        return int(uid)
    fb = await open_mode_fallback_user_id(session)
    return int(fb) if fb else 0


def _require_uid(uid: int):
    if not uid:
        raise HTTPException(status_code=401, detail="Authentification requise")


# ── Pydantic models (requests) ────────────────────────────────────────────

class ProjectIn(BaseModel):
    title: Optional[str] = None
    description: Optional[str] = None
    archived: Optional[bool] = None
    position: Optional[int] = None


class StatusIn(BaseModel):
    label: str
    color: str
    # `key` est généré côté serveur (slug du label + suffix) si absent, pour
    # garantir l'unicité et éviter les collisions avec les built-in.
    key: Optional[str] = None
    position: Optional[int] = None


class SubtaskIn(BaseModel):
    label: str
    done: bool = False


class CardIn(BaseModel):
    title: Optional[str] = None
    subtitle: Optional[str] = None
    description: Optional[str] = None
    status_key: Optional[str] = None
    position: Optional[int] = None
    expanded: Optional[bool] = None
    subtasks: Optional[list] = None   # liste 1 de {id?, label, done}
    subtasks2: Optional[list] = None  # liste 2 — même shape
    subtasks2_title: Optional[str] = None  # header éditable de la liste 2
    tags: Optional[list] = None       # liste de strings (labels libres)


class CardReorder(BaseModel):
    # [{id, position, status_key?}, ...] — batch update après drag & drop
    items: list[dict]


# ── Helpers de serialization ──────────────────────────────────────────────

def _serialize_project(p: ValkyrieProject) -> dict:
    return {
        "id": p.id,
        "title": p.title,
        "description": p.description or "",
        "archived": bool(p.archived),
        "position": p.position or 0,
        "created_at": p.created_at.isoformat() if p.created_at else None,
        "updated_at": p.updated_at.isoformat() if p.updated_at else None,
    }


def _serialize_status(s: ValkyrieStatus) -> dict:
    return {
        "id": s.id,
        "key": s.key,
        "label": s.label,
        "color": s.color,
        "position": s.position or 0,
        "project_id": s.project_id,
        "builtin": False,
    }


def _serialize_card(c: ValkyrieCard) -> dict:
    return {
        "id": c.id,
        "project_id": c.project_id,
        "title": c.title or "",
        "subtitle": (c.subtitle or ""),
        "description": c.description or "",
        "status_key": c.status_key,
        "position": c.position or 0,
        "expanded": bool(c.expanded),
        "subtasks": list(c.subtasks_json or []),
        "subtasks2": list(c.subtasks2_json or []),
        "subtasks2_title": (c.subtasks2_title or ""),
        "tags": list(c.tags_json or []),
        "created_at": c.created_at.isoformat() if c.created_at else None,
        "updated_at": c.updated_at.isoformat() if c.updated_at else None,
    }


def _slugify_status_key(label: str) -> str:
    """Transforme un label user en clé stable (pour stockage card.status_key)."""
    import re
    s = (label or "custom").strip().lower()
    s = re.sub(r"[^a-z0-9]+", "_", s)
    s = s.strip("_") or "custom"
    return f"custom_{s}"[:60]


# ── Health ────────────────────────────────────────────────────────────────

@router.get("/health")
async def health():
    return {"plugin": "valkyrie", "status": "ok"}


# ── Color palette (pour l'UI de création de statut) ──────────────────────

@router.get("/palette")
async def color_palette():
    return {"colors": STATUS_COLOR_PALETTE}


# ═══════════════════════════════════════════════════════════════════════════
# Projets
# ═══════════════════════════════════════════════════════════════════════════

@router.get("/projects")
async def list_projects(request: Request, session: AsyncSession = Depends(get_session)):
    uid = await _uid(request, session)
    _require_uid(uid)
    rs = await session.execute(
        select(ValkyrieProject)
        .where(ValkyrieProject.user_id == uid)
        .order_by(ValkyrieProject.position, ValkyrieProject.id)
    )
    rows = rs.scalars().all()
    # Premier appel pour cet user : s'il n'a aucun projet, on en crée un
    # par défaut pour qu'il voie immédiatement l'interface remplie.
    if not rows:
        default_proj = ValkyrieProject(
            user_id=uid,
            title="Mon premier tableau",
            description="Projet de démarrage — édite le titre, ajoute des cartes, réorganise à la volée.",
            position=0,
        )
        session.add(default_proj)
        await session.commit()
        await session.refresh(default_proj)
        rows = [default_proj]
    return {"projects": [_serialize_project(p) for p in rows]}


@router.post("/projects")
async def create_project(payload: ProjectIn, request: Request,
                          session: AsyncSession = Depends(get_session)):
    uid = await _uid(request, session)
    _require_uid(uid)
    row = ValkyrieProject(
        user_id=uid,
        title=(payload.title or "Nouveau projet").strip()[:200],
        description=(payload.description or "").strip(),
        position=int(payload.position or 0),
    )
    session.add(row)
    await session.commit()
    await session.refresh(row)
    return {"project": _serialize_project(row)}


@router.put("/projects/{project_id}")
async def update_project(project_id: int, payload: ProjectIn, request: Request,
                          session: AsyncSession = Depends(get_session)):
    uid = await _uid(request, session)
    _require_uid(uid)
    row = await _get_project_owned(session, uid, project_id)
    if payload.title is not None:
        row.title = payload.title.strip()[:200] or "Projet sans nom"
    if payload.description is not None:
        row.description = payload.description.strip()
    if payload.archived is not None:
        row.archived = bool(payload.archived)
    if payload.position is not None:
        row.position = int(payload.position)
    await session.commit()
    return {"project": _serialize_project(row)}


@router.delete("/projects/{project_id}")
async def delete_project(project_id: int, request: Request,
                          session: AsyncSession = Depends(get_session)):
    uid = await _uid(request, session)
    _require_uid(uid)
    row = await _get_project_owned(session, uid, project_id)
    await session.delete(row)  # CASCADE supprime les cards liées
    await session.commit()
    return {"ok": True, "deleted": project_id}


async def _get_project_owned(session: AsyncSession, uid: int, project_id: int) -> ValkyrieProject:
    rs = await session.execute(
        select(ValkyrieProject).where(
            ValkyrieProject.id == project_id,
            ValkyrieProject.user_id == uid,
        )
    )
    row = rs.scalar_one_or_none()
    if not row:
        raise HTTPException(status_code=404, detail="Projet introuvable")
    return row


# ═══════════════════════════════════════════════════════════════════════════
# Statuts
# ═══════════════════════════════════════════════════════════════════════════

@router.get("/statuses")
async def list_statuses(request: Request, session: AsyncSession = Depends(get_session)):
    """Retourne les built-in (toujours) + les statuts custom de l'user."""
    uid = await _uid(request, session)
    _require_uid(uid)
    rs = await session.execute(
        select(ValkyrieStatus)
        .where(ValkyrieStatus.user_id == uid)
        .order_by(ValkyrieStatus.position, ValkyrieStatus.id)
    )
    custom = [_serialize_status(s) for s in rs.scalars().all()]
    return {"statuses": list(BUILTIN_STATUSES) + custom}


@router.post("/statuses")
async def create_status(payload: StatusIn, request: Request,
                         session: AsyncSession = Depends(get_session)):
    uid = await _uid(request, session)
    _require_uid(uid)
    label = (payload.label or "").strip()[:60]
    if not label:
        raise HTTPException(status_code=400, detail="Label requis")
    key = (payload.key or "").strip() or _slugify_status_key(label)
    # Empêche les collisions avec les built-in
    builtin_keys = {s["key"] for s in BUILTIN_STATUSES}
    if key in builtin_keys:
        key = f"custom_{key}"
    # Unicité par user : suffixe numérique si déjà pris
    rs = await session.execute(
        select(ValkyrieStatus.key).where(ValkyrieStatus.user_id == uid)
    )
    existing = {k for (k,) in rs.all()}
    base = key
    n = 2
    while key in existing:
        key = f"{base}_{n}"
        n += 1

    row = ValkyrieStatus(
        user_id=uid,
        project_id=None,  # global v1
        key=key,
        label=label,
        color=(payload.color or "#7a8a9b").strip()[:20],
        position=int(payload.position or 0),
    )
    session.add(row)
    await session.commit()
    await session.refresh(row)
    return {"status": _serialize_status(row)}


@router.put("/statuses/{status_id}")
async def update_status(status_id: int, payload: StatusIn, request: Request,
                         session: AsyncSession = Depends(get_session)):
    uid = await _uid(request, session)
    _require_uid(uid)
    rs = await session.execute(
        select(ValkyrieStatus).where(
            ValkyrieStatus.id == status_id, ValkyrieStatus.user_id == uid
        )
    )
    row = rs.scalar_one_or_none()
    if not row:
        raise HTTPException(status_code=404, detail="Statut introuvable")
    if payload.label:
        row.label = payload.label.strip()[:60]
    if payload.color:
        row.color = payload.color.strip()[:20]
    if payload.position is not None:
        row.position = int(payload.position)
    await session.commit()
    return {"status": _serialize_status(row)}


@router.delete("/statuses/{status_id}")
async def delete_status(status_id: int, request: Request,
                         session: AsyncSession = Depends(get_session)):
    uid = await _uid(request, session)
    _require_uid(uid)
    rs = await session.execute(
        select(ValkyrieStatus).where(
            ValkyrieStatus.id == status_id, ValkyrieStatus.user_id == uid
        )
    )
    row = rs.scalar_one_or_none()
    if not row:
        raise HTTPException(status_code=404, detail="Statut introuvable")
    deleted_key = row.key
    # Les cartes qui utilisaient ce statut retombent sur 'todo' (fallback safe).
    await session.execute(
        _sqlupdate(ValkyrieCard)
        .where(ValkyrieCard.user_id == uid, ValkyrieCard.status_key == deleted_key)
        .values(status_key="todo")
    )
    await session.delete(row)
    await session.commit()
    return {"ok": True, "deleted": status_id, "reassigned_to": "todo"}


# ═══════════════════════════════════════════════════════════════════════════
# Cartes
# ═══════════════════════════════════════════════════════════════════════════

@router.get("/projects/{project_id}/cards")
async def list_cards(project_id: int, request: Request,
                      session: AsyncSession = Depends(get_session)):
    uid = await _uid(request, session)
    _require_uid(uid)
    # Vérifie l'ownership du projet
    await _get_project_owned(session, uid, project_id)
    rs = await session.execute(
        select(ValkyrieCard)
        .where(ValkyrieCard.project_id == project_id, ValkyrieCard.user_id == uid)
        .order_by(ValkyrieCard.position, ValkyrieCard.id)
    )
    rows = rs.scalars().all()
    return {"cards": [_serialize_card(c) for c in rows]}


@router.post("/projects/{project_id}/cards")
async def create_card(project_id: int, payload: CardIn, request: Request,
                       session: AsyncSession = Depends(get_session)):
    uid = await _uid(request, session)
    _require_uid(uid)
    await _get_project_owned(session, uid, project_id)
    row = ValkyrieCard(
        project_id=project_id,
        user_id=uid,
        title=(payload.title or "").strip()[:300] or "Nouvelle carte",
        subtitle=(payload.subtitle or "").strip()[:300],
        description=(payload.description or "").strip(),
        status_key=(payload.status_key or "todo").strip()[:60] or "todo",
        position=int(payload.position or 0),
        expanded=bool(payload.expanded or False),
        subtasks_json=_sanitize_subtasks(payload.subtasks or []),
        subtasks2_json=_sanitize_subtasks(payload.subtasks2 or []),
        subtasks2_title=(payload.subtasks2_title or "").strip()[:60],
        tags_json=_sanitize_tags(payload.tags or []),
    )
    session.add(row)
    await session.commit()
    await session.refresh(row)
    return {"card": _serialize_card(row)}


@router.put("/cards/{card_id}")
async def update_card(card_id: int, payload: CardIn, request: Request,
                       session: AsyncSession = Depends(get_session)):
    uid = await _uid(request, session)
    _require_uid(uid)
    row = await _get_card_owned(session, uid, card_id)
    if payload.title is not None:
        row.title = payload.title.strip()[:300]
    if payload.subtitle is not None:
        row.subtitle = payload.subtitle.strip()[:300]
    if payload.description is not None:
        row.description = payload.description.strip()
    if payload.status_key is not None:
        row.status_key = payload.status_key.strip()[:60] or "todo"
    if payload.position is not None:
        row.position = int(payload.position)
    if payload.expanded is not None:
        row.expanded = bool(payload.expanded)
    if payload.subtasks is not None:
        row.subtasks_json = _sanitize_subtasks(payload.subtasks)
        flag_modified(row, "subtasks_json")
    if payload.subtasks2 is not None:
        row.subtasks2_json = _sanitize_subtasks(payload.subtasks2)
        flag_modified(row, "subtasks2_json")
    if payload.subtasks2_title is not None:
        row.subtasks2_title = payload.subtasks2_title.strip()[:60]
    if payload.tags is not None:
        row.tags_json = _sanitize_tags(payload.tags)
        flag_modified(row, "tags_json")
    await session.commit()
    return {"card": _serialize_card(row)}


@router.delete("/cards/{card_id}")
async def delete_card(card_id: int, request: Request,
                       session: AsyncSession = Depends(get_session)):
    uid = await _uid(request, session)
    _require_uid(uid)
    row = await _get_card_owned(session, uid, card_id)
    await session.delete(row)
    await session.commit()
    return {"ok": True, "deleted": card_id}


@router.post("/cards/reorder")
async def reorder_cards(payload: CardReorder, request: Request,
                         session: AsyncSession = Depends(get_session)):
    """Applique un batch d'updates (position + status_key optionnel) après un
    drag & drop — une seule requête plutôt que N PUT individuels."""
    uid = await _uid(request, session)
    _require_uid(uid)
    if not isinstance(payload.items, list):
        raise HTTPException(status_code=400, detail="items doit être une liste")
    for item in payload.items:
        if not isinstance(item, dict):
            continue
        cid = item.get("id")
        if not cid:
            continue
        try:
            cid = int(cid)
        except (TypeError, ValueError):
            continue
        updates = {}
        if "position" in item:
            try:
                updates["position"] = int(item["position"])
            except (TypeError, ValueError):
                pass
        if "status_key" in item and isinstance(item["status_key"], str):
            updates["status_key"] = item["status_key"][:60]
        if not updates:
            continue
        await session.execute(
            _sqlupdate(ValkyrieCard)
            .where(ValkyrieCard.id == cid, ValkyrieCard.user_id == uid)
            .values(**updates)
        )
    await session.commit()
    return {"ok": True, "updated": len(payload.items)}


async def _get_card_owned(session: AsyncSession, uid: int, card_id: int) -> ValkyrieCard:
    rs = await session.execute(
        select(ValkyrieCard).where(
            ValkyrieCard.id == card_id, ValkyrieCard.user_id == uid
        )
    )
    row = rs.scalar_one_or_none()
    if not row:
        raise HTTPException(status_code=404, detail="Carte introuvable")
    return row


def _sanitize_subtasks(items) -> list[dict]:
    """Normalise la liste de subtasks : {id (str), label (str), done (bool)}."""
    import uuid
    out = []
    for it in items or []:
        if not isinstance(it, dict):
            continue
        label = str(it.get("label") or "").strip()[:200]
        if not label:
            continue
        sid = str(it.get("id") or "").strip() or f"s_{uuid.uuid4().hex[:8]}"
        out.append({"id": sid[:32], "label": label, "done": bool(it.get("done", False))})
    return out


def _sanitize_tags(items) -> list[str]:
    """Normalise la liste de tags : strings uniques trim, ≤40 chars chacun,
    max 20 tags par carte. On lowercase pas — l'user garde sa casse."""
    out: list[str] = []
    seen = set()
    for it in items or []:
        if not isinstance(it, str):
            continue
        label = it.strip()[:40]
        if not label:
            continue
        key = label.lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(label)
        if len(out) >= 20:
            break
    return out


# ── Tags (autocomplete source — tous les tags utilisés par l'user) ───────

@router.get("/tags")
async def list_tags(request: Request, session: AsyncSession = Depends(get_session)):
    """Retourne tous les tags uniques utilisés par l'user sur l'ensemble de
    ses cartes. Utilisé par l'UI pour l'autocomplétion + la recherche."""
    uid = await _uid(request, session)
    _require_uid(uid)
    rs = await session.execute(
        select(ValkyrieCard.tags_json).where(ValkyrieCard.user_id == uid)
    )
    seen: dict[str, int] = {}  # label → count
    for (tags,) in rs.all():
        if not tags:
            continue
        for t in tags:
            if not isinstance(t, str):
                continue
            key = t.strip()
            if not key:
                continue
            seen[key] = seen.get(key, 0) + 1
    # Trié par fréquence descendante puis alphabétique
    ranked = sorted(seen.items(), key=lambda x: (-x[1], x[0].lower()))
    return {"tags": [{"label": k, "count": v} for k, v in ranked]}
