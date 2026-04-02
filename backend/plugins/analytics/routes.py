"""
Gungnir Plugin — Analytics
Routes will be migrated from OpenClaude in Phase 4.
"""
from fastapi import APIRouter

router = APIRouter()


@router.get("/health")
async def analytics_health():
    return {"plugin": "analytics", "status": "ok"}
