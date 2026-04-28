"""
Gungnir Plugin — Code v1.0.0

Mini-IDE backend: file explorer, file read/write, code execution, terminal.
Workspace scoped to data/workspace/ by default (configurable).

Self-contained — no core dependency.

── Package layout ──
This module used to be a single ~3500-line file. It is now a package split by
concern. The split is transparent to the rest of the codebase:

- ``backend.plugins.code.routes`` (this file) still exposes ``router`` so the
  plugin loader keeps importing it unchanged.
- ``agent_tools.py`` still imports ``_current_user_id``, ``_workspace`` and
  ``_safe_path`` from this module — they are defined here.
- Submodules (``files``, ``versions``, ``git``, ``exec``, ``ai``, ``snippets``)
  register their own routes on the ``router`` defined below. They are imported
  at the very bottom of this file so helpers are defined before they are used.
"""
import asyncio
import io
import json
import logging
import mimetypes
import os
import re
import shutil
import time
import uuid
import zipfile
from datetime import datetime
from pathlib import Path
from typing import Optional
from contextvars import ContextVar

from fastapi import APIRouter, Depends, File, HTTPException, Query, Request, UploadFile
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel

logger = logging.getLogger("gungnir.plugins.code")

# ── Rate limiting for subprocess endpoints ──────────────────────────────────
# Per-user cap (30/min) on /run and /terminal to prevent a compromised or
# runaway client from saturating the container with subprocess.exec. The
# RateLimitExceeded exception handler is registered globally by main.py.
from slowapi import Limiter
from slowapi.util import get_remote_address


def _code_rate_limit_key(request: Request) -> str:
    """Prefer authenticated user_id; fall back to IP when auth is missing."""
    uid = getattr(getattr(request, "state", None), "user_id", None)
    if uid:
        return f"user:{uid}"
    return get_remote_address(request)


limiter_code = Limiter(key_func=_code_rate_limit_key)

# Hard upper bound for a single AI tool-calling loop (all variants).
# If a provider is slow or the model keeps requesting tools, we bail rather
# than let the request hang indefinitely. Per-round LLM calls still have
# their own provider-level timeout; this caps the aggregate wall time.
AI_LOOP_TIMEOUT_S = 60

# ── Per-user workspace isolation ────────────────────────────────────────────
# Each user gets their own workspace under data/workspace/{user_id}/
# The context var is set by the dependency injected into the router.
_current_user_id: ContextVar[int] = ContextVar("_current_user_id", default=0)

async def _inject_user_id(request: Request):
    """Extract user_id from auth middleware and store in context var.

    MUST be async: sync FastAPI deps run in a threadpool via anyio, and a
    ContextVar.set() in that thread is not visible to the async handler
    executing afterwards. Declaring the dep as async keeps the set() in the
    caller's context so ``_current_user_id`` reflects the real user id."""
    uid = getattr(request.state, "user_id", None) or 0
    _current_user_id.set(uid)

router = APIRouter(dependencies=[Depends(_inject_user_id)])


async def _effective_user_id() -> int:
    """Return the current user id. In open/setup mode (no auth active) we only
    fall back to user #1 if they are the SOLE user in the DB — otherwise we
    refuse to resolve an identity, to prevent cross-user leakage of provider
    API keys, workspaces and service credentials when a second user exists.
    """
    uid = _current_user_id.get(0) or 0
    if uid > 0:
        return uid
    try:
        from backend.core.db.engine import async_session
        from backend.core.api.auth_helpers import open_mode_fallback_user_id
        async with async_session() as s:
            fallback_id = await open_mode_fallback_user_id(s)
            return fallback_id or 0
    except Exception:
        return 0

# ── Workspace ────────────────────────────────────────────────────────────────

DEFAULT_WORKSPACE = Path("data/workspace")
PROJECT_ROOT = Path(__file__).parent.parent.parent.parent.parent.resolve()
_CODE_CONFIG_ROOT = Path("data/code_configs")
_LEGACY_CODE_CONFIG_FILE = Path("data/code_config.json")


