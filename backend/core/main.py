"""
Gungnir — Main FastAPI application

Core app with dynamic plugin loading.
"""
import sys
import logging
from pathlib import Path
from contextlib import asynccontextmanager

# Ensure project root is on sys.path
PROJECT_ROOT = Path(__file__).parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse

from backend.core.db.engine import engine
from backend.core.db.models import init_db
from backend.core.config.settings import PLUGINS_DIR
from backend.core.services.plugin_loader import (
    discover_plugins, mount_plugin_routes, call_plugin_lifecycle,
)

# ── Logging ──────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
)
logger = logging.getLogger("gungnir")

# ── Plugin state (populated at startup) ──────────────────────────────────────
_loaded_plugins = []


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup and shutdown lifecycle."""
    global _loaded_plugins

    # 1. Initialize database
    logger.info("Initializing database...")
    await init_db(engine)

    # 2. Discover and mount plugins
    logger.info("Discovering plugins...")
    manifests = discover_plugins(PLUGINS_DIR)
    for manifest in manifests:
        if manifest.enabled_by_default:
            success = mount_plugin_routes(app, manifest)
            if success:
                _loaded_plugins.append(manifest)

    # 3. Call plugin on_startup hooks
    for manifest in _loaded_plugins:
        call_plugin_lifecycle(manifest, "on_startup", app=app)

    logger.info(
        f"Gungnir started — {len(_loaded_plugins)} plugins loaded: "
        f"{', '.join(p.name for p in _loaded_plugins)}"
    )

    yield

    # Shutdown
    for manifest in _loaded_plugins:
        call_plugin_lifecycle(manifest, "on_shutdown")
    logger.info("Gungnir stopped.")


# ── App ──────────────────────────────────────────────────────────────────────
app = FastAPI(title="Gungnir API", version="2.0.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Core API routes ──────────────────────────────────────────────────────────
from backend.core.api.router import core_router
app.include_router(core_router, prefix="/api")


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


# ── Frontend SPA serving ─────────────────────────────────────────────────────
frontend_dist = PROJECT_ROOT / "frontend" / "dist"
if frontend_dist.exists():
    app.mount("/assets", StaticFiles(directory=str(frontend_dist / "assets")), name="assets")

    # Serve static files (logo, favicon, etc.)
    @app.get("/logo.png")
    async def serve_logo():
        logo_path = frontend_dist / "logo.png"
        if logo_path.exists():
            return FileResponse(str(logo_path))
        return JSONResponse({"error": "not found"}, status_code=404)

    @app.get("/")
    async def serve_frontend():
        return FileResponse(str(frontend_dist / "index.html"))

    @app.get("/{path:path}")
    async def serve_frontend_files(path: str):
        if path.startswith("api"):
            return JSONResponse({"error": "Route not found"}, status_code=404)
        file_path = frontend_dist / path
        if file_path.exists() and file_path.is_file():
            return FileResponse(str(file_path))
        return FileResponse(str(frontend_dist / "index.html"))


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
