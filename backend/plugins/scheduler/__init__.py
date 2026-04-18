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


def _is_task_due(task: dict, now: datetime) -> tuple[bool, bool]:
    """Decide if a task should run now.

    Returns (due, mutated) where ``mutated`` is True when the task dict was
    edited (e.g. auto-disabled because its cron expression no longer parses)
    so the caller can persist the change.
    """
    if not task.get("enabled"):
        return False, False

    task_type = task.get("task_type")
    last_run = _parse_iso(task.get("last_run"))
    created_at = _parse_iso(task.get("created_at")) or now

    if task_type == "interval":
        interval = task.get("interval_seconds")
        if not isinstance(interval, int) or interval <= 0:
            return False, False
        if last_run is None:
            return True, False
        return (now - last_run).total_seconds() >= interval, False

    if task_type == "cron":
        if not _croniter_available:
            return False, False
        expr = task.get("cron_expression") or ""
        parts = expr.split()
        if not expr or len(parts) != 5:
            # Auto-disable tasks that would otherwise spam warnings forever.
            logger.warning(
                f"Auto-disabling task '{task.get('name')}' ({task.get('id')}): "
                f"cron expression '{expr}' has {len(parts)} fields, expected 5"
            )
            task["enabled"] = False
            task["last_status"] = "cron_invalid"
            task["last_error"] = f"cron expression invalide ({len(parts)} champs, 5 attendus)"
            task["updated_at"] = now.isoformat()
            return False, True
        try:
            anchor = last_run or created_at
            itr = croniter(expr, anchor)
            next_fire = itr.get_next(datetime)
            if next_fire.tzinfo is None:
                next_fire = next_fire.replace(tzinfo=timezone.utc)
            return next_fire <= now, False
        except Exception as e:
            logger.warning(
                f"Auto-disabling task '{task.get('name')}' ({task.get('id')}): "
                f"invalid cron expression '{expr}': {e}"
            )
            task["enabled"] = False
            task["last_status"] = "cron_invalid"
            task["last_error"] = f"cron expression invalide: {str(e)[:200]}"
            task["updated_at"] = now.isoformat()
            return False, True

    if task_type == "run_at":
        if last_run is not None:
            return False, False  # run_at is one-shot
        target = _parse_iso(task.get("run_at"))
        if not target:
            return False, False
        return now >= target, False

    return False, False


async def _execute_task(user_id: int, task: dict) -> dict:
    """Invoke the user's LLM with the task prompt + user tools + skill context.
    Builds a system prompt from the user's soul + optional skill, similar to chat.py."""
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

    # Build per-user tool set: WOLF core tools + user's MCP tools.
    tools: list[dict] | None = None
    executors: dict | None = None
    try:
        from backend.core.agents.wolf_tools import (
            WOLF_TOOL_SCHEMAS,
            WOLF_EXECUTORS,
            set_user_context,
        )
        from backend.core.agents.mcp_client import mcp_manager

        await mcp_manager.ensure_user_started(user_id)
        mcp_schemas = mcp_manager.get_user_schemas(user_id)
        mcp_executors = mcp_manager.get_user_executors(user_id)

        tools = list(WOLF_TOOL_SCHEMAS) + list(mcp_schemas)
        executors = {**WOLF_EXECUTORS, **mcp_executors}
        set_user_context(user_id)
    except Exception as e:
        logger.warning(f"Tool wiring failed for user={user_id} task={task.get('id')}: {e}")
        tools = None
        executors = None

    # Build system prompt: soul + skill (like chat.py does)
    system_prompt = None
    try:
        from backend.core.db.engine import get_session
        from backend.core.api.auth_helpers import get_user_settings
        from backend.core.agents.wolf_tools import _soul_path
        from backend.core.agents import user_data as _ud
        from backend.core.api.chat import _get_default_soul

        async for session in get_session():
            us = await get_user_settings(user_id, session)
            agent_name = us.agent_name or "Gungnir"

            # Load soul
            soul_file = _soul_path(user_id)
            if soul_file.exists():
                soul_content = soul_file.read_text(encoding="utf-8")
            else:
                soul_content = _get_default_soul(agent_name)

            # Resolve skill: task-specific skill_name > user's active skill
            skill_block = ""
            task_skill = task.get("skill_name", "")
            if task_skill:
                skill_data = await _ud.get_skill(session, user_id, task_skill)
                if skill_data and skill_data.get("prompt"):
                    skill_block = f"\n\n## Skill actif : {skill_data['name']}\n{skill_data['prompt']}"
            else:
                active_skill = await _ud.get_active_skill(session, user_id)
                if active_skill and active_skill.get("prompt"):
                    skill_block = f"\n\n## Skill actif : {active_skill['name']}\n{active_skill['prompt']}"

            system_prompt = soul_content + skill_block
            system_prompt += f"\n\n**Ton nom :** Tu t'appelles **{agent_name}**."
            system_prompt += "\n**Contexte :** Tu exécutes une tâche planifiée automatiquement (cron/scheduler)."
            break
    except Exception as e:
        logger.warning(f"System prompt build failed for user={user_id}: {e}")

    try:
        result = await invoke_llm_for_user(
            user_id,
            prompt,
            system_prompt=system_prompt,
            tools=tools,
            executors=executors,
        )
    finally:
        # Reset the wolf user context so subsequent ticks don't leak it
        try:
            from backend.core.agents.wolf_tools import set_user_context as _reset_uid
            _reset_uid(0)
        except Exception:
            pass

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
            "tool_events": result.get("tool_events", []),
        })
    else:
        entry.update({
            "status": "error",
            "error": result.get("error", "unknown"),
            "tool_events": result.get("tool_events", []),
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
            due, mutated = _is_task_due(task, now)
            if mutated:
                dirty = True
            if not due:
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
