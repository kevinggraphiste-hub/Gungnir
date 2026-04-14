"""
User bootstrap — seed per-user defaults on account creation.

Centralizes the "basics given to each user at signup" logic across features:
  • skills / personalities / sub-agents  (DB, via user_data)
  • consciousness                          (filesystem, per-user JSON files)
  • automata                               (filesystem, per-user tasks.json)

Each user keeps their own copy and can modify/delete freely afterwards.
"""
from __future__ import annotations

import json
import logging
import uuid
from datetime import datetime, timezone
from pathlib import Path

from sqlalchemy.ext.asyncio import AsyncSession

from backend.core.agents import user_data as ud

logger = logging.getLogger("gungnir.user_bootstrap")

DATA_DIR = Path(__file__).parent.parent.parent.parent / "data"
BUNDLED_DEFAULTS_DIR = Path(__file__).parent.parent.parent / "data"


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _load_automata_template() -> list[dict]:
    """Load bundled automata template tasks."""
    path = BUNDLED_DEFAULTS_DIR / "automata.json"
    if not path.exists():
        return []
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
        return raw.get("tasks", []) if isinstance(raw, dict) else []
    except Exception as e:
        logger.warning(f"Failed to load automata template: {e}")
        return []


def _seed_automata(user_id: int) -> int:
    """Seed default automata tasks for a user by writing their tasks.json.

    Backfills new template tasks by name — existing tasks are never overwritten.
    Returns number of tasks added.
    """
    tasks_file = DATA_DIR / "automata" / str(user_id) / "tasks.json"
    tasks_file.parent.mkdir(parents=True, exist_ok=True)

    if tasks_file.exists():
        try:
            data = json.loads(tasks_file.read_text(encoding="utf-8"))
        except Exception:
            data = {"tasks": [], "history": []}
    else:
        data = {"tasks": [], "history": []}

    existing_names = {t.get("name") for t in data.get("tasks", [])}
    template = _load_automata_template()
    now = _now_iso()
    added = 0

    for t in template:
        if t.get("name") in existing_names:
            continue
        task = {
            "id": str(uuid.uuid4()),
            "name": t.get("name", "Tâche sans nom"),
            "description": t.get("description", ""),
            "prompt": t.get("prompt", ""),
            "task_type": t.get("task_type", "interval"),
            "cron_expression": t.get("cron_expression"),
            "interval_seconds": t.get("interval_seconds"),
            "run_at": t.get("run_at"),
            "enabled": bool(t.get("enabled", False)),
            "created_at": now,
            "updated_at": now,
            "last_run": None,
            "run_count": 0,
            "last_status": None,
        }
        data.setdefault("tasks", []).append(task)
        added += 1

    if added:
        data.setdefault("history", [])
        tasks_file.write_text(
            json.dumps(data, indent=2, ensure_ascii=False, default=str),
            encoding="utf-8",
        )
    return added


def _seed_consciousness(user_id: int) -> bool:
    """Initialize per-user consciousness files with defaults.

    Creates data/consciousness/users/{uid}/ with default config+state files.
    Idempotent — existing files are preserved.
    """
    try:
        from backend.plugins.consciousness.engine import consciousness_manager
        engine = consciousness_manager.get(user_id)
        engine.save_all()
        return True
    except Exception as e:
        logger.warning(f"Consciousness seed failed for user {user_id}: {e}")
        return False


async def seed_user_defaults(session: AsyncSession, user_id: int) -> dict:
    """Seed all default content for a newly created user.

    Called from create_user() right after commit. Safe to call on existing
    users — backfills missing defaults without overwriting customizations.
    """
    result = {"user_id": user_id, "seeded": {}}

    try:
        await ud._seed_skills(session, user_id)
        result["seeded"]["skills"] = "ok"
    except Exception as e:
        logger.error(f"Skill seed failed for user {user_id}: {e}")
        result["seeded"]["skills"] = f"error: {e}"

    try:
        await ud._seed_personalities(session, user_id)
        result["seeded"]["personalities"] = "ok"
    except Exception as e:
        logger.error(f"Personality seed failed for user {user_id}: {e}")
        result["seeded"]["personalities"] = f"error: {e}"

    try:
        await ud._seed_sub_agents(session, user_id)
        result["seeded"]["sub_agents"] = "ok"
    except Exception as e:
        logger.error(f"Sub-agent seed failed for user {user_id}: {e}")
        result["seeded"]["sub_agents"] = f"error: {e}"

    try:
        added = _seed_automata(user_id)
        result["seeded"]["automata"] = f"ok ({added} tasks)"
    except Exception as e:
        logger.error(f"Automata seed failed for user {user_id}: {e}")
        result["seeded"]["automata"] = f"error: {e}"

    ok = _seed_consciousness(user_id)
    result["seeded"]["consciousness"] = "ok" if ok else "skipped"

    logger.info(f"User {user_id} defaults seeded: {result['seeded']}")
    return result
