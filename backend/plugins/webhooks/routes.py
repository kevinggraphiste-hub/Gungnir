"""
Gungnir Plugin — Webhooks
Routes will be migrated from OpenClaude in Phase 5.
"""
from fastapi import APIRouter

router = APIRouter()


@router.get("/health")
async def webhooks_health():
    return {"plugin": "webhooks", "status": "ok"}
