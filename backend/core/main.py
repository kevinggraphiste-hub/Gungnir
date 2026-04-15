"""
Gungnir — Main FastAPI application

Core app with dynamic plugin loading.
"""
import sys
import asyncio
import hashlib
import logging
from pathlib import Path
from contextlib import asynccontextmanager

# Ensure project root is on sys.path
PROJECT_ROOT = Path(__file__).parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse

from backend.core.db.engine import engine, DATABASE_URL
from backend.core.db.models import init_db
from backend.core.config.settings import PLUGINS_DIR, Settings
from backend.core.services.plugin_loader import (
    discover_plugins, mount_plugin_routes, call_plugin_lifecycle,
)

# ── Logging ──────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
)
logger = logging.getLogger("gungnir")

# ── Plugin state ─────────────────────────────────────────────────────────────
_loaded_plugins = []


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup and shutdown lifecycle."""
    # 1. Initialize database
    logger.info("Initializing database...")
    await init_db(engine)

    # 1b. Auto-migrations
    try:
        from sqlalchemy import text
        async with engine.begin() as conn:
            _is_pg = "postgresql" in DATABASE_URL or "asyncpg" in DATABASE_URL

            # Helper to check if column exists
            async def _has_col(table: str, column: str) -> bool:
                if _is_pg:
                    r = await conn.execute(text(
                        f"SELECT column_name FROM information_schema.columns "
                        f"WHERE table_name = '{table}' AND column_name = '{column}'"
                    ))
                    return r.fetchone() is not None
                else:
                    r = await conn.execute(text(f"PRAGMA table_info({table})"))
                    return column in [row[1] for row in r.fetchall()]

            # Migration: api_token on users
            if not await _has_col("users", "api_token"):
                await conn.execute(text("ALTER TABLE users ADD COLUMN api_token VARCHAR(128)"))
                logger.info("Migration: added api_token column to users")

            # Migration: is_admin on users
            if not await _has_col("users", "is_admin"):
                await conn.execute(text("ALTER TABLE users ADD COLUMN is_admin BOOLEAN DEFAULT FALSE"))
                # Set first user (id=1) as admin
                await conn.execute(text("UPDATE users SET is_admin = TRUE WHERE id = 1"))
                logger.info("Migration: added is_admin column, user #1 set as admin")

    except Exception as e:
        logger.warning(f"Migration check skipped: {e}")

    # 2. Reload data singletons (skills, personalities, sub-agents)
    from backend.core.agents.skills import skill_library, personality_manager, subagent_library
    skill_library.skills.clear()
    skill_library._load()
    personality_manager.personalities.clear()
    personality_manager._load()
    subagent_library.agents.clear()
    subagent_library._load()

    # 3. Call plugin on_startup hooks
    for manifest in _loaded_plugins:
        try:
            await call_plugin_lifecycle(manifest, "on_startup", app=app)
        except Exception as _plugin_err:
            import logging
            logging.getLogger("gungnir").error(f"Plugin {getattr(manifest, 'name', '?')} startup failed: {_plugin_err}")

    # 4a. Provider-keys one-shot migration: move any api_key stored in the
    # legacy global settings.providers[*] into user #1's UserSettings so the
    # global JSON never acts as a cross-user fallback again. Idempotent.
    try:
        from sqlalchemy import select as _select_keys
        from backend.core.db.engine import get_session as _get_session_keys
        from backend.core.db.models import User as _User_keys, UserSettings as _US_keys
        from backend.core.config.settings import encrypt_value as _enc_keys

        settings_keys = Settings.load()
        legacy_keys: dict[str, dict] = {}
        for pname, pconf in (settings_keys.providers or {}).items():
            if pconf and pconf.api_key:
                legacy_keys[pname] = {
                    "api_key": pconf.api_key,
                    "base_url": pconf.base_url,
                    "enabled": True,
                }

        if legacy_keys:
            async for _ks in _get_session_keys():
                _target = await _ks.execute(_select_keys(_User_keys).order_by(_User_keys.id).limit(1))
                _owner_k = _target.scalar()
                if _owner_k is None:
                    logger.info("Provider-keys legacy migration skipped: no users yet")
                    break

                _us_row = await _ks.execute(
                    _select_keys(_US_keys).where(_US_keys.user_id == _owner_k.id)
                )
                _us = _us_row.scalar_one_or_none()
                if _us is None:
                    _us = _US_keys(user_id=_owner_k.id, provider_keys={}, service_keys={})
                    _ks.add(_us)
                    await _ks.flush()

                existing = dict(_us.provider_keys or {})
                added = 0
                for pname, payload in legacy_keys.items():
                    if pname in existing and existing[pname].get("api_key"):
                        continue  # User already has their own key for this provider
                    existing[pname] = {
                        "api_key": _enc_keys(payload["api_key"]),
                        "base_url": payload.get("base_url"),
                        "enabled": True,
                    }
                    added += 1
                _us.provider_keys = existing
                await _ks.commit()

                if added:
                    # Clear global api_keys so the cross-user fallback is gone for good
                    for pname in legacy_keys.keys():
                        if settings_keys.providers.get(pname):
                            settings_keys.providers[pname].api_key = None
                    settings_keys.save()
                    logger.info(
                        f"Provider-keys legacy migration: {added} key(s) moved to user #{_owner_k.id} "
                        f"({', '.join(legacy_keys.keys())})"
                    )
                break
    except Exception as e:
        logger.warning(f"Provider-keys legacy migration failed: {e}")

    # 4b. MCP one-shot migration: move legacy global settings.mcp_servers to
    # per-user DB rows under user #1, then clear the legacy field. Servers are
    # started lazily on first use (chat/scheduler/webhooks), not at boot.
    from backend.core.agents.mcp_client import mcp_manager  # imported for shutdown hook
    try:
        settings = Settings.load()
        legacy_servers = list(settings.mcp_servers or [])
        if legacy_servers:
            from sqlalchemy import select as _select
            from backend.core.db.engine import get_session as _get_session
            from backend.core.db.models import MCPServerConfig as _DBMCP, User as _User
            from backend.core.config.settings import encrypt_value as _enc

            async for _session in _get_session():
                # Pick user #1 as the owner (the admin / historical single user).
                # If no user exists yet (fresh install), skip — nothing to migrate to.
                _target = await _session.execute(_select(_User).order_by(_User.id).limit(1))
                _owner = _target.scalar()
                if _owner is None:
                    logger.info("MCP legacy migration skipped: no users yet")
                    break

                migrated = 0
                for s in legacy_servers:
                    # Idempotency: skip if an entry with this name already exists for the owner
                    existing = await _session.execute(
                        _select(_DBMCP).where(
                            _DBMCP.user_id == _owner.id,
                            _DBMCP.name == s.name,
                        )
                    )
                    if existing.scalar():
                        continue
                    env_to_store = {}
                    for k, v in (s.env or {}).items():
                        if isinstance(v, str) and v and any(t in k.lower() for t in ("key", "secret", "token", "password")) and not v.startswith(("FERNET:", "enc:")):
                            env_to_store[k] = _enc(v)
                        else:
                            env_to_store[k] = v
                    _session.add(_DBMCP(
                        user_id=_owner.id,
                        name=s.name,
                        command=s.command,
                        args_json=list(s.args or []),
                        env_json=env_to_store,
                        enabled=s.enabled,
                    ))
                    migrated += 1
                await _session.commit()

                if migrated:
                    # Clear the legacy field so we never migrate again
                    settings.mcp_servers = []
                    settings.save()
                    logger.info(f"MCP legacy migration: {migrated} server(s) moved to user #{_owner.id}")
                break
    except Exception as e:
        logger.warning(f"MCP legacy migration failed: {e}")

    # 5. Start auto-backup scheduler
    auto_backup_task = asyncio.create_task(_auto_backup_loop())

    # 6. Start the heartbeat master scanner loop (always — it's a base service).
    # The loop is cheap and per-user logic is handled internally: each user's
    # config decides whether they actually beat. _autostart_scan flips
    # enabled=true for any user that has on_startup=true so they resume
    # automatically after a server restart.
    try:
        from backend.core.api.heartbeat_routes import _ensure_loop as _hb_start, _autostart_scan
        info = _autostart_scan()
        _hb_start()
        if info.get("config", {}).get("on_startup"):
            logger.info("Heartbeat master loop started — at least one user has on_startup=true")
        else:
            logger.info("Heartbeat master loop started — idle (no users enabled at boot)")
    except Exception as e:
        logger.warning(f"Heartbeat master loop start failed: {e}")

    logger.info(
        f"Gungnir started — {len(_loaded_plugins)} plugins loaded: "
        f"{', '.join(p.name for p in _loaded_plugins)}"
    )

    yield

    # Shutdown
    auto_backup_task.cancel()
    await mcp_manager.stop_all()
    for manifest in _loaded_plugins:
        await call_plugin_lifecycle(manifest, "on_shutdown")
    logger.info("Gungnir stopped.")


async def _auto_backup_loop():
    """Background loop: runs daily backup at midnight if enabled."""
    from backend.core.api.backup_routes import _load_config, BACKUPS_DIR, BACKUP_TARGETS, PROJECT_ROOT, _enforce_max_backups
    import zipfile
    from datetime import datetime, timedelta

    while True:
        try:
            now = datetime.now()
            next_midnight = (now + timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)
            wait_seconds = (next_midnight - now).total_seconds()
            logger.info(f"Auto-backup: next check at midnight ({int(wait_seconds)}s)")
        except Exception:
            wait_seconds = 3600

        await asyncio.sleep(wait_seconds)

        try:
            cfg = _load_config()
            if not cfg.get("auto_daily"):
                continue

            BACKUPS_DIR.mkdir(parents=True, exist_ok=True)
            timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
            filename = f"gungnir_backup_{timestamp}.zip"
            zip_path = BACKUPS_DIR / filename
            with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
                for target in BACKUP_TARGETS:
                    if target.exists():
                        zf.write(target, str(target.relative_to(PROJECT_ROOT)))
            _enforce_max_backups(cfg.get("max_backups", 10))
            logger.info(f"Auto-backup created at midnight: {filename}")
        except Exception as e:
            logger.warning(f"Auto-backup error: {e}")


# ── App ──────────────────────────────────────────────────────────────────────
app = FastAPI(title="Gungnir API", version="2.1.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://localhost:8000",
        "http://127.0.0.1:5173",
        "http://127.0.0.1:8000",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Rate limiting ────────────────────────────────────────────────────────────
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.util import get_remote_address
from slowapi.errors import RateLimitExceeded


def _rate_limit_key(request):
    """Use authenticated user_id as rate limit key, fallback to IP."""
    uid = getattr(getattr(request, "state", None), "user_id", None)
    if uid:
        return f"user:{uid}"
    return get_remote_address(request)


limiter = Limiter(key_func=_rate_limit_key, default_limits=["300/minute"])
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)


@app.middleware("http")
async def security_headers(request, call_next):
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["X-XSS-Protection"] = "1; mode=block"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    return response


# ── Token auth middleware ───────────────────────────────────────────────────
# Routes that don't require authentication
PUBLIC_PATHS = {
    "/api/health", "/api/doctor", "/api/users/login", "/api/users/me", "/api/plugins/status",
}
PUBLIC_PREFIXES = (
    "/api/webhook/",                        # Incoming webhooks have their own auth
    "/api/plugins/channels/webhook/",       # Channel webhooks (Telegram, Discord, Slack, WhatsApp)
    "/api/plugins/channels/incoming/",      # Channel incoming messages (API channels with own auth)
    "/assets/", "/static/", "/favicon",
)


@app.middleware("http")
async def token_auth_middleware(request, call_next):
    """Optional token auth: active only when users with tokens exist."""
    from starlette.requests import Request as StarletteRequest

    path = request.url.path

    # Always allow public routes, OPTIONS (CORS preflight), and static files
    if request.method == "OPTIONS":
        return await call_next(request)
    if path in PUBLIC_PATHS:
        return await call_next(request)
    for prefix in PUBLIC_PREFIXES:
        if path.startswith(prefix):
            return await call_next(request)
    # Allow creating users (POST /api/users) without auth for initial setup
    if path == "/api/users" and request.method == "POST":
        return await call_next(request)
    if not path.startswith("/api/"):
        return await call_next(request)

    # Check if auth is enabled (at least one user has a token)
    try:
        from backend.core.db.engine import get_session as _get_session
        from backend.core.db.models import User
        from sqlalchemy import select
        async for session in _get_session():
            result = await session.execute(
                select(User.api_token).where(User.api_token.isnot(None)).limit(1)
            )
            has_tokens = result.scalar() is not None
            if not has_tokens:
                # No user has logged in yet — open mode (setup)
                return await call_next(request)

            # Auth is active — verify Bearer token
            auth_header = request.headers.get("Authorization", "")
            if not auth_header.startswith("Bearer "):
                return JSONResponse({"error": "Token requis (Authorization: Bearer <token>)"}, status_code=401)
            token = auth_header[7:]
            token_hash = hashlib.sha256(token.encode()).hexdigest()
            result = await session.execute(
                select(User).where(User.api_token == token_hash, User.is_active == True)
            )
            user = result.scalar()
            if not user:
                return JSONResponse({"error": "Token invalide ou utilisateur désactivé"}, status_code=401)
            # Inject user info into request state for downstream use
            request.state.user_id = user.id
            request.state.username = user.username
            return await call_next(request)
    except Exception as e:
        logger.warning(f"Auth middleware error (denying request): {e}")
        return JSONResponse({"error": "Service d'authentification indisponible"}, status_code=503)

# ── Core API routes ──────────────────────────────────────────────────────────
from backend.core.api.router import core_router
app.include_router(core_router, prefix="/api")

# ── Discover and mount plugins at module level (before catch-all) ────────────
logger.info("Discovering plugins...")
_manifests = discover_plugins(PLUGINS_DIR)
for _manifest in _manifests:
    if _manifest.enabled_by_default:
        if mount_plugin_routes(app, _manifest):
            _loaded_plugins.append(_manifest)


# ── Plugin status endpoint ───────────────────────────────────────────────────
@app.get("/api/plugins/status")
async def plugins_status():
    """List all loaded plugins and their status."""
    return {
        "plugins": [
            {
                "name": p.name,
                "display_name": p.display_name,
                "version": p.version,
                "icon": p.icon,
                "route": p.route,
                "sidebar_position": p.sidebar_position,
                "sidebar_section": p.sidebar_section,
                "enabled": True,
            }
            for p in _loaded_plugins
        ]
    }


# ── Frontend SPA serving (middleware — never conflicts with API routes) ──────
frontend_dist = PROJECT_ROOT / "frontend" / "dist"

if frontend_dist.exists():
    from starlette.middleware.base import BaseHTTPMiddleware
    from starlette.requests import Request
    from starlette.responses import Response

    class SPAMiddleware(BaseHTTPMiddleware):
        """Serves SPA files for non-API routes. API routes pass through."""
        async def dispatch(self, request: Request, call_next) -> Response:
            path = request.url.path

            # Let API routes pass through to FastAPI router
            if path.startswith("/api"):
                return await call_next(request)

            # Serve static assets
            if path == "/logo.png":
                logo_path = (frontend_dist / "logo.png").resolve()
                if not str(logo_path).startswith(str(frontend_dist.resolve())):
                    return Response(status_code=403)
                if logo_path.exists():
                    return FileResponse(str(logo_path))

            if path.startswith("/assets/"):
                file_path = (frontend_dist / path.lstrip("/")).resolve()
                if not str(file_path).startswith(str(frontend_dist.resolve())):
                    return Response(status_code=403)
                if file_path.exists() and file_path.is_file():
                    return FileResponse(str(file_path))

            # Serve actual files from dist
            if path != "/":
                file_path = (frontend_dist / path.lstrip("/")).resolve()
                if not str(file_path).startswith(str(frontend_dist.resolve())):
                    return Response(status_code=403)
                if file_path.exists() and file_path.is_file():
                    return FileResponse(str(file_path))

            # SPA fallback
            return FileResponse(str(frontend_dist / "index.html"))

    app.add_middleware(SPAMiddleware)


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
