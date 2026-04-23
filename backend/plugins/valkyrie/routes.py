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
    recurrence_rule: Optional[str] = None  # "", "daily", "weekly[:1,3,5]", "monthly"


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
        # Normalise à la lecture aussi (pas juste à l'écriture) — rattrape
        # les cartes historiques qui avaient DEV, Dev, dev côte à côte.
        "tags": _sanitize_tags(list(c.tags_json or [])),
        "due_date": c.due_date.date().isoformat() if c.due_date else None,
        "archived_at": c.archived_at.isoformat() if c.archived_at else None,
        "origin": c.origin or "",
        "recurrence_rule": c.recurrence_rule or "",
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
        recurrence_rule=_sanitize_recurrence(payload.recurrence_rule),
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
    if payload.recurrence_rule is not None:
        row.recurrence_rule = _sanitize_recurrence(payload.recurrence_rule)

    # ── Récurrence : si la carte vient de passer à "done" et qu'elle a une
    # règle de récurrence, on crée la prochaine occurrence (avec la due_date
    # décalée) et on archive la carte actuelle pour garder l'historique.
    spawned = None
    if (payload.status_key is not None and row.status_key == "done"
            and (row.recurrence_rule or "").strip()):
        spawned = await _spawn_next_recurrence(session, row)

    await session.commit()
    result = {"card": _serialize_card(row)}
    if spawned:
        result["spawned"] = _serialize_card(spawned)
    return result


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


_VALID_RECURRENCE_PREFIXES = ("daily", "weekly", "monthly")

def _sanitize_recurrence(v: Optional[str]) -> str:
    """Valide/normalise une règle de récurrence. Retourne '' si invalide."""
    if not v:
        return ""
    s = str(v).strip().lower()[:40]
    if not s:
        return ""
    base = s.split(":", 1)[0]
    if base not in _VALID_RECURRENCE_PREFIXES:
        return ""
    # weekly:1,3 etc. — on garde tel quel (parsé au spawn).
    return s


async def _spawn_next_recurrence(session: AsyncSession, src: ValkyrieCard) -> Optional[ValkyrieCard]:
    """Calcule la prochaine due_date selon la règle puis insère une nouvelle
    carte identique dans le même projet. Retourne la nouvelle carte ou None
    si la règle est invalide ou la source n'a pas de due_date."""
    rule = (src.recurrence_rule or "").strip()
    if not rule:
        return None
    base_date = src.due_date.date() if src.due_date else datetime.utcnow().date()
    prefix, _, spec = rule.partition(":")
    next_date = None
    if prefix == "daily":
        next_date = base_date + timedelta(days=1)
    elif prefix == "weekly":
        if spec:
            # Liste de jours (1=lun..7=dim). Prochaine occurrence après base_date.
            wanted: list[int] = []
            for tok in spec.split(","):
                try:
                    n = int(tok.strip())
                    if 1 <= n <= 7:
                        wanted.append(n)
                except ValueError:
                    continue
            wanted = sorted(set(wanted))
            if not wanted:
                next_date = base_date + timedelta(days=7)
            else:
                # Cherche le prochain jour >= base_date+1 qui match
                for delta in range(1, 15):
                    cand = base_date + timedelta(days=delta)
                    iso_w = cand.isoweekday()
                    if iso_w in wanted:
                        next_date = cand
                        break
        else:
            next_date = base_date + timedelta(days=7)
    elif prefix == "monthly":
        # Même jour de mois, mois suivant. Gère les bords (31 → dernier jour).
        y, m, d = base_date.year, base_date.month + 1, base_date.day
        if m > 12:
            y += 1; m = 1
        # Clamp au dernier jour du mois cible
        import calendar as _cal
        last = _cal.monthrange(y, m)[1]
        next_date = datetime(y, m, min(d, last)).date()
    if next_date is None:
        return None
    # Crée la nouvelle carte (même projet, subtasks re-décochées)
    def _reset_done(items):
        out = []
        for it in (items or []):
            if isinstance(it, dict):
                out.append({**it, "done": False})
        return out
    clone = ValkyrieCard(
        project_id=src.project_id, user_id=src.user_id,
        title=src.title or "",
        subtitle=src.subtitle or "",
        description=src.description or "",
        status_key="todo",
        position=(src.position or 0),
        expanded=False,
        subtasks_json=_reset_done(src.subtasks_json),
        subtasks2_json=_reset_done(src.subtasks2_json),
        subtasks2_title=src.subtasks2_title or "",
        tags_json=list(src.tags_json or []),
        due_date=datetime(next_date.year, next_date.month, next_date.day),
        recurrence_rule=rule,
        origin=f"recurrence:{src.id}",
    )
    session.add(clone)
    # Archive la carte source complétée pour ne pas polluer le board.
    if src.archived_at is None:
        src.archived_at = datetime.utcnow()
    return clone


