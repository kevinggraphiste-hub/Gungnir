"""
Gungnir Plugin — Code v1.0.0

Mini-IDE backend: file explorer, file read/write, code execution, terminal.
Workspace scoped to data/workspace/ by default (configurable).

Self-contained — no core dependency.
"""
import asyncio
import json
import logging
import mimetypes
import os
import subprocess
import uuid
from datetime import datetime
from pathlib import Path
from typing import Optional
from contextvars import ContextVar

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel

logger = logging.getLogger("gungnir.plugins.code")

# ── Per-user workspace isolation ────────────────────────────────────────────
# Each user gets their own workspace under data/workspace/{user_id}/
# The context var is set by the dependency injected into the router.
_current_user_id: ContextVar[int] = ContextVar("_current_user_id", default=0)

def _inject_user_id(request: Request):
    """Extract user_id from auth middleware and store in context var."""
    uid = getattr(request.state, "user_id", None) or 0
    _current_user_id.set(uid)

router = APIRouter(dependencies=[Depends(_inject_user_id)])

# ── Workspace ────────────────────────────────────────────────────────────────

DEFAULT_WORKSPACE = Path("data/workspace")
PROJECT_ROOT = Path(__file__).parent.parent.parent.parent.resolve()
_CODE_CONFIG_ROOT = Path("data/code_configs")
_LEGACY_CODE_CONFIG_FILE = Path("data/code_config.json")


def _user_config_file() -> Path:
    """Return the per-user code config path. Falls back to a shared file in
    open/setup mode so the legacy behaviour still works before any user exists."""
    uid = _current_user_id.get(0) or 0
    if uid > 0:
        return _CODE_CONFIG_ROOT / f"{uid}.json"
    return _LEGACY_CODE_CONFIG_FILE

# Directories allowed as workspace roots (project + user home subfolders)
def _is_allowed_workspace(p: Path) -> bool:
    """Restrict workspace to project tree or user home subfolders (no system dirs)."""
    resolved = p.resolve()
    # Always allow within project
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


def _load_config() -> dict:
    path = _user_config_file()
    default = {"workspace": str(DEFAULT_WORKSPACE), "recent_files": [], "font_size": 14}
    if path.exists():
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            return {**default, **(data or {})}
        except Exception:
            pass
    # One-shot migration: if the legacy shared config still exists, copy it
    # into the current user's file on first access so settings carry over.
    uid = _current_user_id.get(0) or 0
    if uid > 0 and _LEGACY_CODE_CONFIG_FILE.exists():
        try:
            legacy = json.loads(_LEGACY_CODE_CONFIG_FILE.read_text(encoding="utf-8"))
            merged = {**default, **(legacy or {})}
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
    uid = _current_user_id.get(0)
    if uid and uid > 0:
        # Per-user isolated workspace
        ws = DEFAULT_WORKSPACE / str(uid)
    else:
        # Fallback: shared workspace (open mode / admin)
        ws = DEFAULT_WORKSPACE
    ws.mkdir(parents=True, exist_ok=True)
    return ws


def _safe_path(rel: str) -> Path:
    """Resolve relative path inside workspace. Prevents directory traversal."""
    ws = _workspace()
    resolved = (ws / rel).resolve()
    if not str(resolved).startswith(str(ws.resolve())):
        raise HTTPException(403, "Acces interdit: chemin hors du workspace")
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


# ── File tree ────────────────────────────────────────────────────────────────

@router.get("/tree")
async def get_file_tree(path: str = ""):
    """List files/folders at a given path in the workspace."""
    target = _safe_path(path) if path else _workspace()
    if not target.exists():
        raise HTTPException(404, "Chemin introuvable")
    if not target.is_dir():
        raise HTTPException(400, "Le chemin n'est pas un dossier")

    entries = []
    try:
        for item in sorted(target.iterdir(), key=lambda x: (not x.is_dir(), x.name.lower())):
            # Skip hidden and __pycache__
            if item.name.startswith(".") or item.name == "__pycache__" or item.name == "node_modules":
                continue
            rel = str(item.relative_to(_workspace())).replace("\\", "/")
            entry = {
                "name": item.name,
                "path": rel,
                "is_dir": item.is_dir(),
            }
            if item.is_file():
                entry["size"] = item.stat().st_size
                entry["ext"] = item.suffix.lower()
                entry["language"] = LANG_MAP.get(item.suffix.lower(), "text")
                entry["is_text"] = _is_text_file(item)
            elif item.is_dir():
                try:
                    entry["children_count"] = sum(1 for _ in item.iterdir() if not _.name.startswith("."))
                except PermissionError:
                    entry["children_count"] = 0
            entries.append(entry)
    except PermissionError:
        raise HTTPException(403, "Permission refusee")

    return {"path": path or ".", "entries": entries}


# ── File CRUD ────────────────────────────────────────────────────────────────

@router.get("/file")
async def read_file(path: str):
    """Read a file's content."""
    target = _safe_path(path)
    if not target.exists():
        raise HTTPException(404, "Fichier introuvable")
    if not target.is_file():
        raise HTTPException(400, "Le chemin n'est pas un fichier")

    is_text = _is_text_file(target)
    if not is_text:
        return {
            "path": path,
            "is_text": False,
            "size": target.stat().st_size,
            "message": "Fichier binaire — apercu non disponible",
        }

    try:
        content = target.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        try:
            content = target.read_text(encoding="latin-1")
        except Exception:
            return {"path": path, "is_text": False, "message": "Encodage non supporte"}

    # Track recent files
    cfg = _load_config()
    recents = cfg.get("recent_files", [])
    if path in recents:
        recents.remove(path)
    recents.insert(0, path)
    cfg["recent_files"] = recents[:20]
    _save_config(cfg)

    return {
        "path": path,
        "is_text": True,
        "content": content,
        "size": len(content),
        "language": LANG_MAP.get(target.suffix.lower(), "text"),
        "lines": content.count("\n") + 1,
    }


class FileWrite(BaseModel):
    path: str
    content: str


@router.put("/file")
async def write_file(data: FileWrite):
    """Write/create a file."""
    target = _safe_path(data.path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(data.content, encoding="utf-8")
    logger.info(f"File written: {data.path} ({len(data.content)} chars)")
    return {"ok": True, "path": data.path, "size": len(data.content)}


class FileRename(BaseModel):
    old_path: str
    new_path: str


@router.post("/rename")
async def rename_file(data: FileRename):
    """Rename/move a file or folder."""
    src = _safe_path(data.old_path)
    dst = _safe_path(data.new_path)
    if not src.exists():
        raise HTTPException(404, "Fichier source introuvable")
    if dst.exists():
        raise HTTPException(409, "Le fichier destination existe deja")
    dst.parent.mkdir(parents=True, exist_ok=True)
    src.rename(dst)
    logger.info(f"Renamed: {data.old_path} -> {data.new_path}")
    return {"ok": True, "old_path": data.old_path, "new_path": data.new_path}


@router.delete("/file")
async def delete_file(path: str):
    """Delete a file or empty folder."""
    target = _safe_path(path)
    if not target.exists():
        raise HTTPException(404, "Fichier introuvable")
    if target.is_dir():
        try:
            target.rmdir()
        except OSError:
            import shutil
            shutil.rmtree(target)
    else:
        target.unlink()
    logger.info(f"Deleted: {path}")
    return {"ok": True, "path": path}


class FolderCreate(BaseModel):
    path: str


@router.post("/folder")
async def create_folder(data: FolderCreate):
    """Create a new folder."""
    target = _safe_path(data.path)
    if target.exists():
        raise HTTPException(409, "Le dossier existe deja")
    target.mkdir(parents=True, exist_ok=True)
    logger.info(f"Folder created: {data.path}")
    return {"ok": True, "path": data.path}


# ── Search ───────────────────────────────────────────────────────────────────

@router.get("/search")
async def search_files(q: str = Query(..., min_length=1), max_results: int = 50):
    """Search file names and content in workspace."""
    ws = _workspace()
    results = []
    q_lower = q.lower()

    for root, dirs, files in os.walk(ws):
        dirs[:] = [d for d in dirs if not d.startswith(".") and d not in ("node_modules", "__pycache__")]
        for f in files:
            if len(results) >= max_results:
                break
            fp = Path(root) / f
            rel = str(fp.relative_to(ws)).replace("\\", "/")

            # Name match
            if q_lower in f.lower():
                results.append({"path": rel, "name": f, "match": "filename"})
                continue

            # Content match (text files only, max 2MB)
            if _is_text_file(fp) and fp.stat().st_size < 2_000_000:
                try:
                    content = fp.read_text(encoding="utf-8")
                    idx = content.lower().find(q_lower)
                    if idx >= 0:
                        line_num = content[:idx].count("\n") + 1
                        start = max(0, idx - 40)
                        end = min(len(content), idx + len(q) + 40)
                        snippet = content[start:end].replace("\n", " ").strip()
                        results.append({
                            "path": rel, "name": f, "match": "content",
                            "line": line_num, "snippet": snippet,
                        })
                except (UnicodeDecodeError, PermissionError):
                    pass

    return {"query": q, "results": results[:max_results], "total": len(results)}


# ── Code execution (safe — uses create_subprocess_exec, no shell) ────────────

class RunRequest(BaseModel):
    path: str
    args: list[str] = []
    timeout: int = 30


RUN_COMMANDS = {
    ".py": ["python", "-u"],
    ".js": ["node"],
    ".ts": ["npx", "tsx"],
    ".sh": ["bash"],
    ".bash": ["bash"],
    ".rb": ["ruby"],
    ".go": ["go", "run"],
    ".php": ["php"],
    ".lua": ["lua"],
    ".r": ["Rscript"],
}


@router.post("/run")
async def run_file(req: RunRequest):
    """Execute a file and return stdout/stderr. Uses subprocess_exec (no shell injection)."""
    target = _safe_path(req.path)
    if not target.exists():
        raise HTTPException(404, "Fichier introuvable")

    ext = target.suffix.lower()
    cmd_prefix = RUN_COMMANDS.get(ext)
    if not cmd_prefix:
        raise HTTPException(400, f"Extension non supportee pour l'execution: {ext}")

    cmd = cmd_prefix + [str(target)] + req.args
    timeout = min(max(req.timeout, 1), 120)

    start = datetime.now()
    try:
        # Sanitized env for code execution
        _safe_env = {k: v for k, v in os.environ.items()
                     if not any(s in k.upper() for s in ("KEY", "SECRET", "TOKEN", "PASSWORD", "DATABASE_URL"))}
        _safe_env["PYTHONUNBUFFERED"] = "1"
        _safe_env["HOME"] = str(_workspace())

        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=str(_workspace()),
            env=_safe_env,
        )
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout)
        elapsed = (datetime.now() - start).total_seconds()

        return {
            "ok": proc.returncode == 0,
            "exit_code": proc.returncode,
            "stdout": stdout.decode("utf-8", errors="replace")[:50000],
            "stderr": stderr.decode("utf-8", errors="replace")[:10000],
            "elapsed": round(elapsed, 2),
            "command": " ".join(cmd),
        }
    except asyncio.TimeoutError:
        proc.kill()
        return {
            "ok": False, "exit_code": -1, "stdout": "",
            "stderr": f"Timeout apres {timeout}s", "elapsed": timeout,
            "command": " ".join(cmd),
        }
    except FileNotFoundError as e:
        return {
            "ok": False, "exit_code": -1, "stdout": "",
            "stderr": f"Commande introuvable: {e}", "elapsed": 0,
            "command": " ".join(cmd),
        }


