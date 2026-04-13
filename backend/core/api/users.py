from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
import hashlib
import secrets

from backend.core.db.models import User
from backend.core.db.engine import get_session

from slowapi import Limiter
from slowapi.util import get_remote_address
limiter = Limiter(key_func=get_remote_address)

router = APIRouter()


def _hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def _hash_password(password: str) -> str:
    salt = secrets.token_hex(16)
    dk = hashlib.pbkdf2_hmac('sha256', password.encode(), salt.encode(), 200_000)
    return f"pbkdf2:{salt}:{dk.hex()}"


def _verify_password(password: str, hashed: str) -> bool:
    if hashed.startswith("pbkdf2:"):
        _, salt, expected = hashed.split(":", 2)
        dk = hashlib.pbkdf2_hmac('sha256', password.encode(), salt.encode(), 200_000)
        return secrets.compare_digest(dk.hex(), expected)
    # Fallback: old SHA256 hashes for migration (constant-time compare)
    return secrets.compare_digest(hashlib.sha256(password.encode()).hexdigest(), hashed)


@router.get("/users")
async def list_users(session: AsyncSession = Depends(get_session)):
    """Liste tous les utilisateurs."""
    result = await session.execute(select(User).order_by(User.created_at))
    users = result.scalars().all()
    return [
        {
            "id": u.id,
            "username": u.username,
            "display_name": u.display_name,
            "avatar_url": u.avatar_url,
            "is_active": u.is_active,
            "created_at": u.created_at.isoformat() if u.created_at else None,
        }
        for u in users
    ]


@router.post("/users")
async def create_user(request: Request, session: AsyncSession = Depends(get_session)):
    """Crée un nouvel utilisateur."""
    body = await request.json()
    username = body.get("username", "").strip()
    if not username:
        return JSONResponse({"error": "username requis"}, status_code=400)

    # Check unique
    existing = await session.execute(select(User).where(User.username == username))
    if existing.scalars().first():
        return JSONResponse({"error": f"L'utilisateur '{username}' existe déjà"}, status_code=409)

    password_hash = None
    if body.get("password"):
        password_hash = _hash_password(body["password"])

    # First user ever created becomes admin automatically
    user_count = await session.execute(select(User))
    is_first_user = len(user_count.scalars().all()) == 0

    user = User(
        username=username,
        display_name=body.get("display_name", username),
        password_hash=password_hash,
        avatar_url=body.get("avatar_url", ""),
        is_active=True,
        is_admin=is_first_user,
    )
    session.add(user)
    await session.commit()
    await session.refresh(user)
    return {
        "id": user.id,
        "username": user.username,
        "display_name": user.display_name,
        "avatar_url": user.avatar_url,
        "is_active": user.is_active,
        "is_admin": bool(user.is_admin),
    }


@router.put("/users/{user_id}")
async def update_user(user_id: int, request: Request, session: AsyncSession = Depends(get_session)):
    """Met à jour un utilisateur."""
    # Only allow if request user == target user OR request user is admin
    uid = getattr(request.state, "user_id", None)
    if uid is not None and uid != user_id:
        from backend.core.api.auth_helpers import require_admin
        if not await require_admin(request, session):
            return JSONResponse({"error": "Admin requis"}, status_code=403)

    user = await session.get(User, user_id)
    if not user:
        return JSONResponse({"error": "Utilisateur non trouvé"}, status_code=404)

    body = await request.json()
    if "display_name" in body:
        user.display_name = body["display_name"]
    if "avatar_url" in body:
        user.avatar_url = body["avatar_url"]
    if "password" in body and body["password"]:
        user.password_hash = _hash_password(body["password"])
    if "is_active" in body:
        user.is_active = body["is_active"]

    await session.commit()
    return {"ok": True, "id": user.id, "display_name": user.display_name}


@router.delete("/users/{user_id}")
async def delete_user(user_id: int, request: Request, session: AsyncSession = Depends(get_session)):
    """Supprime un utilisateur. Admin only."""
    uid = getattr(request.state, "user_id", None)
    if uid is not None:
        from backend.core.api.auth_helpers import require_admin
        if not await require_admin(request, session):
            return JSONResponse({"error": "Admin requis"}, status_code=403)

    user = await session.get(User, user_id)
    if not user:
        return JSONResponse({"error": "Utilisateur non trouvé"}, status_code=404)
    await session.delete(user)
    await session.commit()
    return {"ok": True}


@router.get("/users/me")
async def get_current_user(request: Request, session: AsyncSession = Depends(get_session)):
    """Renvoie l'utilisateur courant à partir du Bearer token."""
    auth_header = request.headers.get("Authorization", "")
    if not auth_header.startswith("Bearer "):
        return JSONResponse({"error": "Non authentifié"}, status_code=401)
    token = auth_header[7:]
    token_hash = _hash_token(token)
    result = await session.execute(select(User).where(User.api_token == token_hash, User.is_active == True))
    user = result.scalars().first()
    if not user:
        return JSONResponse({"error": "Token invalide"}, status_code=401)
    return {
        "ok": True,
        "user": {
            "id": user.id,
            "username": user.username,
            "display_name": user.display_name,
            "avatar_url": user.avatar_url,
            "is_admin": bool(user.is_admin),
        }
    }


@router.post("/users/login")
@limiter.limit("10/minute")
async def login_user(request: Request, session: AsyncSession = Depends(get_session)):
    """Vérifie les identifiants d'un utilisateur."""
    body = await request.json()
    username = body.get("username", "").strip()
    password = body.get("password", "")

    result = await session.execute(select(User).where(User.username == username))
    user = result.scalars().first()

    if not user:
        return JSONResponse({"error": "Identifiants invalides"}, status_code=401)

    if user.password_hash:
        if not _verify_password(password, user.password_hash):
            return JSONResponse({"error": "Identifiants invalides"}, status_code=401)
    else:
        # Compte sans mot de passe : accepter seulement si aucun password fourni
        if password:
            return JSONResponse({"error": "Ce compte n'utilise pas de mot de passe"}, status_code=400)
        # Passwordless login is allowed — this is the simple mode for small installs.
        # Users are encouraged to set a password in Settings for better security.

    # Toujours générer un nouveau token (rotation — invalide les anciennes sessions)
    raw_token = secrets.token_hex(32)
    user.api_token = _hash_token(raw_token)
    await session.commit()

    return {
        "ok": True,
        "token": raw_token,
        "user": {
            "id": user.id,
            "username": user.username,
            "display_name": user.display_name,
            "avatar_url": user.avatar_url,
            "is_admin": bool(user.is_admin),
        }
    }
