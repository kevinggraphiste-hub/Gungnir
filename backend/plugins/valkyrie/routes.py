"""
Valkyrie — API routes (CRUD per-user).

Chaque endpoint vérifie strictement l'ownership via `request.state.user_id`
(middleware d'auth) + un `ValkyrieProject.user_id == uid` sur la requête.
Aucun fallback global.
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from sqlalchemy import select, delete as _sqldelete, update as _sqlupdate, func as _sqlfunc
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
    # Optionnel : clé de template à appliquer à la création (seed cartes).
    template: Optional[str] = None


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
    # Date limite ISO "YYYY-MM-DD" ou vide/null pour retirer. On ne gère pas
    # d'heure ni de fuseau — une carte est due "pour le jour X".
    due_date: Optional[str] = None


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
        "due_date": c.due_date.date().isoformat() if c.due_date else None,
        "archived_at": c.archived_at.isoformat() if c.archived_at else None,
        "origin": c.origin or "",
        "created_at": c.created_at.isoformat() if c.created_at else None,
        "updated_at": c.updated_at.isoformat() if c.updated_at else None,
    }


def _parse_due_date(v: Optional[str]) -> Optional[datetime]:
    """Accepte 'YYYY-MM-DD' ou ISO complet. Retourne None si vide."""
    if not v:
        return None
    s = str(v).strip()
    if not s:
        return None
    try:
        # Format simple "YYYY-MM-DD"
        if len(s) == 10:
            return datetime.strptime(s, "%Y-%m-%d")
        # Format ISO complet
        return datetime.fromisoformat(s.replace("Z", "+00:00")).replace(tzinfo=None)
    except (ValueError, TypeError):
        return None


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
    # Si un template est fourni, on prend son titre/description par défaut
    # quand l'user n'en a pas saisi.
    tmpl = PROJECT_TEMPLATES.get((payload.template or "").strip()) if payload.template else None
    row = ValkyrieProject(
        user_id=uid,
        title=(payload.title or (tmpl["title"] if tmpl else "Nouveau projet")).strip()[:200],
        description=(payload.description or (tmpl["description"] if tmpl else "")).strip(),
        position=int(payload.position or 0),
    )
    session.add(row)
    await session.commit()
    await session.refresh(row)
    # Seed les cartes du template (positions + statuts built-in uniquement).
    if tmpl:
        for i, seed in enumerate(tmpl.get("cards", [])):
            session.add(ValkyrieCard(
                project_id=row.id, user_id=uid,
                title=seed.get("title", f"Carte {i+1}")[:300],
                subtitle=seed.get("subtitle", "")[:300],
                description=seed.get("description", ""),
                status_key=seed.get("status_key", "todo")[:60],
                position=i,
                subtasks_json=_sanitize_subtasks(seed.get("subtasks") or []),
                subtasks2_json=_sanitize_subtasks(seed.get("subtasks2") or []),
                subtasks2_title=seed.get("subtasks2_title", "")[:60],
                tags_json=_sanitize_tags(seed.get("tags") or []),
                origin=f"template:{payload.template}",
            ))
        await session.commit()
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
                      include_archived: bool = Query(False),
                      archived_only: bool = Query(False),
                      session: AsyncSession = Depends(get_session)):
    uid = await _uid(request, session)
    _require_uid(uid)
    # Vérifie l'ownership du projet
    await _get_project_owned(session, uid, project_id)
    q = select(ValkyrieCard).where(
        ValkyrieCard.project_id == project_id, ValkyrieCard.user_id == uid
    )
    if archived_only:
        q = q.where(ValkyrieCard.archived_at.isnot(None))
    elif not include_archived:
        q = q.where(ValkyrieCard.archived_at.is_(None))
    rs = await session.execute(q.order_by(ValkyrieCard.position, ValkyrieCard.id))
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
        due_date=_parse_due_date(payload.due_date),
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
    if payload.due_date is not None:
        # Chaîne vide → on vide la date. Sinon on parse.
        row.due_date = _parse_due_date(payload.due_date) if payload.due_date else None
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


# ═══════════════════════════════════════════════════════════════════════════
# Archive / Restore / Duplicate (actions sur une carte existante)
# ═══════════════════════════════════════════════════════════════════════════

@router.post("/cards/{card_id}/archive")
async def archive_card(card_id: int, request: Request,
                        session: AsyncSession = Depends(get_session)):
    """Soft-delete : la carte sort du board mais reste en DB, restaurable."""
    uid = await _uid(request, session)
    _require_uid(uid)
    row = await _get_card_owned(session, uid, card_id)
    if row.archived_at is None:
        row.archived_at = datetime.utcnow()
    await session.commit()
    return {"ok": True, "card": _serialize_card(row)}


@router.post("/cards/{card_id}/restore")
async def restore_card(card_id: int, request: Request,
                        session: AsyncSession = Depends(get_session)):
    uid = await _uid(request, session)
    _require_uid(uid)
    row = await _get_card_owned(session, uid, card_id)
    row.archived_at = None
    await session.commit()
    return {"ok": True, "card": _serialize_card(row)}


@router.post("/cards/{card_id}/duplicate")
async def duplicate_card(card_id: int, request: Request,
                          session: AsyncSession = Depends(get_session)):
    """Clone la carte dans le même projet, juste après l'original."""
    uid = await _uid(request, session)
    _require_uid(uid)
    src = await _get_card_owned(session, uid, card_id)
    clone = ValkyrieCard(
        project_id=src.project_id, user_id=uid,
        title=(src.title or "Carte") + " (copie)",
        subtitle=src.subtitle or "",
        description=src.description or "",
        status_key=src.status_key,
        position=(src.position or 0) + 1,
        expanded=False,
        subtasks_json=list(src.subtasks_json or []),
        subtasks2_json=list(src.subtasks2_json or []),
        subtasks2_title=src.subtasks2_title or "",
        tags_json=list(src.tags_json or []),
        due_date=None,
        origin="duplicate",
    )
    # Décale les positions suivantes pour garder un ordre cohérent.
    await session.execute(
        _sqlupdate(ValkyrieCard)
        .where(
            ValkyrieCard.project_id == src.project_id,
            ValkyrieCard.user_id == uid,
            ValkyrieCard.position > (src.position or 0),
            ValkyrieCard.archived_at.is_(None),
        )
        .values(position=ValkyrieCard.position + 1)
    )
    session.add(clone)
    await session.commit()
    await session.refresh(clone)
    return {"ok": True, "card": _serialize_card(clone)}


