#!/usr/bin/env python3
"""
Archive orphan per-user directories.

Scans plugin data directories that use a ``{uid}/`` layout and renames any
directory whose ``uid`` no longer matches a row in the ``users`` table to
``{uid}.orphan.{UTC_TIMESTAMP}``. **Nothing is deleted** — the script only
renames, so an admin can inspect the contents and either restore them (rename
back) or remove them manually once confirmed unwanted.

Scanned roots (all under ``data/``):
  - scheduler/{uid}/
  - webhooks/{uid}/
  - integrations/{uid}/
  - voice_sessions/{uid}/
  - channels/{uid}/              (with ``_index.json`` preserved)
  - consciousness/users/{uid}/

A ``uid`` is considered valid if:
  - it is numeric AND present in the ``users`` table, OR
  - it equals ``0`` (the anonymous / setup-mode bucket — preserved by design).

Usage:
  python3 scripts/archive_orphan_dirs.py               # dry-run (default)
  python3 scripts/archive_orphan_dirs.py --apply       # actually rename

Requires ``DATABASE_URL`` to be set (same format as the backend).
"""
import argparse
import asyncio
import os
import pathlib
import re
import sys
from datetime import datetime, timezone
from typing import Iterable


ROOT = pathlib.Path(__file__).resolve().parent.parent
DATA = ROOT / "data"

# Roots that follow a ``{uid}/`` layout directly
DIRECT_ROOTS = (
    DATA / "scheduler",
    DATA / "webhooks",
    DATA / "integrations",
    DATA / "voice_sessions",
    DATA / "channels",
)

# Roots that nest the uid dirs under an extra level (e.g. consciousness/users/{uid})
NESTED_ROOTS = (
    DATA / "consciousness" / "users",
)

# File/dir names inside a root that must NEVER be treated as a uid
PRESERVED_ENTRIES = {"_index.json", ".gitkeep"}


def log(msg: str) -> None:
    print(msg, flush=True)


def timestamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


async def _fetch_user_ids_async(dsn: str) -> set[int]:
    import asyncpg  # type: ignore

    conn = await asyncpg.connect(dsn=dsn)
    try:
        rows = await conn.fetch("SELECT id FROM users")
    finally:
        await conn.close()
    return {int(r["id"]) for r in rows}


def load_valid_user_ids() -> set[int]:
    """Return the set of user IDs currently present in the DB, plus ``0``
    (the anonymous / open-mode bucket which must never be archived).

    Uses asyncpg (the backend's own driver) so the script runs out of the box
    inside the ``app`` container without extra dependencies.
    """
    db_url = os.environ.get("DATABASE_URL", "").strip()
    if not db_url:
        log("ERROR: DATABASE_URL is not set — cannot determine valid user IDs.")
        sys.exit(2)

    # asyncpg only accepts plain ``postgresql://`` DSNs — strip SQLAlchemy's
    # ``+asyncpg`` / ``+psycopg2`` suffixes so the same env value works here.
    dsn = re.sub(r"^postgresql\+[^:]+://", "postgresql://", db_url)

    try:
        ids = asyncio.run(_fetch_user_ids_async(dsn))
    except ImportError:
        log("ERROR: asyncpg is required. Install with: pip install asyncpg")
        sys.exit(2)
    except Exception as e:
        log(f"ERROR: could not query users table: {e}")
        sys.exit(2)

    ids.add(0)  # anonymous / open-mode bucket must never be archived
    return ids


def iter_uid_dirs(root: pathlib.Path) -> Iterable[pathlib.Path]:
    """Yield immediate children of ``root`` that look like uid directories."""
    if not root.exists() or not root.is_dir():
        return
    for child in root.iterdir():
        if not child.is_dir():
            continue
        if child.name in PRESERVED_ENTRIES:
            continue
        # Skip already-archived dirs so re-runs are idempotent
        if ".orphan." in child.name:
            continue
        yield child


def is_orphan(uid_dir: pathlib.Path, valid_ids: set[int]) -> bool:
    try:
        uid = int(uid_dir.name)
    except ValueError:
        # Non-numeric subdir — not a uid, leave it alone
        return False
    return uid not in valid_ids


def plan(valid_ids: set[int]) -> list[tuple[pathlib.Path, pathlib.Path]]:
    """Return [(current_path, new_path)] for every orphan directory."""
    ts = timestamp()
    moves: list[tuple[pathlib.Path, pathlib.Path]] = []
    for root in DIRECT_ROOTS:
        for d in iter_uid_dirs(root):
            if is_orphan(d, valid_ids):
                moves.append((d, d.with_name(f"{d.name}.orphan.{ts}")))
    for root in NESTED_ROOTS:
        for d in iter_uid_dirs(root):
            if is_orphan(d, valid_ids):
                moves.append((d, d.with_name(f"{d.name}.orphan.{ts}")))
    return moves


def format_size(path: pathlib.Path) -> str:
    total = 0
    for p in path.rglob("*"):
        if p.is_file():
            try:
                total += p.stat().st_size
            except OSError:
                pass
    if total < 1024:
        return f"{total} o"
    if total < 1024 * 1024:
        return f"{total / 1024:.1f} KiB"
    return f"{total / (1024 * 1024):.1f} MiB"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--apply",
        action="store_true",
        help="Actually rename the directories. Without this flag, runs as a dry-run.",
    )
    args = parser.parse_args()

    log(f"Scanning orphan per-user dirs under {DATA} ...")
    valid_ids = load_valid_user_ids()
    log(f"Valid user IDs (DB + anonymous bucket 0): {sorted(valid_ids)}")

    moves = plan(valid_ids)
    if not moves:
        log("No orphan dirs detected — nothing to archive.")
        return 0

    log("")
    log(f"Found {len(moves)} orphan dir(s):")
    for src, dst in moves:
        log(f"  {src.relative_to(ROOT)}  →  {dst.name}   [{format_size(src)}]")

    if not args.apply:
        log("")
        log("Dry-run only. Re-run with --apply to rename.")
        return 0

    log("")
    log("Applying renames ...")
    for src, dst in moves:
        try:
            src.rename(dst)
            log(f"  ✓ {src.name} → {dst.name}")
        except OSError as e:
            log(f"  ✗ FAILED {src.name}: {e}")
    log("Done.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