# ── Terminal (single command — uses create_subprocess_exec with shell wrapper) ──

class TerminalRequest(BaseModel):
    command: str
    timeout: int = 30


@router.post("/terminal")
async def run_terminal(req: TerminalRequest):
    """Execute a shell command in the workspace directory.
    Uses create_subprocess_exec with explicit shell binary for safety."""
    if not req.command.strip():
        raise HTTPException(400, "Commande vide")

    import re as _re
    cmd_lower = req.command.lower().strip()
    # Block destructive and escape patterns
    destructive_patterns = [
        r"rm\s+(-[a-z]*\s+)*(/|~|\$home)", r"del\s+/[sfq]",
        r"format\s+[a-z]:", r"mkfs", r"dd\s+if=",
        r"find\s+/\s+.*-delete", r"shred\s+", r"wipefs",
        r"remove-item\s+.*-recurse.*-force.*/",
        r"net\s+user\s+.*\s+/add", r"reg\s+(add|delete)",
        # Block access outside workspace
        r"cat\s+/app/data/config", r"cat\s+/etc/",
        r"curl\s+", r"wget\s+", r"nc\s+", r"ncat\s+",
        r"python[23]?\s+-c\s+", r"perl\s+-e\s+", r"ruby\s+-e\s+",
        r"base64\s+.*\|", r"eval\s+", r"exec\s+",
        r"docker\s+", r"kubectl\s+", r"systemctl\s+",
        r"/app/data/config", r"/app/data/gungnir\.db",
        r"\.\./\.\./",  # directory traversal
    ]
    for pat in destructive_patterns:
        if _re.search(pat, cmd_lower):
            raise HTTPException(403, "Commande bloquée: pattern non autorisé")

    timeout = min(max(req.timeout, 1), 120)
    start = datetime.now()

    # Determine shell binary
    import platform
    if platform.system() == "Windows":
        shell_bin = "cmd.exe"
        shell_args = ["/c", req.command]
    else:
        shell_bin = "/bin/bash"
        shell_args = ["-c", req.command]

    try:
        # Sanitized env: strip sensitive vars (API keys, secrets, DB URLs)
        _safe_env = {k: v for k, v in os.environ.items()
                     if not any(s in k.upper() for s in ("KEY", "SECRET", "TOKEN", "PASSWORD", "DATABASE_URL"))}
        _safe_env["PYTHONUNBUFFERED"] = "1"
        _safe_env["HOME"] = str(_workspace())

        proc = await asyncio.create_subprocess_exec(
            shell_bin, *shell_args,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=str(_workspace()),
            env=_safe_env,
        )
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout)
        elapsed = (datetime.now() - start).total_seconds()

        return {
            "ok": proc.returncode == 0,
            "exit_code": proc.returncode,
            "stdout": stdout.decode("utf-8", errors="replace")[:50000],
            "stderr": stderr.decode("utf-8", errors="replace")[:10000],
            "elapsed": round(elapsed, 2),
        }
    except asyncio.TimeoutError:
        proc.kill()
        return {"ok": False, "exit_code": -1, "stdout": "", "stderr": f"Timeout apres {timeout}s", "elapsed": timeout}
    except Exception as e:
        return {"ok": False, "exit_code": -1, "stdout": "", "stderr": str(e), "elapsed": 0}


# ── Workspace stats ──────────────────────────────────────────────────────────

@router.get("/stats")
async def workspace_stats():
    """Quick stats about the workspace."""
    ws = _workspace()
    total_files = 0
    total_dirs = 0
    total_size = 0
    by_ext: dict[str, int] = {}

    for root, dirs, files in os.walk(ws):
        dirs[:] = [d for d in dirs if not d.startswith(".") and d not in ("node_modules", "__pycache__")]
        total_dirs += len(dirs)
        for f in files:
            fp = Path(root) / f
            total_files += 1
            try:
                sz = fp.stat().st_size
                total_size += sz
                ext = fp.suffix.lower() or "(aucune)"
                by_ext[ext] = by_ext.get(ext, 0) + 1
            except OSError:
                pass

    top_ext = sorted(by_ext.items(), key=lambda x: -x[1])[:10]

    return {
        "workspace": str(ws),
        "total_files": total_files,
        "total_dirs": total_dirs,
        "total_size": total_size,
        "top_extensions": [{"ext": e, "count": c} for e, c in top_ext],
    }


# ── Quick file list (for command palette fuzzy search) ─────────────────────

@router.get("/files")
async def list_all_files(max_files: int = 500):
    """List all files in workspace (flat list for fuzzy search)."""
    ws = _workspace()
    files = []
    for root, dirs, filenames in os.walk(ws):
        dirs[:] = [d for d in dirs if d not in IGNORE_DIRS and not d.startswith(".")]
        for f in filenames:
            if len(files) >= max_files:
                break
            fp = Path(root) / f
            rel = str(fp.relative_to(ws)).replace("\\", "/")
            lang = LANG_MAP.get(fp.suffix.lower(), "")
            files.append({"path": rel, "name": f, "language": lang, "ext": fp.suffix.lower()})
    return {"files": files}


# ── Image preview ──────────────────────────────────────────────────────────

@router.get("/preview")
async def preview_file(path: str):
    """Return base64-encoded preview of binary files (images, SVG)."""
    import base64
    target = _safe_path(path)
    if not target.exists() or not target.is_file():
        raise HTTPException(404, "Fichier introuvable")

    ext = target.suffix.lower()
    MIME_MAP = {
        ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
        ".gif": "image/gif", ".webp": "image/webp", ".ico": "image/x-icon",
        ".svg": "image/svg+xml", ".bmp": "image/bmp",
    }

    mime = MIME_MAP.get(ext)
    if not mime:
        return {"ok": False, "error": "Format non supporte pour l'apercu"}

    # SVG can be returned as text
    if ext == ".svg":
        try:
            content = target.read_text(encoding="utf-8")
            return {"ok": True, "type": "svg", "content": content, "mime": mime}
        except Exception:
            pass

    # Binary images as base64 (max 5MB)
    if target.stat().st_size > 5_000_000:
        return {"ok": False, "error": "Fichier trop volumineux (max 5 Mo)"}

    data = target.read_bytes()
    b64 = base64.b64encode(data).decode("ascii")
    return {"ok": True, "type": "image", "data": f"data:{mime};base64,{b64}", "size": len(data)}