def _user_config_file() -> Path:
    """Return the per-user code config path. Falls back to a shared file in
    open/setup mode so the legacy behaviour still works before any user exists."""
    uid = _current_user_id.get(0) or 0
    if uid > 0:
        return _CODE_CONFIG_ROOT / f"{uid}.json"
    return _LEGACY_CODE_CONFIG_FILE

# Répertoires sensibles dans data/ qui ne doivent JAMAIS être un workspace,
# quel que soit le mode (auth / open). Sinon un user peut pointer son
# workspace vers data/backups/<autre_uid>/ et zip-download les backups d'un
# autre user (CVE-style cross-user data leak rapporté 2026-04-28).
_SENSITIVE_DATA_SUBDIRS = {
    "backups",          # data/backups/<uid>/ — secrets chiffrés en zip
    "soul",             # data/soul/<uid>/   — soul.md + identity per-user
    "kb",               # data/kb/<uid>/     — knowledge base per-user
    "consciousness",    # data/consciousness/users/<uid>/ — état conscience
    "channels",         # data/channels/<uid>/ — bot tokens Telegram/Discord
    "code-config",      # data/code-config/<uid>.json — config SpearCode user
    "huntr",            # data/huntr/ — historique recherches potentiellement sensible
    "plugins_external", # data/plugins_external/ — code plugin tiers
}


def _is_path_in_sensitive_data(resolved: Path) -> bool:
    """Bloque l'accès aux sous-dossiers per-user de data/ (cross-user leak)."""
    try:
        data_root = (PROJECT_ROOT / "data").resolve()
        rel = resolved.relative_to(data_root)
        if rel.parts and rel.parts[0] in _SENSITIVE_DATA_SUBDIRS:
            return True
    except ValueError:
        pass
    return False


# Directories allowed as workspace roots (project + user home subfolders).
def _is_allowed_workspace(p: Path) -> bool:
    """Restrict workspace to per-user tree (or project for open mode).

    Sécurité (fix 2026-04-28) : pour un user authentifié, on autorise
    UNIQUEMENT le sub-tree `data/workspace/<uid>/`. Sinon un user pouvait
    overrider son workspace vers `data/backups/<autre_uid>/` et exfiltrer
    les backups d'un autre user via /api/plugins/code/download.

    Blacklist absolue (data/backups, data/soul, data/kb, data/consciousness,
    data/channels…) en plus pour defense-in-depth, quel que soit le mode.
    """
    resolved = p.resolve()

    # Defense-in-depth : data/<dir-sensible> bloqué dans tous les cas.
    if _is_path_in_sensitive_data(resolved):
        return False

    uid = _current_user_id.get(0) or 0

    # Mode authentifié : workspace strict per-user
    if uid > 0:
        user_root = (DEFAULT_WORKSPACE / str(uid)).resolve()
        # Le user_root lui-même ou un sub-folder dedans, OK
        if resolved == user_root:
            return True
        try:
            resolved.relative_to(user_root)
            return True
        except ValueError:
            return False

    # Mode open (single-user setup, pas d'auth) : comportement legacy
    # Allow within project
    if str(resolved).startswith(str(PROJECT_ROOT)):
        return True
    # Allow user home subfolders (e.g. ~/projects/something)
    home = Path.home().resolve()
    if str(resolved).startswith(str(home)):
        # Block root of home itself and sensitive dirs
        if resolved == home:
            return False
        sensitive = {".ssh", ".gnupg", ".config", "AppData", ".aws", ".azure"}
        try:
            rel = resolved.relative_to(home)
            if rel.parts and rel.parts[0] in sensitive:
                return False
        except ValueError:
            return False
        return True
    return False


