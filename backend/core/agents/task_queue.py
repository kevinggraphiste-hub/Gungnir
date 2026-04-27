"""
task_queue.py — File de tâches background per-user.

Permet à l'agent d'empiler des sous-tâches que des sub-agents traitent en
parallèle pendant que la conversation principale continue. Inspiré du
worktree parallelism d'Hermes Agent.

Workflow :
- L'agent appelle `task_queue_enqueue(task, agent_name?)` pendant la conversation.
- Le sub-agent désigné (ou `agent_dev_senior` par défaut) traite en background.
- L'agent peut ensuite appeler `task_queue_results()` pour récupérer les
  résultats prêts (et les retirer de la queue).

Stockage : en mémoire process, per-user. Les tâches non récupérées avant un
restart sont perdues (acceptable pour une queue d'orchestration courte).
"""
from __future__ import annotations

import asyncio
import logging
import time
import uuid
from typing import Any

logger = logging.getLogger("gungnir.task_queue")


# Structure : {user_id: {task_id: {status, agent, task, result, started_at, finished_at}}}
_queues: dict[int, dict[str, dict]] = {}
_running_tasks: dict[str, asyncio.Task] = {}

# Max tâches simultanées par user pour ne pas saturer (modifiable)
_MAX_CONCURRENT_PER_USER = 8


def _user_q(user_id: int) -> dict[str, dict]:
    return _queues.setdefault(int(user_id), {})


def _running_count(user_id: int) -> int:
    q = _user_q(user_id)
    return sum(1 for v in q.values() if v.get("status") == "running")


async def _execute_task(task_id: str, user_id: int, agent_name: str, task_text: str) -> None:
    q = _user_q(user_id)
    entry = q.get(task_id)
    if not entry:
        return
    entry["status"] = "running"
    entry["started_at"] = time.time()
    try:
        from backend.core.agents.wolf_tools import _subagent_invoke
        result = await _subagent_invoke(agent_name, task_text)
        entry["result"] = result
        entry["status"] = "done"
    except asyncio.CancelledError:
        entry["status"] = "cancelled"
        raise
    except Exception as e:
        entry["status"] = "error"
        entry["result"] = {"ok": False, "error": str(e)[:300]}
    finally:
        entry["finished_at"] = time.time()
        _running_tasks.pop(task_id, None)


async def enqueue(user_id: int, task_text: str, agent_name: str = "agent_dev_senior") -> dict:
    """Empile une nouvelle tâche en background. Retourne le task_id."""
    if not task_text or not task_text.strip():
        return {"ok": False, "error": "task vide"}
    if _running_count(user_id) >= _MAX_CONCURRENT_PER_USER:
        return {
            "ok": False,
            "error": f"file pleine ({_MAX_CONCURRENT_PER_USER} tâches max simultanées). "
                     f"Appelle `task_queue_results` pour vider, ou attends."
        }
    task_id = uuid.uuid4().hex[:12]
    q = _user_q(user_id)
    q[task_id] = {
        "id": task_id, "agent": agent_name, "task": task_text[:500],
        "status": "pending", "result": None,
        "queued_at": time.time(),
    }
    try:
        t = asyncio.create_task(_execute_task(task_id, user_id, agent_name, task_text))
        _running_tasks[task_id] = t
    except RuntimeError:
        q[task_id]["status"] = "error"
        q[task_id]["result"] = {"ok": False, "error": "Pas d'event loop disponible"}
        return {"ok": False, "task_id": task_id, "error": "no event loop"}
    return {"ok": True, "task_id": task_id, "agent": agent_name, "status": "running"}


def list_tasks(user_id: int, only_done: bool = False) -> list[dict]:
    q = _user_q(user_id)
    out = []
    for entry in q.values():
        if only_done and entry.get("status") not in ("done", "error", "cancelled"):
            continue
        out.append({
            "id": entry["id"],
            "agent": entry["agent"],
            "task": entry["task"][:200],
            "status": entry["status"],
            "queued_at": entry.get("queued_at"),
            "started_at": entry.get("started_at"),
            "finished_at": entry.get("finished_at"),
        })
    return out


def collect_results(user_id: int, drain: bool = True) -> dict:
    """Récupère les résultats des tâches terminées. Si `drain`, les retire de la queue."""
    q = _user_q(user_id)
    done_ids = [tid for tid, e in q.items() if e.get("status") in ("done", "error", "cancelled")]
    results = []
    for tid in done_ids:
        entry = q[tid]
        results.append({
            "id": tid,
            "agent": entry["agent"],
            "task": entry["task"][:200],
            "status": entry["status"],
            "result": entry.get("result"),
            "duration_s": (
                round((entry["finished_at"] - entry["started_at"]), 2)
                if entry.get("started_at") and entry.get("finished_at") else None
            ),
        })
        if drain:
            q.pop(tid, None)
    pending = [e["id"] for e in q.values() if e.get("status") in ("pending", "running")]
    return {"ok": True, "completed": len(results), "results": results, "still_pending": pending}


def cancel_task(user_id: int, task_id: str) -> dict:
    q = _user_q(user_id)
    entry = q.get(task_id)
    if not entry:
        return {"ok": False, "error": "task_id introuvable"}
    t = _running_tasks.get(task_id)
    if t and not t.done():
        t.cancel()
    entry["status"] = "cancelled"
    return {"ok": True, "cancelled": task_id}
