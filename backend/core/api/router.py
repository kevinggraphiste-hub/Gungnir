"""
Gungnir — Core API Router

Aggregates all core route modules.
"""
from fastapi import APIRouter

core_router = APIRouter()

# These will be populated in Phase 1 when we extract routes from OpenClaude
# from backend.core.api.config_routes import router as config_router
# from backend.core.api.conversations import router as conversations_router
# from backend.core.api.chat import router as chat_router
# from backend.core.api.users import router as users_router
# from backend.core.api.agent_routes import router as agent_router

# core_router.include_router(config_router)
# core_router.include_router(conversations_router)
# core_router.include_router(chat_router)
# core_router.include_router(users_router)
# core_router.include_router(agent_router)


# Temporary health check
@core_router.get("/health")
async def health():
    return {"status": "ok", "app": "Gungnir", "version": "2.0.0"}
