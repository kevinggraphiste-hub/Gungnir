"""
Gungnir Plugin — Automata (Scheduled Tasks & n8n Workflows)

Two concerns:
1. Scheduled tasks: CRUD for LLM-created crons (data/automata.json)
2. n8n proxy: list/toggle/execute workflows via n8n REST API

n8n config stored in data/automata.json under "n8n" key.
"""
import json
import logging
from datetime import datetime
from pathlib import Path

import httpx
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel
from typing import Optional

logger = logging.getLogger("gungnir.plugins.automata")
router = APIRouter()

DATA_DIR = Path("data")


# ── Per-user data isolation ─────────────────────────────────────────────────

def _user_automata_file(request: Request) -> Path:
    """Return per-user automata file path."""
    uid = getattr(request.state, "user_id", None) or 0
    p = DATA_DIR / "automata" / str(uid) / "tasks.json"
    p.parent.mkdir(parents=True, exist_ok=True)
    return p


# ── Persistence (shared format with wolf_tools) ─────────────────────────────

def _load_data(data_file: Path) -> dict:
    if data_file.exists():
        try:
            return json.loads(data_file.read_text(encoding="utf-8"))
        except Exception:
            pass
    return {"tasks": [], "history": []}


def _save_data(data: dict, data_file: Path):
    data_file.parent.mkdir(parents=True, exist_ok=True)
    data_file.write_text(json.dumps(data, indent=2, ensure_ascii=False, default=str), encoding="utf-8")


# ── Models ───────────────────────────────────────────────────────────────────

class TaskUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    prompt: Optional[str] = None
    task_type: Optional[str] = None
    cron_expression: Optional[str] = None
    interval_seconds: Optional[int] = None
    run_at: Optional[str] = None
    skill_name: Optional[str] = None
    enabled: Optional[bool] = None


class TaskCreate(BaseModel):
    name: str
    description: str = ""
    prompt: str
    task_type: str  # "cron" | "interval" | "run_at"
    cron_expression: Optional[str] = None
    interval_seconds: Optional[int] = None
    run_at: Optional[str] = None
    skill_name: str = ""
    enabled: bool = True


# ── Endpoints ────────────────────────────────────────────────────────────────

@router.get("/health")
async def automata_health():
    return {"plugin": "automata", "status": "ok", "version": "1.0.0"}


@router.get("/tasks")
async def list_tasks(request: Request):
    """List all scheduled tasks with stats."""
    data_file = _user_automata_file(request)
    data = _load_data(data_file)
    tasks = data.get("tasks", [])
    active = sum(1 for t in tasks if t.get("enabled"))
    return {
        "tasks": tasks,
        "stats": {
            "total": len(tasks),
            "active": active,
            "paused": len(tasks) - active,
            "total_runs": sum(t.get("run_count", 0) for t in tasks),
        },
    }


def _validate_cron(expr: str) -> None:
    """Raise HTTPException(400) if the cron expression is not parseable.

    Standard cron is 5 fields (min hour dom month dow). Anything else (including
    the 7-field form with seconds+command appended) is rejected so we never
    accept a value the daemon can't schedule.
    """
    try:
        from croniter import croniter  # type: ignore
    except ImportError:
        return  # If croniter isn't installed the daemon skips crons anyway.
    parts = (expr or "").split()
    if len(parts) != 5:
        raise HTTPException(
            400,
            f"cron_expression invalide: 5 champs attendus (min h jour mois dow), reçu {len(parts)}",
        )
    try:
        croniter(expr)
    except Exception as e:
        raise HTTPException(400, f"cron_expression invalide: {e}")


