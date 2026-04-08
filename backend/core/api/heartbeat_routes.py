"""
Gungnir — Heartbeat API Routes

Gère le cycle heartbeat : battement périodique qui permet à la conscience
de réfléchir en arrière-plan, maintenir les connexions WebSocket,
et exécuter des tâches planifiées.
"""
import json
import asyncio
import logging
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter

logger = logging.getLogger("gungnir.heartbeat")

router = APIRouter()

DATA_DIR = Path(__file__).parent.parent.parent.parent / "data"
HB_FILE = DATA_DIR / "heartbeat.json"

DEFAULT_CONFIG = {
    "enabled": False,
    "paused": False,
    "check_interval_seconds": 30,
    "ws_ping_interval_seconds": 25,
    "offset_seconds": 0,
    "max_concurrent_tasks": 5,
    "on_startup": False,
    "started_at": None,
}


def _load() -> dict:
    """Charge la config heartbeat depuis le fichier JSON."""
    if HB_FILE.exists():
        try:
            return json.loads(HB_FILE.read_text(encoding="utf-8"))
        except Exception:
            pass
    return {"config": {**DEFAULT_CONFIG}, "tasks": []}


def _save(data: dict):
    """Sauvegarde la config heartbeat."""
    HB_FILE.parent.mkdir(parents=True, exist_ok=True)
    HB_FILE.write_text(json.dumps(data, indent=2, default=str), encoding="utf-8")


# ── Background heartbeat loop ─────────────────────────────────────────────

_heartbeat_task: asyncio.Task | None = None


async def _heartbeat_loop():
    """Boucle de fond : exécute les tâches heartbeat périodiquement."""
    while True:
        try:
            data = _load()
            cfg = data.get("config", {})

            if not cfg.get("enabled") or cfg.get("paused"):
                await asyncio.sleep(5)
                continue

            interval = cfg.get("check_interval_seconds", 30)

            # Trigger consciousness background think if available
            try:
                from backend.plugins.consciousness.engine import consciousness
                if consciousness.enabled:
                    await consciousness.background_think()
                    logger.debug("Heartbeat: consciousness tick")
            except Exception:
                pass  # Consciousness plugin may not be loaded

            await asyncio.sleep(interval)

        except asyncio.CancelledError:
            break
        except Exception as e:
            logger.warning(f"Heartbeat loop error: {e}")
            await asyncio.sleep(10)


def _ensure_loop():
    """Démarre la boucle heartbeat si elle n'est pas active."""
    global _heartbeat_task
    if _heartbeat_task is None or _heartbeat_task.done():
        try:
            loop = asyncio.get_event_loop()
            _heartbeat_task = loop.create_task(_heartbeat_loop())
        except RuntimeError:
            pass


def _stop_loop():
    """Arrête la boucle heartbeat."""
    global _heartbeat_task
    if _heartbeat_task and not _heartbeat_task.done():
        _heartbeat_task.cancel()
        _heartbeat_task = None


# ── Routes ─────────────────────────────────────────────────────────────────

@router.get("/heartbeat")
async def get_heartbeat():
    """Statut complet du heartbeat."""
    data = _load()
    cfg = data.get("config", {})

    # Determine running status
    running = _heartbeat_task is not None and not _heartbeat_task.done()
    status = "stopped"
    if cfg.get("enabled") and running:
        status = "paused" if cfg.get("paused") else "running"

    return {
        "status": status,
        "config": cfg,
        "tasks": data.get("tasks", []),
        "loop_active": running,
    }


@router.put("/heartbeat/config")
async def update_heartbeat_config(request_data: dict):
    """Met à jour la configuration du heartbeat."""
    data = _load()
    cfg = data.get("config", {})

    for key, val in request_data.items():
        if key in DEFAULT_CONFIG:
            cfg[key] = val

    data["config"] = cfg
    _save(data)
    return {"ok": True, "config": cfg}


@router.post("/heartbeat/start")
async def start_heartbeat():
    """Démarre le heartbeat."""
    data = _load()
    data["config"]["enabled"] = True
    data["config"]["paused"] = False
    data["config"]["started_at"] = datetime.now(timezone.utc).isoformat()
    _save(data)
    _ensure_loop()
    return {"ok": True, "status": "running"}


@router.post("/heartbeat/pause")
async def pause_heartbeat():
    """Met en pause le heartbeat."""
    data = _load()
    data["config"]["paused"] = True
    _save(data)
    return {"ok": True, "status": "paused"}


@router.post("/heartbeat/resume")
async def resume_heartbeat():
    """Reprend le heartbeat après une pause."""
    data = _load()
    data["config"]["paused"] = False
    _save(data)
    _ensure_loop()
    return {"ok": True, "status": "running"}


@router.post("/heartbeat/stop")
async def stop_heartbeat():
    """Arrête le heartbeat."""
    data = _load()
    data["config"]["enabled"] = False
    data["config"]["paused"] = False
    data["config"]["started_at"] = None
    _save(data)
    _stop_loop()
    return {"ok": True, "status": "stopped"}
