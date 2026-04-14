"""
Gungnir Automata — background tick daemon.

Scans every user's data/automata/{uid}/tasks.json every TICK_INTERVAL seconds.
For each enabled task that is due (cron / interval / run_at), invokes the
user's configured LLM with the task prompt and writes the result to history.

Task types:
  • interval  — fires every N seconds; runs immediately on first tick
  • cron      — fires at cron schedule (uses croniter)
  • run_at    — fires once at a specific ISO8601 datetime, then disables itself
"""
from __future__ import annotations

import asyncio
import json
import logging
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

logger = logging.getLogger("gungnir.automata.daemon")

DATA_DIR = Path(__file__).parent.parent.parent.parent / "data"
AUTOMATA_DIR = DATA_DIR / "automata"
TICK_INTERVAL_SECONDS = 30
MAX_HISTORY_ENTRIES = 200

_daemon_task: asyncio.Task | None = None
_croniter_available = False

try:
    from croniter import croniter  # type: ignore
    _croniter_available = True
except ImportError:
    logger.warning("croniter not installed — cron-based automata tasks will be skipped")


def _parse_iso(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        if value.endswith("Z"):
            value = value[:-1] + "+00:00"
        dt = datetime.fromisoformat(value)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
    except Exception:
        return None


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _load_user_tasks(user_id: str) -> tuple[dict, Path]:
    tasks_file = AUTOMATA_DIR / user_id / "tasks.json"
    if tasks_file.exists():
        try:
            return json.loads(tasks_file.read_text(encoding="utf-8")), tasks_file
        except Exception as e:
            logger.warning(f"Failed to read {tasks_file}: {e}")
    return {"tasks": [], "history": []}, tasks_file


def _save_user_tasks(data: dict, tasks_file: Path):
    tasks_file.parent.mkdir(parents=True, exist_ok=True)
    tasks_file.write_text(
        json.dumps(data, indent=2, ensure_ascii=False, default=str),
        encoding="utf-8",
    )


def _is_task_due(task: dict, now: datetime) -> bool:
    """Decide if a task should run now, given its type and last_run."""
    if not task.get("enabled"):
        return False

    task_type = task.get("task_type")
    last_run = _parse_iso(task.get("last_run"))
    created_at = _parse_iso(task.get("created_at")) or now

    if task_type == "interval":
        interval = task.get("interval_seconds")
        if not isinstance(interval, int) or interval <= 0:
            return False
        if last_run is None:
            return True
        return (now - last_run).total_seconds() >= interval

    if task_type == "cron":
        if not _croniter_available:
            return False
        expr = task.get("cron_expression")
        if not expr:
            return False
        try:
            anchor = last_run or created_at
            itr = croniter(expr, anchor)
            next_fire = itr.get_next(datetime)
            if next_fire.tzinfo is None:
                next_fire = next_fire.replace(tzinfo=timezone.utc)
            return next_fire <= now
        except Exception as e:
            logger.warning(f"Invalid cron expression '{expr}': {e}")
            return False

    if task_type == "run_at":
        if last_run is not None:
            return False  # run_at is one-shot
        target = _parse_iso(task.get("run_at"))
        if not target:
            return False
        return now >= target

    return False


async def _execute_task(user_id: int, task: dict) -> dict:
    """Invoke the user's LLM with the task prompt. Returns history entry."""
    from backend.core.services.llm_invoker import invoke_llm_for_user

    prompt = task.get("prompt", "")
    if not prompt.strip():
        return {
            "id": str(uuid.uuid4()),
            "task_id": task.get("id"),
            "task_name": task.get("name"),
            "timestamp": _now().isoformat(),
            "status": "error",
            "error": "prompt vide",
        }

    result = await invoke_llm_for_user(user_id, prompt)
    entry = {
        "id": str(uuid.uuid4()),
        "task_id": task.get("id"),
        "task_name": task.get("name"),
        "timestamp": _now().isoformat(),
    }
    if result.get("ok"):
        entry.update({
            "status": "success",
            "response": result.get("content", ""),
            "model": result.get("model"),
            "provider": result.get("provider"),
            "tokens_input": result.get("tokens_input", 0),
            "tokens_output": result.get("tokens_output", 0),
        })
    else:
        entry.update({
            "status": "error",
            "error": result.get("error", "unknown"),
        })
    return entry


async def _tick_once():
    """One pass: scan all users and run their due tasks."""
    if not AUTOMATA_DIR.exists():
        return

    now = _now()

    for user_dir in AUTOMATA_DIR.iterdir():
        if not user_dir.is_dir():
            continue
        user_id_str = user_dir.name
        try:
            user_id = int(user_id_str)
        except ValueError:
            continue

        data, tasks_file = _load_user_tasks(user_id_str)
        tasks = data.get("tasks", [])
        if not tasks:
            continue

        dirty = False
        for task in tasks:
            if not _is_task_due(task, now):
                continue

            logger.info(f"Running task '{task.get('name')}' for user {user_id}")
            try:
                entry = await _execute_task(user_id, task)
            except Exception as e:
                logger.exception(f"Task execution crashed: {e}")
                entry = {
                    "id": str(uuid.uuid4()),
                    "task_id": task.get("id"),
                    "task_name": task.get("name"),
                    "timestamp": now.isoformat(),
                    "status": "error",
                    "error": str(e),
                }

            task["last_run"] = now.isoformat()
            task["run_count"] = int(task.get("run_count") or 0) + 1
            task["last_status"] = entry.get("status", "unknown")
            task["updated_at"] = now.isoformat()

            # run_at tasks disable themselves after firing
            if task.get("task_type") == "run_at":
                task["enabled"] = False

            history = data.setdefault("history", [])
            history.append(entry)
            if len(history) > MAX_HISTORY_ENTRIES:
                data["history"] = history[-MAX_HISTORY_ENTRIES:]

            dirty = True

        if dirty:
            try:
                _save_user_tasks(data, tasks_file)
            except Exception as e:
                logger.error(f"Failed to persist tasks for user {user_id}: {e}")


async def _automata_loop():
    logger.info(f"Automata daemon started (tick every {TICK_INTERVAL_SECONDS}s)")
    while True:
        try:
            await asyncio.sleep(TICK_INTERVAL_SECONDS)
            await _tick_once()
        except asyncio.CancelledError:
            logger.info("Automata daemon cancelled")
            raise
        except Exception as e:
            logger.exception(f"Automata daemon tick failed: {e}")
            await asyncio.sleep(5)


async def on_startup(app: Any = None):
    global _daemon_task
    if _daemon_task and not _daemon_task.done():
        return
    _daemon_task = asyncio.create_task(_automata_loop())


async def on_shutdown(*args, **kwargs):
    global _daemon_task
    if _daemon_task:
        _daemon_task.cancel()
        try:
            await _daemon_task
        except (asyncio.CancelledError, Exception):
            pass
        _daemon_task = None
