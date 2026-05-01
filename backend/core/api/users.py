from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, or_
import hashlib
import re
import secrets
from datetime import datetime as _dt, timedelta as _td

from backend.core.db.models import User
from backend.core.db.engine import get_session
from backend.core.api.auth_helpers import require_admin
from backend.core.services import mail as mail_service

from slowapi import Limiter
from slowapi.util import get_remote_address
limiter = Limiter(key_func=get_remote_address)

EMAIL_RE = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")


def _normalize_email(raw: str) -> str:
    return (raw or "").strip().lower()


def _is_valid_email(value: str) -> bool:
    return bool(value and EMAIL_RE.match(value) and len(value) <= 255)

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
async def list_users(request: Request, session: AsyncSession = Depends(get_session)):
    """Liste les utilisateurs.

    Admin → voit tout le monde.
    Non-admin → ne voit que son propre compte (pas de fuite vers les autres).
    Mode ouvert (pas d'auth) → renvoie tout (legacy, setup-first-user flow).
    """
    uid = getattr(request.state, "user_id", None)

    if uid is None:
        # Open mode — no auth active. Needed for the initial "create first user"
        # flow before any token exists. Return everything as before.
        result = await session.execute(select(User).order_by(User.created_at))
        users = result.scalars().all()
    else:
        is_admin = await require_admin(request, session)
        if is_admin:
            result = await session.execute(select(User).order_by(User.created_at))
            users = result.scalars().all()
        else:
            # Non-admin: expose only the caller's own account.
            me = await session.get(User, uid)
            users = [me] if me else []

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
@limiter.limit("5/minute")
async def create_user(request: Request, session: AsyncSession = Depends(get_session)):
    """Crée un nouvel utilisateur.

    `email` est optionnel mais fortement recommandé : sans email vérifié,
    la récupération de mot de passe est désactivée. Si fourni, on envoie
    immédiatement un email de vérification (24h de validité)."""
    body = await request.json()
    username = body.get("username", "").strip()
    if not username:
        return JSONResponse({"error": "username requis"}, status_code=400)

    email_raw = _normalize_email(body.get("email", ""))
    if email_raw and not _is_valid_email(email_raw):
        return JSONResponse({"error": "Format d'email invalide"}, status_code=400)

    # Check unique username
    existing = await session.execute(select(User).where(User.username == username))
    if existing.scalars().first():
        return JSONResponse({"error": f"L'utilisateur '{username}' existe déjà"}, status_code=409)

    # Check unique email (si fourni)
    if email_raw:
        e = await session.execute(select(User).where(User.email == email_raw))
        if e.scalars().first():
            return JSONResponse({"error": "Cette adresse email est déjà utilisée"}, status_code=409)

    password_hash = None
    if body.get("password"):
        password_hash = _hash_password(body["password"])

    # First user ever created becomes admin automatically
    user_count = await session.execute(select(User))
    is_first_user = len(user_count.scalars().all()) == 0

    # Email verification token (si email fourni)
    verif_raw = None
    verif_hash = None
    verif_expires = None
    if email_raw:
        verif_raw = secrets.token_hex(32)
        verif_hash = _hash_token(verif_raw)
        verif_expires = _dt.utcnow() + _td(hours=24)

    user = User(
        username=username,
        display_name=body.get("display_name", username),
        password_hash=password_hash,
        avatar_url=body.get("avatar_url", ""),
        is_active=True,
        is_admin=is_first_user,
        email=email_raw or None,
        email_verified=False,
        email_verification_token=verif_hash,
        email_verification_expires_at=verif_expires,
    )
    session.add(user)
    await session.commit()
    await session.refresh(user)

    # Envoi du mail de vérif (best-effort, ne bloque pas la création).
    if email_raw and verif_raw:
        try:
            await mail_service.send_email_verification(
                to=email_raw, display_name=user.display_name or username, token=verif_raw,
            )
        except Exception as _e:
            import logging
            logging.getLogger("gungnir.users").warning(f"Email verif send failed for {email_raw}: {_e}")

    # Seed default skills, personalities, agents, automata, consciousness.
    # Each user gets their own copy of the basics at signup.
    try:
        from backend.core.services.user_bootstrap import seed_user_defaults
        await seed_user_defaults(session, user.id)
        await session.commit()
    except Exception as e:
        import logging
        logging.getLogger("gungnir.users").error(f"Bootstrap failed for user {user.id}: {e}")

    return {
        "id": user.id,
        "username": user.username,
        "display_name": user.display_name,
        "avatar_url": user.avatar_url,
        "is_active": user.is_active,
        "is_admin": bool(user.is_admin),
        "email": user.email,
        "email_verified": bool(user.email_verified),
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


@router.post("/users/{user_id}/impersonate")
async def impersonate_user(user_id: int, request: Request, session: AsyncSession = Depends(get_session)):
    """Admin-only: mint a fresh Bearer token for another user so an admin can
    actually test as them (onboarding flow, per-user isolation, etc.) instead
    of just cosmetically switching the UI while staying authenticated as
    themselves.

    Rotates the target user's ``api_token`` to a freshly generated value
    (the raw token is returned once; only its hash is stored). This means
    the target user will have to log in again if they were active elsewhere,
    which is acceptable for testing workflows.
    """
    uid = getattr(request.state, "user_id", None)
    if uid is not None:
        from backend.core.api.auth_helpers import require_admin
        if not await require_admin(request, session):
            return JSONResponse({"error": "Admin requis"}, status_code=403)

    target = await session.get(User, user_id)
    if not target:
        return JSONResponse({"error": "Utilisateur non trouvé"}, status_code=404)
    if not target.is_active:
        return JSONResponse({"error": "Utilisateur désactivé"}, status_code=400)

    raw_token = secrets.token_hex(32)
    target.api_token = _hash_token(raw_token)
    await session.commit()

    return {
        "ok": True,
        "token": raw_token,
        "user": {
            "id": target.id,
            "username": target.username,
            "display_name": target.display_name,
            "avatar_url": target.avatar_url,
            "is_admin": bool(target.is_admin),
        },
    }


async def _perform_user_delete(session: AsyncSession, user: User) -> dict:
    """Cascade-delete d'un user + toutes ses ressources (DB + fichiers +
    caches). Refuse si c'est le dernier admin actif. Utilisé à la fois par
    la route admin (DELETE /users/{id}) et la route self-delete (/users/me).
    """
    user_id = user.id
    if user.is_admin:
        admin_count_res = await session.execute(
            select(User).where(User.is_admin == True, User.is_active == True)  # noqa: E712
        )
        admin_count = len(admin_count_res.scalars().all())
        if admin_count <= 1:
            return {"_error": "Impossible de supprimer le dernier administrateur de l'instance", "_status": 400}

    # 1. Cascade delete every user-scoped row (reuses the backup helper).
    from backend.core.api.backup_routes import _delete_user_db, _wipe_user_files
    await _delete_user_db(session, user_id)

    # 2. Remove the user's own backup directory so their zips go with them.
    try:
        import shutil
        from backend.core.api.backup_routes import _user_backup_dir
        d = _user_backup_dir(user_id)
        if d.exists():
            shutil.rmtree(d, ignore_errors=True)
    except Exception:
        pass

    # 3. Delete the user row itself.
    await session.delete(user)
    await session.commit()

    # 4. Wipe the per-user filesystem tree (automata, consciousness,
    #    workspace, soul, kb, webhooks, integrations, code_configs…).
    _wipe_user_files(user_id)

    # 5. Evict per-user caches so nothing points at a ghost user.
    try:
        from backend.core.agents.mcp_client import mcp_manager as _mcp
        await _mcp.stop_user_servers(user_id)
    except Exception:
        pass
    try:
        from backend.core.plugin_registry import evict_consciousness
        evict_consciousness(user_id)
    except Exception:
        pass
    try:
        from backend.core.agents.mode_manager import mode_pool as _mp
        _mp._instances.pop(user_id, None)
    except Exception:
        pass

    return {"ok": True, "id": user_id}


@router.delete("/users/me")
async def delete_my_account(request: Request, session: AsyncSession = Depends(get_session)):
    """Self-delete : un utilisateur authentifié peut supprimer son propre
    compte (toutes ses données partent avec : conversations, skills, perso,
    sub-agents, channels, intégrations, conscience, KB, workspace…). Refuse
    si c'est le dernier admin pour ne pas verrouiller l'instance."""
    uid = getattr(request.state, "user_id", None)
    if not uid:
        return JSONResponse({"error": "Non authentifié"}, status_code=401)
    user = await session.get(User, int(uid))
    if not user:
        return JSONResponse({"error": "Utilisateur introuvable"}, status_code=404)
    try:
        result = await _perform_user_delete(session, user)
        if "_error" in result:
            return JSONResponse({"error": result["_error"]}, status_code=result.get("_status", 400))
        return result
    except Exception as e:
        import logging
        logging.getLogger("gungnir").error(f"Self-delete failed for uid={uid}: {e}", exc_info=True)
        try:
            await session.rollback()
        except Exception:
            pass
        return JSONResponse(
            {"error": f"Erreur lors de la suppression de votre compte: {str(e)[:200]}"},
            status_code=500,
        )


@router.delete("/users/{user_id}")
async def delete_user(user_id: int, request: Request, session: AsyncSession = Depends(get_session)):
    """Hard-delete a user and every row/file scoped to them.

    Admin-only. Refuses to delete the last remaining admin so the instance
    never ends up locked out. The heavy lifting (cascade delete across the
    14 user-scoped tables + wipe of the per-user filesystem dirs + per-user
    cache eviction) reuses the same helpers used by the backup restore flow.
    """
    uid = getattr(request.state, "user_id", None)
    if uid is not None:
        from backend.core.api.auth_helpers import require_admin
        if not await require_admin(request, session):
            return JSONResponse({"error": "Admin requis"}, status_code=403)

    user = await session.get(User, user_id)
    if not user:
        return JSONResponse({"error": "Utilisateur non trouvé"}, status_code=404)

    try:
        result = await _perform_user_delete(session, user)
        if "_error" in result:
            return JSONResponse({"error": result["_error"]}, status_code=result.get("_status", 400))
        return result
    except Exception as e:
        import logging
        logging.getLogger("gungnir").error(f"User delete failed for uid={user_id}: {e}", exc_info=True)
        try:
            await session.rollback()
        except Exception:
            pass
        return JSONResponse(
            {"error": f"Erreur lors de la suppression de l'utilisateur: {str(e)[:200]}"},
            status_code=500,
        )


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
            "email": user.email,
            "email_verified": bool(user.email_verified),
            "pending_email": user.pending_email,
        }
    }