# ═══════════════════════════════════════════════════════════════════════════
# Stats dashboard par projet
# ═══════════════════════════════════════════════════════════════════════════

@router.get("/projects/{project_id}/stats")
async def project_stats(project_id: int, request: Request,
                         session: AsyncSession = Depends(get_session)):
    """Agrégats non-paginés pour le mini-dashboard : répartition par statut,
    overdue, done cette semaine, cartes bloquées (aucune sous-tâche cochée
    depuis 7 jours si déjà commencées)."""
    uid = await _uid(request, session)
    _require_uid(uid)
    await _get_project_owned(session, uid, project_id)
    rs = await session.execute(
        select(ValkyrieCard)
        .where(
            ValkyrieCard.project_id == project_id,
            ValkyrieCard.user_id == uid,
            ValkyrieCard.archived_at.is_(None),
        )
    )
    rows = rs.scalars().all()
    now = datetime.utcnow()
    today = now.date()
    week_ago = now - timedelta(days=7)
    by_status: dict[str, int] = {}
    overdue = 0
    due_this_week = 0
    done_this_week = 0
    total = 0
    subtasks_total = 0
    subtasks_done = 0
    for c in rows:
        total += 1
        by_status[c.status_key] = by_status.get(c.status_key, 0) + 1
        if c.due_date:
            d = c.due_date.date() if isinstance(c.due_date, datetime) else c.due_date
            if c.status_key != "done" and d < today:
                overdue += 1
            if today <= d <= (today + timedelta(days=7)):
                due_this_week += 1
        if c.status_key == "done" and c.updated_at and c.updated_at >= week_ago:
            done_this_week += 1
        for s in (c.subtasks_json or []) + (c.subtasks2_json or []):
            subtasks_total += 1
            if s.get("done"):
                subtasks_done += 1
    archived_rs = await session.execute(
        select(_sqlfunc.count(ValkyrieCard.id)).where(
            ValkyrieCard.project_id == project_id,
            ValkyrieCard.user_id == uid,
            ValkyrieCard.archived_at.isnot(None),
        )
    )
    archived_count = int(archived_rs.scalar() or 0)
    return {
        "total": total,
        "by_status": by_status,
        "overdue": overdue,
        "due_this_week": due_this_week,
        "done_this_week": done_this_week,
        "archived": archived_count,
        "subtasks_total": subtasks_total,
        "subtasks_done": subtasks_done,
    }