# ── File Versioning (local snapshots, independent of Git) ────────────────────

VERSIONS_DIR = Path("data/code_versions")


def _versions_path(file_path: str) -> Path:
    """Get version storage directory for a file."""
    safe_name = file_path.replace("/", "__").replace("\\", "__")
    return VERSIONS_DIR / safe_name


@router.post("/version/save")
async def save_version(data: dict):
    """Save a snapshot of a file before applying changes. Max 20 versions per file."""
    file_path = data.get("path", "")
    content = data.get("content", "")
    label = data.get("label", "")

    if not file_path or not content:
        raise HTTPException(400, "Chemin et contenu requis")

    vdir = _versions_path(file_path)
    vdir.mkdir(parents=True, exist_ok=True)

    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S_%f")
    version_info = {
        "timestamp": datetime.now().isoformat(),
        "label": label or "Sauvegarde auto",
        "file_path": file_path,
        "lines": content.count("\n") + 1,
        "size": len(content),
    }

    # Save content + metadata
    (vdir / f"{timestamp}.txt").write_text(content, encoding="utf-8")
    (vdir / f"{timestamp}.json").write_text(
        json.dumps(version_info, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    # Enforce max 20 versions per file
    versions = sorted(vdir.glob("*.txt"))
    while len(versions) > 20:
        old = versions.pop(0)
        old.unlink(missing_ok=True)
        meta = old.with_suffix(".json")
        meta.unlink(missing_ok=True)

    logger.info(f"Version saved: {file_path} ({label or 'auto'})")
    return {"ok": True, "version_id": timestamp}


@router.get("/version/list")
async def list_versions(path: str):
    """List all saved versions of a file."""
    vdir = _versions_path(path)
    if not vdir.exists():
        return {"versions": []}

    versions = []
    for meta_file in sorted(vdir.glob("*.json"), reverse=True):
        try:
            info = json.loads(meta_file.read_text(encoding="utf-8"))
            info["version_id"] = meta_file.stem
            versions.append(info)
        except Exception:
            pass

    return {"versions": versions}


@router.get("/version/get")
async def get_version(path: str, version_id: str):
    """Retrieve a specific version's content."""
    vdir = _versions_path(path)
    content_file = vdir / f"{version_id}.txt"
    if not content_file.exists():
        raise HTTPException(404, "Version introuvable")

    content = content_file.read_text(encoding="utf-8")
    return {"ok": True, "content": content, "version_id": version_id}


@router.delete("/version/delete")
async def delete_version(path: str, version_id: str):
    """Delete a specific version."""
    vdir = _versions_path(path)
    for ext in [".txt", ".json"]:
        f = vdir / f"{version_id}{ext}"
        f.unlink(missing_ok=True)
    return {"ok": True}


# ── Git integration ─────────────────────────────────────────────────────────

async def _git_exec(*args: str, cwd: str | None = None) -> tuple[bool, str]:
    """Run a git command and return (success, output)."""
    try:
        proc = await asyncio.create_subprocess_exec(
            "git", *args,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=cwd or str(_workspace()),
        )
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=15)
        out = stdout.decode("utf-8", errors="replace") + stderr.decode("utf-8", errors="replace")
        return proc.returncode == 0, out.strip()
    except Exception as e:
        return False, str(e)


@router.get("/git/status")
async def git_status():
    """Git status of the workspace."""
    ws = str(_workspace())
    ok, _ = await _git_exec("rev-parse", "--git-dir", cwd=ws)
    if not ok:
        return {"is_repo": False}

    _, branch = await _git_exec("branch", "--show-current", cwd=ws)
    _, status = await _git_exec("status", "--porcelain", cwd=ws)
    _, log = await _git_exec("log", "--oneline", "-10", cwd=ws)

    files = []
    for line in status.strip().split("\n"):
        if len(line) >= 4:
            st = line[:2].strip()
            path = line[3:].strip()
            files.append({"status": st, "path": path})

    return {
        "is_repo": True,
        "branch": branch or "main",
        "files": files,
        "log": [l.strip() for l in log.strip().split("\n") if l.strip()][:10],
    }


@router.get("/git/diff")
async def git_diff(path: str = ""):
    """Get git diff for workspace or specific file."""
    ws = str(_workspace())
    args = ["diff"]
    if path:
        args.append("--")
        args.append(path)
    _, diff = await _git_exec(*args, cwd=ws)
    # Also staged diff
    args_staged = ["diff", "--cached"]
    if path:
        args_staged += ["--", path]
    _, staged = await _git_exec(*args_staged, cwd=ws)
    return {"diff": diff, "staged": staged}


class GitCommitRequest(BaseModel):
    message: str
    files: list[str] = []  # empty = all changed


@router.post("/git/commit")
async def git_commit(req: GitCommitRequest):
    """Stage files and commit."""
    ws = str(_workspace())
    if req.files:
        for f in req.files:
            await _git_exec("add", f, cwd=ws)
    else:
        await _git_exec("add", "-A", cwd=ws)
    ok, out = await _git_exec("commit", "-m", req.message, cwd=ws)
    return {"ok": ok, "output": out}


@router.post("/git/init")
async def git_init():
    """Initialize a git repo in the workspace."""
    ws = str(_workspace())
    ok, out = await _git_exec("init", cwd=ws)
    return {"ok": ok, "output": out}


@router.get("/git/branches")
async def git_branches():
    """List git branches."""
    ws = str(_workspace())
    ok, out = await _git_exec("branch", "--no-color", cwd=ws)
    if not ok:
        return {"branches": [], "current": ""}
    branches = []
    current = ""
    for line in out.strip().split("\n"):
        line = line.strip()
        if line.startswith("* "):
            current = line[2:]
            branches.append(current)
        elif line:
            branches.append(line)
    return {"branches": branches, "current": current}


@router.post("/git/checkout")
async def git_checkout(data: dict):
    """Switch branch."""
    ws = str(_workspace())
    branch = data.get("branch", "")
    if not branch:
        raise HTTPException(400, "Branche requise")
    ok, out = await _git_exec("checkout", branch, cwd=ws)
    return {"ok": ok, "output": out}


# ── Provider list (for model selector) ──────────────────────────────────────

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

    uid = _current_user_id.get() or 0
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
    import time
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


@router.get("/providers")
async def list_providers():
    """List the current user's configured LLM providers with live model lists."""
    try:
        from backend.core.config.settings import Settings
        from backend.core.db.engine import async_session
        from backend.core.api.auth_helpers import get_user_settings, get_user_provider_key
    except ImportError:
        return {"providers": []}

    uid = _current_user_id.get() or 0
    if uid <= 0:
        return {"providers": []}

    settings = Settings.load()
    result = []
    async with async_session() as _s:
        user_settings = await get_user_settings(uid, _s)
        for pname in (user_settings.provider_keys or {}).keys():
            decoded = get_user_provider_key(user_settings, pname)
            if not decoded or not decoded.get("api_key"):
                continue
            meta = settings.providers.get(pname)
            base_url = decoded.get("base_url") or (meta.base_url if meta else None)
            static_models = list(meta.models) if meta and meta.models else []
            default_model = meta.default_model if meta else None
            models = await _fetch_provider_models(pname, decoded["api_key"], base_url, static_models, default_model)
            result.append({
                "name": pname,
                "default_model": default_model,
                "enabled": True,
                "models": models,
            })
    return {"providers": result}


@router.get("/providers/{provider_name}/models")
async def refresh_provider_models(provider_name: str):
    """Force-refresh the current user's model list for a specific provider."""
    import time
    try:
        from backend.core.config.settings import Settings
        from backend.core.providers import get_provider
        from backend.core.db.engine import async_session
        from backend.core.api.auth_helpers import get_user_settings, get_user_provider_key
    except ImportError:
        raise HTTPException(404, "Settings not available")

    uid = _current_user_id.get() or 0
    if uid <= 0:
        raise HTTPException(401, "Authentification requise")

    settings = Settings.load()
    meta = settings.providers.get(provider_name)
    async with async_session() as _s:
        user_settings = await get_user_settings(uid, _s)
        decoded = get_user_provider_key(user_settings, provider_name)
        if not decoded or not decoded.get("api_key"):
            raise HTTPException(404, f"Provider '{provider_name}' non configuré pour cet utilisateur")
        api_key = decoded["api_key"]
        base_url = decoded.get("base_url") or (meta.base_url if meta else None)

    # Clear cache to force refresh
    _models_cache.pop(provider_name, None)

    try:
        provider = get_provider(provider_name, api_key, base_url)
        models = await provider.list_models()
        if models:
            _models_cache[provider_name] = {"models": models, "ts": time.time()}
            return {"provider": provider_name, "models": models, "count": len(models)}
    except Exception as e:
        logger.error(f"Failed to refresh models for {provider_name}: {e}")
        raise HTTPException(502, f"Could not fetch models from {provider_name}: {str(e)}")

    default_m = meta.default_model if meta else None
    return {"provider": provider_name, "models": [default_m] if default_m else [], "count": 1 if default_m else 0}


# ═══════════════════════════════════════════════════════════════════════════════
# SpearCode Integration — Project Analysis, Coding Personas, AI Chat
# Ported from backend/plugins/claude code/src/core/ (TypeScript → Python)
# ═══════════════════════════════════════════════════════════════════════════════


# ── Project Analysis (ported from context.ts) ────────────────────────────────

FRAMEWORK_DETECTORS = [
    (["package.json"], "node", "javascript"),
    (["tsconfig.json"], "typescript", "typescript"),
    (["Cargo.toml"], "rust", "rust"),
    (["go.mod"], "go", "go"),
    (["requirements.txt", "pyproject.toml", "setup.py"], "python", "python"),
    (["Gemfile"], "ruby", "ruby"),
    (["pom.xml", "build.gradle"], "java", "java"),
    (["composer.json"], "php", "php"),
    (["Package.swift"], "swift", "swift"),
]

IGNORE_DIRS = {"node_modules", ".git", "dist", "build", ".next", "__pycache__", ".venv", "venv", ".spearcode"}


def _detect_language(ws: Path) -> str:
    for files, _, language in FRAMEWORK_DETECTORS:
        for f in files:
            if (ws / f).exists():
                return language
    return "unknown"


def _detect_framework(ws: Path) -> Optional[str]:
    pkg = ws / "package.json"
    if pkg.exists():
        try:
            data = json.loads(pkg.read_text(encoding="utf-8"))
            deps = {**data.get("dependencies", {}), **data.get("devDependencies", {})}
            for name, fw in [("react", "react"), ("vue", "vue"), ("svelte", "svelte"),
                             ("next", "nextjs"), ("nuxt", "nuxt"), ("express", "express"),
                             ("fastify", "fastify"), ("@nestjs/core", "nestjs"), ("astro", "astro"),
                             ("fastapi", "fastapi"), ("flask", "flask"), ("django", "django")]:
                if name in deps:
                    return fw
        except Exception:
            pass
    if (ws / "Cargo.toml").exists(): return "rust"
    if (ws / "go.mod").exists(): return "go"
    if (ws / "pyproject.toml").exists():
        try:
            txt = (ws / "pyproject.toml").read_text(encoding="utf-8")
            if "fastapi" in txt.lower(): return "fastapi"
            if "flask" in txt.lower(): return "flask"
            if "django" in txt.lower(): return "django"
            return "python"
        except Exception:
            return "python"
    return None


def _build_tree(ws: Path, rel: str = "", depth: int = 0, max_depth: int = 3) -> list[dict]:
    target = ws / rel if rel else ws
    if depth > max_depth or not target.is_dir():
        return []
    nodes = []
    try:
        items = sorted(target.iterdir(), key=lambda x: (not x.is_dir(), x.name.lower()))
    except PermissionError:
        return []
    for item in items:
        if item.name in IGNORE_DIRS or item.name.startswith("."):
            continue
        r = str(item.relative_to(ws)).replace("\\", "/")
        if item.is_dir():
            children = _build_tree(ws, r, depth + 1, max_depth) if depth < max_depth else []
            nodes.append({"name": item.name, "path": r, "type": "directory", "children": children})
        else:
            lang = LANG_MAP.get(item.suffix.lower(), "")
            nodes.append({"name": item.name, "path": r, "type": "file",
                          "size": item.stat().st_size, "language": lang})
    return nodes


def _render_tree(nodes: list[dict], prefix: str = "", max_items: int = 40) -> str:
    lines = []
    shown = nodes[:max_items]
    for i, node in enumerate(shown):
        is_last = i == len(shown) - 1
        connector = "└── " if is_last else "├── "
        icon = "📁 " if node["type"] == "directory" else "📄 "
        lines.append(f"{prefix}{connector}{icon}{node['name']}")
        if node["type"] == "directory" and node.get("children"):
            child_prefix = prefix + ("    " if is_last else "│   ")
            lines.append(_render_tree(node["children"], child_prefix, max_items - len(shown)))
    if len(nodes) > max_items:
        lines.append(f"{prefix}└── ... ({len(nodes) - max_items} de plus)")
    return "\n".join(lines)


def _count_lines(ws: Path) -> dict:
    """Count lines by language (sampling max 200 files for speed)."""
    by_lang: dict[str, dict] = {}
    total_lines = 0
    count = 0
    for root, dirs, files in os.walk(ws):
        dirs[:] = [d for d in dirs if d not in IGNORE_DIRS and not d.startswith(".")]
        for f in files:
            if count > 200:
                break
            fp = Path(root) / f
            lang = LANG_MAP.get(fp.suffix.lower())
            if not lang or fp.stat().st_size > 1_000_000:
                continue
            try:
                lines = fp.read_text(encoding="utf-8").count("\n") + 1
                total_lines += lines
                if lang not in by_lang:
                    by_lang[lang] = {"files": 0, "lines": 0}
                by_lang[lang]["files"] += 1
                by_lang[lang]["lines"] += lines
                count += 1
            except (UnicodeDecodeError, PermissionError, OSError):
                pass
    return {"total_lines": total_lines, "by_language": by_lang}


@router.get("/analyze")
async def analyze_project():
    """Full project analysis — language, framework, tree, stats. (SpearCode context.ts port)"""
    ws = _workspace()
    language = _detect_language(ws)
    framework = _detect_framework(ws)
    tree = _build_tree(ws)
    line_stats = _count_lines(ws)

    # Load README if available
    readme = None
    for name in ["README.md", "readme.md", "README.rst", "README"]:
        rp = ws / name
        if rp.exists():
            try:
                readme = rp.read_text(encoding="utf-8")[:2000]
            except Exception:
                pass
            break

    # Detect config files
    config_files = []
    for name in ["package.json", "tsconfig.json", "Cargo.toml", "go.mod",
                  "pyproject.toml", "requirements.txt", "Dockerfile",
                  "docker-compose.yml", ".env.example", "Makefile"]:
        if (ws / name).exists():
            config_files.append(name)

    return {
        "name": ws.name,
        "language": language,
        "framework": framework,
        "tree_text": _render_tree(tree),
        "config_files": config_files,
        "readme_excerpt": readme,
        "stats": line_stats,
    }


# ── Coding Personas (ported from personas.ts) ────────────────────────────────

CODING_PERSONAS = {
    "architect": {
        "id": "architect", "name": "Architect", "icon": "🏗️",
        "description": "Design systeme, patterns d'architecture, scalabilite",
        "system_prompt": (
            "Tu es un architecte logiciel senior. Concentre-toi sur :\n"
            "- Design systeme et patterns d'architecture\n"
            "- Scalabilite et performance\n"
            "- Organisation du code et limites des modules\n"
            "- Design d'API et flux de donnees\n"
            "- Compromis entre differentes approches\n"
            "Considere toujours la vue d'ensemble avant l'implementation."
        ),
    },
    "debugger": {
        "id": "debugger", "name": "Debugger", "icon": "🐛",
        "description": "Chasse aux bugs, analyse d'erreurs, root cause",
        "system_prompt": (
            "Tu es un expert en debugging. Concentre-toi sur :\n"
            "- Analyse de la cause racine, pas juste les symptomes\n"
            "- Lecture attentive des messages d'erreur et stack traces\n"
            "- Isolation systematique du probleme\n"
            "- Verification des edge cases et race conditions\n"
            "- Verifier que le fix n'introduit pas de nouveaux bugs\n"
            "Sois methodique. Explique ton raisonnement etape par etape."
        ),
    },
    "reviewer": {
        "id": "reviewer", "name": "Reviewer", "icon": "👁️",
        "description": "Code review, qualite, securite, bonnes pratiques",
        "system_prompt": (
            "Tu es un code reviewer strict. Concentre-toi sur :\n"
            "- Vulnerabilites securite (injection, XSS, auth)\n"
            "- Goulots de performance et complexite inutile\n"
            "- Lacunes dans la gestion d'erreurs\n"
            "- Lisibilite et maintenabilite du code\n"
            "- Respect des conventions du projet\n"
            "Sois specifique. Utilise des niveaux: 🔴 Critique, 🟡 Warning, 🟢 Suggestion."
        ),
    },
    "writer": {
        "id": "writer", "name": "Writer", "icon": "📝",
        "description": "Documentation, commentaires, README, guides",
        "system_prompt": (
            "Tu es un technical writer. Concentre-toi sur :\n"
            "- Documentation claire et concise\n"
            "- Bons exemples et patterns d'usage\n"
            "- README utiles pour les nouveaux arrivants\n"
            "- Commentaires qui expliquent le POURQUOI, pas le QUOI\n"
            "- Documentation d'API avec des exemples reels"
        ),
    },
    "tester": {
        "id": "tester", "name": "Tester", "icon": "🧪",
        "description": "Generation de tests, couverture, edge cases",
        "system_prompt": (
            "Tu es un ingenieur QA. Concentre-toi sur :\n"
            "- Couverture de test exhaustive\n"
            "- Edge cases et conditions limites\n"
            "- Happy path ET chemins d'erreur\n"
            "- Lisibilite et maintenabilite des tests\n"
            "- Strategies de mocking\n"
            "Pense toujours : 'Qu'est-ce qui pourrait aller de travers ?'"
        ),
    },
    "optimizer": {
        "id": "optimizer", "name": "Optimizer", "icon": "⚡",
        "description": "Performance, profiling, optimisation",
        "system_prompt": (
            "Tu es un ingenieur performance. Concentre-toi sur :\n"
            "- Identifier les goulots par analyse de code\n"
            "- Complexite algorithmique (temps et espace)\n"
            "- Strategies de cache\n"
            "- Optimisation de requetes DB\n"
            "- Taille de bundle et performance de chargement\n"
            "Mesure avant d'optimiser. Propose des approches de profiling."
        ),
    },
    "hacker": {
        "id": "hacker", "name": "Hacker", "icon": "🔓",
        "description": "Audit securite, mentalite pentest",
        "system_prompt": (
            "Tu es un ingenieur securite. Concentre-toi sur :\n"
            "- OWASP Top 10\n"
            "- Validation et sanitisation des inputs\n"
            "- Failles d'authentification et d'autorisation\n"
            "- Gestion des secrets\n"
            "- Vulnerabilites des dependances\n"
            "Pense comme un attaquant. Qu'est-ce que tu exploiterais ?"
        ),
    },
}


@router.get("/personas")
async def list_personas():
    """List available coding personas."""
    return {"personas": list(CODING_PERSONAS.values())}


# ── AI Code Chat (contextual) ───────────────────────────────────────────────

class AIChatRequest(BaseModel):
    message: str
    file_path: Optional[str] = None    # current open file for context
    persona: Optional[str] = None       # persona ID
    selection: Optional[str] = None     # selected code snippet
    provider_name: Optional[str] = None # override provider
    model_name: Optional[str] = None    # override model
    context_mode: str = "smart"         # "smart" | "selection" | "full" | "none"
    history: list[dict] = []            # previous messages for multi-turn


# ── Context Reduction Engine ─────────────────────────────────────────────────

import re

def _extract_relevant_context(content: str, query: str, lang: str, max_chars: int = 4000) -> str:
    """
    Smart context reduction: extract only the parts of the file relevant to the query.
    Preserves imports, class/function signatures near the query topic, and the
    targeted code block — without sending the entire file.
    Returns reduced content that keeps precision while minimizing tokens.
    """
    if len(content) <= max_chars:
        return content

    lines = content.split("\n")
    query_lower = query.lower()
    query_words = set(re.findall(r'\w{3,}', query_lower))

    # Score each line for relevance
    scored: list[tuple[int, float]] = []
    for i, line in enumerate(lines):
        score = 0.0
        stripped = line.strip().lower()

        # Always keep imports/requires (structural context, low cost)
        if any(stripped.startswith(kw) for kw in ("import ", "from ", "require(", "use ", "#include")):
            score += 3.0

        # Keep class/function/method definitions (structural anchors)
        if re.match(r'^(class |def |function |const |let |var |export |async |pub fn |fn |impl )', stripped):
            score += 4.0

        # Direct keyword match from user query
        line_words = set(re.findall(r'\w{3,}', stripped))
        overlap = query_words & line_words
        if overlap:
            score += 5.0 * len(overlap)

        # Decorators/annotations near definitions
        if stripped.startswith("@") or stripped.startswith("#["):
            score += 2.0

        # Type definitions, interfaces
        if re.match(r'^(interface |type |struct |enum |typedef )', stripped):
            score += 3.0

        # Non-empty lines get a tiny base score
        if stripped and not stripped.startswith("#") and not stripped.startswith("//"):
            score += 0.1

        scored.append((i, score))

    # Select lines: high-scoring lines + their neighbors (context window of ±3)
    selected = set()
    for i, score in scored:
        if score >= 2.0:
            for j in range(max(0, i - 3), min(len(lines), i + 4)):
                selected.add(j)

    # Always include first 5 lines (file header/imports) and last 3
    for i in range(min(5, len(lines))):
        selected.add(i)
    for i in range(max(0, len(lines) - 3), len(lines)):
        selected.add(i)

    # Build reduced content with fold markers
    result_parts = []
    sorted_sel = sorted(selected)
    prev_i = -2
    char_count = 0

    for i in sorted_sel:
        if char_count >= max_chars:
            result_parts.append(f"  ... ({len(lines) - i} lignes restantes tronquees)")
            break
        if i > prev_i + 1:
            gap = i - prev_i - 1
            result_parts.append(f"  ... ({gap} lignes masquees)")
        line_text = lines[i]
        result_parts.append(line_text)
        char_count += len(line_text) + 1
        prev_i = i

    return "\n".join(result_parts)


def _estimate_tokens(text: str) -> int:
    """Rough token estimate (chars/3.5 for multilingual, conservative)."""
    return max(1, int(len(text) / 3.5))


@router.post("/ai/chat")
async def ai_code_chat(req: AIChatRequest):
    """
    Contextual AI coding chat with model switching and smart context reduction.
    Sends user message + optimized context + persona to the chosen LLM.
    """
    # Lazy imports to maintain plugin independence
    try:
        from backend.core.providers import ChatMessage
    except ImportError as e:
        return {"ok": False, "error": f"Import error: {e}"}

    provider, chosen_model, _err = await _resolve_user_provider(req.provider_name, req.model_name)
    if _err or not provider or not chosen_model:
        return {"ok": False, "error": _err or "Aucun provider LLM configuré"}

    # ── Build system prompt (optimized for token efficiency) ─────────────
    ws = _workspace()
    system_parts = [
        f"Tu es l'assistant IA integre a SpearCode, l'IDE de Gungnir. Tu operes dans le workspace '{ws.name}' ({ws.resolve()}).",
        "Tu as acces au systeme de fichiers : lecture, ecriture, creation, suppression de fichiers du workspace.",
        "Tu peux executer des commandes shell dans le terminal integre.",
        "Tu conserves le contexte de la conversation en cours (memoire de session).",
        "Reponds en francais, concis et technique. Code dans des blocs ```language.",
    ]

    # Add persona (compact)
    persona = None
    if req.persona and req.persona in CODING_PERSONAS:
        persona = CODING_PERSONAS[req.persona]
        system_parts.append(f"\n[Persona: {persona['icon']} {persona['name']}]\n{persona['system_prompt']}")

    # ── Smart context injection based on context_mode ────────────────────
    context_tokens = 0

    if req.context_mode == "selection" and req.selection:
        # Minimal: only selected code
        system_parts.append(f"\nCode selectionne:\n```\n{req.selection[:3000]}\n```")
        context_tokens = _estimate_tokens(req.selection[:3000])

    elif req.context_mode == "none":
        # No file context at all — pure chat
        pass

    elif req.file_path:
        try:
            target = _safe_path(req.file_path)
            if target.exists() and _is_text_file(target):
                content = target.read_text(encoding="utf-8")
                lang = LANG_MAP.get(target.suffix.lower(), "text")
                total_lines = content.count("\n") + 1

                if req.context_mode == "full":
                    # Full file (capped at 8000 chars)
                    ctx = content[:8000]
                else:
                    # Smart mode: extract only relevant parts
                    if req.selection:
                        # If there's a selection, use it as primary + smart extract for surrounding context
                        ctx = f"[Selection]\n{req.selection[:2000]}\n\n[Contexte fichier]\n{_extract_relevant_context(content, req.message + ' ' + req.selection[:200], lang, 2000)}"
                    else:
                        ctx = _extract_relevant_context(content, req.message, lang, 4000)

                file_header = f"\nFichier: {req.file_path} ({lang}, {total_lines}L)"
                system_parts.append(f"{file_header}\n```{lang}\n{ctx}\n```")
                context_tokens = _estimate_tokens(ctx)
        except Exception:
            pass

        # Selection context if not already used
        if req.selection and req.context_mode not in ("selection",):
            if req.context_mode != "smart":  # smart already includes selection above
                system_parts.append(f"\nCode selectionne:\n```\n{req.selection[:2000]}\n```")

    # Project context (1-liner, very cheap)
    fw = _detect_framework(ws)
    project_info = f"Projet: {ws.name} ({_detect_language(ws)}"
    if fw:
        project_info += f", {fw}"
    project_info += ")"
    system_parts.append(f"\n{project_info}")

    system_prompt = "\n".join(system_parts)

    # ── Build messages (with history for multi-turn, capped) ─────────────
    messages = [ChatMessage(role="system", content=system_prompt)]

    # Add conversation history (keep last N messages, cap total tokens)
    history_budget = 2000  # chars for history
    history_chars = 0
    trimmed_history = []
    for h in reversed(req.history[-10:]):  # max 10 messages
        msg_len = len(h.get("content", ""))
        if history_chars + msg_len > history_budget:
            break
        trimmed_history.insert(0, h)
        history_chars += msg_len

    for h in trimmed_history:
        messages.append(ChatMessage(role=h["role"], content=h["content"]))

    messages.append(ChatMessage(role="user", content=req.message))

    # Estimate total tokens
    total_chars = sum(len(m.content) for m in messages)
    est_tokens = int(total_chars / 3.5)

    try:
        response = await provider.chat(messages, chosen_model)
        resp_text = response.content or ""
        return {
            "ok": True,
            "response": resp_text,
            "persona": persona["name"] if persona else None,
            "model": chosen_model,
            "token_estimate": {
                "context": _estimate_tokens(system_prompt),
                "history": _estimate_tokens(str(history_chars)),
                "query": _estimate_tokens(req.message),
                "response": _estimate_tokens(resp_text),
                "total": _estimate_tokens(total_chars + len(resp_text)),
            },
        }
    except Exception as e:
        logger.error(f"AI code chat failed: {e}")
        return {"ok": False, "error": f"Erreur LLM: {str(e)[:200]}"}


# ── Helper: build provider + messages from request ────────────────────────

async def _build_chat_context(req: AIChatRequest):
    """Shared logic for building provider, model, system prompt, and messages."""
    from backend.core.providers import ChatMessage

    provider, chosen_model, _err = await _resolve_user_provider(req.provider_name, req.model_name)
    if not provider or not chosen_model:
        return None, None, None, None

    ws = _workspace()
    system_parts = [
        f"Tu es l'assistant IA integre a SpearCode, l'IDE de Gungnir. Tu operes dans le workspace '{ws.name}' ({ws.resolve()}).",
        "Tu as acces au systeme de fichiers : lecture, ecriture, creation, suppression de fichiers du workspace.",
        "Tu peux executer des commandes shell dans le terminal integre.",
        "Tu conserves le contexte de la conversation en cours (memoire de session).",
        "Reponds en francais, concis et technique. Code dans des blocs ```language.",
    ]

    persona = None
    if req.persona and req.persona in CODING_PERSONAS:
        persona = CODING_PERSONAS[req.persona]
        system_parts.append(f"\n[Persona: {persona['icon']} {persona['name']}]\n{persona['system_prompt']}")

    if req.context_mode == "selection" and req.selection:
        system_parts.append(f"\nCode selectionne:\n```\n{req.selection[:3000]}\n```")
    elif req.context_mode != "none" and req.file_path:
        try:
            target = _safe_path(req.file_path)
            if target.exists() and _is_text_file(target):
                content = target.read_text(encoding="utf-8")
                lang = LANG_MAP.get(target.suffix.lower(), "text")
                total_lines = content.count("\n") + 1
                if req.context_mode == "full":
                    ctx = content[:8000]
                else:
                    ctx = _extract_relevant_context(content, req.message, lang, 4000) if not req.selection else \
                        f"[Selection]\n{req.selection[:2000]}\n\n[Contexte]\n{_extract_relevant_context(content, req.message, lang, 2000)}"
                system_parts.append(f"\nFichier: {req.file_path} ({lang}, {total_lines}L)\n```{lang}\n{ctx}\n```")
        except Exception:
            pass

    fw = _detect_framework(ws)
    system_parts.append(f"\nProjet: {ws.name} ({_detect_language(ws)}{', ' + fw if fw else ''})")

    # Load .spearcode project rules if available
    rules_file = ws / ".spearcode"
    if rules_file.exists():
        try:
            rules = rules_file.read_text(encoding="utf-8")[:1500]
            system_parts.append(f"\n[Regles projet .spearcode]\n{rules}")
        except Exception:
            pass

    system_prompt = "\n".join(system_parts)
    messages = [ChatMessage(role="system", content=system_prompt)]

    history_budget, history_chars = 2000, 0
    trimmed_history = []
    for h in reversed(req.history[-10:]):
        msg_len = len(h.get("content", ""))
        if history_chars + msg_len > history_budget:
            break
        trimmed_history.insert(0, h)
        history_chars += msg_len
    for h in trimmed_history:
        messages.append(ChatMessage(role=h["role"], content=h["content"]))
    messages.append(ChatMessage(role="user", content=req.message))

    return provider, chosen_model, messages, persona


# ── Streaming AI Chat (SSE) ──────────────────────────────────────────────

from fastapi.responses import StreamingResponse


@router.post("/ai/chat/stream")
async def ai_code_chat_stream(req: AIChatRequest):
    """
    Streaming AI chat via Server-Sent Events.
    Sends tokens one by one as they arrive from the LLM.
    """
    try:
        provider, chosen_model, messages, persona = await _build_chat_context(req)
    except ImportError as e:
        return {"ok": False, "error": f"Import error: {e}"}

    if not provider:
        return {"ok": False, "error": "Aucun provider LLM configuré pour cet utilisateur"}

    async def event_stream():
        try:
            # Send metadata first
            meta = json.dumps({
                "type": "meta",
                "model": chosen_model,
                "persona": persona["name"] if persona else None,
            }, ensure_ascii=False)
            yield f"data: {meta}\n\n"

            # Stream tokens
            full_text = ""
            async for chunk in provider.chat_stream(messages, chosen_model):
                full_text += chunk
                data = json.dumps({"type": "token", "content": chunk}, ensure_ascii=False)
                yield f"data: {data}\n\n"

            # Send done event with token estimate
            done = json.dumps({
                "type": "done",
                "full_text": full_text,
                "token_estimate": _estimate_tokens(full_text),
            }, ensure_ascii=False)
            yield f"data: {done}\n\n"

        except Exception as e:
            err = json.dumps({"type": "error", "error": str(e)[:200]}, ensure_ascii=False)
            yield f"data: {err}\n\n"

    return StreamingResponse(event_stream(), media_type="text/event-stream")


# ── Agent Mode (Autonomous coding loop) ──────────────────────────────────

AGENT_TOOLS_DESC = """Tu as acces aux outils suivants. Reponds UNIQUEMENT avec un bloc JSON pour executer un outil, ou du texte normal pour repondre a l'utilisateur.

Outils disponibles (reponds avec ```json {"tool": "nom", "args": {...}} ``` pour les utiliser):

1. read_file(path) — Lire un fichier du workspace
2. write_file(path, content) — Ecrire/creer un fichier
3. run_command(command) — Executer une commande shell
4. search(query) — Chercher dans le workspace
5. list_files(path) — Lister les fichiers d'un dossier

Quand tu as fini, reponds normalement sans bloc JSON outil.
Chaque etape, explique brievement ce que tu fais et pourquoi."""


class AgentRequest(BaseModel):
    task: str
    file_path: Optional[str] = None
    provider_name: Optional[str] = None
    model_name: Optional[str] = None
    max_steps: int = 10


@router.post("/ai/agent")
async def ai_agent_run(req: AgentRequest):
    """
    Agentic coding mode: the AI plans, executes tools, and iterates
    autonomously. Streams each step back via SSE.
    """
    try:
        from backend.core.providers import ChatMessage
    except ImportError as e:
        return {"ok": False, "error": f"Import error: {e}"}

    provider, chosen_model, _err = await _resolve_user_provider(req.provider_name, req.model_name)
    if _err or not provider or not chosen_model:
        return {"ok": False, "error": _err or "Aucun provider LLM configuré"}

    ws = _workspace()

    # Build agent system prompt
    system_prompt = (
        "Tu es un agent de programmation autonome integre dans SpearCode IDE.\n"
        "Tu peux lire, ecrire des fichiers, executer des commandes et chercher dans le code.\n"
        "Reponds en francais. Sois methodique: analyse → plan → execute → verifie.\n"
        f"\nWorkspace: {ws.name} ({_detect_language(ws)})\n"
        f"{AGENT_TOOLS_DESC}"
    )

    # Add file context if provided
    if req.file_path:
        try:
            target = _safe_path(req.file_path)
            if target.exists() and _is_text_file(target):
                content = target.read_text(encoding="utf-8")[:4000]
                lang = LANG_MAP.get(target.suffix.lower(), "text")
                system_prompt += f"\n\nFichier actif: {req.file_path}\n```{lang}\n{content}\n```"
        except Exception:
            pass

    conversation = [
        ChatMessage(role="system", content=system_prompt),
        ChatMessage(role="user", content=req.task),
    ]

    max_steps = min(max(req.max_steps, 1), 15)

    async def agent_stream():
        nonlocal conversation
        steps_done = 0

        yield f"data: {json.dumps({'type': 'start', 'task': req.task, 'max_steps': max_steps}, ensure_ascii=False)}\n\n"

        for step in range(max_steps):
            steps_done = step + 1

            # Get AI response
            yield f"data: {json.dumps({'type': 'thinking', 'step': steps_done}, ensure_ascii=False)}\n\n"

            try:
                response = await provider.chat(conversation, chosen_model)
                ai_text = response.content or ""
            except Exception as e:
                yield f"data: {json.dumps({'type': 'error', 'error': str(e)[:200]}, ensure_ascii=False)}\n\n"
                break

            conversation.append(ChatMessage(role="assistant", content=ai_text))

            # Try to extract tool call
            tool_call = _extract_tool_call(ai_text)

            if tool_call:
                tool_name = tool_call.get("tool", "")
                tool_args = tool_call.get("args", {})

                yield f"data: {json.dumps({'type': 'tool_call', 'step': steps_done, 'tool': tool_name, 'args': tool_args, 'reasoning': ai_text.split('```')[0].strip()}, ensure_ascii=False)}\n\n"

                # Execute the tool
                result = await _execute_agent_tool(tool_name, tool_args, ws)

                yield f"data: {json.dumps({'type': 'tool_result', 'step': steps_done, 'tool': tool_name, 'result': result[:2000]}, ensure_ascii=False)}\n\n"

                # Feed result back to AI
                conversation.append(ChatMessage(
                    role="user",
                    content=f"Resultat de {tool_name}:\n{result[:3000]}\n\nContinue ta tache. Si tu as fini, reponds normalement sans outil."
                ))
            else:
                # No tool call — AI is done
                yield f"data: {json.dumps({'type': 'response', 'step': steps_done, 'content': ai_text}, ensure_ascii=False)}\n\n"
                break

        yield f"data: {json.dumps({'type': 'done', 'steps': steps_done}, ensure_ascii=False)}\n\n"

    return StreamingResponse(agent_stream(), media_type="text/event-stream")


def _extract_tool_call(text: str) -> Optional[dict]:
    """Extract a JSON tool call from AI response text."""
    # Look for ```json {...} ``` blocks
    import re
    matches = re.findall(r'```(?:json)?\s*(\{[^`]+\})\s*```', text, re.DOTALL)
    for match in matches:
        try:
            data = json.loads(match)
            if "tool" in data:
                return data
        except json.JSONDecodeError:
            continue
    # Also try inline JSON
    matches = re.findall(r'\{["\']tool["\']\s*:\s*["\'](\w+)["\'].*?\}', text, re.DOTALL)
    if matches:
        try:
            # Find the full JSON object
            start = text.find('{"tool"')
            if start == -1:
                start = text.find("{'tool'")
            if start >= 0:
                # Find matching brace
                depth = 0
                for i in range(start, len(text)):
                    if text[i] == '{': depth += 1
                    elif text[i] == '}': depth -= 1
                    if depth == 0:
                        return json.loads(text[start:i+1].replace("'", '"'))
        except (json.JSONDecodeError, ValueError):
            pass
    return None


async def _execute_agent_tool(tool_name: str, args: dict, ws: Path) -> str:
    """Execute an agent tool and return the result as text."""
    try:
        if tool_name == "read_file":
            path = args.get("path", "")
            target = (ws / path).resolve()
            if not str(target).startswith(str(ws.resolve())):
                return "ERREUR: Chemin hors du workspace"
            if not target.exists():
                return f"ERREUR: Fichier introuvable: {path}"
            if not _is_text_file(target):
                return "ERREUR: Fichier binaire"
            content = target.read_text(encoding="utf-8")
            return f"Contenu de {path} ({len(content)} chars, {content.count(chr(10))+1} lignes):\n{content[:6000]}"

        elif tool_name == "write_file":
            path = args.get("path", "")
            content = args.get("content", "")
            target = (ws / path).resolve()
            if not str(target).startswith(str(ws.resolve())):
                return "ERREUR: Chemin hors du workspace"
            # Auto-version before writing
            if target.exists():
                old_content = target.read_text(encoding="utf-8")
                vdir = VERSIONS_DIR / path.replace("/", "__").replace("\\", "__")
                vdir.mkdir(parents=True, exist_ok=True)
                ts = datetime.now().strftime("%Y%m%d_%H%M%S_%f")
                (vdir / f"{ts}.txt").write_text(old_content, encoding="utf-8")
                (vdir / f"{ts}.json").write_text(json.dumps({
                    "timestamp": datetime.now().isoformat(),
                    "label": "Avant ecriture agent",
                    "file_path": path, "lines": old_content.count("\n")+1, "size": len(old_content),
                }, ensure_ascii=False), encoding="utf-8")
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(content, encoding="utf-8")
            return f"OK: {path} ecrit ({len(content)} chars)"

        elif tool_name == "run_command":
            command = args.get("command", "")
            if not command:
                return "ERREUR: Commande vide"
            import platform
            if platform.system() == "Windows":
                proc = await asyncio.create_subprocess_exec(
                    "cmd.exe", "/c", command,
                    stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
                    cwd=str(ws),
                )
            else:
                proc = await asyncio.create_subprocess_exec(
                    "/bin/bash", "-c", command,
                    stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
                    cwd=str(ws),
                )
            stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=30)
            out = stdout.decode("utf-8", errors="replace")[:3000]
            err = stderr.decode("utf-8", errors="replace")[:1000]
            return f"Exit code: {proc.returncode}\nStdout:\n{out}\n{f'Stderr:\n{err}' if err else ''}"

        elif tool_name == "search":
            query = args.get("query", "")
            if not query:
                return "ERREUR: Requete vide"
            results = []
            q_lower = query.lower()
            for root, dirs, files in os.walk(ws):
                dirs[:] = [d for d in dirs if d not in IGNORE_DIRS and not d.startswith(".")]
                for f in files:
                    if len(results) >= 10:
                        break
                    fp = Path(root) / f
                    rel = str(fp.relative_to(ws)).replace("\\", "/")
                    if q_lower in f.lower():
                        results.append(f"[Fichier] {rel}")
                    elif _is_text_file(fp) and fp.stat().st_size < 500_000:
                        try:
                            content = fp.read_text(encoding="utf-8")
                            if q_lower in content.lower():
                                idx = content.lower().find(q_lower)
                                snippet = content[max(0,idx-30):idx+len(query)+30].replace("\n", " ")
                                results.append(f"[Match] {rel}: ...{snippet}...")
                        except Exception:
                            pass
            return f"Resultats pour '{query}' ({len(results)}):\n" + "\n".join(results) if results else f"Aucun resultat pour '{query}'"

        elif tool_name == "list_files":
            path = args.get("path", "")
            target = (ws / path).resolve() if path else ws
            if not str(target).startswith(str(ws.resolve())):
                return "ERREUR: Chemin hors du workspace"
            if not target.is_dir():
                return "ERREUR: Pas un dossier"
            items = []
            for item in sorted(target.iterdir(), key=lambda x: (not x.is_dir(), x.name.lower())):
                if item.name.startswith(".") or item.name in IGNORE_DIRS:
                    continue
                rel = str(item.relative_to(ws)).replace("\\", "/")
                if item.is_dir():
                    items.append(f"  [D] {rel}/")
                else:
                    items.append(f"  [F] {rel} ({item.stat().st_size}o)")
            return f"Contenu de {path or '.'}:\n" + "\n".join(items[:50])

        else:
            return f"ERREUR: Outil inconnu: {tool_name}"

    except Exception as e:
        return f"ERREUR: {str(e)[:200]}"


