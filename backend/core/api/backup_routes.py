"""
Gungnir — Backup & Restore API Routes

Per-user logical backup system:

- Each user has their own backup directory `data/backups/<uid>/` and their own
  config file `data/backups/<uid>/config.json`. A regular user can list,
  create, delete and restore **their own** backups — nothing more.
- A backup is a zip containing `manifest.json`, `db_export.json` (a JSON dump
  of the user's rows across every per-user table) and `files/` (the user's
  per-user filesystem tree: automata, workspace, soul, kb, consciousness,
  etc.).
- Restore is destructive for the calling user: their existing rows in the
  user-scoped tables are deleted and re-inserted from the backup with fresh
  primary keys (an old_id → new_id map rewrites foreign-keys like
  messages.conversation_id). Files under their per-user directories are
  replaced.
- A separate admin endpoint `/backup/admin/now` still produces a legacy
  full-instance zip (global config.json + shared SQLite DB) for disaster
  recovery / VPS migration.
"""
import io
import json
import logging
import shutil
import zipfile
from datetime import datetime, date
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.core.db.engine import get_session
from backend.core.db.models import (
    User,
    UserSettings,
    Conversation,
    ConversationFolder,
    ConversationTag,
    ConversationTagLink,
    ConversationTask,
    Message,
    AgentTask,
    CostAnalytics,
    BudgetSettings,
    ProviderBudget,
    UserSkill,
    UserPersonality,
    UserSubAgent,
    MCPServerConfig,
)
from backend.core.api.auth_helpers import require_admin

router = APIRouter()
logger = logging.getLogger("gungnir")

PROJECT_ROOT = Path(__file__).parent.parent.parent.parent
DATA_DIR = PROJECT_ROOT / "data"
BACKEND_DATA_DIR = PROJECT_ROOT / "backend" / "data"
BACKUPS_ROOT = DATA_DIR / "backups"


# ── Legacy full-instance backup targets (admin-only path) ───────────────────
LEGACY_BACKUP_TARGETS = [
    DATA_DIR / "config.json",
    DATA_DIR / "agent_mode.json",
    DATA_DIR / "agents.json",
    DATA_DIR / "heartbeat.json",
    DATA_DIR / "personalities.json",
    BACKEND_DATA_DIR / "skills.json",
    BACKEND_DATA_DIR / "personalities.json",
]


def _legacy_backup_targets() -> list[Path]:
    targets = list(LEGACY_BACKUP_TARGETS)
    from backend.core.db.engine import DATABASE_URL
    if "postgresql" not in DATABASE_URL and "asyncpg" not in DATABASE_URL:
        db_path = DATA_DIR / "gungnir.db"
        if db_path.exists():
            targets.append(db_path)
    return targets


# ── Per-user filesystem layout ───────────────────────────────────────────────

def _user_backup_dir(uid: int) -> Path:
    d = BACKUPS_ROOT / str(uid)
    d.mkdir(parents=True, exist_ok=True)
    return d


def _user_config_file(uid: int) -> Path:
    return _user_backup_dir(uid) / "config.json"


def _load_user_config(uid: int) -> dict:
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
    f = _user_config_file(uid)
    if f.exists():
        try:
            data = json.loads(f.read_text(encoding="utf-8"))
            return {**defaults, **(data or {})}
        except Exception:
            pass
    return defaults


def _save_user_config(uid: int, cfg: dict) -> None:
    f = _user_config_file(uid)
    f.parent.mkdir(parents=True, exist_ok=True)
    f.write_text(json.dumps(cfg, indent=2, ensure_ascii=False), encoding="utf-8")


def _enforce_max_backups(uid: int, max_backups: int) -> None:
    d = _user_backup_dir(uid)
    zips = sorted(d.glob("*.zip"), key=lambda p: p.stat().st_mtime)
    while len(zips) > max_backups:
        victim = zips.pop(0)
        try:
            victim.unlink()
        except Exception as e:
            logger.warning(f"Could not delete old backup {victim}: {e}")


