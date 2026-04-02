"""
Gungnir Plugin — Voice (ElevenLabs ConvAI)
Routes will be migrated from OpenClaude in Phase 4.
"""
from fastapi import APIRouter

router = APIRouter()


@router.get("/health")
async def voice_health():
    return {"plugin": "voice", "status": "ok"}