# ═══════════════════════════════════════════════════════════════════════════════
# AI Commit Message Generator
# ═══════════════════════════════════════════════════════════════════════════════

class AICommitRequest(BaseModel):
    diff: str
    provider_name: Optional[str] = None
    model_name: Optional[str] = None


@router.post("/git/ai-commit-message")
async def generate_commit_message(req: AICommitRequest):
    """Generate a commit message from git diff using AI."""
    try:
        from backend.core.providers import ChatMessage
    except ImportError as e:
        return {"ok": False, "error": f"Import error: {e}"}

    provider, chosen_model, _err = await _resolve_user_provider(req.provider_name, req.model_name)
    if _err or not provider or not chosen_model:
        return {"ok": False, "error": _err or "Aucun provider LLM configuré"}

    messages = [
        ChatMessage(role="system", content=(
            "Tu generes des messages de commit Git concis et precis en anglais.\n"
            "Format: type(scope): description\n"
            "Types: feat, fix, refactor, docs, style, test, chore, perf\n"
            "- Premiere ligne: max 72 caracteres\n"
            "- Optionnel: ligne vide + description detaillee\n"
            "Reponds UNIQUEMENT avec le message de commit, rien d'autre."
        )),
        ChatMessage(role="user", content=f"Genere un message de commit pour ce diff:\n\n{req.diff[:6000]}"),
    ]

    try:
        response = await provider.chat(messages, chosen_model)
        msg = (response.content or "").strip()
        # Clean up: remove markdown code blocks if present
        if msg.startswith("```"):
            msg = msg.split("\n", 1)[-1].rsplit("```", 1)[0].strip()
        return {"ok": True, "message": msg}
    except Exception as e:
        return {"ok": False, "error": str(e)[:200]}