@router.post("/users/login")
@limiter.limit("5/minute")
async def login_user(request: Request, session: AsyncSession = Depends(get_session)):
    """Vérifie les identifiants d'un utilisateur.

    Accepte au choix `email` ou `username` (option B hybride). Si les deux
    sont fournis, `email` prime. Le matching email est case-insensitive.
    """
    body = await request.json()
    email_raw = _normalize_email(body.get("email", ""))
    username = body.get("username", "").strip()
    password = body.get("password", "")

    if not email_raw and not username:
        return JSONResponse({"error": "Email ou nom d'utilisateur requis"}, status_code=400)

    if email_raw:
        result = await session.execute(select(User).where(User.email == email_raw))
    else:
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
    # Expiration 30j (fix sécu M1). L'utilisateur devra se reconnecter après.
    raw_token = secrets.token_hex(32)
    user.api_token = _hash_token(raw_token)
    user.token_expires_at = _dt.utcnow() + _td(days=30)
    await session.commit()

    return {
        "ok": True,
        "token": raw_token,
        "expires_at": user.token_expires_at.isoformat() + "Z",
        "user": {
            "id": user.id,
            "username": user.username,
            "display_name": user.display_name,
            "avatar_url": user.avatar_url,
            "is_admin": bool(user.is_admin),
            "email": user.email,
            "email_verified": bool(user.email_verified),
        }
    }