@router.post("/tasks")
async def create_task(body: TaskCreate, request: Request):
    """Create a new scheduled task for the current user."""
    import uuid
    if body.task_type not in ("cron", "interval", "run_at"):
        raise HTTPException(400, f"task_type invalide: {body.task_type}")
    if body.task_type == "cron":
        if not body.cron_expression:
            raise HTTPException(400, "cron_expression requis pour task_type=cron")
        _validate_cron(body.cron_expression)
    if body.task_type == "interval" and not (body.interval_seconds and body.interval_seconds > 0):
        raise HTTPException(400, "interval_seconds > 0 requis pour task_type=interval")
    if body.task_type == "run_at" and not body.run_at:
        raise HTTPException(400, "run_at requis pour task_type=run_at")
    if not body.name.strip() or not body.prompt.strip():
        raise HTTPException(400, "name et prompt sont obligatoires")

    data_file = _user_automata_file(request)
    data = _load_data(data_file)
    now = datetime.now().isoformat()
    task = {
        "id": str(uuid.uuid4()),
        "name": body.name.strip(),
        "description": body.description,
        "prompt": body.prompt,
        "task_type": body.task_type,
        "cron_expression": body.cron_expression,
        "interval_seconds": body.interval_seconds,
        "run_at": body.run_at,
        "skill_name": body.skill_name or "",
        "enabled": body.enabled,
        "created_at": now,
        "updated_at": now,
        "last_run": None,
        "run_count": 0,
        "last_status": None,
    }
    data.setdefault("tasks", []).append(task)
    data.setdefault("history", [])
    _save_data(data, data_file)
    logger.info(f"Task created: {task['name']} ({task['id']})")
    return task


@router.put("/tasks/{task_id}")
async def update_task(task_id: str, update: TaskUpdate, request: Request):
    """Update a task (name, prompt, schedule, enabled state)."""
    data_file = _user_automata_file(request)
    data = _load_data(data_file)
    for i, t in enumerate(data["tasks"]):
        if t["id"] == task_id:
            updates = update.model_dump(exclude_none=True)
            merged = {**t, **updates}
            # Revalidate the cron expression when the task is (or remains) a cron.
            if merged.get("task_type") == "cron":
                expr = merged.get("cron_expression") or ""
                if not expr:
                    raise HTTPException(400, "cron_expression requis pour task_type=cron")
                _validate_cron(expr)
            data["tasks"][i] = {**merged, "updated_at": datetime.now().isoformat()}
            _save_data(data, data_file)
            logger.info(f"Task updated: {task_id}")
            return data["tasks"][i]
    raise HTTPException(404, "Task not found")


@router.delete("/tasks/{task_id}")
async def delete_task(task_id: str, request: Request):
    """Delete a scheduled task."""
    data_file = _user_automata_file(request)
    data = _load_data(data_file)
    before = len(data["tasks"])
    data["tasks"] = [t for t in data["tasks"] if t["id"] != task_id]
    if len(data["tasks"]) == before:
        raise HTTPException(404, "Task not found")
    _save_data(data, data_file)
    logger.info(f"Task deleted: {task_id}")
    return {"deleted": task_id}


@router.post("/tasks/{task_id}/toggle")
async def toggle_task(task_id: str, request: Request):
    """Toggle task enabled/disabled."""
    data_file = _user_automata_file(request)
    data = _load_data(data_file)
    for i, t in enumerate(data["tasks"]):
        if t["id"] == task_id:
            data["tasks"][i]["enabled"] = not t.get("enabled", True)
            data["tasks"][i]["updated_at"] = datetime.now().isoformat()
            _save_data(data, data_file)
            return {"id": task_id, "enabled": data["tasks"][i]["enabled"]}
    raise HTTPException(404, "Task not found")


@router.post("/tasks/{task_id}/run")
async def run_task_now(task_id: str, request: Request):
    """Trigger immediate execution of a task (sends prompt to active LLM)."""
    data_file = _user_automata_file(request)
    data = _load_data(data_file)
    for i, t in enumerate(data["tasks"]):
        if t["id"] == task_id:
            # Mark as manually triggered
            data["tasks"][i]["last_run"] = datetime.now().isoformat()
            data["tasks"][i]["run_count"] = t.get("run_count", 0) + 1
            data["tasks"][i]["last_status"] = "manual"
            _save_data(data, data_file)

            # Add to history
            data.setdefault("history", []).append({
                "task_id": task_id,
                "task_name": t["name"],
                "triggered_at": datetime.now().isoformat(),
                "trigger": "manual",
                "status": "triggered",
            })
            _save_data(data, data_file)

            logger.info(f"Manual run: {t['name']} ({task_id})")
            return {
                "id": task_id,
                "status": "triggered",
                "prompt": t.get("prompt", ""),
                "run_count": data["tasks"][i]["run_count"],
            }
    raise HTTPException(404, "Task not found")


@router.get("/history")
async def get_history(request: Request):
    """Get execution history (last 50 entries, all tasks)."""
    data_file = _user_automata_file(request)
    data = _load_data(data_file)
    history = data.get("history", [])
    return {"entries": history[-50:], "total": len(history)}