def _default_workspace_for_current_user() -> Path:
    """Workspace path used when a user has no custom override in their config.

    Authenticated users get their own subfolder `data/workspace/{uid}`, open
    mode keeps the shared `data/workspace` (no uid available to isolate by).
    """
    uid = _current_user_id.get(0) or 0
    if uid > 0:
        return DEFAULT_WORKSPACE / str(uid)
    return DEFAULT_WORKSPACE


def _load_config() -> dict:
    path = _user_config_file()
    default = {
        "workspace": str(_default_workspace_for_current_user()),
        "recent_files": [],
        "font_size": 14,
    }
    if path.exists():
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            merged = {**default, **(data or {})}
            # Legacy migration: if an older config still points at the shared
            # root while this user now has an isolated default, swap it so
            # the user's files don't silently leak into the shared folder.
            uid = _current_user_id.get(0) or 0
            if uid > 0 and merged.get("workspace") == str(DEFAULT_WORKSPACE):
                merged["workspace"] = str(_default_workspace_for_current_user())
            return merged
        except Exception:
            pass
    # One-shot migration from the old shared config file.
    uid = _current_user_id.get(0) or 0
    if uid > 0 and _LEGACY_CODE_CONFIG_FILE.exists():
        try:
            legacy = json.loads(_LEGACY_CODE_CONFIG_FILE.read_text(encoding="utf-8"))
            merged = {**default, **(legacy or {})}
            # Never carry the shared workspace over — rewrite to per-user path.
            merged["workspace"] = str(_default_workspace_for_current_user())
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps(merged, indent=2, ensure_ascii=False), encoding="utf-8")
            return merged
        except Exception:
            pass
    return default


def _save_config(cfg: dict):
    path = _user_config_file()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(cfg, indent=2, ensure_ascii=False), encoding="utf-8")


def _workspace() -> Path:
    """Resolve the effective workspace: user-configured path if it passes the
    allowed-path check, otherwise the per-user default (falls back to the
    shared root only in open/setup mode)."""
    try:
        cfg = _load_config()
        configured = cfg.get("workspace")
    except Exception:
        configured = None
    if configured:
        try:
            p = Path(configured).resolve()
            if _is_allowed_workspace(p):
                p.mkdir(parents=True, exist_ok=True)
                return p
        except Exception:
            pass
    ws = _default_workspace_for_current_user()
    ws.mkdir(parents=True, exist_ok=True)
    return ws


def _safe_path(rel: str) -> Path:
    """Resolve relative path inside workspace. Prevents directory traversal
    AND symlink escape (fix sécu M3).

    `.resolve()` suit les symlinks et retourne le chemin réel — donc un
    symlink pointant hors workspace est détecté. On vérifie aussi chaque
    composant intermédiaire au cas où un symlink serait créé en cours de
    route (ex: via bash_exec) puis exploité par un autre call.
    """
    ws = _workspace().resolve()
    candidate = (ws / rel)
    # resolve(strict=False) : accepte les paths qui n'existent pas encore
    # (create file case) tout en suivant les symlinks existants.
    resolved = candidate.resolve(strict=False)
    if not str(resolved).startswith(str(ws)):
        raise HTTPException(403, "Acces interdit: chemin hors du workspace")
    # Vérifie qu'aucun composant du path n'est un symlink qui pointerait
    # hors du workspace (detection tardive des escape via symlink).
    current = ws
    try:
        rel_parts = resolved.relative_to(ws).parts
    except ValueError:
        raise HTTPException(403, "Acces interdit: chemin hors du workspace")
    for part in rel_parts:
        current = current / part
        if current.is_symlink():
            target = current.resolve(strict=False)
            if not str(target).startswith(str(ws)):
                raise HTTPException(403, "Acces interdit: symlink vers l'extérieur du workspace")
        if not current.exists():
            break  # Pas la peine de scanner les parts non-créées
    return resolved


# ── Text vs binary detection ─────────────────────────────────────────────────