# Per-user filesystem locations the backup captures. Each entry is a directory
# under DATA_DIR containing a single `<uid>/` subfolder. A user's backup only
# picks up files inside those subfolders, so two users never see each other's
# data in their zips.
_USER_DATA_ROOTS = [
    "automata",
    "consciousness",
    "heartbeat",
    "integrations",
    "kb",
    "soul",
    "webhooks",
    "workspace",
    "skills",
    "personalities",
]


def _user_files_to_archive(uid: int) -> list[tuple[Path, str]]:
    """Return (abs_path, arcname) pairs for every file belonging to this user.

    ``arcname`` is relative to ``files/`` inside the zip; restore uses it to
    know where to put the file back under ``data/``.
    """
    out: list[tuple[Path, str]] = []
    uid_str = str(uid)
    for root in _USER_DATA_ROOTS:
        root_dir = DATA_DIR / root / uid_str
        if not root_dir.exists() or not root_dir.is_dir():
            continue
        for p in root_dir.rglob("*"):
            if p.is_file():
                try:
                    rel = p.relative_to(DATA_DIR)
                    out.append((p, str(rel).replace("\\", "/")))
                except Exception:
                    continue

    code_cfg = DATA_DIR / "code_configs" / f"{uid}.json"
    if code_cfg.exists():
        out.append((code_cfg, f"code_configs/{uid}.json"))
    return out


# ── DB export / import ──────────────────────────────────────────────────────

def _row_to_dict(row) -> dict:
    """Serialize a SQLAlchemy ORM row into a JSON-safe dict."""
    data = {}
    for col in row.__table__.columns:
        value = getattr(row, col.name)
        if isinstance(value, (datetime, date)):
            data[col.name] = value.isoformat()
        else:
            data[col.name] = value
    return data


def _parse_value(col, value):
    """Reverse of _row_to_dict for a single column."""
    if value is None:
        return None
    from sqlalchemy import Date, DateTime
    col_type = col.type
    if isinstance(col_type, DateTime) and isinstance(value, str):
        try:
            return datetime.fromisoformat(value.replace("Z", "+00:00"))
        except Exception:
            return None
    if isinstance(col_type, Date) and isinstance(value, str):
        try:
            return date.fromisoformat(value[:10])
        except Exception:
            return None
    return value


async def _export_user_db(session: AsyncSession, uid: int) -> dict:
    """Dump every user-scoped row for ``uid`` as JSON-ready dicts.

    Non user-scoped tables (messages, conversation_tasks, agent_tasks,
    conversation_tag_links) are pulled via the user's conversations.
    """
    export: dict[str, list[dict]] = {}

    # User row itself (for informational purposes — not restored)
    user_row = await session.get(User, uid)
    export["users"] = [_row_to_dict(user_row)] if user_row else []

    # Direct user-scoped tables
    for label, model, col in [
        ("user_settings", UserSettings, UserSettings.user_id),
        ("conversation_folders", ConversationFolder, ConversationFolder.user_id),
        ("conversation_tags", ConversationTag, ConversationTag.user_id),
        ("conversations", Conversation, Conversation.user_id),
        ("user_skills", UserSkill, UserSkill.user_id),
        ("user_personalities", UserPersonality, UserPersonality.user_id),
        ("user_sub_agents", UserSubAgent, UserSubAgent.user_id),
        ("mcp_server_configs", MCPServerConfig, MCPServerConfig.user_id),
        ("cost_analytics", CostAnalytics, CostAnalytics.user_id),
        ("budget_settings", BudgetSettings, BudgetSettings.user_id),
        ("provider_budgets", ProviderBudget, ProviderBudget.user_id),
    ]:
        result = await session.execute(select(model).where(col == uid))
        export[label] = [_row_to_dict(r) for r in result.scalars().all()]

    # User's conversation IDs, used to scope child tables
    convo_ids = [c["id"] for c in export["conversations"]]
    if convo_ids:
        messages_result = await session.execute(
            select(Message).where(Message.conversation_id.in_(convo_ids))
        )
        export["messages"] = [_row_to_dict(r) for r in messages_result.scalars().all()]

        tasks_result = await session.execute(
            select(ConversationTask).where(ConversationTask.conversation_id.in_(convo_ids))
        )
        export["conversation_tasks"] = [_row_to_dict(r) for r in tasks_result.scalars().all()]

        agent_tasks_result = await session.execute(
            select(AgentTask).where(AgentTask.conversation_id.in_(convo_ids))
        )
        export["agent_tasks"] = [_row_to_dict(r) for r in agent_tasks_result.scalars().all()]

        tag_links_result = await session.execute(
            select(ConversationTagLink).where(ConversationTagLink.conversation_id.in_(convo_ids))
        )
        export["conversation_tag_links"] = [
            _row_to_dict(r) for r in tag_links_result.scalars().all()
        ]
    else:
        export["messages"] = []
        export["conversation_tasks"] = []
        export["agent_tasks"] = []
        export["conversation_tag_links"] = []

    return export


