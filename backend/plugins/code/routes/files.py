"""Files & workspace endpoints: tree, file CRUD, upload/download, search, stats, preview."""
from __future__ import annotations

import base64
import io
import mimetypes
import os
import shutil
import zipfile
from pathlib import Path
from typing import Optional

from fastapi import File, HTTPException, Query, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel

from . import (
    IGNORE_DIRS,
    LANG_MAP,
    _is_text_file,
    _load_config,
    _safe_path,
    _save_config,
    _workspace,
    logger,
    router,
)


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


# ── Upload / Download (PC ↔ workspace) ──────────────────────────────────────

# Cap uploaded files so a single request can't fill the disk. 50 MiB per file
# is generous for source / assets; binaries above that belong in git-lfs / S3.
_MAX_UPLOAD_BYTES = 50 * 1024 * 1024


def _sanitize_upload_name(name: str) -> str:
    """Keep only the basename and strip anything funky. Caller still resolves
    the final path through ``_safe_path`` so traversal is blocked either way."""
    base = os.path.basename(name or "").strip()
    # Drop leading dots so uploads don't silently overwrite dotfiles
    base = base.lstrip(".") or "upload.bin"
    # Replace path-ish chars that slipped through basename on Windows clients
    for bad in ("\\", "/", "\x00"):
        base = base.replace(bad, "_")
    return base[:255]


# Fix sécu M8 — magic-bytes detection pour les binaires exécutables.
# On refuse l'upload direct de ces formats (ELF Linux, PE Windows, Mach-O
# macOS, wasm, JAR) car ils peuvent être exécutés via bash_exec sans que
# l'user ne le veuille. Si quelqu'un en a vraiment besoin, il peut les
# renommer en .txt / .bin avant d'uploader (contournement assumé — le but
# est de bloquer le piège par défaut, pas d'interdire les executables en
# absolu).
_EXEC_MAGIC_BYTES = (
    (b"\x7fELF", "ELF binary (Linux)"),
    (b"MZ", "PE binary (Windows)"),
    (b"\xca\xfe\xba\xbe", "Mach-O fat binary"),
    (b"\xcf\xfa\xed\xfe", "Mach-O 64-bit binary"),
    (b"\xfe\xed\xfa\xce", "Mach-O 32-bit binary"),
    (b"\x00asm", "WASM binary"),
)


def _detect_executable(first_bytes: bytes) -> str | None:
    """Retourne le label du format binaire détecté ou None si safe."""
    for magic, label in _EXEC_MAGIC_BYTES:
        if first_bytes.startswith(magic):
            return label
    return None


@router.post("/upload")
async def upload_files(
    files: list[UploadFile] = File(...),
    dest: str = "",
):
    """Upload one or more files from the user's PC into the workspace.

    ``dest`` is the workspace-relative destination directory (empty = root).
    Existing files are overwritten. Each file is capped at _MAX_UPLOAD_BYTES.
    Les binaires exécutables (ELF/PE/Mach-O) sont refusés — cf. fix sécu M8.
    """
    dest_dir = _safe_path(dest) if dest else _workspace()
    dest_dir.mkdir(parents=True, exist_ok=True)
    if not dest_dir.is_dir():
        raise HTTPException(400, "La destination n'est pas un dossier")

    saved: list[dict] = []
    for up in files:
        name = _sanitize_upload_name(up.filename or "upload.bin")
        # Resolve through _safe_path so even a sanitized name can't escape
        rel = f"{dest}/{name}" if dest else name
        target = _safe_path(rel)
        target.parent.mkdir(parents=True, exist_ok=True)

        total = 0
        first_chunk_checked = False
        with target.open("wb") as out:
            while True:
                chunk = await up.read(1024 * 1024)
                if not chunk:
                    break
                # Fix sécu M8 : inspection du premier chunk pour bloquer les
                # binaires exécutables (magic bytes), ne fait confiance ni à
                # l'extension ni au Content-Type client.
                if not first_chunk_checked:
                    exec_kind = _detect_executable(chunk[:16])
                    if exec_kind:
                        out.close()
                        target.unlink(missing_ok=True)
                        raise HTTPException(
                            415,
                            f"Upload refusé : {name} est un binaire exécutable "
                            f"({exec_kind}). Renomme-le en .bin/.dat si tu veux "
                            f"vraiment le stocker.",
                        )
                    first_chunk_checked = True
                total += len(chunk)
                if total > _MAX_UPLOAD_BYTES:
                    out.close()
                    target.unlink(missing_ok=True)
                    raise HTTPException(
                        413,
                        f"Fichier trop volumineux (> {_MAX_UPLOAD_BYTES // (1024*1024)} Mo): {name}",
                    )
                out.write(chunk)
        saved.append({"path": rel, "size": total})
        logger.info(f"Uploaded: {rel} ({total} bytes)")

    return {"ok": True, "files": saved}


@router.get("/download")
async def download_path(path: str = Query("", description="Chemin relatif ou vide pour exporter le workspace complet")):
    """Download a workspace file (raw) or a directory (zip).

    An empty path exports the entire workspace as <workspace>.zip.
    """
    rel = (path or "").strip()
    if not rel or rel in (".", "/", "./"):
        target = _workspace()
    else:
        target = _safe_path(rel)
    if not target.exists():
        raise HTTPException(404, "Introuvable")

    if target.is_file():
        mime = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        data = target.read_bytes()
        headers = {
            "Content-Disposition": f'attachment; filename="{target.name}"',
            "Content-Length": str(len(data)),
        }
        return Response(content=data, media_type=mime, headers=headers)

    # Directory → build a zip in memory. Workspace trees are typically small;
    # a stream wrapper would be fancier but adds no meaningful benefit here.
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for root, _dirs, files in os.walk(target):
            for f in files:
                fp = Path(root) / f
                try:
                    arcname = str(fp.relative_to(target.parent)).replace("\\", "/")
                    zf.write(fp, arcname=arcname)
                except (OSError, ValueError):
                    continue
    buf.seek(0)
    zip_name = f"{target.name}.zip"
    headers = {
        "Content-Disposition": f'attachment; filename="{zip_name}"',
        "Content-Length": str(buf.getbuffer().nbytes),
    }
    return Response(content=buf.getvalue(), media_type="application/zip", headers=headers)


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
