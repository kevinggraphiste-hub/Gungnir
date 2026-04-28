"""
Gungnir — Auth helpers for per-user isolation
Provides utilities to get current user, their API keys, and enforce ownership.
"""
import logging

from fastapi import Request, Depends
from fastapi.responses import JSONResponse
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func

from backend.core.db.models import User, UserSettings, Conversation
from backend.core.db.engine import get_session
from backend.core.config.settings import encrypt_value, decrypt_value

logger = logging.getLogger("gungnir.auth_helpers")


async def open_mode_fallback_user_id(session: AsyncSession) -> int | None:
    """Return user #1 ONLY if it's the single user in the DB.

    Used by legacy open/setup-mode endpoints that need to behave as if the
    lone admin was calling. Returns None as soon as a second user exists, so
    unauthenticated calls can no longer read or write credentials belonging
    to the first user (cross-user leak prevention).

    Sécurité (fix M2) : on utilise `SELECT ... FOR UPDATE` pour poser un
    row-lock Postgres sur l'user #1 pendant que la décision est prise.
    Évite une race condition où un second user est inséré entre le
    count() et le return de l'user #1.
    """
    count_row = await session.execute(select(func.count()).select_from(User))
    user_count = count_row.scalar() or 0
    if user_count != 1:
        if user_count > 1:
            logger.warning(
                "Refused open-mode fallback to user #1: %d users in DB (auth required)",
                user_count,
            )
        return None
    # Lock explicite sur la ligne User #1 pour la durée de la transaction.
    # `with_for_update()` est un no-op sur SQLite (tests) et effectif sur Pg.
    stmt = select(User).order_by(User.id).limit(1).with_for_update()
    row = await session.execute(stmt)
    user = row.scalar()
    return user.id if user else None


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


def get_provider_extras(provider_name: str, user_prov: dict | None) -> dict:
    """Return provider-specific kwargs to forward to ``get_provider()``.

    Some providers need more than just (api_key, base_url) — e.g. MiniMax
    requires a ``GroupId`` query param on every chat call. This helper keeps
    that quirk in one place so each call site doesn't have to know about it.
    """
    if not user_prov:
        return {}
    extras: dict = {}
    if provider_name == "minimax":
        gid = (user_prov.get("group_id") or "").strip()
        if gid:
            extras["group_id"] = gid
    return extras


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

    # No auth active (open mode / setup) → allow all
    if not user_id:
        return convo

    # Conversation has no owner (legacy) → allow
    if convo.user_id is None:
        return convo

    # Owner match
    if convo.user_id == user_id:
        return convo

    # Check admin
    user = await session.get(User, user_id)
    if user and user.is_admin:
        return convo

    return None  # Unauthorized


async def require_admin(request: Request, session: AsyncSession) -> bool:
    """Check if the current user is admin. Returns True or raises 403."""
    uid = getattr(request.state, "user_id", None)
    if uid is None:
        return True  # Open mode, no auth active
    user = await session.get(User, uid)
    if not user or not user.is_admin:
        return False
    return True