async def _delete_user_db(session: AsyncSession, uid: int) -> None:
    """Destructive: wipe every user-scoped row for ``uid``.

    Order matters: dependent rows are removed before their parents. ``messages``,
    ``conversation_tasks``, ``agent_tasks`` and ``conversation_tag_links`` are
    resolved by joining against the user's conversations first.
    """
    convo_id_result = await session.execute(
        select(Conversation.id).where(Conversation.user_id == uid)
    )
    convo_ids = [row[0] for row in convo_id_result.all()]

    if convo_ids:
        await session.execute(delete(Message).where(Message.conversation_id.in_(convo_ids)))
        await session.execute(
            delete(ConversationTask).where(ConversationTask.conversation_id.in_(convo_ids))
        )
        await session.execute(delete(AgentTask).where(AgentTask.conversation_id.in_(convo_ids)))
        await session.execute(
            delete(ConversationTagLink).where(ConversationTagLink.conversation_id.in_(convo_ids))
        )

    # Direct user-scoped tables
    for model, col in [
        (CostAnalytics, CostAnalytics.user_id),
        (BudgetSettings, BudgetSettings.user_id),
        (ProviderBudget, ProviderBudget.user_id),
        (Conversation, Conversation.user_id),
        (ConversationFolder, ConversationFolder.user_id),
        (ConversationTag, ConversationTag.user_id),
        (UserSkill, UserSkill.user_id),
        (UserPersonality, UserPersonality.user_id),
        (UserSubAgent, UserSubAgent.user_id),
        (MCPServerConfig, MCPServerConfig.user_id),
        (UserSettings, UserSettings.user_id),
    ]:
        await session.execute(delete(model).where(col == uid))


