"""
Gungnir Plugin — Browser (Perplexity-style search)
Routes will be migrated from OpenClaude in Phase 3.
"""
from fastapi import APIRouter

router = APIRouter()


@router.get("/health")
async def browser_health():
    return {"plugin": "browser", "status": "ok"}
