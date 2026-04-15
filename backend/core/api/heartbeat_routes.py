"""
Gungnir — Heartbeat API Routes (strict per-user)

Each user has their own heartbeat config and status at
data/heartbeat/{uid}/state.json. A single master scanner loop walks the
per-user directories every MASTER_TICK_RESOLUTION seconds and beats each
user whose own check_interval has elapsed since their own last_tick.

There is no shared state between users:
  • One state file per user
  • Routes always operate on the caller's own state (request.state.user_id)
  • Tick side effects (event bus, consciousness tagging) are scoped to the
    user being beaten — never iterate or mutate other users' instances.
"""
import json
import asyncio
import logging
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, Request

logger = logging.getLogger("gungnir.heartbeat")

router = APIRouter()

DATA_DIR = Path(__file__).parent.parent.parent.parent / "data"
HB_DIR = DATA_DIR / "heartbeat"
MASTER_TICK_RESOLUTION = 5  # seconds — granularity of the master scanner

DEFAULT_CONFIG = {
    "enabled": False,
    "paused": False,
    "check_interval_seconds": 30,
    "ws_ping_interval_seconds": 25,
    "offset_seconds": 0,
    "max_concurrent_tasks": 5,
    "on_startup": False,
    "started_at": None,
    # Mode Jour/Nuit — applique night_config entre night_start_hour et day_start_hour
    "day_night_enabled": False,
    "day_start_hour": 7,
    "night_start_hour": 22,
    "night_config": {
        "check_interval_seconds": 300,
        "ws_ping_interval_seconds": 60,
        "max_concurrent_tasks": 2,
    },
}

DEFAULT_STATUS = {
    "last_tick": None,
    "tick_count": 0,
}


# ── Time helpers ──────────────────────────────────────────────────────────────

def _is_night_time(cfg: dict) -> bool:
    if not cfg.get("day_night_enabled"):
        return False
    hour = datetime.now().hour
    day_start = int(cfg.get("day_start_hour", 7))
    night_start = int(cfg.get("night_start_hour", 22))
    if night_start > day_start:
        return hour >= night_start or hour < day_start
    return night_start <= hour < day_start


def _effective_config(cfg: dict) -> dict:
    if not _is_night_time(cfg):
        return cfg
    night = cfg.get("night_config") or {}
    merged = {**cfg}
    for k, v in night.items():
        if v is not None:
            merged[k] = v
    return merged


def _parse_iso(value):
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


# ── Per-user storage ──────────────────────────────────────────────────────────

def _user_hb_file(user_id: int) -> Path:
    p = HB_DIR / str(user_id) / "state.json"
    p.parent.mkdir(parents=True, exist_ok=True)
    return p


def _load_user(user_id: int) -> dict:
    f = _user_hb_file(user_id)
    if f.exists():
        try:
            data = json.loads(f.read_text(encoding="utf-8"))
            data.setdefault("config", {**DEFAULT_CONFIG})
            data.setdefault("status", {**DEFAULT_STATUS})
            return data
        except Exception:
            pass
    return {"config": {**DEFAULT_CONFIG}, "status": {**DEFAULT_STATUS}}


def _save_user(user_id: int, data: dict):
    f = _user_hb_file(user_id)
    f.parent.mkdir(parents=True, exist_ok=True)
    f.write_text(json.dumps(data, indent=2, default=str), encoding="utf-8")


def _resolve_user_id(request: Request) -> int:
    """Extract user_id from request. Falls back to 0 for unauthenticated /
    open-mode requests so the route is still usable in setup flows."""
    return getattr(request.state, "user_id", None) or 0


# ── Background heartbeat master loop ──────────────────────────────────────────

_heartbeat_task: asyncio.Task | None = None


