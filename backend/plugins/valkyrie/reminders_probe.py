"""
Valkyrie — probe synchrone des rappels pour la Conscience.

La méthode `get_consciousness_prompt_block()` de la conscience est synchrone
(elle est appelée dans le flux de génération du system prompt, hors event
loop). On expose ici un helper qui fait un appel async via `asyncio.run`
ou réutilise la boucle existante si dispo.

Le probe est best-effort : en cas d'erreur (table absente, DB indispo, etc.)
il retourne None et l'appelant n'affiche rien.
"""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timedelta
from typing import Optional

logger = logging.getLogger("gungnir.plugins.valkyrie.probe")


async def _probe_reminders_async(user_id: int) -> Optional[dict]:
    if not user_id:
        return None
    try:
        from backend.core.db.engine import async_session
        from backend.plugins.valkyrie.models import ValkyrieCard, ValkyrieProject
        from sqlalchemy import select
    except Exception as e:
        logger.debug("Valkyrie imports unavailable: %s", e)
        return None
    try:
        async with async_session() as session:
            rs = await session.execute(
                select(ValkyrieCard, ValkyrieProject.title)
                .join(ValkyrieProject, ValkyrieProject.id == ValkyrieCard.project_id)
                .where(
                    ValkyrieCard.user_id == user_id,
                    ValkyrieCard.archived_at.is_(None),
                    ValkyrieCard.status_key != "done",
                    ValkyrieCard.due_date.isnot(None),
                    ValkyrieProject.archived.is_(False),
                )
                .order_by(ValkyrieCard.due_date)
            )
            today = datetime.utcnow().date()
            week_ahead = today + timedelta(days=7)
            overdue: list[dict] = []
            today_list: list[dict] = []
            soon: list[dict] = []
            for card, proj_title in rs.all():
                d = card.due_date.date() if isinstance(card.due_date, datetime) else card.due_date
                item = {
                    "id": card.id,
                    "title": card.title,
                    "project_title": proj_title,
                    "due_date": d.isoformat(),
                    "days_diff": (d - today).days,
                }
                if d < today:
                    overdue.append(item)
                elif d == today:
                    today_list.append(item)
                elif d <= week_ahead:
                    soon.append(item)
            # Émet un trigger `promise_unkept` par carte overdue — pousse le
            # besoin `integrity` de la conscience. Cooldown 24h par carte
            # (idempotence via entity_id = card_id) pour éviter de saturer
            # l'urgence à chaque tick tant que la carte reste en retard.
            try:
                from backend.plugins.consciousness.triggers import emit_trigger
                for item in overdue:
                    cid = item.get("id")
                    if cid is None:
                        continue
                    await emit_trigger(
                        user_id, "promise_unkept",
                        entity_id=f"valkyrie_card:{cid}",
                        cooldown_seconds=24 * 3600,
                    )
            except Exception as _e:
                logger.debug("promise_unkept emit failed uid=%s: %s", user_id, _e)

            # Émet `project_stalled` → besoin `progression` pour chaque projet
            # non archivé avec AUCUNE activité depuis 14j ET au moins une carte
            # non-done. Pas une alerte de retard (ça c'est promise_unkept) —
            # ici c'est de l'inertie pure, des projets qui stagnent sans tirer
            # la sonnette d'alarme. Cooldown 48h par projet pour ne pas spam.
            try:
                from datetime import datetime as _dt
                from backend.plugins.consciousness.triggers import emit_trigger
                stall_cutoff = _dt.utcnow() - timedelta(days=14)
                proj_rs = await session.execute(
                    select(ValkyrieProject)
                    .where(
                        ValkyrieProject.user_id == user_id,
                        ValkyrieProject.archived.is_(False),
                        ValkyrieProject.updated_at < stall_cutoff,
                    )
                )
                stalled_projects = list(proj_rs.scalars().all())
                for proj in stalled_projects:
                    # Vérifie qu'il reste au moins une carte "à faire" (sinon
                    # projet stalled mais terminé = pas un problème).
                    open_rs = await session.execute(
                        select(ValkyrieCard)
                        .where(
                            ValkyrieCard.project_id == proj.id,
                            ValkyrieCard.user_id == user_id,
                            ValkyrieCard.archived_at.is_(None),
                            ValkyrieCard.status_key != "done",
                        )
                        .limit(1)
                    )
                    if open_rs.scalar_one_or_none() is None:
                        continue
                    await emit_trigger(
                        user_id, "project_stalled",
                        entity_id=f"valkyrie_project:{proj.id}",
                        cooldown_seconds=48 * 3600,
                    )
            except Exception as _ps_err:
                logger.debug("project_stalled emit failed uid=%s: %s", user_id, _ps_err)

            return {
                "overdue": overdue,
                "today": today_list,
                "soon": soon,
                "total": len(overdue) + len(today_list) + len(soon),
            }
    except Exception as e:
        logger.debug("probe_reminders failed: %s", e)
        return None


def probe_reminders_sync(user_id: int) -> Optional[dict]:
    """Wrapper sync. Si une boucle asyncio tourne déjà (cas courant dans
    FastAPI), on crée une tâche dans cette boucle via `run_coroutine_threadsafe`
    n'a pas de sens ici — on tombe plutôt en fallback vide pour éviter de
    bloquer. La Conscience tolère `None`."""
    try:
        loop = asyncio.get_event_loop()
        if loop.is_running():
            # Impossible d'appeler run() dans une loop déjà active ; on
            # n'essaie pas de bricoler un thread ici pour éviter les deadlocks.
            # Le nudge apparaîtra lors du prochain rebuild du prompt où
            # la loop n'est pas en cours (rare dans FastAPI). Retourne None.
            return None
    except RuntimeError:
        pass
    try:
        return asyncio.run(_probe_reminders_async(user_id))
    except Exception as e:
        logger.debug("probe_reminders_sync run failed: %s", e)
        return None
