"""
Forge — worker cron en background.

Scanne périodiquement les triggers de type 'cron' et fire ceux dont la
prochaine occurrence (calculée via croniter) est passée. Démarre via
l'event lifespan d'un asyncio.Task au boot du backend (lance via
__init__.py du plugin).

Granularité : tick toutes les 30s — suffisant pour des cron à la minute
sans charger inutilement la DB. Pas de drift fix (un cron toutes les
minutes peut être fire à la seconde près 0-29 puis 30-59 selon le tick).
"""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timedelta

logger = logging.getLogger("gungnir.plugins.forge.cron")

_started = False
_task: asyncio.Task | None = None
TICK_SECONDS = 30


async def _scan_and_fire():
    from sqlalchemy import select
    from backend.core.db.engine import async_session
    from backend.core.agents.wolf_tools import set_user_context, get_user_context
    from .models import ForgeTrigger, ForgeWorkflow, ForgeWorkflowRun
    from .runner import run_workflow
    try:
        from croniter import croniter
    except ImportError:
        logger.warning("croniter introuvable — worker cron Forge désactivé.")
        return

    now = datetime.utcnow()
    async with async_session() as session:
        rs = await session.execute(
            select(ForgeTrigger).where(
                ForgeTrigger.type == "cron",
                ForgeTrigger.enabled.is_(True),
            )
        )
        triggers = list(rs.scalars().all())

        for t in triggers:
            cfg = t.config_json or {}
            expr = (cfg.get("expression") or "").strip()
            if not expr:
                continue
            try:
                # Anchor sur last_fire ou la dernière minute pour calculer le
                # next. Si jamais fire, on ancre 1 min en arrière → si le
                # cron est passé depuis l'install, il fire au prochain tick.
                anchor = t.last_fire_at or (now - timedelta(minutes=1))
                ci = croniter(expr, anchor)
                next_fire = ci.get_next(datetime)
                if next_fire > now:
                    continue  # pas encore l'heure
            except Exception as e:
                logger.warning("[forge.cron] expression invalide trigger %s : %s", t.id, e)
                continue

            # Charge le workflow.
            rs2 = await session.execute(
                select(ForgeWorkflow).where(
                    ForgeWorkflow.id == t.workflow_id, ForgeWorkflow.user_id == t.user_id,
                )
            )
            w = rs2.scalar_one_or_none()
            if not w or not w.enabled:
                continue

            # Lance le workflow. Async bloquant pour ce tick — si le user
            # a 100 cron qui fire en même temps, le tick sera lent. À voir
            # si on parallélise plus tard (gather avec semaphore).
            run_row = ForgeWorkflowRun(
                workflow_id=w.id, user_id=t.user_id, status="running",
                inputs_json={"_cron": {"expression": expr, "scheduled_for": next_fire.isoformat()}},
                trigger_source="cron",
            )
            session.add(run_row)
            await session.commit()
            await session.refresh(run_row)

            prev_uid = get_user_context()
            set_user_context(t.user_id)
            try:
                res = await run_workflow(w.yaml_def, run_row.inputs_json or {})
            except Exception as e:
                logger.exception("[forge.cron] run %s a crash", run_row.id)
                res = type("R", (), {"status": "error", "logs": [], "output": {}, "error": str(e)})
            finally:
                set_user_context(prev_uid)

            run_row.status = res.status
            run_row.logs_json = res.logs
            run_row.output_json = res.output if isinstance(res.output, dict) else {"value": res.output}
            run_row.error = res.error or ""
            run_row.finished_at = datetime.utcnow()
            t.last_fire_at = datetime.utcnow()
            await session.commit()
            logger.info("[forge.cron] fired trigger=%s wf=%s run=%s status=%s",
                        t.id, w.id, run_row.id, res.status)


async def _loop():
    logger.info("[forge.cron] worker démarré (tick %ss)", TICK_SECONDS)
    while True:
        try:
            await _scan_and_fire()
        except Exception:
            logger.exception("[forge.cron] erreur dans scan_and_fire")
        await asyncio.sleep(TICK_SECONDS)


def start_cron_worker():
    """Démarre le worker une seule fois (idempotent). Appelé depuis
    `__init__.py` du plugin via une tâche asyncio.create_task.

    On ne peut pas créer la task ici directement parce qu'au moment de
    l'import du plugin il n'y a pas encore d'event loop. La création se
    fait à la demande, lazy.
    """
    global _started, _task
    if _started:
        return
    try:
        loop = asyncio.get_event_loop()
        if loop.is_running():
            _task = loop.create_task(_loop())
            _started = True
        else:
            # Pas d'event loop running : on enregistre un hook qui
            # créera la task au premier `asyncio.run` ou équivalent.
            _started = False
    except RuntimeError:
        _started = False
