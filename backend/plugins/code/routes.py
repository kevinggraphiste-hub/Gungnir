"""
Gungnir Plugin — Code (future)
Empty shell ready for plugin integration.
"""
from fastapi import APIRouter

router = APIRouter()


@router.get("/health")
async def code_health():
    return {"plugin": "code", "status": "placeholder", "message": "Coming soon"}