# ═══════════════════════════════════════════════════════════════════════════════
# Code Actions (contextual AI actions on selection)
# ═══════════════════════════════════════════════════════════════════════════════

class CodeActionRequest(BaseModel):
    action: str         # "explain" | "refactor" | "tests" | "document" | "optimize" | "fix"
    code: str           # selected code
    file_path: Optional[str] = None
    language: Optional[str] = None
    provider_name: Optional[str] = None
    model_name: Optional[str] = None


CODE_ACTION_PROMPTS = {
    "explain": "Explique ce code en detail. Que fait-il, comment, et pourquoi ? Mentionne les edge cases potentiels.",
    "refactor": "Refactorise ce code pour ameliorer sa lisibilite, maintenabilite et performance. Garde la meme fonctionnalite. Montre le code refactorise dans un bloc ```.",
    "tests": "Genere des tests unitaires exhaustifs pour ce code. Couvre le happy path, les edge cases et les erreurs. Utilise le framework de test standard du langage.",
    "document": "Ajoute une documentation complete a ce code : docstrings/JSDoc, commentaires inline pour les parties complexes, et un resume en tete.",
    "optimize": "Analyse et optimise ce code pour la performance. Identifie les goulots, propose des ameliorations avec le code optimise dans un bloc ```.",
    "fix": "Analyse ce code pour des bugs potentiels. Identifie les problemes et propose des corrections avec le code corrige dans un bloc ```.",
}