async def _import_user_db(session: AsyncSession, uid: int, export: dict) -> dict:
    """Re-insert rows from ``export`` for user ``uid`` with fresh primary keys.

    Returns a report {table: row_count}. Foreign keys that reference another
    exported row (conversations → folders, messages → conversations, etc.) are
    rewritten via an old→new id map so the restore can't collide with other
    users' rows in the same tables.
    """
    counts: dict[str, int] = {}

    # Map from old exported IDs to the new IDs assigned at insert time
    folder_id_map: dict[int, int] = {}
    convo_id_map: dict[int, int] = {}
    tag_id_map: dict[int, int] = {}

    # ── conversation_folders (self-referencing via parent_id) ───────────
    folders = list(export.get("conversation_folders") or [])
    # Insert in order: parents before children. A single pass with retries is
    # enough because the hierarchy is shallow and we remap ids lazily.
    pending = folders[:]
    safety = 0
    while pending and safety < len(folders) * 3 + 5:
        safety += 1
        still_pending = []
        for row in pending:
            old_id = row.get("id")
            parent_old = row.get("parent_id")
            new_parent = None
            if parent_old is not None:
                if parent_old in folder_id_map:
                    new_parent = folder_id_map[parent_old]
                else:
                    still_pending.append(row)
                    continue
            kwargs = {c.name: _parse_value(c, row.get(c.name)) for c in ConversationFolder.__table__.columns}
            kwargs.pop("id", None)
            kwargs["user_id"] = uid
            kwargs["parent_id"] = new_parent
            inst = ConversationFolder(**kwargs)
            session.add(inst)
            await session.flush()
            folder_id_map[old_id] = inst.id
        pending = still_pending
    if pending:
        logger.warning(f"Restore: {len(pending)} folder(s) skipped (unresolved parent)")
    counts["conversation_folders"] = len(folders) - len(pending)

    # ── conversation_tags ───────────────────────────────────────────────
    for row in export.get("conversation_tags") or []:
        old_id = row.get("id")
        kwargs = {c.name: _parse_value(c, row.get(c.name)) for c in ConversationTag.__table__.columns}
        kwargs.pop("id", None)
        kwargs["user_id"] = uid
        inst = ConversationTag(**kwargs)
        session.add(inst)
        await session.flush()
        tag_id_map[old_id] = inst.id
    counts["conversation_tags"] = len(export.get("conversation_tags") or [])

    # ── user_settings (unique on user_id, so at most one row) ───────────
    for row in export.get("user_settings") or []:
        kwargs = {c.name: _parse_value(c, row.get(c.name)) for c in UserSettings.__table__.columns}
        kwargs.pop("id", None)
        kwargs["user_id"] = uid
        session.add(UserSettings(**kwargs))
    counts["user_settings"] = len(export.get("user_settings") or [])

    # ── user_skills / user_personalities / user_sub_agents ──────────────
    for label, model in [
        ("user_skills", UserSkill),
        ("user_personalities", UserPersonality),
        ("user_sub_agents", UserSubAgent),
    ]:
        rows = export.get(label) or []
        for row in rows:
            kwargs = {c.name: _parse_value(c, row.get(c.name)) for c in model.__table__.columns}
            kwargs.pop("id", None)
            kwargs["user_id"] = uid
            session.add(model(**kwargs))
        counts[label] = len(rows)

    # ── mcp_server_configs ──────────────────────────────────────────────
    for row in export.get("mcp_server_configs") or []:
        kwargs = {c.name: _parse_value(c, row.get(c.name)) for c in MCPServerConfig.__table__.columns}
        kwargs.pop("id", None)
        kwargs["user_id"] = uid
        session.add(MCPServerConfig(**kwargs))
    counts["mcp_server_configs"] = len(export.get("mcp_server_configs") or [])

    # ── budget_settings / provider_budgets ──────────────────────────────
    for row in export.get("budget_settings") or []:
        kwargs = {c.name: _parse_value(c, row.get(c.name)) for c in BudgetSettings.__table__.columns}
        kwargs.pop("id", None)
        kwargs["user_id"] = uid
        session.add(BudgetSettings(**kwargs))
    counts["budget_settings"] = len(export.get("budget_settings") or [])

    for row in export.get("provider_budgets") or []:
        kwargs = {c.name: _parse_value(c, row.get(c.name)) for c in ProviderBudget.__table__.columns}
        kwargs.pop("id", None)
        kwargs["user_id"] = uid
        session.add(ProviderBudget(**kwargs))
    counts["provider_budgets"] = len(export.get("provider_budgets") or [])

    # ── conversations (depend on folders) ───────────────────────────────
    for row in export.get("conversations") or []:
        old_id = row.get("id")
        old_folder = row.get("folder_id")
        kwargs = {c.name: _parse_value(c, row.get(c.name)) for c in Conversation.__table__.columns}
        kwargs.pop("id", None)
        kwargs["user_id"] = uid
        kwargs["folder_id"] = folder_id_map.get(old_folder) if old_folder is not None else None
        inst = Conversation(**kwargs)
        session.add(inst)
        await session.flush()
        convo_id_map[old_id] = inst.id
    counts["conversations"] = len(export.get("conversations") or [])

    # ── messages (depend on conversations) ──────────────────────────────
    for row in export.get("messages") or []:
        old_convo = row.get("conversation_id")
        if old_convo not in convo_id_map:
            continue
        kwargs = {c.name: _parse_value(c, row.get(c.name)) for c in Message.__table__.columns}
        kwargs.pop("id", None)
        kwargs["conversation_id"] = convo_id_map[old_convo]
        session.add(Message(**kwargs))
    counts["messages"] = len(export.get("messages") or [])

    # ── conversation_tasks (depend on conversations) ────────────────────
    for row in export.get("conversation_tasks") or []:
        old_convo = row.get("conversation_id")
        if old_convo not in convo_id_map:
            continue
        kwargs = {c.name: _parse_value(c, row.get(c.name)) for c in ConversationTask.__table__.columns}
        kwargs.pop("id", None)
        kwargs["conversation_id"] = convo_id_map[old_convo]
        session.add(ConversationTask(**kwargs))
    counts["conversation_tasks"] = len(export.get("conversation_tasks") or [])

    # ── agent_tasks ─────────────────────────────────────────────────────
    for row in export.get("agent_tasks") or []:
        old_convo = row.get("conversation_id")
        if old_convo is not None and old_convo not in convo_id_map:
            continue
        kwargs = {c.name: _parse_value(c, row.get(c.name)) for c in AgentTask.__table__.columns}
        kwargs.pop("id", None)
        if old_convo is not None:
            kwargs["conversation_id"] = convo_id_map[old_convo]
        session.add(AgentTask(**kwargs))
    counts["agent_tasks"] = len(export.get("agent_tasks") or [])

    # ── cost_analytics ──────────────────────────────────────────────────
    for row in export.get("cost_analytics") or []:
        old_convo = row.get("conversation_id")
        kwargs = {c.name: _parse_value(c, row.get(c.name)) for c in CostAnalytics.__table__.columns}
        kwargs.pop("id", None)
        kwargs["user_id"] = uid
        if old_convo is not None and old_convo in convo_id_map:
            kwargs["conversation_id"] = convo_id_map[old_convo]
        else:
            kwargs["conversation_id"] = None
        session.add(CostAnalytics(**kwargs))
    counts["cost_analytics"] = len(export.get("cost_analytics") or [])

    # ── conversation_tag_links (depend on conversations + tags) ─────────
    tl_rows = export.get("conversation_tag_links") or []
    tl_inserted = 0
    for row in tl_rows:
        old_convo = row.get("conversation_id")
        old_tag = row.get("tag_id")
        if old_convo not in convo_id_map or old_tag not in tag_id_map:
            continue
        session.add(ConversationTagLink(
            conversation_id=convo_id_map[old_convo],
            tag_id=tag_id_map[old_tag],
        ))
        tl_inserted += 1
    counts["conversation_tag_links"] = tl_inserted

    await session.commit()
    return counts