@router.post("/users/logout")
async def logout_user(request: Request, session: AsyncSession = Depends(get_session)):
    """Révoque le token de la session courante côté serveur (fix sécu M1).
    Sans ça, un token volé restait valide jusqu'à son expiration naturelle."""
    uid = getattr(request.state, "user_id", None)
    if not uid:
        return {"ok": True}  # Déjà logout
    result = await session.execute(select(User).where(User.id == uid))
    user = result.scalar()
    if user:
        user.api_token = None
        user.token_expires_at = None
        await session.commit()
    return {"ok": True}


@router.post("/users/refresh-token")
async def refresh_token(request: Request, session: AsyncSession = Depends(get_session)):
    """Prolonge la session : rotate le token + nouvelle expiration 30j.
    L'appelant doit présenter un token encore valide (middleware auth)."""
    uid = getattr(request.state, "user_id", None)
    if not uid:
        return JSONResponse({"error": "Non authentifié"}, status_code=401)
    result = await session.execute(select(User).where(User.id == uid))
    user = result.scalar()
    if not user:
        return JSONResponse({"error": "Utilisateur introuvable"}, status_code=404)
    from datetime import datetime as _dt, timedelta as _td
    raw_token = secrets.token_hex(32)
    user.api_token = _hash_token(raw_token)
    user.token_expires_at = _dt.utcnow() + _td(days=30)
    await session.commit()
    return {
        "ok": True,
        "token": raw_token,
        "expires_at": user.token_expires_at.isoformat() + "Z",
    }


