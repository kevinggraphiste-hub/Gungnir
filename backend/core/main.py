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

            # Migration: user_id on cost_analytics / budget_settings / provider_budgets
            if not await _has_col("cost_analytics", "user_id"):
                await conn.execute(text("ALTER TABLE cost_analytics ADD COLUMN user_id INTEGER"))
                # Backfill from conversations
                await conn.execute(text(
                    "UPDATE cost_analytics SET user_id = ("
                    " SELECT user_id FROM conversations WHERE conversations.id = cost_analytics.conversation_id"
                    ") WHERE user_id IS NULL"
                ))
                logger.info("Migration: added user_id column to cost_analytics (backfilled from conversations)")
            if not await _has_col("budget_settings", "user_id"):
                await conn.execute(text("ALTER TABLE budget_settings ADD COLUMN user_id INTEGER"))
                await conn.execute(text("UPDATE budget_settings SET user_id = 1 WHERE user_id IS NULL"))
                logger.info("Migration: added user_id column to budget_settings (assigned to user #1)")
            if not await _has_col("provider_budgets", "user_id"):
                await conn.execute(text("ALTER TABLE provider_budgets ADD COLUMN user_id INTEGER"))
                await conn.execute(text("UPDATE provider_budgets SET user_id = 1 WHERE user_id IS NULL"))
                logger.info("Migration: added user_id column to provider_budgets (assigned to user #1)")

            # Drop the legacy single-column unique constraint on provider_budgets.provider
            # (uniqueness is now enforced per (user_id, provider) at the application layer).
            if _is_pg:
                try:
                    await conn.execute(text(
                        "ALTER TABLE provider_budgets DROP CONSTRAINT IF EXISTS provider_budgets_provider_key"
                    ))
                except Exception as _drop_err:
                    logger.debug(f"Drop provider_budgets_provider_key constraint: {_drop_err}")

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

    # 4y. Legacy backup zips one-shot migration: move any pre-refactor zip
    # stored directly under data/backups/ into data/backups/_admin/ so it
    # still shows up in the admin history after the per-user refactor.
    # Idempotent: once moved, there's nothing left at the top level.
    try:
        from pathlib import Path as _PathBU
        _backups_root = _PathBU("data/backups")
        if _backups_root.exists() and _backups_root.is_dir():
            _admin_dir = _backups_root / "_admin"
            _admin_dir.mkdir(parents=True, exist_ok=True)
            _moved = 0
            for _zip in _backups_root.glob("*.zip"):
                if not _zip.is_file():
                    continue
                _dest = _admin_dir / _zip.name
                if _dest.exists():
                    continue
                try:
                    _zip.rename(_dest)
                    _moved += 1
                except Exception as _mv_err:
                    logger.warning(f"Could not move legacy backup {_zip.name}: {_mv_err}")
            if _moved:
                logger.info(f"Legacy backups migration: {_moved} zip(s) moved to data/backups/_admin/")
    except Exception as e:
        logger.warning(f"Legacy backups migration failed: {e}")

    # 4z. Services one-shot migration: move any secret stored in legacy
    # settings.services[*] (api_key, token, plus non-secret fields the user
    # had customised like base_url/project_id/...) into user #1's
    # UserSettings.service_keys, then clear the legacy fields so the global
    # JSON never leaks. Idempotent: skips entries the user already has.
    try:
        from sqlalchemy import select as _select_svc
        from backend.core.db.engine import get_session as _get_session_svc
        from backend.core.db.models import User as _User_svc, UserSettings as _US_svc
        from backend.core.config.settings import encrypt_value as _enc_svc

        settings_svc = Settings.load()
        legacy_svc: dict[str, dict] = {}
        for sname, sconf in (settings_svc.services or {}).items():
            if not sconf:
                continue
            payload: dict = {}
            if sconf.api_key:
                payload["api_key"] = sconf.api_key
            if sconf.token:
                payload["token"] = sconf.token
            # Non-secret but user-customized fields worth preserving
            for f in ("base_url", "project_id", "region", "bucket", "database", "namespace", "webhook_url"):
                v = getattr(sconf, f, None)
                if v:
                    payload[f] = v
            if getattr(sconf, "extra", None):
                payload["extra"] = dict(sconf.extra)
            if sconf.enabled:
                payload["enabled"] = True
            if payload:
                legacy_svc[sname] = payload

        if legacy_svc:
            async for _svs in _get_session_svc():
                _target = await _svs.execute(_select_svc(_User_svc).order_by(_User_svc.id).limit(1))
                _owner_sv = _target.scalar()
                if _owner_sv is None:
                    logger.info("Services legacy migration skipped: no users yet")
                    break

                _us_row = await _svs.execute(
                    _select_svc(_US_svc).where(_US_svc.user_id == _owner_sv.id)
                )
                _us_sv = _us_row.scalar_one_or_none()
                if _us_sv is None:
                    _us_sv = _US_svc(user_id=_owner_sv.id, provider_keys={}, service_keys={})
                    _svs.add(_us_sv)
                    await _svs.flush()

                existing_sv = dict(_us_sv.service_keys or {})
                added_sv = 0
                cleared_names: list[str] = []
                for sname, payload in legacy_svc.items():
                    if sname in existing_sv and (
                        existing_sv[sname].get("api_key") or existing_sv[sname].get("token")
                    ):
                        # User already owns credentials for this service → leave alone
                        continue
                    entry = dict(existing_sv.get(sname) or {})
                    if "api_key" in payload:
                        entry["api_key"] = _enc_svc(payload["api_key"])
                    if "token" in payload:
                        entry["token"] = _enc_svc(payload["token"])
                    for k in ("base_url", "project_id", "region", "bucket", "database", "namespace", "webhook_url"):
                        if k in payload:
                            entry[k] = payload[k]
                    if "extra" in payload:
                        entry["extra"] = payload["extra"]
                    if payload.get("enabled"):
                        entry["enabled"] = True
                    existing_sv[sname] = entry
                    added_sv += 1
                    cleared_names.append(sname)

                from sqlalchemy.orm.attributes import flag_modified as _svc_flag
                _us_sv.service_keys = existing_sv
                _svc_flag(_us_sv, "service_keys")
                await _svs.commit()

                if added_sv:
                    # Clear secrets + user-specific fields from the global store
                    for sname in cleared_names:
                        sconf = settings_svc.services.get(sname)
                        if not sconf:
                            continue
                        sconf.api_key = None
                        sconf.token = None
                        # Keep generic base_url (public endpoint metadata) — most
                        # service defaults are public URLs anyway.
                        sconf.project_id = None
                        sconf.region = None
                        sconf.bucket = None
                        sconf.database = None
                        sconf.namespace = None
                        sconf.webhook_url = None
                        if hasattr(sconf, "extra"):
                            sconf.extra = {}
                    settings_svc.save()
                    logger.info(
                        f"Services legacy migration: {added_sv} service(s) moved to user #{_owner_sv.id} "
                        f"({', '.join(cleared_names)})"
                    )
                break
    except Exception as e:
        logger.warning(f"Services legacy migration failed: {e}")

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
    """Background loop: every midnight, run a per-user auto-backup for every
    user that has ``auto_daily`` enabled in their own backup config. Each
    user's zip is stored under ``data/backups/<uid>/``.
    """
    from datetime import datetime, timedelta
    from sqlalchemy import select as _sel
    from backend.core.api.backup_routes import create_user_backup, _load_user_config
    from backend.core.db.engine import async_session
    from backend.core.db.models import User

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
            async with async_session() as backup_session:
                users_result = await backup_session.execute(_sel(User))
                users = list(users_result.scalars().all())
                for u in users:
                    cfg = _load_user_config(u.id)
                    if not cfg.get("auto_daily"):
                        continue
                    result = await create_user_backup(backup_session, u.id)
                    if result.get("ok"):
                        logger.info(
                            f"Auto-backup created for user {u.id}: {result.get('filename')}"
                        )
                    else:
                        logger.warning(
                            f"Auto-backup failed for user {u.id}: {result.get('error')}"
                        )
        except Exception as e:
            logger.warning(f"Auto-backup loop error: {e}")


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
