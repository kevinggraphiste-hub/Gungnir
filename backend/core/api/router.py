"""
Gungnir — Core API Router

Aggregates all core route modules.
"""
from fastapi import APIRouter, Request

from backend.core.api.config_routes import router as config_router
from backend.core.api.conversations import router as conversations_router
from backend.core.api.chat import router as chat_router
from backend.core.api.users import router as users_router
from backend.core.api.agent_routes import router as agent_router
from backend.core.api.backup_routes import router as backup_router
from backend.core.api.heartbeat_routes import router as heartbeat_router
from backend.core.api.organization_routes import router as organization_router
from backend.core.api.task_routes import router as task_router
from backend.core.api.onboarding import router as onboarding_router

from backend.core.__version__ import __version__

core_router = APIRouter()

# Health check + version
@core_router.get("/health")
async def health():
    return {"status": "ok", "app": "Gungnir", "version": __version__}


# Version endpoint : Gungnir + tous les plugins chargés
@core_router.get("/version")
async def version():
    """Single source of truth for versions : coeur Gungnir + plugins actifs."""
    try:
        from backend.core import main as _core_main
        plugins = [
            {"name": p.name, "display_name": p.display_name, "version": p.version}
            for p in getattr(_core_main, "_loaded_plugins", [])
        ]
    except Exception:
        plugins = []
    return {
        "app": "Gungnir",
        "version": __version__,
        "plugins": plugins,
    }


# Doctor — diagnostic complet
@core_router.get("/doctor")
async def doctor(scope: str = "full", request: Request = None):
    """Run a full system diagnostic."""
    from backend.core.agents.wolf_tools import _doctor_check, set_user_context
    # Set user context so doctor can check per-user provider keys
    uid = (getattr(request.state, "user_id", None) or 1) if request else 1
    set_user_context(uid)
    return await _doctor_check(scope)

# Mount core route modules
core_router.include_router(config_router, tags=["Config"])
core_router.include_router(conversations_router, tags=["Conversations"])
core_router.include_router(chat_router, tags=["Chat"])
core_router.include_router(users_router, tags=["Users"])
core_router.include_router(agent_router, tags=["Agent"])
core_router.include_router(backup_router, tags=["Backup"])
core_router.include_router(heartbeat_router, tags=["Heartbeat"])
core_router.include_router(organization_router, tags=["Organization"])
core_router.include_router(task_router, tags=["Tasks"])
core_router.include_router(onboarding_router, tags=["Onboarding"])