def _sanitize_tags(items) -> list[str]:
    """Normalise la liste de tags : strings uniques trim, ≤40 chars, max 20
    par carte. Forme canonique Title Case (première lettre UPPER, reste
    LOWER) → 'DEV' = 'Dev' = 'dev' tous stockés 'Dev'. Insensible à la
    casse côté dédup et côté comparaison globale.
    """
    out: list[str] = []
    seen = set()
    for it in items or []:
        if not isinstance(it, str):
            continue
        cleaned = it.strip()[:40]
        if not cleaned:
            continue
        canonical = cleaned[:1].upper() + cleaned[1:].lower()
        key = canonical.lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(canonical)
        if len(out) >= 20:
            break
    return out


# ── Tags (autocomplete source — tous les tags utilisés par l'user) ───────

@router.get("/tags")
async def list_tags(request: Request, session: AsyncSession = Depends(get_session)):
    """Retourne tous les tags uniques utilisés par l'user. Dédup insensible
    à la casse + forme canonique Title Case pour l'affichage (DEV / Dev /
    dev → 'Dev'). Count agrégé sur toutes les variantes de casse."""
    uid = await _uid(request, session)
    _require_uid(uid)
    rs = await session.execute(
        select(ValkyrieCard.tags_json).where(ValkyrieCard.user_id == uid)
    )
    seen: dict[str, dict] = {}  # lowercase_key → {label, count}
    for (tags,) in rs.all():
        if not tags:
            continue
        for t in tags:
            if not isinstance(t, str):
                continue
            cleaned = t.strip()
            if not cleaned:
                continue
            canonical = cleaned[:1].upper() + cleaned[1:].lower()
            key = canonical.lower()
            entry = seen.setdefault(key, {"label": canonical, "count": 0})
            entry["count"] += 1
    ranked = sorted(seen.values(), key=lambda x: (-x["count"], x["label"].lower()))
    return {"tags": ranked}


# ═══════════════════════════════════════════════════════════════════════════
# Rappels (deadlines) — tous projets user confondus, non archivé, non done
# ═══════════════════════════════════════════════════════════════════════════

@router.get("/reminders")
async def list_reminders(request: Request,
                          session: AsyncSession = Depends(get_session)):
    """Retourne 3 buckets : overdue (retard), today, soon (≤ 7j).
    Agrège sur tous les projets non-archivés de l'user."""
    uid = await _uid(request, session)
    _require_uid(uid)
    today = datetime.utcnow().date()
    week_ahead = today + timedelta(days=7)
    rs = await session.execute(
        select(ValkyrieCard, ValkyrieProject.title)
        .join(ValkyrieProject, ValkyrieProject.id == ValkyrieCard.project_id)
        .where(
            ValkyrieCard.user_id == uid,
            ValkyrieCard.archived_at.is_(None),
            ValkyrieCard.status_key != "done",
            ValkyrieCard.due_date.isnot(None),
            ValkyrieProject.archived.is_(False),
        )
        .order_by(ValkyrieCard.due_date)
    )
    overdue: list[dict] = []
    today_list: list[dict] = []
    soon: list[dict] = []
    for card, proj_title in rs.all():
        if not card.due_date:
            continue
        d = card.due_date.date() if isinstance(card.due_date, datetime) else card.due_date
        item = {
            "id": card.id,
            "project_id": card.project_id,
            "project_title": proj_title,
            "title": card.title,
            "status_key": card.status_key,
            "due_date": d.isoformat(),
            "days_diff": (d - today).days,
        }
        if d < today:
            overdue.append(item)
        elif d == today:
            today_list.append(item)
        elif d <= week_ahead:
            soon.append(item)
    return {
        "overdue": overdue,
        "today": today_list,
        "soon": soon,
        "total": len(overdue) + len(today_list) + len(soon),
    }


