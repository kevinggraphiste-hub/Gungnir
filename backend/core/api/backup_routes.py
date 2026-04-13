"""
Gungnir — Backup & Restore API Routes
"""
import json
import logging
import shutil
import zipfile
from datetime import datetime
from pathlib import Path
from fastapi import APIRouter

router = APIRouter()
logger = logging.getLogger("gungnir")

PROJECT_ROOT = Path(__file__).parent.parent.parent.parent
DATA_DIR = PROJECT_ROOT / "data"
BACKEND_DATA_DIR = PROJECT_ROOT / "backend" / "data"
BACKUPS_DIR = DATA_DIR / "backups"
CONFIG_FILE = DATA_DIR / "backup_config.json"

# Files to include in backups (gungnir.db only if SQLite is used)
BACKUP_TARGETS = [
    DATA_DIR / "config.json",
    DATA_DIR / "agent_mode.json",
    DATA_DIR / "agents.json",
    DATA_DIR / "heartbeat.json",
    DATA_DIR / "personalities.json",
    BACKEND_DATA_DIR / "skills.json",
    BACKEND_DATA_DIR / "personalities.json",
]

# Add SQLite DB only if not using PostgreSQL
def _get_backup_targets() -> list[Path]:
    targets = list(BACKUP_TARGETS)
    from backend.core.db.engine import DATABASE_URL
    if "postgresql" not in DATABASE_URL and "asyncpg" not in DATABASE_URL:
        db_path = DATA_DIR / "gungnir.db"
        if db_path.exists():
            targets.append(db_path)
    return targets


def _load_config() -> dict:
    defaults = {
        "provider": "local",
        "auto_daily": False,
        "max_backups": 10,
        "supabase_url": "",
        "supabase_key": "",
        "supabase_bucket": "gungnir-backups",
        "github_token": "",
        "github_repo": "",
        "github_branch": "backups",
    }
    if CONFIG_FILE.exists():
        try:
            data = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
            return {**defaults, **data}
        except Exception:
            pass
    return defaults


def _save_config(cfg: dict):
    CONFIG_FILE.parent.mkdir(parents=True, exist_ok=True)
    CONFIG_FILE.write_text(json.dumps(cfg, indent=2, ensure_ascii=False), encoding="utf-8")


def _enforce_max_backups(max_backups: int):
    """Delete oldest backups if over limit."""
    if not BACKUPS_DIR.exists():
        return
    zips = sorted(BACKUPS_DIR.glob("*.zip"), key=lambda p: p.stat().st_mtime)
    while len(zips) > max_backups:
        zips.pop(0).unlink()


@router.get("/backup/config")
async def get_backup_config():
    config = _load_config()
    # Mask secrets in response
    safe_config = dict(config)
    for secret_key in ("github_token", "supabase_key"):
        if safe_config.get(secret_key):
            safe_config[secret_key] = "***" + safe_config[secret_key][-4:] if len(safe_config[secret_key]) > 4 else "***"
    return safe_config


@router.put("/backup/config")
async def update_backup_config(data: dict):
    cfg = _load_config()
    cfg.update(data)
    _save_config(cfg)
    return cfg


@router.get("/backup/history")
async def backup_history():
    BACKUPS_DIR.mkdir(parents=True, exist_ok=True)
    backups = []
    for f in sorted(BACKUPS_DIR.glob("*.zip"), key=lambda p: p.stat().st_mtime, reverse=True):
        stat = f.stat()
        backups.append({
            "filename": f.name,
            "size_mb": round(stat.st_size / (1024 * 1024), 2),
            "created_at": datetime.fromtimestamp(stat.st_mtime).isoformat(),
            "provider": "local",
        })
    return {"backups": backups}


@router.post("/backup/now")
async def create_backup_now():
    """Create a zip backup of all data files."""
    try:
        BACKUPS_DIR.mkdir(parents=True, exist_ok=True)
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        filename = f"gungnir_backup_{timestamp}.zip"
        zip_path = BACKUPS_DIR / filename

        with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
            for target in _get_backup_targets():
                if target.exists():
                    arcname = str(target.relative_to(PROJECT_ROOT))
                    zf.write(target, arcname)

        # Enforce max backups
        cfg = _load_config()
        _enforce_max_backups(cfg.get("max_backups", 10))

        size_mb = round(zip_path.stat().st_size / (1024 * 1024), 2)
        return {"ok": True, "filename": filename, "size_mb": size_mb}
    except Exception as e:
        import logging; logging.getLogger("gungnir").error(f"Backup error: {e}")
        return {"ok": False, "error": "Erreur lors de la création du backup"}


@router.post("/backup/restore")
async def restore_backup(data: dict):
    """Restore data files from a chosen backup zip."""
    filename = data.get("filename", "")
    if not filename:
        return {"ok": False, "error": "Nom de fichier requis"}

    zip_path = BACKUPS_DIR / filename
    if not zip_path.exists() or not zip_path.name.endswith(".zip"):
        return {"ok": False, "error": "Backup introuvable"}

    # Security: ensure the path is within BACKUPS_DIR
    try:
        zip_path.resolve().relative_to(BACKUPS_DIR.resolve())
    except ValueError:
        return {"ok": False, "error": "Chemin non autorisé"}

    try:
        with zipfile.ZipFile(zip_path, "r") as zf:
            # Security: check for zip bombs (max 100MB uncompressed)
            MAX_BACKUP_SIZE = 100 * 1024 * 1024  # 100MB max
            total_size = sum(info.file_size for info in zf.infolist())
            if total_size > MAX_BACKUP_SIZE:
                return {"ok": False, "error": f"Backup trop volumineux ({total_size // 1024 // 1024}MB > 100MB)"}

            # Security: check for path traversal in filenames
            for entry in zf.namelist():
                if ".." in entry or entry.startswith("/") or entry.startswith("\\"):
                    return {"ok": False, "error": f"Chemin suspect dans le backup: {entry}"}

            # Validate all entries are within expected paths
            for entry in zf.namelist():
                entry_path = (PROJECT_ROOT / entry).resolve()
                if not (
                    str(entry_path).startswith(str(DATA_DIR.resolve()))
                    or str(entry_path).startswith(str(BACKEND_DATA_DIR.resolve()))
                ):
                    return {"ok": False, "error": f"Fichier non autorisé dans le backup: {entry}"}

            # Extract all files to project root (preserving relative paths)
            zf.extractall(PROJECT_ROOT)

        # Reload singletons so changes take effect immediately
        try:
            from backend.core.agents.skills import skill_library, personality_manager, subagent_library
            skill_library.skills.clear()
            skill_library._load()
            personality_manager.personalities.clear()
            personality_manager._load()
            subagent_library.agents.clear()
            subagent_library._load()
        except Exception:
            pass

        return {"ok": True, "message": f"Restauration de {filename} réussie."}
    except Exception as e:
        import logging; logging.getLogger("gungnir").error(f"Restore error: {e}")
        return {"ok": False, "error": "Erreur lors de la restauration du backup"}


@router.delete("/backup/{filename}")
async def delete_backup(filename: str):
    """Delete a specific backup file."""
    zip_path = BACKUPS_DIR / filename
    if not zip_path.exists():
        return {"ok": False, "error": "Fichier introuvable"}

    # Security check
    try:
        zip_path.resolve().relative_to(BACKUPS_DIR.resolve())
    except ValueError:
        return {"ok": False, "error": "Chemin non autorisé"}

    zip_path.unlink()
    return {"ok": True}