@router.post("/ai/code-action")
async def ai_code_action(req: CodeActionRequest):
    """Execute a contextual AI action on selected code."""
    try:
        from backend.core.providers import ChatMessage
    except ImportError as e:
        return {"ok": False, "error": f"Import error: {e}"}

    provider, chosen_model, _err = await _resolve_user_provider(req.provider_name, req.model_name)
    if _err or not provider or not chosen_model:
        return {"ok": False, "error": _err or "Aucun provider LLM configuré"}

    action_prompt = CODE_ACTION_PROMPTS.get(req.action, f"Action: {req.action}")
    lang = req.language or "text"
    file_info = f" (fichier: {req.file_path})" if req.file_path else ""

    messages = [
        ChatMessage(role="system", content=f"Assistant de programmation. Reponds en francais. Code dans des blocs ```{lang}."),
        ChatMessage(role="user", content=f"{action_prompt}\n\nCode ({lang}{file_info}):\n```{lang}\n{req.code[:6000]}\n```"),
    ]

    try:
        response = await provider.chat(messages, chosen_model)
        return {"ok": True, "response": response.content or "", "action": req.action}
    except Exception as e:
        return {"ok": False, "error": str(e)[:200]}


# ═══════════════════════════════════════════════════════════════════════════════
# Multi-file context support
# ═══════════════════════════════════════════════════════════════════════════════