@router.get("/tasks/{task_id}/history")
async def get_task_history(task_id: str, request: Request):
    """Execution history for a single task (chronological, last 100)."""
    data_file = _user_automata_file(request)
    data = _load_data(data_file)
    entries = [e for e in data.get("history", []) if e.get("task_id") == task_id]
    return {"entries": entries[-100:], "total": len(entries)}


# ═══════════════════════════════════════════════════════════════════════════════
# n8n Workflow Integration
# ═══════════════════════════════════════════════════════════════════════════════

class N8nConfig(BaseModel):
    url: str = ""          # e.g. "http://localhost:5678"
    api_key: str = ""      # n8n API key


def _get_n8n_config(data_file: Path) -> dict:
    data = _load_data(data_file)
    return data.get("n8n", {"url": "", "api_key": ""})


def _n8n_headers(config: dict) -> dict:
    return {"X-N8N-API-KEY": config["api_key"], "Content-Type": "application/json"}


async def _n8n_request(method: str, path: str, data_file: Path, json_body: dict = None) -> dict:
    """Proxy request to n8n API."""
    config = _get_n8n_config(data_file)
    if not config.get("url") or not config.get("api_key"):
        raise HTTPException(400, "n8n non configure. Ajoutez l'URL et la cle API.")

    url = f"{config['url'].rstrip('/')}/api/v1{path}"
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.request(method, url, headers=_n8n_headers(config), json=json_body)
            resp.raise_for_status()
            return resp.json()
    except httpx.HTTPStatusError as e:
        raise HTTPException(e.response.status_code, f"n8n error: {e.response.text[:200]}")
    except httpx.ConnectError:
        raise HTTPException(502, f"Impossible de joindre n8n a {config['url']}")
    except Exception as e:
        raise HTTPException(500, f"n8n request failed: {str(e)[:200]}")


# ── n8n config ────────────────────────────────────────────────────────────────

@router.get("/n8n/config")
async def get_n8n_config(request: Request):
    """Get n8n connection config (url only, key masked)."""
    data_file = _user_automata_file(request)
    config = _get_n8n_config(data_file)
    return {
        "url": config.get("url", ""),
        "has_key": bool(config.get("api_key")),
        "configured": bool(config.get("url") and config.get("api_key")),
    }


@router.put("/n8n/config")
async def update_n8n_config(cfg: N8nConfig, request: Request):
    """Save n8n connection config."""
    data_file = _user_automata_file(request)
    data = _load_data(data_file)
    data["n8n"] = {"url": cfg.url.rstrip("/"), "api_key": cfg.api_key}
    _save_data(data, data_file)
    logger.info(f"n8n config updated: {cfg.url}")
    return {"ok": True, "url": cfg.url}


@router.get("/n8n/test")
async def test_n8n_connection(request: Request):
    """Test n8n connectivity."""
    data_file = _user_automata_file(request)
    config = _get_n8n_config(data_file)
    if not config.get("url") or not config.get("api_key"):
        return {"ok": False, "error": "Non configure"}
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(
                f"{config['url'].rstrip('/')}/api/v1/workflows?limit=1",
                headers=_n8n_headers(config),
            )
            resp.raise_for_status()
            return {"ok": True, "message": "Connexion reussie"}
    except httpx.ConnectError:
        return {"ok": False, "error": f"Impossible de joindre {config['url']}"}
    except httpx.HTTPStatusError as e:
        return {"ok": False, "error": f"HTTP {e.response.status_code}: cle API invalide?"}
    except Exception as e:
        return {"ok": False, "error": str(e)[:200]}


# ── n8n workflows ─────────────────────────────────────────────────────────────

@router.get("/n8n/workflows")
async def list_n8n_workflows(request: Request):
    """List all n8n workflows."""
    data_file = _user_automata_file(request)
    data = await _n8n_request("GET", "/workflows", data_file)
    workflows = data.get("data", [])
    return {
        "workflows": [
            {
                "id": w["id"],
                "name": w.get("name", ""),
                "active": w.get("active", False),
                "created_at": w.get("createdAt", ""),
                "updated_at": w.get("updatedAt", ""),
                "tags": [t.get("name", "") for t in w.get("tags", [])],
                "node_count": len(w.get("nodes", [])),
            }
            for w in workflows
        ],
        "total": len(workflows),
    }


