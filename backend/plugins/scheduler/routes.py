"""
Gungnir Plugin — Scheduler (Heartbeat)
Routes will be migrated from OpenClaude in Phase 5.
"""
from fastapi import APIRouter

router = APIRouter()


@router.get("/health")
async def scheduler_health():
    return {"plugin": "scheduler", "status": "ok"}
