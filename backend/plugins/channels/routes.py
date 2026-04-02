"""
Gungnir Plugin — Channels (Telegram, etc.)
Routes will be migrated from OpenClaude in Phase 5.
"""
from fastapi import APIRouter

router = APIRouter()


@router.get("/health")
async def channels_health():
    return {"plugin": "channels", "status": "ok"}
