"""
Gungnir — Auth helpers for per-user isolation
Provides utilities to get current user, their API keys, and enforce ownership.
"""
from fastapi import Request, Depends
from fastapi.responses import JSONResponse
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from backend.core.db.models import User, UserSettings, Conversation
from backend.core.db.engine import get_session
from backend.core.config.settings import encrypt_value, decrypt_value


async def get_current_user_id(request: Request) -> int | None:
    """Extract user_id from request.state (set by auth middleware). Returns None if no auth."""
    return getattr(request.state, "user_id", None)


async def get_current_user(request: Request, session: AsyncSession = Depends(get_session)) -> User | None:
    """Get the full User object from the authenticated request."""
    user_id = getattr(request.state, "user_id", None)
    if not user_id:
        return None
    return await session.get(User, user_id)


async def get_user_settings(user_id: int, session: AsyncSession) -> UserSettings:
    """Get or create UserSettings for a given user."""
    result = await session.execute(
        select(UserSettings).where(UserSettings.user_id == user_id)
    )
    settings = result.scalar_one_or_none()
    if not settings:
        settings = UserSettings(user_id=user_id, provider_keys={}, service_keys={})
        session.add(settings)
        await session.commit()
        await session.refresh(settings)
    return settings


def get_user_provider_key(user_settings: UserSettings, provider_name: str) -> dict | None:
    """Get a user's provider config (api_key, enabled, etc.) with decrypted key."""
    if not user_settings or not user_settings.provider_keys:
        return None
    prov = user_settings.provider_keys.get(provider_name)
    if not prov:
        return None
    # Decrypt api_key
    result = dict(prov)
    if result.get("api_key"):
        result["api_key"] = decrypt_value(result["api_key"])
    return result


def get_user_service_key(user_settings: UserSettings, service_name: str) -> dict | None:
    """Get a user's service config with decrypted secrets."""
    if not user_settings or not user_settings.service_keys:
        return None
    svc = user_settings.service_keys.get(service_name)
    if not svc:
        return None
    result = dict(svc)
    for field in ("api_key", "token"):
        if result.get(field):
            result[field] = decrypt_value(result[field])
    return result


async def enforce_conversation_owner(convo_id: int, request: Request, session: AsyncSession) -> Conversation | None:
    """Check that the conversation belongs to the authenticated user.
    Returns the conversation if OK, or None + logs warning if unauthorized."""
    user_id = getattr(request.state, "user_id", None)
    result = await session.execute(
        select(Conversation).where(Conversation.id == convo_id)
    )
    convo = result.scalar_one_or_none()
    if not convo:
        return None

    # If conversation has no user_id (legacy) or user is admin, allow
    if convo.user_id is None:
        return convo
    if user_id and convo.user_id == user_id:
        return convo

    # Check admin
    if user_id:
        user = await session.get(User, user_id)
        if user and user.is_admin:
            return convo

    return None  # Unauthorized