class MultiFileContextRequest(BaseModel):
    message: str
    files: list[dict] = []          # [{path, content?}] — up to 5 files
    persona: Optional[str] = None
    provider_name: Optional[str] = None
    model_name: Optional[str] = None
    context_mode: str = "smart"
    history: list[dict] = []


@router.post("/ai/chat/multi")
async def ai_multi_file_chat(req: MultiFileContextRequest):
    """AI chat with multiple file contexts."""
    try:
        from backend.core.providers import ChatMessage
    except ImportError as e:
        return {"ok": False, "error": f"Import error: {e}"}

    provider, chosen_model, _err = await _resolve_user_provider(req.provider_name, req.model_name)
    if _err or not provider or not chosen_model:
        return {"ok": False, "error": _err or "Aucun provider LLM configuré"}

    system_parts = [
        "Assistant de programmation IDE multi-fichiers. Reponds en francais, concis et technique.",
        "Code dans des blocs ```language.",
    ]

    persona = None
    if req.persona and req.persona in CODING_PERSONAS:
        persona = CODING_PERSONAS[req.persona]
        system_parts.append(f"\n[Persona: {persona['icon']} {persona['name']}]\n{persona['system_prompt']}")

    # Load .spearcode project rules if available
    ws = _workspace()
    rules_file = ws / ".spearcode"
    if rules_file.exists():
        try:
            rules = rules_file.read_text(encoding="utf-8")[:1500]
            system_parts.append(f"\n[Regles projet .spearcode]\n{rules}")
        except Exception:
            pass

    # Add multi-file context
    total_ctx_chars = 0
    max_ctx = 8000  # total budget for all files
    per_file_budget = max_ctx // max(len(req.files), 1)

    for f_info in req.files[:5]:  # max 5 files
        fpath = f_info.get("path", "")
        if not fpath:
            continue
        try:
            target = _safe_path(fpath)
            if not target.exists() or not _is_text_file(target):
                continue
            content = f_info.get("content") or target.read_text(encoding="utf-8")
            lang = LANG_MAP.get(target.suffix.lower(), "text")
            lines = content.count("\n") + 1

            if req.context_mode == "smart":
                ctx = _extract_relevant_context(content, req.message, lang, per_file_budget)
            elif req.context_mode == "full":
                ctx = content[:per_file_budget]
            else:
                ctx = content[:per_file_budget]

            if total_ctx_chars + len(ctx) > max_ctx:
                ctx = ctx[:max_ctx - total_ctx_chars]
            total_ctx_chars += len(ctx)
            system_parts.append(f"\nFichier: {fpath} ({lang}, {lines}L)\n```{lang}\n{ctx}\n```")
        except Exception:
            pass

    fw = _detect_framework(ws)
    system_parts.append(f"\nProjet: {ws.name} ({_detect_language(ws)}{', ' + fw if fw else ''})")

    system_prompt = "\n".join(system_parts)
    messages = [ChatMessage(role="system", content=system_prompt)]

    # History
    history_chars = 0
    for h in reversed(req.history[-8:]):
        hl = len(h.get("content", ""))
        if history_chars + hl > 2000:
            break
        messages.insert(1, ChatMessage(role=h["role"], content=h["content"]))
        history_chars += hl
    messages.append(ChatMessage(role="user", content=req.message))

    try:
        response = await provider.chat(messages, chosen_model)
        return {
            "ok": True,
            "response": response.content or "",
            "model": chosen_model,
            "files_used": len(req.files),
        }
    except Exception as e:
        return {"ok": False, "error": str(e)[:200]}