@router.post("/n8n/workflows/{workflow_id}/activate")
async def activate_n8n_workflow(workflow_id: str, request: Request):
    """Activate a n8n workflow."""
    data_file = _user_automata_file(request)
    result = await _n8n_request("PATCH", f"/workflows/{workflow_id}", data_file, {"active": True})
    return {"ok": True, "id": workflow_id, "active": True}


@router.post("/n8n/workflows/{workflow_id}/deactivate")
async def deactivate_n8n_workflow(workflow_id: str, request: Request):
    """Deactivate a n8n workflow."""
    data_file = _user_automata_file(request)
    result = await _n8n_request("PATCH", f"/workflows/{workflow_id}", data_file, {"active": False})
    return {"ok": True, "id": workflow_id, "active": False}


@router.post("/n8n/workflows/{workflow_id}/execute")
async def execute_n8n_workflow(workflow_id: str, request: Request):
    """Trigger immediate execution of a n8n workflow."""
    data_file = _user_automata_file(request)
    try:
        result = await _n8n_request("POST", f"/workflows/{workflow_id}/run", data_file)
        return {"ok": True, "id": workflow_id, "execution": result}
    except HTTPException:
        # Some n8n versions use different endpoint
        try:
            result = await _n8n_request("POST", f"/executions", data_file, {"workflowId": workflow_id})
            return {"ok": True, "id": workflow_id, "execution": result}
        except Exception:
            raise


@router.get("/n8n/executions")
async def list_n8n_executions(request: Request):
    """Get recent n8n executions."""
    data_file = _user_automata_file(request)
    data = await _n8n_request("GET", "/executions?limit=20", data_file)
    executions = data.get("data", [])
    return {
        "executions": [
            {
                "id": e.get("id"),
                "workflow_id": e.get("workflowId", ""),
                "workflow_name": e.get("workflowData", {}).get("name", ""),
                "status": e.get("status", ""),
                "started_at": e.get("startedAt", ""),
                "finished_at": e.get("stoppedAt", ""),
                "mode": e.get("mode", ""),
            }
            for e in executions
        ],
        "total": len(executions),
    }


# ── n8n inline modification via LLM + MCP ───────────────────────────────────

class ModifyRequest(BaseModel):
    prompt: str  # e.g. "ajoute un node Discord apres le trigger"