# ── Email verification + password reset ─────────────────────────────────────


@router.post("/users/forgot-password")
@limiter.limit("3/minute")
async def forgot_password(request: Request, session: AsyncSession = Depends(get_session)):
    """Déclenche un email de récupération si l'adresse correspond à un compte
    avec email vérifié.

    Réponses :
    - Toujours 200 OK avec ``{ok: true}`` pour ne pas révéler l'existence
      ou non d'un compte (anti-enumeration).
    - L'email n'est envoyé que si ``email_verified == true`` — sinon un
      attaquant pourrait créer un compte avec l'adresse d'une victime
      (sans la confirmer) et déclencher un reset sur ce faux compte.
    """
    body = await request.json()
    email_raw = _normalize_email(body.get("email", ""))
    if not _is_valid_email(email_raw):
        return {"ok": True}

    result = await session.execute(select(User).where(User.email == email_raw))
    user = result.scalars().first()

    if user and user.email_verified and user.is_active:
        raw_token = secrets.token_hex(32)
        user.password_reset_token = _hash_token(raw_token)
        user.password_reset_expires_at = _dt.utcnow() + _td(hours=1)
        await session.commit()
        try:
            await mail_service.send_password_reset(
                to=email_raw,
                display_name=user.display_name or user.username,
                token=raw_token,
            )
        except Exception as e:
            import logging
            logging.getLogger("gungnir.users").warning(f"Password reset mail failed for {email_raw}: {e}")

    return {"ok": True}


@router.post("/users/reset-password")
@limiter.limit("5/minute")
async def reset_password(request: Request, session: AsyncSession = Depends(get_session)):
    """Consomme un token de reset + définit un nouveau mot de passe.

    Le token est invalidé après usage et tous les Bearer tokens du user
    sont rotatés (force la reconnexion des sessions actives).
    """
    body = await request.json()
    token = (body.get("token") or "").strip()
    new_password = body.get("password", "")
    if not token or not new_password:
        return JSONResponse({"error": "Token et nouveau mot de passe requis"}, status_code=400)
    if len(new_password) < 8:
        return JSONResponse({"error": "Mot de passe trop court (minimum 8 caractères)"}, status_code=400)

    token_hash = _hash_token(token)
    result = await session.execute(
        select(User).where(User.password_reset_token == token_hash)
    )
    user = result.scalars().first()
    if not user or not user.password_reset_expires_at or user.password_reset_expires_at < _dt.utcnow():
        return JSONResponse({"error": "Lien invalide ou expiré"}, status_code=400)

    user.password_hash = _hash_password(new_password)
    user.password_reset_token = None
    user.password_reset_expires_at = None
    # Invalide la session courante — le user devra se reconnecter avec son
    # nouveau mot de passe (et tout token volé devient inutile).
    user.api_token = None
    user.token_expires_at = None
    await session.commit()
    return {"ok": True}


@router.post("/users/verify-email")
@limiter.limit("10/minute")
async def verify_email(request: Request, session: AsyncSession = Depends(get_session)):
    """Confirme une adresse email à partir du token reçu par mail.

    Couvre 2 cas :
    1. Vérification initiale à la création de compte → marque
       ``email_verified = true``.
    2. Confirmation d'un changement d'email (``pending_email`` set) →
       remplace ``email`` par ``pending_email`` puis vide ``pending_email``.
    """
    body = await request.json()
    token = (body.get("token") or "").strip()
    if not token:
        return JSONResponse({"error": "Token requis"}, status_code=400)

    token_hash = _hash_token(token)
    result = await session.execute(
        select(User).where(User.email_verification_token == token_hash)
    )
    user = result.scalars().first()
    if not user or not user.email_verification_expires_at or user.email_verification_expires_at < _dt.utcnow():
        return JSONResponse({"error": "Lien invalide ou expiré"}, status_code=400)

    if user.pending_email:
        # Re-check unicité au moment de la commit (un autre user a pu
        # prendre l'adresse entre l'envoi et la confirm).
        existing = await session.execute(
            select(User).where(User.email == user.pending_email, User.id != user.id)
        )
        if existing.scalars().first():
            user.pending_email = None
            user.email_verification_token = None
            user.email_verification_expires_at = None
            await session.commit()
            return JSONResponse({"error": "Cette adresse email est déjà utilisée par un autre compte"}, status_code=409)
        user.email = user.pending_email
        user.pending_email = None
        user.email_verified = True
    else:
        user.email_verified = True

    user.email_verification_token = None
    user.email_verification_expires_at = None
    await session.commit()
    return {
        "ok": True,
        "email": user.email,
        "email_verified": True,
    }