# ═══════════════════════════════════════════════════════════════════════════════
# .spearcode Project Rules
# ═══════════════════════════════════════════════════════════════════════════════

@router.get("/project-rules")
async def get_project_rules():
    """Get .spearcode project rules file."""
    ws = _workspace()
    rules_file = ws / ".spearcode"
    if rules_file.exists():
        try:
            content = rules_file.read_text(encoding="utf-8")
            return {"ok": True, "content": content, "exists": True}
        except Exception as e:
            return {"ok": False, "error": str(e)}
    return {"ok": True, "content": "", "exists": False}


@router.put("/project-rules")
async def save_project_rules(data: dict):
    """Save .spearcode project rules file."""
    ws = _workspace()
    rules_file = ws / ".spearcode"
    content = data.get("content", "")
    try:
        rules_file.write_text(content, encoding="utf-8")
        return {"ok": True}
    except Exception as e:
        return {"ok": False, "error": str(e)}


# ═══════════════════════════════════════════════════════════════════════════════
# Snippets Library
# ═══════════════════════════════════════════════════════════════════════════════

SNIPPETS_FILE = Path("data/code_snippets.json")


def _load_snippets() -> list[dict]:
    if SNIPPETS_FILE.exists():
        try:
            return json.loads(SNIPPETS_FILE.read_text(encoding="utf-8"))
        except Exception:
            pass
    return []


def _save_snippets(snippets: list[dict]):
    SNIPPETS_FILE.parent.mkdir(parents=True, exist_ok=True)
    SNIPPETS_FILE.write_text(json.dumps(snippets, indent=2, ensure_ascii=False), encoding="utf-8")


@router.get("/snippets")
async def list_snippets(language: str = ""):
    """List all code snippets, optionally filtered by language."""
    snippets = _load_snippets()
    if language:
        snippets = [s for s in snippets if s.get("language") == language]
    return {"snippets": snippets}


@router.post("/snippets")
async def create_snippet(data: dict):
    """Create a new code snippet."""
    snippets = _load_snippets()
    snippet = {
        "id": str(uuid.uuid4())[:8],
        "name": data.get("name", "Sans nom"),
        "language": data.get("language", "text"),
        "code": data.get("code", ""),
        "description": data.get("description", ""),
        "tags": data.get("tags", []),
        "created": datetime.now().isoformat(),
    }
    snippets.insert(0, snippet)
    if len(snippets) > 100:
        snippets = snippets[:100]
    _save_snippets(snippets)
    return {"ok": True, "snippet": snippet}


@router.delete("/snippets/{snippet_id}")
async def delete_snippet(snippet_id: str):
    """Delete a snippet by ID."""
    snippets = _load_snippets()
    snippets = [s for s in snippets if s.get("id") != snippet_id]
    _save_snippets(snippets)
    return {"ok": True}