def _wipe_user_files(uid: int) -> None:
    """Delete every file under the user's per-user filesystem locations."""
    uid_str = str(uid)
    for root in _USER_DATA_ROOTS:
        d = DATA_DIR / root / uid_str
        if d.exists():
            try:
                shutil.rmtree(d)
            except Exception as e:
                logger.warning(f"Could not wipe {d}: {e}")
    code_cfg = DATA_DIR / "code_configs" / f"{uid}.json"
    if code_cfg.exists():
        try:
            code_cfg.unlink()
        except Exception as e:
            logger.warning(f"Could not remove {code_cfg}: {e}")


def _extract_user_files_from_zip(uid: int, zf: zipfile.ZipFile) -> int:
    """Extract every ``files/...`` entry from the zip back under DATA_DIR.

    Path traversal is refused; only entries whose destination stays inside
    DATA_DIR are written. Returns the count of extracted files.
    """
    count = 0
    data_dir_resolved = DATA_DIR.resolve()
    for entry in zf.infolist():
        if entry.is_dir():
            continue
        if not entry.filename.startswith("files/"):
            continue
        rel_path = entry.filename[len("files/"):]
        if not rel_path:
            continue
        dest = (DATA_DIR / rel_path).resolve()
        try:
            dest.relative_to(data_dir_resolved)
        except ValueError:
            logger.warning(f"Restore: refusing path-traversal entry {entry.filename}")
            continue
        dest.parent.mkdir(parents=True, exist_ok=True)
        with zf.open(entry) as src, open(dest, "wb") as dst:
            shutil.copyfileobj(src, dst)
        count += 1
    return count


