"""Snippets Library (per-user)."""
from __future__ import annotations

import json
import uuid
from datetime import datetime
from pathlib import Path

from . import _current_user_id, router


SNIPPETS_DIR = Path("data/code_snippets")
_LEGACY_SNIPPETS_FILE = Path("data/code_snippets.json")


def _user_snippets_file() -> Path:
    """Return the per-user snippets file. Falls back to the legacy shared file
    in open/setup mode so the plugin still works before any user exists."""
    uid = _current_user_id.get(0) or 0
    if uid > 0:
        return SNIPPETS_DIR / f"{uid}.json"
    return _LEGACY_SNIPPETS_FILE


def _load_snippets() -> list[dict]:
    path = _user_snippets_file()
    if path.exists():
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            pass
    # One-shot migration: if a legacy shared snippets file exists, seed the
    # current user's file with it on first access so nothing is lost.
    uid = _current_user_id.get(0) or 0
    if uid > 0 and _LEGACY_SNIPPETS_FILE.exists() and path != _LEGACY_SNIPPETS_FILE:
        try:
            legacy = json.loads(_LEGACY_SNIPPETS_FILE.read_text(encoding="utf-8")) or []
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps(legacy, indent=2, ensure_ascii=False), encoding="utf-8")
            return legacy
        except Exception:
            pass
    return []


def _save_snippets(snippets: list[dict]):
    path = _user_snippets_file()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(snippets, indent=2, ensure_ascii=False), encoding="utf-8")


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