@router.post("/n8n/workflows/{workflow_id}/modify")
async def modify_n8n_workflow(workflow_id: str, req: ModifyRequest, request: Request):
    """
    Inline modification: sends user prompt + workflow context to the LLM
    with MCP tools available, so it can modify the n8n workflow directly.
    """
    data_file = _user_automata_file(request)
    # 1. Fetch full workflow details from n8n for context
    try:
        workflow_data = await _n8n_request("GET", f"/workflows/{workflow_id}", data_file)
    except HTTPException as e:
        return {"ok": False, "error": f"Impossible de recuperer le workflow: {e.detail}"}

    workflow_name = workflow_data.get("name", workflow_id)
    nodes = workflow_data.get("nodes", [])
    connections = workflow_data.get("connections", {})

    # Build a concise workflow summary for the LLM
    nodes_summary = "\n".join(
        f"  - {n.get('name', '?')} (type: {n.get('type', '?')})"
        for n in nodes
    )
    context = (
        f"Workflow n8n: \"{workflow_name}\" (id: {workflow_id})\n"
        f"Noeuds actuels ({len(nodes)}):\n{nodes_summary}\n"
        f"Connexions: {json.dumps(connections, ensure_ascii=False)[:500]}"
    )

    # 2. Load settings and get the current user's configured LLM provider
    try:
        from backend.core.config.settings import Settings
        from backend.core.providers import get_provider, ChatMessage
        from backend.core.agents.mcp_client import mcp_manager
        from backend.core.db.engine import async_session as _n8n_sm
        from backend.core.api.auth_helpers import (
            get_user_settings as _n8n_gus,
            get_user_provider_key as _n8n_gpk,
        )
    except ImportError as e:
        return {"ok": False, "error": f"Import error: {e}"}

    settings = Settings.load()

    # STRICT per-user: pick the first provider for which THIS user has a key.
    _req_uid = getattr(request.state, "user_id", None) or 0
    provider = None
    chosen_model = None
    if _req_uid > 0:
        try:
            async with _n8n_sm() as _n8n_s:
                _uset_n8n = await _n8n_gus(_req_uid, _n8n_s)
                _active = _uset_n8n.active_provider or "openrouter"
                _order = [_active] + [
                    p for p in (_uset_n8n.provider_keys or {}).keys() if p != _active
                ]
                for pname in _order:
                    decoded = _n8n_gpk(_uset_n8n, pname)
                    if not decoded or not decoded.get("api_key"):
                        continue
                    meta = settings.providers.get(pname)
                    _bu = decoded.get("base_url") or (meta.base_url if meta else None)
                    provider = get_provider(pname, decoded["api_key"], _bu)
                    chosen_model = (
                        (_uset_n8n.active_model if pname == _active else None)
                        or (meta.default_model if meta else None)
                    )
                    if provider and chosen_model:
                        break
        except Exception as _e:
            return {"ok": False, "error": f"Erreur de résolution de provider: {_e}"}

    if not provider or not chosen_model:
        return {"ok": False, "error": "Aucun provider LLM configuré pour cet utilisateur"}

    # 3. Build messages with workflow context + MCP tools
    system_prompt = (
        "Tu es un assistant specialise dans la modification de workflows n8n. "
        "Tu as acces aux outils MCP n8n pour modifier les workflows. "
        "Utilise les outils disponibles pour effectuer la modification demandee. "
        "Reponds en francais. Sois concis et indique exactement ce que tu as fait."
    )

    user_content = (
        f"Voici le contexte du workflow a modifier:\n\n{context}\n\n"
        f"Modification demandee: {req.prompt}"
    )

    messages = [
        ChatMessage(role="system", content=system_prompt),
        ChatMessage(role="user", content=user_content),
    ]

    # 4. Get this user's MCP tool schemas (n8n tools) — lazy-start if needed
    _uid = getattr(request.state, "user_id", None) or 0
    await mcp_manager.ensure_user_started(_uid)
    mcp_tools = mcp_manager.get_user_schemas(_uid)
    mcp_executors = mcp_manager.get_user_executors(_uid)

    if not mcp_tools:
        return {"ok": False, "error": "Aucun serveur MCP connecte. Configurez le MCP n8n dans les parametres."}

    # 5. LLM call with tool loop (max 5 rounds)
    MAX_ROUNDS = 5
    tool_results = []

    try:
        for _round in range(MAX_ROUNDS):
            response = await provider.chat(messages, chosen_model, tools=mcp_tools, tool_choice="auto")

            if not response.tool_calls:
                # LLM is done — return its final message
                return {
                    "ok": True,
                    "response": response.content or "Modification effectuee.",
                    "tool_results": tool_results,
                }

            # Execute each tool call
            messages.append(ChatMessage(
                role="assistant", content=response.content or "",
                tool_calls=response.tool_calls,
            ))

            for tc in response.tool_calls:
                fn = tc.get("function", tc) if isinstance(tc, dict) else tc
                tool_name = fn.get("name", "") if isinstance(fn, dict) else getattr(fn, "name", "")
                tool_args_raw = fn.get("arguments", "{}") if isinstance(fn, dict) else getattr(fn, "arguments", "{}")
                tc_id = tc.get("id", f"tc-{_round}") if isinstance(tc, dict) else getattr(tc, "id", f"tc-{_round}")

                try:
                    tool_args = json.loads(tool_args_raw) if isinstance(tool_args_raw, str) else tool_args_raw
                except json.JSONDecodeError:
                    tool_args = {}

                executor = mcp_executors.get(tool_name)
                if executor:
                    try:
                        result = await executor(**tool_args)
                        result_str = json.dumps(result, ensure_ascii=False, default=str)[:2000]
                        tool_results.append({"tool": tool_name, "result": result})
                    except Exception as e:
                        result_str = json.dumps({"error": str(e)})
                        tool_results.append({"tool": tool_name, "error": str(e)})
                else:
                    result_str = json.dumps({"error": f"Outil '{tool_name}' non trouve"})

                messages.append(ChatMessage(role="tool", content=result_str, tool_call_id=tc_id))

        # If we exhausted rounds
        return {
            "ok": True,
            "response": response.content or "Modification en cours (rounds max atteints).",
            "tool_results": tool_results,
        }

    except Exception as e:
        logger.error(f"Inline n8n modify failed: {e}")
        return {"ok": False, "error": f"Erreur LLM: {str(e)[:200]}"}