# ═══════════════════════════════════════════════════════════════════════════
# Bulk operations (pour les UI multi-sélection)
# ═══════════════════════════════════════════════════════════════════════════

class ImportIn(BaseModel):
    format: str  # "json" | "csv" | "markdown"
    data: str    # contenu brut
    default_status: Optional[str] = "todo"


@router.post("/projects/{project_id}/import")
async def import_cards(project_id: int, payload: ImportIn, request: Request,
                        session: AsyncSession = Depends(get_session)):
    """Import de cartes depuis un contenu texte brut.

    Formats supportés :
    - JSON : soit un export Valkyrie (`{cards: [...]}`), soit un array
      de dicts `[{title, description?, status_key?, tags?, due_date?, subtasks?}, ...]`.
    - CSV : première ligne = header ; colonnes reconnues : title, subtitle,
      description, status, tags (séparés par `|`), due_date (YYYY-MM-DD).
    - Markdown : les `# Heading` deviennent des statuts (best-effort via
      label), les `- item` en dessous deviennent des cartes. Les sous-items
      indentés deviennent des sous-tâches.
    """
    uid = await _uid(request, session)
    _require_uid(uid)
    await _get_project_owned(session, uid, project_id)
    default_status = (payload.default_status or "todo").strip()[:60] or "todo"
    fmt = (payload.format or "").strip().lower()
    raw = payload.data or ""
    if not raw.strip():
        return {"ok": True, "created": 0, "items": []}

    # Position de départ = max + 1
    pos_rs = await session.execute(
        select(_sqlfunc.max(ValkyrieCard.position)).where(
            ValkyrieCard.project_id == project_id, ValkyrieCard.user_id == uid,
        )
    )
    next_pos = int(pos_rs.scalar() or 0) + 1
    created: list[dict] = []

    def _mk_card(d: dict) -> ValkyrieCard:
        nonlocal next_pos
        subs_raw = d.get("subtasks") or []
        subs_clean: list[dict] = []
        if isinstance(subs_raw, list):
            for s in subs_raw:
                if isinstance(s, str):
                    subs_clean.append({"label": s.strip()[:200], "done": False})
                elif isinstance(s, dict):
                    subs_clean.append({
                        "label": str(s.get("label", "")).strip()[:200],
                        "done": bool(s.get("done", False)),
                    })
        subs_clean = _sanitize_subtasks(subs_clean)
        # Accepte "status" ou "status_key"
        raw_status = str(d.get("status_key") or d.get("status") or default_status).strip()[:60]
        row = ValkyrieCard(
            project_id=project_id, user_id=uid,
            title=str(d.get("title") or "Importée").strip()[:300],
            subtitle=str(d.get("subtitle") or "").strip()[:300],
            description=str(d.get("description") or "").strip(),
            status_key=raw_status or default_status,
            position=next_pos,
            subtasks_json=subs_clean,
            tags_json=_sanitize_tags(d.get("tags") or []),
            due_date=_parse_due_date(d.get("due_date")),
            origin="import",
        )
        next_pos += 1
        return row

    try:
        if fmt == "json":
            import json as _json
            parsed = _json.loads(raw)
            items = parsed.get("cards") if isinstance(parsed, dict) else parsed
            if not isinstance(items, list):
                raise HTTPException(400, detail="JSON : attendu une liste ou {cards: [...]}")
            for it in items:
                if isinstance(it, dict):
                    row = _mk_card(it)
                    session.add(row)
                    created.append({"title": row.title, "status_key": row.status_key})
        elif fmt == "csv":
            import csv as _csv
            from io import StringIO
            reader = _csv.DictReader(StringIO(raw))
            for r in reader:
                d = {
                    "title": r.get("title") or r.get("Title") or "",
                    "subtitle": r.get("subtitle") or "",
                    "description": r.get("description") or r.get("desc") or "",
                    "status_key": r.get("status_key") or r.get("status") or default_status,
                    "due_date": r.get("due_date") or r.get("due") or "",
                    "tags": [t.strip() for t in (r.get("tags") or "").split("|") if t.strip()],
                }
                if not d["title"]:
                    continue
                row = _mk_card(d)
                session.add(row)
                created.append({"title": row.title, "status_key": row.status_key})
        elif fmt == "markdown":
            # Parseur best-effort : # → statut courant ; - → carte ;
            # sous-indentation "  - " → sous-tâche de la carte précédente.
            current_status = default_status
            current_card: dict | None = None
            for line in raw.splitlines():
                stripped = line.strip()
                if not stripped:
                    continue
                if stripped.startswith("# "):
                    label = stripped[2:].strip().lower()
                    # On ne crée pas de statut custom — on mappe vers les
                    # built-in communs puis fallback default_status.
                    if label in ("à faire", "a faire", "todo"):
                        current_status = "todo"
                    elif label in ("en cours", "doing", "in progress"):
                        current_status = "doing"
                    elif label in ("fait", "done", "terminé", "termine"):
                        current_status = "done"
                    else:
                        current_status = default_status
                    current_card = None
                elif stripped.startswith("- ") or stripped.startswith("* "):
                    # Indentation : nombre d'espaces avant le tiret (2 = subtask)
                    indent = len(line) - len(line.lstrip())
                    text = stripped[2:].strip()
                    if indent >= 2 and current_card is not None:
                        current_card.setdefault("subtasks", []).append(text)
                    else:
                        if current_card:
                            row = _mk_card(current_card)
                            session.add(row)
                            created.append({"title": row.title, "status_key": row.status_key})
                        current_card = {"title": text, "status_key": current_status}
            if current_card:
                row = _mk_card(current_card)
                session.add(row)
                created.append({"title": row.title, "status_key": row.status_key})
        else:
            raise HTTPException(400, detail=f"Format inconnu : {fmt!r} (attendu json/csv/markdown)")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(400, detail=f"Erreur de parsing : {e}")

    await session.commit()
    return {"ok": True, "created": len(created), "items": created}


