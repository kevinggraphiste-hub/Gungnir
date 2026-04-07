"""
Gungnir — Main FastAPI application

Core app with dynamic plugin loading.
"""
import sys
import asyncio
import logging
from pathlib import Path
from contextlib import asynccontextmanager

# Ensure project root is on sys.path
PROJECT_ROOT = Path(__file__).parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse

from backend.core.db.engine import engine
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

    # 1b. Auto-migrate: ensure api_token column exists
    try:
        from sqlalchemy import text
        async with engine.begin() as conn:
            result = await conn.execute(text("PRAGMA table_info(users)"))
            columns = [row[1] for row in result.fetchall()]
            if "api_token" not in columns:
                await conn.execute(text("ALTER TABLE users ADD COLUMN api_token VARCHAR(128)"))
                logger.info("Migration: added api_token column to users table")
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
        call_plugin_lifecycle(manifest, "on_startup", app=app)

    # 4. Start MCP servers
    from backend.core.agents.mcp_client import mcp_manager
    settings = Settings.load()
    if settings.mcp_servers:
        mcp_configs = [s.model_dump() for s in settings.mcp_servers]
        await mcp_manager.start_all(mcp_configs)
        mcp_tools = mcp_manager.get_all_schemas()
        if mcp_tools:
            logger.info(f"MCP: {len(mcp_tools)} tools from {len(mcp_manager.clients)} server(s)")

    # 5. Start auto-backup scheduler
    auto_backup_task = asyncio.create_task(_auto_backup_loop())

    logger.info(
        f"Gungnir started — {len(_loaded_plugins)} plugins loaded: "
        f"{', '.join(p.name for p in _loaded_plugins)}"
    )

    yield

    # Shutdown
    auto_backup_task.cancel()
    await mcp_manager.stop_all()
    for manifest in _loaded_plugins:
        call_plugin_lifecycle(manifest, "on_shutdown")
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
    "/api/health", "/api/doctor", "/api/users/login", "/api/plugins/status",
}
PUBLIC_PREFIXES = (
    "/api/webhook/",      # Incoming webhooks (Slack, Discord, WhatsApp) have their own auth
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
    # Allow creating first user (POST /api/users) and serving SPA
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
            result = await session.execute(
                select(User).where(User.api_token == token, User.is_active == True)
            )
            user = result.scalar()
            if not user:
                return JSONResponse({"error": "Token invalide ou utilisateur désactivé"}, status_code=401)
            # Inject user info into request state for downstream use
            request.state.user_id = user.id
            request.state.username = user.username
            return await call_next(request)
    except Exception as e:
        # If DB not ready or column missing — allow request (graceful degradation)
        logger.warning(f"Auth middleware error (allowing request): {e}")
        return await call_next(request)

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