async def _beat_user(user_id: int, data: dict, eff_cfg: dict, now: datetime):
    """Persist a beat for a single user and fire user-scoped side effects.

    Strictly user-isolated: only this user's state is written, only this
    user's consciousness instance is tagged, only an event mentioning this
    user_id is emitted. No iteration over other users.
    """
    now_iso = now.isoformat()
    status = data.get("status") or {}
    status["last_tick"] = now_iso
    status["tick_count"] = int(status.get("tick_count", 0)) + 1
    data["status"] = status
    _save_user(user_id, data)

    # Emit user-scoped event so plugins can react per-user
    try:
        from backend.core.services.event_bus import event_bus
        await event_bus.emit(
            "user.heartbeat.tick",
            user_id=user_id,
            timestamp=now_iso,
            tick=status["tick_count"],
            interval=int(eff_cfg.get("check_interval_seconds", 30) or 30),
        )
    except Exception as e:
        logger.warning(f"Heartbeat: event emit failed for user {user_id}: {e}")

    # Tag ONLY this user's consciousness instance
    try:
        from backend.plugins.consciousness.engine import consciousness_manager
        instance = consciousness_manager._instances.get(user_id)
        if instance and instance.enabled:
            instance._state["last_heartbeat"] = now_iso
            stats = instance._state.setdefault("stats", {})
            stats["heartbeats"] = int(stats.get("heartbeats", 0)) + 1
            try:
                instance.save_state()
            except Exception as e:
                logger.warning(f"Heartbeat: save_state failed for user {user_id}: {e}")
    except Exception as e:
        logger.warning(f"Heartbeat: consciousness tag failed for user {user_id}: {e}")

    logger.debug(f"Heartbeat tick #{status['tick_count']} for user {user_id} at {now_iso}")


async def _heartbeat_loop():
    """Master scanner — ticks every MASTER_TICK_RESOLUTION seconds, beats each
    user whose own check_interval has elapsed since their last_tick."""
    logger.info(f"Heartbeat master loop started (resolution {MASTER_TICK_RESOLUTION}s)")
    while True:
        try:
            await asyncio.sleep(MASTER_TICK_RESOLUTION)
            now = datetime.now(timezone.utc)

            if not HB_DIR.exists():
                continue

            for user_dir in HB_DIR.iterdir():
                if not user_dir.is_dir():
                    continue
                try:
                    user_id = int(user_dir.name)
                except ValueError:
                    continue

                data = _load_user(user_id)
                cfg = data.get("config", {})
                if not cfg.get("enabled") or cfg.get("paused"):
                    continue

                eff = _effective_config(cfg)
                interval = int(eff.get("check_interval_seconds", 30) or 30)

                last = _parse_iso(data.get("status", {}).get("last_tick"))
                if last and (now - last).total_seconds() < interval:
                    continue

                try:
                    await _beat_user(user_id, data, eff, now)
                except Exception as e:
                    logger.warning(f"Heartbeat: _beat_user failed for {user_id}: {e}")

        except asyncio.CancelledError:
            logger.info("Heartbeat master loop cancelled")
            break
        except Exception as e:
            logger.warning(f"Heartbeat loop error: {e}")
            await asyncio.sleep(10)


def _ensure_loop():
    """Start the master scanner loop if not already running.
    Safe to call multiple times — idempotent."""
    global _heartbeat_task
    if _heartbeat_task is None or _heartbeat_task.done():
        try:
            loop = asyncio.get_event_loop()
            _heartbeat_task = loop.create_task(_heartbeat_loop())
        except RuntimeError:
            pass


def _stop_loop():
    global _heartbeat_task
    if _heartbeat_task and not _heartbeat_task.done():
        _heartbeat_task.cancel()
        _heartbeat_task = None


def _autostart_scan() -> dict:
    """Walk all per-user state files and mark on_startup=true users as enabled,
    so the master loop picks them up. Called by main.py at server boot.

    Returns a legacy-shaped dict so older code doing
    `_load().get("config", {}).get("on_startup")` keeps working.
    """
    any_startup = False
    if HB_DIR.exists():
        for user_dir in HB_DIR.iterdir():
            if not user_dir.is_dir():
                continue
            try:
                user_id = int(user_dir.name)
            except ValueError:
                continue
            data = _load_user(user_id)
            if data.get("config", {}).get("on_startup"):
                any_startup = True
                data["config"]["enabled"] = True
                data["config"]["paused"] = False
                data["config"]["started_at"] = datetime.now(timezone.utc).isoformat()
                _save_user(user_id, data)
    return {"config": {"on_startup": any_startup}}