# ═══════════════════════════════════════════════════════════════════════════
# Templates de projet
# ═══════════════════════════════════════════════════════════════════════════

PROJECT_TEMPLATES: dict[str, dict] = {
    "blank": {
        "key": "blank",
        "title": "Nouveau projet",
        "description": "",
        "cards": [],
    },
    "dev_sprint": {
        "key": "dev_sprint",
        "title": "Sprint de dev",
        "description": "Cycle court : backlog → en cours → review → fait.",
        "cards": [
            {"title": "Définir le périmètre du sprint", "status_key": "doing",
             "subtasks": [{"label": "Objectif", "done": False},
                          {"label": "Critères de succès", "done": False}]},
            {"title": "Setup environnement", "status_key": "todo",
             "subtasks": [{"label": "Branche dédiée", "done": False},
                          {"label": "CI verte", "done": False}]},
            {"title": "Review + merge", "status_key": "todo"},
        ],
    },
    "personal_week": {
        "key": "personal_week",
        "title": "Semaine perso",
        "description": "Suivi hebdo : pro, perso, santé, admin.",
        "cards": [
            {"title": "Pro", "subtitle": "Priorités de la semaine", "status_key": "todo",
             "tags": ["pro"]},
            {"title": "Perso", "subtitle": "Projets perso, créatif, lecture", "status_key": "todo",
             "tags": ["perso"]},
            {"title": "Santé", "subtitle": "Sport, alimentation, sommeil", "status_key": "todo",
             "tags": ["santé"]},
            {"title": "Admin", "subtitle": "Factures, rendez-vous, démarches", "status_key": "todo",
             "tags": ["admin"]},
        ],
    },
    "bug_triage": {
        "key": "bug_triage",
        "title": "Bug triage",
        "description": "Tri des bugs entrants — priorité + reproduction + fix.",
        "cards": [
            {"title": "À reproduire", "status_key": "todo",
             "subtasks2_title": "Steps to reproduce"},
            {"title": "Confirmé — à fixer", "status_key": "doing"},
            {"title": "Déployé / à vérifier", "status_key": "doing"},
        ],
    },
    "content_plan": {
        "key": "content_plan",
        "title": "Plan de contenu",
        "description": "Idées → drafts → publiés.",
        "cards": [
            {"title": "Idée 1", "status_key": "todo", "tags": ["idée"]},
            {"title": "Idée 2", "status_key": "todo", "tags": ["idée"]},
            {"title": "Draft en cours", "status_key": "doing", "tags": ["draft"]},
        ],
    },
}


@router.get("/templates")
async def list_templates():
    """Catalogue des templates disponibles pour la création de projet."""
    return {
        "templates": [
            {
                "key": t["key"],
                "title": t["title"],
                "description": t["description"],
                "card_count": len(t.get("cards", [])),
            }
            for t in PROJECT_TEMPLATES.values()
        ],
    }