TEXT_EXTENSIONS = {
    ".py", ".js", ".ts", ".tsx", ".jsx", ".json", ".html", ".css", ".scss",
    ".md", ".txt", ".yaml", ".yml", ".toml", ".cfg", ".ini", ".env",
    ".sh", ".bash", ".zsh", ".fish", ".bat", ".cmd", ".ps1",
    ".sql", ".graphql", ".gql", ".xml", ".svg", ".csv",
    ".rs", ".go", ".java", ".kt", ".c", ".cpp", ".h", ".hpp",
    ".rb", ".php", ".lua", ".r", ".swift", ".dart", ".vue", ".svelte",
    ".dockerfile", ".gitignore", ".editorconfig", ".prettierrc",
    ".eslintrc", ".babelrc", ".npmrc", ".lock",
}


def _is_text_file(p: Path) -> bool:
    if p.suffix.lower() in TEXT_EXTENSIONS:
        return True
    if p.name.lower() in {"makefile", "dockerfile", "procfile", "gemfile", "rakefile", "license", "readme"}:
        return True
    mime, _ = mimetypes.guess_type(str(p))
    return mime is not None and mime.startswith("text/")


# ── Language detection ───────────────────────────────────────────────────────

LANG_MAP = {
    ".py": "python", ".js": "javascript", ".ts": "typescript",
    ".tsx": "tsx", ".jsx": "jsx", ".json": "json", ".html": "html",
    ".css": "css", ".scss": "scss", ".md": "markdown", ".yaml": "yaml",
    ".yml": "yaml", ".toml": "toml", ".sh": "bash", ".bash": "bash",
    ".sql": "sql", ".rs": "rust", ".go": "go", ".java": "java",
    ".c": "c", ".cpp": "cpp", ".h": "c", ".hpp": "cpp",
    ".rb": "ruby", ".php": "php", ".lua": "lua", ".swift": "swift",
    ".dart": "dart", ".vue": "vue", ".svelte": "svelte",
    ".xml": "xml", ".svg": "xml", ".graphql": "graphql",
    ".r": "r", ".kt": "kotlin", ".txt": "text",
}


# ── Shared constants used by several submodules ─────────────────────────────

IGNORE_DIRS = {"node_modules", ".git", "dist", "build", ".next", "__pycache__", ".venv", "venv", ".spearcode"}

VERSIONS_DIR = Path("data/code_versions")


def _versions_path(file_path: str) -> Path:
    """Per-user version storage dir for a file.

    Layout: ``data/code_versions/{uid}/{encoded_path}/`` (uid=0 → flat legacy
    layout for open/setup mode). Historical versions under the old flat layout
    are relocated to user #1 by ``scripts/migrate_code_per_user.py``.
    """
    safe_name = file_path.replace("/", "__").replace("\\", "__")
    uid = _current_user_id.get(0) or 0
    user_root = VERSIONS_DIR / str(uid) if uid > 0 else VERSIONS_DIR
    return user_root / safe_name


# ── Health ───────────────────────────────────────────────────────────────────

@router.get("/health")
async def code_health():
    ws = _workspace()
    return {
        "plugin": "code",
        "status": "ok",
        "version": "1.0.0",
        "workspace": str(ws),
        "exists": ws.exists(),
    }


# ── Config ───────────────────────────────────────────────────────────────────

class ConfigUpdate(BaseModel):
    workspace: Optional[str] = None
    font_size: Optional[int] = None


@router.get("/config")
async def get_config():
    return _load_config()


@router.put("/config")
async def update_config(update: ConfigUpdate):
    cfg = _load_config()
    if update.workspace is not None:
        p = Path(update.workspace).resolve()
        if not _is_allowed_workspace(p):
            raise HTTPException(403, "Workspace interdit: doit être dans le projet ou un sous-dossier du home utilisateur")
        p.mkdir(parents=True, exist_ok=True)
        cfg["workspace"] = str(p)
    if update.font_size is not None:
        cfg["font_size"] = max(8, min(32, update.font_size))
    _save_config(cfg)
    return cfg


