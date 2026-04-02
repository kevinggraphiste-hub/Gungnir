"""
Gungnir Plugin — Model Guide (dynamic catalog)
Routes will be migrated from OpenClaude in Phase 5.
"""
from fastapi import APIRouter

router = APIRouter()


@router.get("/health")
async def model_guide_health():
    return {"plugin": "model_guide", "status": "ok"}
