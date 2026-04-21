"""
valkyrie_tools.py — Outils WOLF permettant à l'agent de piloter Valkyrie.

Tous les accès sont per-user (via `get_user_context()`), stricts : l'agent
ne peut toucher que les projets/cartes de l'user courant. Aucune admin.

Convention des tools WOLF :
- Fonctions async Python typées, retournent un dict avec {"ok": bool, ...}.
- Schémas OpenAI-compatible à ajouter dans WOLF_TOOL_SCHEMAS et exécuteurs
  à mapper dans WOLF_EXECUTORS (dans wolf_tools.py).
"""
from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any, Optional

from .wolf_tools import get_user_context


# ── Schemas exposés au LLM ─────────────────────────────────────────────────

VALKYRIE_TOOL_SCHEMAS: list[dict] = [
    {
        "type": "function",
        "function": {
            "name": "valkyrie_list_projects",
            "description": "Liste les projets Valkyrie de l'utilisateur (tableaux de tâches). Utile avant de créer/modifier des cartes.",
            "parameters": {
                "type": "object",
                "properties": {
                    "include_archived": {
                        "type": "boolean",
                        "description": "Inclure les projets archivés (par défaut: false).",
                    },
                },
                "required": [],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "valkyrie_list_cards",
            "description": "Liste les cartes d'un projet Valkyrie. Peut filtrer par statut, overdue, ou archive.",
            "parameters": {
                "type": "object",
                "properties": {
                    "project_id": {"type": "integer", "description": "ID du projet."},
                    "status_key": {"type": "string", "description": "Filtrer par statut (ex: 'todo', 'doing', 'done' ou custom)."},
                    "overdue_only": {"type": "boolean", "description": "Retourne uniquement les cartes en retard."},
                    "archived_only": {"type": "boolean", "description": "Retourne uniquement les cartes archivées."},
                },
                "required": ["project_id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "valkyrie_create_card",
            "description": "Crée une nouvelle carte dans un projet Valkyrie. Retourne la carte créée.",
            "parameters": {
                "type": "object",
                "properties": {
                    "project_id": {"type": "integer", "description": "ID du projet cible."},
                    "title": {"type": "string", "description": "Titre de la carte."},
                    "subtitle": {"type": "string", "description": "Sous-titre optionnel."},
                    "description": {"type": "string", "description": "Description (supporte le markdown)."},
                    "status_key": {"type": "string", "description": "Statut initial (default: todo)."},
                    "due_date": {"type": "string", "description": "Date limite ISO YYYY-MM-DD."},
                    "tags": {"type": "array", "items": {"type": "string"}, "description": "Tags libres."},
                    "subtasks": {"type": "array", "items": {"type": "string"}, "description": "Liste de labels de sous-tâches à créer (non cochées)."},
                },
                "required": ["project_id", "title"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "valkyrie_update_card",
            "description": "Met à jour une carte (titre, description, statut, date limite, tags, récurrence). Omet les champs non fournis.",
            "parameters": {
                "type": "object",
                "properties": {
                    "card_id": {"type": "integer", "description": "ID de la carte."},
                    "title": {"type": "string"},
                    "subtitle": {"type": "string"},
                    "description": {"type": "string"},
                    "status_key": {"type": "string"},
                    "due_date": {"type": "string", "description": "ISO YYYY-MM-DD, ou chaîne vide pour retirer."},
                    "tags": {"type": "array", "items": {"type": "string"}},
                    "recurrence_rule": {
                        "type": "string",
                        "description": "Règle de récurrence : '' (aucune), 'daily', 'weekly', 'weekly:1,3,5' (1=lun..7=dim), 'monthly'. Quand la carte passe en 'done', la suivante est auto-créée.",
                    },
                },
                "required": ["card_id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "valkyrie_add_subtask",
            "description": "Ajoute une sous-tâche à une carte existante. Les sous-tâches sont identifiées par leur label.",
            "parameters": {
                "type": "object",
                "properties": {
                    "card_id": {"type": "integer"},
                    "label": {"type": "string"},
                    "list": {"type": "integer", "description": "1 = liste principale, 2 = seconde liste (default: 1)."},
                    "done": {"type": "boolean", "description": "Créer déjà cochée (default: false)."},
                },
                "required": ["card_id", "label"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "valkyrie_toggle_subtask",
            "description": "Coche ou décoche une sous-tâche existante par son label (recherche case-insensitive).",
            "parameters": {
                "type": "object",
                "properties": {
                    "card_id": {"type": "integer"},
                    "label": {"type": "string", "description": "Label de la sous-tâche à basculer."},
                    "done": {"type": "boolean", "description": "Forcer un état (true/false). Si omis, bascule."},
                },
                "required": ["card_id", "label"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "valkyrie_archive_card",
            "description": "Archive une carte (soft-delete — restaurable). Utiliser plutôt que supprimer sauf si demandé explicitement.",
            "parameters": {
                "type": "object",
                "properties": {"card_id": {"type": "integer"}},
                "required": ["card_id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "valkyrie_get_stats",
            "description": "Retourne le dashboard d'un projet : total, répartition par statut, overdue, due cette semaine, done cette semaine.",
            "parameters": {
                "type": "object",
                "properties": {"project_id": {"type": "integer"}},
                "required": ["project_id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "valkyrie_get_reminders",
            "description": "Liste les cartes en retard ou à échéance proche (≤ 7j) sur tous les projets de l'user. Utile pour un coup d'œil agenda.",
            "parameters": {"type": "object", "properties": {}, "required": []},
        },
    },
    # ── Projets ──────────────────────────────────────────────────────
    {
        "type": "function",
        "function": {
            "name": "valkyrie_create_project",
            "description": "Crée un nouveau tableau Valkyrie. Option : partir d'un template (dev_sprint, personal_week, bug_triage, content_plan).",
            "parameters": {
                "type": "object",
                "properties": {
                    "title": {"type": "string"},
                    "description": {"type": "string"},
                    "template": {"type": "string", "description": "Clé optionnelle : blank, dev_sprint, personal_week, bug_triage, content_plan."},
                },
                "required": ["title"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "valkyrie_update_project",
            "description": "Renomme ou archive un projet.",
            "parameters": {
                "type": "object",
                "properties": {
                    "project_id": {"type": "integer"},
                    "title": {"type": "string"},
                    "description": {"type": "string"},
                    "archived": {"type": "boolean"},
                },
                "required": ["project_id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "valkyrie_list_templates",
            "description": "Liste les templates de projet disponibles.",
            "parameters": {"type": "object", "properties": {}, "required": []},
        },
    },
    # ── Statuts ──────────────────────────────────────────────────────
    {
        "type": "function",
        "function": {
            "name": "valkyrie_list_statuses",
            "description": "Liste les statuts de l'user (built-in todo/doing/done + custom).",
            "parameters": {"type": "object", "properties": {}, "required": []},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "valkyrie_create_status",
            "description": "Crée un statut custom (en plus des built-in todo/doing/done).",
            "parameters": {
                "type": "object",
                "properties": {
                    "label": {"type": "string"},
                    "color": {"type": "string", "description": "Hex color (ex: #7a8a9b)."},
                },
                "required": ["label", "color"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "valkyrie_delete_status",
            "description": "Supprime un statut custom. Les cartes utilisant ce statut retombent sur 'todo'.",
            "parameters": {
                "type": "object",
                "properties": {"status_id": {"type": "integer"}},
                "required": ["status_id"],
            },
        },
    },
    # ── Cartes : actions avancées ────────────────────────────────────
    {
        "type": "function",
        "function": {
            "name": "valkyrie_duplicate_card",
            "description": "Clone une carte dans le même projet (juste après l'original, sans la due_date).",
            "parameters": {
                "type": "object",
                "properties": {"card_id": {"type": "integer"}},
                "required": ["card_id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "valkyrie_restore_card",
            "description": "Restaure une carte archivée (inverse de archive).",
            "parameters": {
                "type": "object",
                "properties": {"card_id": {"type": "integer"}},
                "required": ["card_id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "valkyrie_delete_card",
            "description": "Supprime définitivement une carte (non réversible). Préférer valkyrie_archive_card sauf demande explicite.",
            "parameters": {
                "type": "object",
                "properties": {"card_id": {"type": "integer"}},
                "required": ["card_id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "valkyrie_remove_subtask",
            "description": "Retire une sous-tâche d'une carte par son label (case-insensitive).",
            "parameters": {
                "type": "object",
                "properties": {
                    "card_id": {"type": "integer"},
                    "label": {"type": "string"},
                },
                "required": ["card_id", "label"],
            },
        },
    },
    # ── Bulk / Import / Tags ─────────────────────────────────────────
    {
        "type": "function",
        "function": {
            "name": "valkyrie_bulk_cards",
            "description": "Applique une action à un lot de cartes : archive, restore, delete, set_status, add_tag, remove_tag.",
            "parameters": {
                "type": "object",
                "properties": {
                    "card_ids": {"type": "array", "items": {"type": "integer"}},
                    "action": {
                        "type": "string",
                        "enum": ["archive", "restore", "delete", "set_status", "add_tag", "remove_tag"],
                    },
                    "status_key": {"type": "string", "description": "Requis si action=set_status."},
                    "tag": {"type": "string", "description": "Requis si action=add_tag ou remove_tag."},
                },
                "required": ["card_ids", "action"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "valkyrie_import_cards",
            "description": "Importe des cartes depuis du texte brut (JSON, CSV, Markdown). Voir endpoint pour détails des formats.",
            "parameters": {
                "type": "object",
                "properties": {
                    "project_id": {"type": "integer"},
                    "format": {"type": "string", "enum": ["json", "csv", "markdown"]},
                    "data": {"type": "string", "description": "Contenu textuel à parser."},
                    "default_status": {"type": "string", "description": "Statut par défaut si non spécifié (default: todo)."},
                },
                "required": ["project_id", "format", "data"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "valkyrie_list_tags",
            "description": "Liste tous les tags utilisés par l'user avec leur compteur. Utile pour l'autocomplétion / proposer des tags existants.",
            "parameters": {"type": "object", "properties": {}, "required": []},
        },
    },
]


# ── Executors ────────────────────────────────────────────────────────────

async def _valkyrie_list_projects(include_archived: bool = False) -> dict:
    uid = get_user_context()
    if not uid:
        return {"ok": False, "error": "Utilisateur non authentifié."}
    from backend.core.db.engine import async_session
    from backend.plugins.valkyrie.models import ValkyrieProject
    from sqlalchemy import select
    async with async_session() as session:
        q = select(ValkyrieProject).where(ValkyrieProject.user_id == uid)
        if not include_archived:
            q = q.where(ValkyrieProject.archived.is_(False))
        rs = await session.execute(q.order_by(ValkyrieProject.position, ValkyrieProject.id))
        rows = rs.scalars().all()
        return {
            "ok": True,
            "projects": [
                {
                    "id": p.id,
                    "title": p.title,
                    "description": p.description or "",
                    "archived": bool(p.archived),
                }
                for p in rows
            ],
        }


async def _valkyrie_list_cards(
    project_id: int,
    status_key: Optional[str] = None,
    overdue_only: bool = False,
    archived_only: bool = False,
) -> dict:
    uid = get_user_context()
    if not uid:
        return {"ok": False, "error": "Utilisateur non authentifié."}
    from backend.core.db.engine import async_session
    from backend.plugins.valkyrie.models import ValkyrieCard, ValkyrieProject
    from sqlalchemy import select
    async with async_session() as session:
        # Vérifie l'ownership
        proj = await session.execute(
            select(ValkyrieProject).where(
                ValkyrieProject.id == project_id, ValkyrieProject.user_id == uid,
            )
        )
        if not proj.scalar_one_or_none():
            return {"ok": False, "error": "Projet introuvable ou non accessible."}
        q = select(ValkyrieCard).where(
            ValkyrieCard.project_id == project_id, ValkyrieCard.user_id == uid,
        )
        if archived_only:
            q = q.where(ValkyrieCard.archived_at.isnot(None))
        else:
            q = q.where(ValkyrieCard.archived_at.is_(None))
        if status_key:
            q = q.where(ValkyrieCard.status_key == status_key)
        rs = await session.execute(q.order_by(ValkyrieCard.position, ValkyrieCard.id))
        rows = rs.scalars().all()
        today = datetime.utcnow().date()
        out = []
        for c in rows:
            d = c.due_date.date() if c.due_date else None
            is_overdue = bool(d and d < today and c.status_key != "done")
            if overdue_only and not is_overdue:
                continue
            out.append({
                "id": c.id,
                "title": c.title,
                "subtitle": c.subtitle or "",
                "description": c.description or "",
                "status_key": c.status_key,
                "due_date": d.isoformat() if d else None,
                "overdue": is_overdue,
                "tags": list(c.tags_json or []),
                "subtasks_done": sum(1 for s in (c.subtasks_json or []) if s.get("done"))
                    + sum(1 for s in (c.subtasks2_json or []) if s.get("done")),
                "subtasks_total": len(c.subtasks_json or []) + len(c.subtasks2_json or []),
                "archived": c.archived_at is not None,
            })
        return {"ok": True, "project_id": project_id, "count": len(out), "cards": out}


def _parse_due(v: Optional[str]):
    if not v:
        return None
    s = str(v).strip()
    if not s:
        return None
    try:
        if len(s) == 10:
            return datetime.strptime(s, "%Y-%m-%d")
        return datetime.fromisoformat(s.replace("Z", "+00:00")).replace(tzinfo=None)
    except (ValueError, TypeError):
        return None


def _normalize_tags(items) -> list[str]:
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


async def _valkyrie_create_card(
    project_id: int,
    title: str,
    subtitle: Optional[str] = None,
    description: Optional[str] = None,
    status_key: Optional[str] = None,
    due_date: Optional[str] = None,
    tags: Optional[list] = None,
    subtasks: Optional[list] = None,
) -> dict:
    uid = get_user_context()
    if not uid:
        return {"ok": False, "error": "Utilisateur non authentifié."}
    from backend.core.db.engine import async_session
    from backend.plugins.valkyrie.models import ValkyrieCard, ValkyrieProject
    from sqlalchemy import select
    import uuid as _uuid
    async with async_session() as session:
        proj = await session.execute(
            select(ValkyrieProject).where(
                ValkyrieProject.id == project_id, ValkyrieProject.user_id == uid,
            )
        )
        if not proj.scalar_one_or_none():
            return {"ok": False, "error": "Projet introuvable ou non accessible."}
        subs: list[dict] = []
        for s in (subtasks or []):
            lbl = str(s).strip()[:200]
            if lbl:
                subs.append({"id": f"s_{_uuid.uuid4().hex[:8]}", "label": lbl, "done": False})
        row = ValkyrieCard(
            project_id=project_id,
            user_id=uid,
            title=str(title).strip()[:300] or "Nouvelle carte",
            subtitle=(subtitle or "").strip()[:300],
            description=(description or "").strip(),
            status_key=(status_key or "todo").strip()[:60] or "todo",
            due_date=_parse_due(due_date),
            tags_json=_normalize_tags(tags or []),
            subtasks_json=subs,
            subtasks2_json=[],
            origin="agent",
        )
        session.add(row)
        await session.commit()
        await session.refresh(row)
        return {
            "ok": True,
            "card": {
                "id": row.id,
                "title": row.title,
                "status_key": row.status_key,
                "due_date": row.due_date.date().isoformat() if row.due_date else None,
                "tags": list(row.tags_json or []),
            },
        }


async def _valkyrie_update_card(
    card_id: int,
    title: Optional[str] = None,
    subtitle: Optional[str] = None,
    description: Optional[str] = None,
    status_key: Optional[str] = None,
    due_date: Optional[str] = None,
    tags: Optional[list] = None,
    recurrence_rule: Optional[str] = None,
) -> dict:
    uid = get_user_context()
    if not uid:
        return {"ok": False, "error": "Utilisateur non authentifié."}
    from backend.core.db.engine import async_session
    from backend.plugins.valkyrie.models import ValkyrieCard
    from backend.plugins.valkyrie.routes import _sanitize_recurrence, _spawn_next_recurrence
    from sqlalchemy import select
    from sqlalchemy.orm.attributes import flag_modified
    async with async_session() as session:
        rs = await session.execute(
            select(ValkyrieCard).where(
                ValkyrieCard.id == card_id, ValkyrieCard.user_id == uid,
            )
        )
        row = rs.scalar_one_or_none()
        if not row:
            return {"ok": False, "error": "Carte introuvable."}
        if title is not None:
            row.title = str(title).strip()[:300]
        if subtitle is not None:
            row.subtitle = str(subtitle).strip()[:300]
        if description is not None:
            row.description = str(description).strip()
        if status_key is not None:
            row.status_key = str(status_key).strip()[:60] or "todo"
        if due_date is not None:
            row.due_date = _parse_due(due_date) if due_date else None
        if tags is not None:
            row.tags_json = _normalize_tags(tags)
            flag_modified(row, "tags_json")
        if recurrence_rule is not None:
            row.recurrence_rule = _sanitize_recurrence(recurrence_rule)
        # Récurrence : spawn la prochaine instance si on vient de passer en done
        spawned = None
        if (status_key is not None and row.status_key == "done"
                and (row.recurrence_rule or "").strip()):
            spawned = await _spawn_next_recurrence(session, row)
        await session.commit()
        out = {
            "ok": True,
            "card": {
                "id": row.id,
                "title": row.title,
                "status_key": row.status_key,
                "due_date": row.due_date.date().isoformat() if row.due_date else None,
                "recurrence_rule": row.recurrence_rule or "",
            },
        }
        if spawned:
            out["spawned"] = {
                "id": spawned.id,
                "title": spawned.title,
                "due_date": spawned.due_date.date().isoformat() if spawned.due_date else None,
            }
        return out


async def _valkyrie_add_subtask(
    card_id: int, label: str, list: int = 1, done: bool = False,
) -> dict:
    uid = get_user_context()
    if not uid:
        return {"ok": False, "error": "Utilisateur non authentifié."}
    from backend.core.db.engine import async_session
    from backend.plugins.valkyrie.models import ValkyrieCard
    from sqlalchemy import select
    from sqlalchemy.orm.attributes import flag_modified
    import uuid as _uuid
    async with async_session() as session:
        rs = await session.execute(
            select(ValkyrieCard).where(
                ValkyrieCard.id == card_id, ValkyrieCard.user_id == uid,
            )
        )
        row = rs.scalar_one_or_none()
        if not row:
            return {"ok": False, "error": "Carte introuvable."}
        lbl = str(label).strip()[:200]
        if not lbl:
            return {"ok": False, "error": "Label vide."}
        new_st = {"id": f"s_{_uuid.uuid4().hex[:8]}", "label": lbl, "done": bool(done)}
        if list == 2:
            row.subtasks2_json = [*(row.subtasks2_json or []), new_st]
            flag_modified(row, "subtasks2_json")
        else:
            row.subtasks_json = [*(row.subtasks_json or []), new_st]
            flag_modified(row, "subtasks_json")
        await session.commit()
        return {"ok": True, "subtask": new_st, "list": list}


async def _valkyrie_toggle_subtask(
    card_id: int, label: str, done: Optional[bool] = None,
) -> dict:
    uid = get_user_context()
    if not uid:
        return {"ok": False, "error": "Utilisateur non authentifié."}
    from backend.core.db.engine import async_session
    from backend.plugins.valkyrie.models import ValkyrieCard
    from sqlalchemy import select
    from sqlalchemy.orm.attributes import flag_modified
    async with async_session() as session:
        rs = await session.execute(
            select(ValkyrieCard).where(
                ValkyrieCard.id == card_id, ValkyrieCard.user_id == uid,
            )
        )
        row = rs.scalar_one_or_none()
        if not row:
            return {"ok": False, "error": "Carte introuvable."}
        target_lower = (label or "").strip().lower()
        matched = None
        which = 0
        for i, lst in enumerate(((row.subtasks_json or []), (row.subtasks2_json or []))):
            for st in lst:
                if isinstance(st, dict) and str(st.get("label", "")).lower() == target_lower:
                    matched = st
                    which = i + 1
                    break
            if matched:
                break
        if not matched:
            return {"ok": False, "error": f"Sous-tâche introuvable : {label!r}"}
        matched["done"] = bool(done) if done is not None else not bool(matched.get("done"))
        if which == 1:
            flag_modified(row, "subtasks_json")
        else:
            flag_modified(row, "subtasks2_json")
        await session.commit()
        return {"ok": True, "label": matched["label"], "done": matched["done"]}


async def _valkyrie_archive_card(card_id: int) -> dict:
    uid = get_user_context()
    if not uid:
        return {"ok": False, "error": "Utilisateur non authentifié."}
    from backend.core.db.engine import async_session
    from backend.plugins.valkyrie.models import ValkyrieCard
    from sqlalchemy import select
    async with async_session() as session:
        rs = await session.execute(
            select(ValkyrieCard).where(
                ValkyrieCard.id == card_id, ValkyrieCard.user_id == uid,
            )
        )
        row = rs.scalar_one_or_none()
        if not row:
            return {"ok": False, "error": "Carte introuvable."}
        if row.archived_at is None:
            row.archived_at = datetime.utcnow()
        await session.commit()
        return {"ok": True, "card_id": card_id, "archived_at": row.archived_at.isoformat()}


async def _valkyrie_get_stats(project_id: int) -> dict:
    uid = get_user_context()
    if not uid:
        return {"ok": False, "error": "Utilisateur non authentifié."}
    from backend.core.db.engine import async_session
    from backend.plugins.valkyrie.models import ValkyrieCard, ValkyrieProject
    from sqlalchemy import select
    async with async_session() as session:
        proj = await session.execute(
            select(ValkyrieProject).where(
                ValkyrieProject.id == project_id, ValkyrieProject.user_id == uid,
            )
        )
        if not proj.scalar_one_or_none():
            return {"ok": False, "error": "Projet introuvable."}
        rs = await session.execute(
            select(ValkyrieCard).where(
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
        done_this_week = 0
        due_this_week = 0
        for c in rows:
            by_status[c.status_key] = by_status.get(c.status_key, 0) + 1
            if c.due_date:
                d = c.due_date.date() if isinstance(c.due_date, datetime) else c.due_date
                if c.status_key != "done" and d < today:
                    overdue += 1
                if today <= d <= today + timedelta(days=7):
                    due_this_week += 1
            if c.status_key == "done" and c.updated_at and c.updated_at >= week_ago:
                done_this_week += 1
        return {
            "ok": True,
            "project_id": project_id,
            "total": len(rows),
            "by_status": by_status,
            "overdue": overdue,
            "due_this_week": due_this_week,
            "done_this_week": done_this_week,
        }


async def _valkyrie_get_reminders() -> dict:
    uid = get_user_context()
    if not uid:
        return {"ok": False, "error": "Utilisateur non authentifié."}
    from backend.core.db.engine import async_session
    from backend.plugins.valkyrie.models import ValkyrieCard, ValkyrieProject
    from sqlalchemy import select
    async with async_session() as session:
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
        today = datetime.utcnow().date()
        week_ahead = today + timedelta(days=7)
        overdue = []
        today_list = []
        soon = []
        for card, proj_title in rs.all():
            d = card.due_date.date() if isinstance(card.due_date, datetime) else card.due_date
            item = {
                "id": card.id,
                "project_id": card.project_id,
                "project_title": proj_title,
                "title": card.title,
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
            "ok": True,
            "overdue": overdue,
            "today": today_list,
            "soon": soon,
            "total": len(overdue) + len(today_list) + len(soon),
        }


# ── Projets ─────────────────────────────────────────────────────────

async def _valkyrie_create_project(
    title: str, description: Optional[str] = None, template: Optional[str] = None,
) -> dict:
    uid = get_user_context()
    if not uid:
        return {"ok": False, "error": "Utilisateur non authentifié."}
    from backend.core.db.engine import async_session
    from backend.plugins.valkyrie.models import ValkyrieProject, ValkyrieCard
    from backend.plugins.valkyrie.routes import PROJECT_TEMPLATES, _sanitize_subtasks, _sanitize_tags
    tmpl = PROJECT_TEMPLATES.get((template or "").strip()) if template else None
    async with async_session() as session:
        row = ValkyrieProject(
            user_id=uid,
            title=(title or (tmpl["title"] if tmpl else "Nouveau projet")).strip()[:200],
            description=(description or (tmpl["description"] if tmpl else "")).strip(),
            position=0,
        )
        session.add(row)
        await session.commit()
        await session.refresh(row)
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
                    origin=f"template:{template}",
                ))
            await session.commit()
        return {
            "ok": True,
            "project": {"id": row.id, "title": row.title, "description": row.description or ""},
        }


async def _valkyrie_update_project(
    project_id: int,
    title: Optional[str] = None,
    description: Optional[str] = None,
    archived: Optional[bool] = None,
) -> dict:
    uid = get_user_context()
    if not uid:
        return {"ok": False, "error": "Utilisateur non authentifié."}
    from backend.core.db.engine import async_session
    from backend.plugins.valkyrie.models import ValkyrieProject
    from sqlalchemy import select
    async with async_session() as session:
        rs = await session.execute(
            select(ValkyrieProject).where(
                ValkyrieProject.id == project_id, ValkyrieProject.user_id == uid,
            )
        )
        row = rs.scalar_one_or_none()
        if not row:
            return {"ok": False, "error": "Projet introuvable."}
        if title is not None:
            row.title = str(title).strip()[:200] or "Projet sans nom"
        if description is not None:
            row.description = str(description).strip()
        if archived is not None:
            row.archived = bool(archived)
        await session.commit()
        return {"ok": True, "project": {
            "id": row.id, "title": row.title, "archived": bool(row.archived),
        }}


async def _valkyrie_list_templates() -> dict:
    from backend.plugins.valkyrie.routes import PROJECT_TEMPLATES
    return {
        "ok": True,
        "templates": [
            {
                "key": t["key"], "title": t["title"], "description": t["description"],
                "card_count": len(t.get("cards", [])),
            }
            for t in PROJECT_TEMPLATES.values()
        ],
    }


# ── Statuts ─────────────────────────────────────────────────────────

async def _valkyrie_list_statuses() -> dict:
    uid = get_user_context()
    if not uid:
        return {"ok": False, "error": "Utilisateur non authentifié."}
    from backend.core.db.engine import async_session
    from backend.plugins.valkyrie.models import ValkyrieStatus, BUILTIN_STATUSES
    from sqlalchemy import select
    async with async_session() as session:
        rs = await session.execute(
            select(ValkyrieStatus).where(ValkyrieStatus.user_id == uid)
            .order_by(ValkyrieStatus.position, ValkyrieStatus.id)
        )
        rows = rs.scalars().all()
        custom = [{
            "id": s.id, "key": s.key, "label": s.label, "color": s.color,
            "position": s.position or 0, "builtin": False,
        } for s in rows]
        return {"ok": True, "statuses": [*BUILTIN_STATUSES, *custom]}


async def _valkyrie_create_status(label: str, color: str) -> dict:
    uid = get_user_context()
    if not uid:
        return {"ok": False, "error": "Utilisateur non authentifié."}
    from backend.core.db.engine import async_session
    from backend.plugins.valkyrie.models import ValkyrieStatus
    from backend.plugins.valkyrie.routes import _slugify_status_key
    async with async_session() as session:
        row = ValkyrieStatus(
            user_id=uid,
            key=_slugify_status_key(label),
            label=str(label).strip()[:60] or "Custom",
            color=str(color).strip()[:20] or "#7a8a9b",
            position=99,
        )
        session.add(row)
        await session.commit()
        await session.refresh(row)
        return {"ok": True, "status": {
            "id": row.id, "key": row.key, "label": row.label, "color": row.color,
        }}


async def _valkyrie_delete_status(status_id: int) -> dict:
    uid = get_user_context()
    if not uid:
        return {"ok": False, "error": "Utilisateur non authentifié."}
    from backend.core.db.engine import async_session
    from backend.plugins.valkyrie.models import ValkyrieStatus, ValkyrieCard
    from sqlalchemy import select, update as _upd
    async with async_session() as session:
        rs = await session.execute(
            select(ValkyrieStatus).where(
                ValkyrieStatus.id == status_id, ValkyrieStatus.user_id == uid,
            )
        )
        row = rs.scalar_one_or_none()
        if not row:
            return {"ok": False, "error": "Statut introuvable."}
        deleted_key = row.key
        # Réassigne les cartes qui utilisaient ce statut → todo
        await session.execute(
            _upd(ValkyrieCard)
            .where(ValkyrieCard.user_id == uid, ValkyrieCard.status_key == deleted_key)
            .values(status_key="todo")
        )
        await session.delete(row)
        await session.commit()
        return {"ok": True, "reassigned_to": "todo"}


# ── Cartes : duplicate / restore / delete / remove_subtask ───────────

async def _valkyrie_duplicate_card(card_id: int) -> dict:
    uid = get_user_context()
    if not uid:
        return {"ok": False, "error": "Utilisateur non authentifié."}
    from backend.core.db.engine import async_session
    from backend.plugins.valkyrie.models import ValkyrieCard
    from sqlalchemy import select, update as _upd
    async with async_session() as session:
        rs = await session.execute(
            select(ValkyrieCard).where(
                ValkyrieCard.id == card_id, ValkyrieCard.user_id == uid,
            )
        )
        src = rs.scalar_one_or_none()
        if not src:
            return {"ok": False, "error": "Carte introuvable."}
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
        await session.execute(
            _upd(ValkyrieCard)
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
        return {"ok": True, "card": {"id": clone.id, "title": clone.title}}


async def _valkyrie_restore_card(card_id: int) -> dict:
    uid = get_user_context()
    if not uid:
        return {"ok": False, "error": "Utilisateur non authentifié."}
    from backend.core.db.engine import async_session
    from backend.plugins.valkyrie.models import ValkyrieCard
    from sqlalchemy import select
    async with async_session() as session:
        rs = await session.execute(
            select(ValkyrieCard).where(
                ValkyrieCard.id == card_id, ValkyrieCard.user_id == uid,
            )
        )
        row = rs.scalar_one_or_none()
        if not row:
            return {"ok": False, "error": "Carte introuvable."}
        row.archived_at = None
        await session.commit()
        return {"ok": True, "card_id": card_id}


async def _valkyrie_delete_card(card_id: int) -> dict:
    uid = get_user_context()
    if not uid:
        return {"ok": False, "error": "Utilisateur non authentifié."}
    from backend.core.db.engine import async_session
    from backend.plugins.valkyrie.models import ValkyrieCard
    from sqlalchemy import select
    async with async_session() as session:
        rs = await session.execute(
            select(ValkyrieCard).where(
                ValkyrieCard.id == card_id, ValkyrieCard.user_id == uid,
            )
        )
        row = rs.scalar_one_or_none()
        if not row:
            return {"ok": False, "error": "Carte introuvable."}
        await session.delete(row)
        await session.commit()
        return {"ok": True, "deleted": card_id}


async def _valkyrie_remove_subtask(card_id: int, label: str) -> dict:
    uid = get_user_context()
    if not uid:
        return {"ok": False, "error": "Utilisateur non authentifié."}
    from backend.core.db.engine import async_session
    from backend.plugins.valkyrie.models import ValkyrieCard
    from sqlalchemy import select
    from sqlalchemy.orm.attributes import flag_modified
    async with async_session() as session:
        rs = await session.execute(
            select(ValkyrieCard).where(
                ValkyrieCard.id == card_id, ValkyrieCard.user_id == uid,
            )
        )
        row = rs.scalar_one_or_none()
        if not row:
            return {"ok": False, "error": "Carte introuvable."}
        target = (label or "").strip().lower()
        removed = 0
        for attr in ("subtasks_json", "subtasks2_json"):
            current = list(getattr(row, attr) or [])
            filtered = [s for s in current
                        if not (isinstance(s, dict) and str(s.get("label", "")).lower() == target)]
            if len(filtered) != len(current):
                setattr(row, attr, filtered)
                flag_modified(row, attr)
                removed += len(current) - len(filtered)
        if removed == 0:
            return {"ok": False, "error": f"Sous-tâche introuvable : {label!r}"}
        await session.commit()
        return {"ok": True, "removed": removed}


# ── Bulk / Import / Tags ──────────────────────────────────────────────

async def _valkyrie_bulk_cards(
    card_ids: list, action: str,
    status_key: Optional[str] = None, tag: Optional[str] = None,
) -> dict:
    uid = get_user_context()
    if not uid:
        return {"ok": False, "error": "Utilisateur non authentifié."}
    from backend.core.db.engine import async_session
    from backend.plugins.valkyrie.models import ValkyrieCard
    from backend.plugins.valkyrie.routes import _sanitize_tags
    from sqlalchemy import select
    from sqlalchemy.orm.attributes import flag_modified
    ids = [int(x) for x in (card_ids or []) if isinstance(x, (int, str)) and str(x).lstrip("-").isdigit()]
    if not ids:
        return {"ok": True, "affected": 0}
    async with async_session() as session:
        rs = await session.execute(
            select(ValkyrieCard).where(
                ValkyrieCard.id.in_(ids), ValkyrieCard.user_id == uid,
            )
        )
        rows = rs.scalars().all()
        now = datetime.utcnow()
        act = (action or "").strip()
        if act == "archive":
            for r in rows:
                if r.archived_at is None:
                    r.archived_at = now
        elif act == "restore":
            for r in rows:
                r.archived_at = None
        elif act == "delete":
            for r in rows:
                await session.delete(r)
        elif act == "set_status":
            target = (status_key or "todo").strip()[:60] or "todo"
            for r in rows:
                r.status_key = target
        elif act == "add_tag":
            t = (tag or "").strip()[:40]
            if t:
                for r in rows:
                    existing = list(r.tags_json or [])
                    if t.lower() not in [x.lower() for x in existing if isinstance(x, str)]:
                        existing.append(t)
                        r.tags_json = _sanitize_tags(existing)
                        flag_modified(r, "tags_json")
        elif act == "remove_tag":
            t = (tag or "").strip()[:40]
            if t:
                for r in rows:
                    r.tags_json = [x for x in (r.tags_json or [])
                                   if isinstance(x, str) and x.lower() != t.lower()]
                    flag_modified(r, "tags_json")
        else:
            return {"ok": False, "error": f"Action inconnue : {act}"}
        await session.commit()
        return {"ok": True, "affected": len(rows), "action": act}


async def _valkyrie_import_cards(
    project_id: int, format: str, data: str,
    default_status: Optional[str] = "todo",
) -> dict:
    uid = get_user_context()
    if not uid:
        return {"ok": False, "error": "Utilisateur non authentifié."}
    # Réutilise la route HTTP pour ne pas dupliquer la logique de parsing.
    # On fabrique un payload direct et on appelle le parseur via l'endpoint
    # interne (plus propre que de dupliquer le code de parsing).
    from backend.core.db.engine import async_session
    from backend.plugins.valkyrie.models import ValkyrieProject
    from backend.plugins.valkyrie.routes import import_cards, ImportIn, _get_project_owned
    from fastapi import Request
    # On court-circuite FastAPI en appelant directement la fonction : elle
    # attend un Request pour son helper `_uid`. On simule un Request minimaliste.
    class _FakeRequest:
        def __init__(self, uid: int):
            class _State: ...
            self.state = _State()
            self.state.user_id = uid
    async with async_session() as session:
        payload = ImportIn(format=format, data=data, default_status=default_status or "todo")
        try:
            result = await import_cards(
                project_id, payload, _FakeRequest(uid), session=session,
            )
        except Exception as e:
            return {"ok": False, "error": str(e)[:300]}
        return result


async def _valkyrie_list_tags() -> dict:
    uid = get_user_context()
    if not uid:
        return {"ok": False, "error": "Utilisateur non authentifié."}
    from backend.core.db.engine import async_session
    from backend.plugins.valkyrie.models import ValkyrieCard
    from sqlalchemy import select
    async with async_session() as session:
        rs = await session.execute(
            select(ValkyrieCard.tags_json).where(ValkyrieCard.user_id == uid)
        )
        seen: dict[str, int] = {}
        for (tags,) in rs.all():
            if not tags:
                continue
            for t in tags:
                if isinstance(t, str) and t.strip():
                    seen[t.strip()] = seen.get(t.strip(), 0) + 1
        ranked = sorted(seen.items(), key=lambda x: (-x[1], x[0].lower()))
        return {"ok": True, "tags": [{"label": k, "count": v} for k, v in ranked]}


VALKYRIE_EXECUTORS: dict[str, Any] = {
    "valkyrie_list_projects":   _valkyrie_list_projects,
    "valkyrie_list_cards":      _valkyrie_list_cards,
    "valkyrie_create_card":     _valkyrie_create_card,
    "valkyrie_update_card":     _valkyrie_update_card,
    "valkyrie_add_subtask":     _valkyrie_add_subtask,
    "valkyrie_toggle_subtask":  _valkyrie_toggle_subtask,
    "valkyrie_archive_card":    _valkyrie_archive_card,
    "valkyrie_get_stats":       _valkyrie_get_stats,
    "valkyrie_get_reminders":   _valkyrie_get_reminders,
    # Projets
    "valkyrie_create_project":  _valkyrie_create_project,
    "valkyrie_update_project":  _valkyrie_update_project,
    "valkyrie_list_templates":  _valkyrie_list_templates,
    # Statuts
    "valkyrie_list_statuses":   _valkyrie_list_statuses,
    "valkyrie_create_status":   _valkyrie_create_status,
    "valkyrie_delete_status":   _valkyrie_delete_status,
    # Cartes avancées
    "valkyrie_duplicate_card":  _valkyrie_duplicate_card,
    "valkyrie_restore_card":    _valkyrie_restore_card,
    "valkyrie_delete_card":     _valkyrie_delete_card,
    "valkyrie_remove_subtask":  _valkyrie_remove_subtask,
    # Bulk / Import / Tags
    "valkyrie_bulk_cards":      _valkyrie_bulk_cards,
    "valkyrie_import_cards":    _valkyrie_import_cards,
    "valkyrie_list_tags":       _valkyrie_list_tags,
}