# ── Provider resolver (shared by every /ai/* endpoint) ─────────────────────

# In-memory cache for provider models { "provider_name": { "models": [...], "ts": timestamp } }
_models_cache: dict[str, dict] = {}
_CACHE_TTL = 300  # 5 minutes


async def _resolve_user_provider(
    req_provider_name: Optional[str] = None,
    req_model_name: Optional[str] = None,
):
    """Resolve an LLM provider strictly from the current user's keys.

    Returns (provider_instance, chosen_model, error_string). Reads user_id from
    the _current_user_id ContextVar populated by the router dependency, so
    callers don't need to pass Request around.
    """
    from backend.core.config.settings import Settings
    from backend.core.providers import get_provider
    from backend.core.db.engine import async_session
    from backend.core.api.auth_helpers import get_user_settings, get_user_provider_key

    uid = await _effective_user_id()
    if uid <= 0:
        return None, None, "Authentification requise pour utiliser les providers LLM"

    settings = Settings.load()
    async with async_session() as _s:
        user_settings = await get_user_settings(uid, _s)

        def _build(pname: str, model_hint: Optional[str]):
            decoded = get_user_provider_key(user_settings, pname)
            if not decoded or not decoded.get("api_key"):
                return None, None
            meta = settings.providers.get(pname)
            base_url = decoded.get("base_url") or (meta.base_url if meta else None)
            prov = get_provider(pname, decoded["api_key"], base_url)
            chosen = (
                model_hint
                or (meta.default_model if meta else None)
                or (user_settings.active_model if pname == user_settings.active_provider else None)
            )
            return prov, chosen

        # 1) Explicitly requested provider (if the caller picked one)
        if req_provider_name:
            prov, chosen = _build(req_provider_name, req_model_name)
            if prov and chosen:
                return prov, chosen, None

        # 2) User's active provider, then any other provider they own a key for
        order = [user_settings.active_provider] + [
            p
            for p in (user_settings.provider_keys or {}).keys()
            if p != user_settings.active_provider
        ]
        for pname in order:
            if not pname:
                continue
            prov, chosen = _build(pname, None)
            if prov and chosen:
                return prov, chosen, None

    return None, None, "Aucun provider LLM configuré pour cet utilisateur"


async def _fetch_provider_models(pname: str, api_key: str, base_url: Optional[str], static_models: list[str], default_model: Optional[str]) -> list[str]:
    """Fetch models dynamically from provider API, with cache."""
    cached = _models_cache.get(pname)
    if cached and (time.time() - cached["ts"]) < _CACHE_TTL:
        return cached["models"]

    try:
        from backend.core.providers import get_provider
        provider = get_provider(pname, api_key, base_url)
        models = await provider.list_models()
        if models:
            _models_cache[pname] = {"models": models, "ts": time.time()}
            return models
    except Exception as e:
        logger.warning(f"Failed to fetch models for {pname}: {e}")

    # Fallback to settings static list or default_model
    return static_models if static_models else ([default_model] if default_model else [])


# ── Submodule registration ──────────────────────────────────────────────────
# Each submodule imports `router` (and the helpers above) from this package
# and registers its own endpoints on the shared APIRouter. Keep this block at
# the very bottom — the helpers must be defined before the submodules import
# them (otherwise we hit ImportError mid-load).
from . import files  # noqa: E402,F401
from . import versions  # noqa: E402,F401
from . import git  # noqa: E402,F401
from . import exec  # noqa: E402,F401
from . import ai  # noqa: E402,F401
from . import snippets  # noqa: E402,F401
from . import format as _format  # noqa: E402,F401
from .lsp import register_lsp_ws  # noqa: E402
register_lsp_ws(router)
