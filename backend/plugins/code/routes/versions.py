"""File versioning endpoints (local snapshots, independent of Git)."""
from __future__ import annotations

import json
from datetime import datetime

from fastapi import HTTPException

from . import _versions_path, logger, router


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