# ── Auth helpers ────────────────────────────────────────────────────────────

async def _require_user_id(request: Request) -> Optional[int]:
    uid = getattr(request.state, "user_id", None)
    return int(uid) if uid else None


async def _ensure_admin(request: Request, session: AsyncSession):
    """Admin-only gate for the legacy full-instance endpoints."""
    if not await require_admin(request, session):
        return JSONResponse({"error": "Admin requis"}, status_code=403)
    return None


# ── Endpoints ───────────────────────────────────────────────────────────────

@router.get("/backup/config")
async def get_backup_config(request: Request):
    """Get the CURRENT user's backup config. Secrets are masked."""
    uid = await _require_user_id(request)
    if uid is None:
        return JSONResponse({"error": "Authentification requise"}, status_code=401)
    cfg = _load_user_config(uid)
    safe = dict(cfg)
    for secret_key in ("github_token", "supabase_key"):
        if safe.get(secret_key):
            value = safe[secret_key]
            safe[secret_key] = "***" + value[-4:] if len(value) > 4 else "***"
    return safe


@router.put("/backup/config")
async def update_backup_config(data: dict, request: Request):
    """Update the CURRENT user's backup config. Masked secrets are preserved."""
    uid = await _require_user_id(request)
    if uid is None:
        return JSONResponse({"error": "Authentification requise"}, status_code=401)
    current = _load_user_config(uid)
    for k, v in data.items():
        if k in ("github_token", "supabase_key") and isinstance(v, str) and v.startswith("***"):
            # Masked value — keep the existing secret
            continue
        current[k] = v
    _save_user_config(uid, current)
    return current


@router.get("/backup/history")
async def backup_history(request: Request):
    """List the current user's backup zips."""
    uid = await _require_user_id(request)
    if uid is None:
        return JSONResponse({"error": "Authentification requise"}, status_code=401)
    d = _user_backup_dir(uid)
    backups = []
    for f in sorted(d.glob("*.zip"), key=lambda p: p.stat().st_mtime, reverse=True):
        stat = f.stat()
        backups.append({
            "filename": f.name,
            "size_mb": round(stat.st_size / (1024 * 1024), 2),
            "created_at": datetime.fromtimestamp(stat.st_mtime).isoformat(),
            "provider": "local",
        })
    return {"backups": backups}