class BulkIn(BaseModel):
    card_ids: list[int]
    action: str  # "archive" | "delete" | "set_status" | "add_tag" | "remove_tag"
    status_key: Optional[str] = None
    tag: Optional[str] = None


@router.post("/cards/bulk")
async def bulk_cards(payload: BulkIn, request: Request,
                      session: AsyncSession = Depends(get_session)):
    """Applique une action à un batch de cartes possédées par l'user.
    Retourne le nombre de cartes affectées."""
    uid = await _uid(request, session)
    _require_uid(uid)
    ids = [int(x) for x in (payload.card_ids or []) if isinstance(x, int) or (isinstance(x, str) and x.isdigit())]
    if not ids:
        return {"ok": True, "affected": 0}
    action = (payload.action or "").strip()
    # Filtre strict : seules les cartes de l'user sont touchées.
    rs = await session.execute(
        select(ValkyrieCard).where(
            ValkyrieCard.id.in_(ids), ValkyrieCard.user_id == uid,
        )
    )
    rows = rs.scalars().all()
    now = datetime.utcnow()
    if action == "archive":
        for r in rows:
            if r.archived_at is None:
                r.archived_at = now
    elif action == "restore":
        for r in rows:
            r.archived_at = None
    elif action == "delete":
        for r in rows:
            await session.delete(r)
    elif action == "set_status":
        target = (payload.status_key or "todo").strip()[:60] or "todo"
        for r in rows:
            r.status_key = target
    elif action == "add_tag":
        tag = (payload.tag or "").strip()[:40]
        if tag:
            for r in rows:
                existing = list(r.tags_json or [])
                if tag.lower() not in [t.lower() for t in existing if isinstance(t, str)]:
                    existing.append(tag)
                    r.tags_json = _sanitize_tags(existing)
                    flag_modified(r, "tags_json")
    elif action == "remove_tag":
        tag = (payload.tag or "").strip()[:40]
        if tag:
            for r in rows:
                r.tags_json = [t for t in (r.tags_json or []) if isinstance(t, str) and t.lower() != tag.lower()]
                flag_modified(r, "tags_json")
    else:
        raise HTTPException(status_code=400, detail=f"Action inconnue: {action}")
    await session.commit()
    return {"ok": True, "affected": len(rows), "action": action}


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