# Legacy aliases — kept so imports in main.py keep working without touching
# every call site. They now delegate to the per-user logic.
def _load() -> dict:
    return _autostart_scan()


def _save(_data: dict):
    pass  # no-op: per-user save happens via _save_user()


# ── Routes ────────────────────────────────────────────────────────────────────

@router.get("/heartbeat")
async def get_heartbeat(request: Request):
    """Statut du heartbeat de l'utilisateur courant."""
    uid = _resolve_user_id(request)
    data = _load_user(uid)
    cfg = data.get("config", {})
    beat_status = data.get("status") or {}

    running = _heartbeat_task is not None and not _heartbeat_task.done()
    state = "stopped"
    if cfg.get("enabled") and running:
        state = "paused" if cfg.get("paused") else "running"

    return {
        "status": state,
        "running": cfg.get("enabled", False) and not cfg.get("paused", False),
        "config": cfg,
        "tasks": data.get("tasks", []),
        "loop_active": running,
        "last_tick": beat_status.get("last_tick"),
        "tick_count": beat_status.get("tick_count", 0),
        "user_id": uid,
    }


@router.put("/heartbeat/config")
async def update_heartbeat_config(request: Request):
    """Met à jour la configuration heartbeat de l'utilisateur courant."""
    uid = _resolve_user_id(request)
    request_data = await request.json()
    data = _load_user(uid)
    cfg = data.get("config", {})

    for key, val in request_data.items():
        if key == "night_config" and isinstance(val, dict):
            current_night = cfg.get("night_config") or {}
            cfg["night_config"] = {**current_night, **val}
        elif key in DEFAULT_CONFIG:
            cfg[key] = val

    data["config"] = cfg
    _save_user(uid, data)
    return {"ok": True, "config": cfg, "night_active": _is_night_time(cfg)}


@router.get("/heartbeat/effective")
async def get_effective_config(request: Request):
    """Config effective (avec overrides jour/nuit) de l'utilisateur courant."""
    uid = _resolve_user_id(request)
    data = _load_user(uid)
    cfg = data.get("config", {})
    return {
        "effective": _effective_config(cfg),
        "night_active": _is_night_time(cfg),
    }


@router.post("/heartbeat/start")
async def start_heartbeat(request: Request):
    """Active le heartbeat de l'utilisateur courant."""
    uid = _resolve_user_id(request)
    data = _load_user(uid)
    data["config"]["enabled"] = True
    data["config"]["paused"] = False
    data["config"]["started_at"] = datetime.now(timezone.utc).isoformat()
    _save_user(uid, data)
    _ensure_loop()  # idempotent — starts the master scanner if not already up
    return {"ok": True, "status": "running"}


@router.post("/heartbeat/pause")
async def pause_heartbeat(request: Request):
    uid = _resolve_user_id(request)
    data = _load_user(uid)
    data["config"]["paused"] = True
    _save_user(uid, data)
    return {"ok": True, "status": "paused"}


@router.post("/heartbeat/resume")
async def resume_heartbeat(request: Request):
    uid = _resolve_user_id(request)
    data = _load_user(uid)
    data["config"]["paused"] = False
    _save_user(uid, data)
    _ensure_loop()
    return {"ok": True, "status": "running"}


@router.post("/heartbeat/stop")
async def stop_heartbeat(request: Request):
    uid = _resolve_user_id(request)
    data = _load_user(uid)
    data["config"]["enabled"] = False
    data["config"]["paused"] = False
    data["config"]["started_at"] = None
    _save_user(uid, data)
    return {"ok": True, "status": "stopped"}