async def create_user_backup(session: AsyncSession, uid: int) -> dict:
    """Core per-user backup routine, shared between the HTTP endpoint and the
    nightly auto-backup daemon. Returns {ok, filename, size_mb, row_counts, file_count}
    or {ok: False, error} on failure.
    """
    try:
        export = await _export_user_db(session, uid)
        row_counts = {k: len(v) for k, v in export.items() if isinstance(v, list)}
        file_entries = _user_files_to_archive(uid)

        user_row = export["users"][0] if export.get("users") else {}
        username = user_row.get("username") or f"user{uid}"

        manifest = {
            "version": "3.0",
            "kind": "per_user",
            "user_id": uid,
            "username": username,
            "created_at": datetime.utcnow().isoformat() + "Z",
            "row_counts": row_counts,
            "file_count": len(file_entries),
        }

        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        filename = f"gungnir_user{uid}_{timestamp}.zip"
        out_dir = _user_backup_dir(uid)
        zip_path = out_dir / filename

        with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
            zf.writestr("manifest.json", json.dumps(manifest, indent=2, ensure_ascii=False))
            zf.writestr("db_export.json", json.dumps(export, indent=2, ensure_ascii=False, default=str))
            for abs_path, arcname in file_entries:
                try:
                    zf.write(abs_path, f"files/{arcname}")
                except Exception as e:
                    logger.warning(f"Could not archive {abs_path}: {e}")

        cfg = _load_user_config(uid)
        _enforce_max_backups(uid, int(cfg.get("max_backups") or 10))

        size_mb = round(zip_path.stat().st_size / (1024 * 1024), 2)
        return {
            "ok": True,
            "filename": filename,
            "size_mb": size_mb,
            "row_counts": row_counts,
            "file_count": len(file_entries),
        }
    except Exception as e:
        logger.error(f"Per-user backup failed for uid={uid}: {e}", exc_info=True)
        return {"ok": False, "error": "Erreur lors de la création du backup"}


@router.post("/backup/now")
async def create_backup_now(request: Request, session: AsyncSession = Depends(get_session)):
    """Create a per-user backup zip (JSON export of rows + per-user files)."""
    uid = await _require_user_id(request)
    if uid is None:
        return JSONResponse({"error": "Authentification requise"}, status_code=401)
    return await create_user_backup(session, uid)


@router.post("/backup/restore")
async def restore_backup(data: dict, request: Request, session: AsyncSession = Depends(get_session)):
    """Destructive restore of the current user's data from one of their zips.

    Steps: validate manifest, delete user's current rows + files, insert from
    the zip. The manifest's user_id must match the caller — a user cannot
    restore another user's zip even if they could reach the file.
    """
    uid = await _require_user_id(request)
    if uid is None:
        return JSONResponse({"error": "Authentification requise"}, status_code=401)

    filename = (data or {}).get("filename", "")
    if not filename or not filename.endswith(".zip"):
        return {"ok": False, "error": "Nom de fichier invalide"}

    d = _user_backup_dir(uid)
    zip_path = d / filename
    if not zip_path.exists():
        return {"ok": False, "error": "Backup introuvable"}

    # Path-traversal guard: the zip must live inside the user's own dir
    try:
        zip_path.resolve().relative_to(d.resolve())
    except ValueError:
        return {"ok": False, "error": "Chemin non autorisé"}

    try:
        with zipfile.ZipFile(zip_path, "r") as zf:
            MAX_BACKUP_SIZE = 500 * 1024 * 1024
            total_size = sum(info.file_size for info in zf.infolist())
            if total_size > MAX_BACKUP_SIZE:
                return {
                    "ok": False,
                    "error": f"Backup trop volumineux ({total_size // 1024 // 1024}MB > 500MB)",
                }

            try:
                manifest_bytes = zf.read("manifest.json")
                manifest = json.loads(manifest_bytes.decode("utf-8"))
            except KeyError:
                return {"ok": False, "error": "manifest.json manquant — zip non-compatible"}

            if manifest.get("kind") != "per_user":
                return {"ok": False, "error": "Ce zip n'est pas un backup per-user"}
            if int(manifest.get("user_id") or 0) != uid:
                return {
                    "ok": False,
                    "error": "Ce backup appartient à un autre utilisateur",
                }

            try:
                export_bytes = zf.read("db_export.json")
                export = json.loads(export_bytes.decode("utf-8"))
            except KeyError:
                return {"ok": False, "error": "db_export.json manquant"}

            await _delete_user_db(session, uid)
            await session.commit()

            counts = await _import_user_db(session, uid, export)

            _wipe_user_files(uid)
            extracted = _extract_user_files_from_zip(uid, zf)

        # ── Targeted post-restore reload (per-user only) ───────────────────
        # Everything below is scoped to this user's caches: stop their MCP
        # subprocesses so next chat lazy-starts from the restored config,
        # evict their consciousness instance so the new tick re-reads from
        # disk + DB, and drop their ModeManager so permissions reload.
        # Other users are never touched.
        try:
            from backend.core.agents.mcp_client import mcp_manager as _mcp_post
            await _mcp_post.stop_user_servers(uid)
        except Exception as _mcp_err:
            logger.warning(f"Restore: MCP stop for user {uid} failed: {_mcp_err}")

        try:
            from backend.plugins.consciousness.engine import consciousness_manager as _cm_post
            _cm_post.evict(uid)
        except Exception as _cm_err:
            logger.warning(f"Restore: consciousness evict for user {uid} failed: {_cm_err}")

        try:
            from backend.core.agents.mode_manager import mode_pool as _mp_post
            _mp_post._instances.pop(uid, None)
        except Exception as _mp_err:
            logger.warning(f"Restore: mode_pool evict for user {uid} failed: {_mp_err}")

        return {
            "ok": True,
            "message": f"Restauration de {filename} réussie.",
            "row_counts": counts,
            "files_restored": extracted,
            "reloaded": ["mcp", "consciousness", "mode_pool"],
        }
    except Exception as e:
        logger.error(f"Per-user restore failed for uid={uid}: {e}", exc_info=True)
        try:
            await session.rollback()
        except Exception:
            pass
        return {"ok": False, "error": "Erreur lors de la restauration"}