# ═══════════════════════════════════════════════════════════════════════════
# Intégration Conscience : import des goals en cartes Valkyrie
# ═══════════════════════════════════════════════════════════════════════════

@router.get("/projects/{project_id}/conscience-goals")
async def list_conscience_goals(project_id: int, request: Request,
                                 session: AsyncSession = Depends(get_session)):
    """Liste les goals Conscience de l'user, en marquant ceux déjà importés
    dans ce projet (via origin = 'conscience:goal:<id>')."""
    uid = await _uid(request, session)
    _require_uid(uid)
    await _get_project_owned(session, uid, project_id)
    # Récupère les goals de la conscience
    try:
        from backend.plugins.consciousness.engine import consciousness_manager
        engine = consciousness_manager.get(uid)
        goals = engine.get_goals(100) or []
    except Exception as e:
        logger.warning("conscience goals unavailable: %s", e)
        return {"goals": [], "error": "Conscience indisponible"}
    # Origines déjà importées dans ce projet
    rs = await session.execute(
        select(ValkyrieCard.origin).where(
            ValkyrieCard.project_id == project_id,
            ValkyrieCard.user_id == uid,
            ValkyrieCard.origin.like("conscience:goal:%"),
        )
    )
    imported = {row[0] for row in rs.all() if row[0]}
    out = []
    for g in goals:
        gid = str(g.get("id") or "")
        origin_key = f"conscience:goal:{gid}" if gid else ""
        out.append({
            **g,
            "imported": origin_key in imported,
            "origin_key": origin_key,
        })
    return {"goals": out}


class SyncGoalsIn(BaseModel):
    goal_ids: Optional[list[str]] = None  # None = tous les goals actifs


@router.post("/projects/{project_id}/sync-goals")
async def sync_conscience_goals(project_id: int, payload: SyncGoalsIn,
                                 request: Request,
                                 session: AsyncSession = Depends(get_session)):
    """Crée une carte Valkyrie pour chaque goal Conscience sélectionné.
    Déduplique via `origin=conscience:goal:<id>` pour éviter les doublons sur
    des appels répétés."""
    uid = await _uid(request, session)
    _require_uid(uid)
    await _get_project_owned(session, uid, project_id)
    try:
        from backend.plugins.consciousness.engine import consciousness_manager
        engine = consciousness_manager.get(uid)
        all_goals = engine.get_goals(100) or []
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"Conscience indisponible: {e}")
    wanted = set(payload.goal_ids) if payload.goal_ids else None
    # Origines déjà importées → skip
    rs = await session.execute(
        select(ValkyrieCard.origin).where(
            ValkyrieCard.project_id == project_id,
            ValkyrieCard.user_id == uid,
            ValkyrieCard.origin.like("conscience:goal:%"),
        )
    )
    imported = {row[0] for row in rs.all() if row[0]}
    # Position de départ = max + 1
    pos_rs = await session.execute(
        select(_sqlfunc.max(ValkyrieCard.position)).where(
            ValkyrieCard.project_id == project_id,
            ValkyrieCard.user_id == uid,
        )
    )
    next_pos = int(pos_rs.scalar() or 0) + 1
    created: list[dict] = []
    for g in all_goals:
        gid = str(g.get("id") or "")
        if not gid:
            continue
        if wanted is not None and gid not in wanted:
            continue
        origin_key = f"conscience:goal:{gid}"
        if origin_key in imported:
            continue
        status = str(g.get("status") or "proposed")
        status_key = "doing" if status == "active" else (
            "done" if status == "completed" else "todo"
        )
        card = ValkyrieCard(
            project_id=project_id, user_id=uid,
            title=str(g.get("title") or "Objectif")[:300],
            subtitle="Objectif Conscience",
            description=str(g.get("description") or "")[:2000],
            status_key=status_key,
            position=next_pos,
            tags_json=["conscience"],
            origin=origin_key,
        )
        session.add(card)
        next_pos += 1
        created.append({"goal_id": gid, "title": card.title})
    await session.commit()
    return {"ok": True, "created": len(created), "items": created}