@router.post("/users/me/email")
@limiter.limit("3/minute")
async def change_email(request: Request, session: AsyncSession = Depends(get_session)):
    """Démarre le flow de changement d'email pour le user courant.

    L'email actuel reste actif tant que le nouveau n'est pas confirmé via
    le lien reçu par mail (``pending_email`` est utilisé pour stocker
    l'adresse en attente). Anti-hijack : si quelqu'un vole une session,
    il ne peut pas remplacer l'email sans accès à la nouvelle boîte.
    """
    uid = getattr(request.state, "user_id", None)
    if not uid:
        return JSONResponse({"error": "Non authentifié"}, status_code=401)

    body = await request.json()
    new_email = _normalize_email(body.get("email", ""))
    if not _is_valid_email(new_email):
        return JSONResponse({"error": "Format d'email invalide"}, status_code=400)

    user = await session.get(User, uid)
    if not user:
        return JSONResponse({"error": "Utilisateur introuvable"}, status_code=404)

    if user.email and user.email == new_email and user.email_verified:
        return JSONResponse({"error": "C'est déjà ton adresse actuelle"}, status_code=400)

    # Unicité : pas un autre user
    existing = await session.execute(
        select(User).where(User.email == new_email, User.id != user.id)
    )
    if existing.scalars().first():
        return JSONResponse({"error": "Cette adresse email est déjà utilisée"}, status_code=409)

    raw_token = secrets.token_hex(32)
    user.email_verification_token = _hash_token(raw_token)
    user.email_verification_expires_at = _dt.utcnow() + _td(hours=24)

    # Si le user n'avait pas encore d'email vérifié, on remplace direct
    # (premier email du compte). Sinon on stocke en pending pour ne valider
    # qu'après clic sur le lien.
    if not user.email or not user.email_verified:
        user.email = new_email
        user.pending_email = None
        user.email_verified = False
    else:
        user.pending_email = new_email

    await session.commit()
    try:
        await mail_service.send_email_verification(
            to=new_email,
            display_name=user.display_name or user.username,
            token=raw_token,
        )
    except Exception as e:
        import logging
        logging.getLogger("gungnir.users").warning(f"Email verif send failed for {new_email}: {e}")

    return {
        "ok": True,
        "email": user.email,
        "pending_email": user.pending_email,
        "email_verified": bool(user.email_verified),
    }


@router.post("/users/me/resend-verification")
@limiter.limit("3/minute")
async def resend_verification(request: Request, session: AsyncSession = Depends(get_session)):
    """Renvoie un mail de vérification pour l'email en cours (pending_email
    s'il existe, sinon email actuel s'il n'est pas encore vérifié)."""
    uid = getattr(request.state, "user_id", None)
    if not uid:
        return JSONResponse({"error": "Non authentifié"}, status_code=401)
    user = await session.get(User, uid)
    if not user:
        return JSONResponse({"error": "Utilisateur introuvable"}, status_code=404)

    target = user.pending_email or (user.email if not user.email_verified else None)
    if not target:
        return JSONResponse({"error": "Aucun email à vérifier"}, status_code=400)

    raw_token = secrets.token_hex(32)
    user.email_verification_token = _hash_token(raw_token)
    user.email_verification_expires_at = _dt.utcnow() + _td(hours=24)
    await session.commit()

    try:
        await mail_service.send_email_verification(
            to=target,
            display_name=user.display_name or user.username,
            token=raw_token,
        )
    except Exception as e:
        import logging
        logging.getLogger("gungnir.users").warning(f"Email verif resend failed for {target}: {e}")

    return {"ok": True}