@router.delete("/backup/{filename}")
async def delete_backup(filename: str, request: Request):
    """Delete one of the current user's backup zips."""
    uid = await _require_user_id(request)
    if uid is None:
        return JSONResponse({"error": "Authentification requise"}, status_code=401)

    d = _user_backup_dir(uid)
    zip_path = d / filename
    if not zip_path.exists():
        return {"ok": False, "error": "Fichier introuvable"}
    try:
        zip_path.resolve().relative_to(d.resolve())
    except ValueError:
        return {"ok": False, "error": "Chemin non autorisé"}
    zip_path.unlink()
    return {"ok": True}


# ── Admin: legacy full-instance backup (disaster recovery / VPS migration) ──

@router.post("/backup/admin/now")
async def admin_full_backup(request: Request, session: AsyncSession = Depends(get_session)):
    """Admin-only: full zip of the whole instance (global config + SQLite DB +
    shared data files). Stored under ``data/backups/_admin/``.
    """
    deny = await _ensure_admin(request, session)
    if deny is not None:
        return deny
    try:
        admin_dir = BACKUPS_ROOT / "_admin"
        admin_dir.mkdir(parents=True, exist_ok=True)
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        filename = f"gungnir_admin_full_{timestamp}.zip"
        zip_path = admin_dir / filename
        with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
            for target in _legacy_backup_targets():
                if target.exists():
                    arcname = str(target.relative_to(PROJECT_ROOT))
                    zf.write(target, arcname)
        size_mb = round(zip_path.stat().st_size / (1024 * 1024), 2)
        return {"ok": True, "filename": filename, "size_mb": size_mb}
    except Exception as e:
        logger.error(f"Admin full backup failed: {e}", exc_info=True)
        return {"ok": False, "error": "Erreur lors de la création du backup admin"}


@router.get("/backup/admin/history")
async def admin_full_history(request: Request, session: AsyncSession = Depends(get_session)):
    """Admin-only: list the legacy full-instance backup zips."""
    deny = await _ensure_admin(request, session)
    if deny is not None:
        return deny
    admin_dir = BACKUPS_ROOT / "_admin"
    admin_dir.mkdir(parents=True, exist_ok=True)
    backups = []
    for f in sorted(admin_dir.glob("*.zip"), key=lambda p: p.stat().st_mtime, reverse=True):
        stat = f.stat()
        backups.append({
            "filename": f.name,
            "size_mb": round(stat.st_size / (1024 * 1024), 2),
            "created_at": datetime.fromtimestamp(stat.st_mtime).isoformat(),
        })
    return {"backups": backups}
