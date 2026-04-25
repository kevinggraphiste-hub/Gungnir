"""Scanner du workspace SpearCode pour le trigger `feature_needed`.

Compte les TODO/FIXME du workspace de l'user. Le seuil est interprété par le
caller : si > N, la conscience considère que l'user a du grain à moudre
(progression). Cooldown 24h côté caller — ce module se contente de retourner
le compte courant.

Design :
- Limite stricte sur la taille parcourue : ignore les binaires, dossiers
  cachés, node_modules/__pycache__/.git, et tout fichier > 256 Ko.
- Cap absolu sur le nombre de fichiers visités (5000) pour éviter le coût
  d'un scan massif.
- Cache mémoire 1h par user pour ne pas re-scanner à chaque tick.
"""
from __future__ import annotations

import re
import time
from pathlib import Path
from typing import Dict, Tuple

_WORKSPACE_ROOT = Path("data/workspace")
_TODO_RE = re.compile(r"\b(TODO|FIXME|XXX|HACK)\b")
_SKIP_DIRS = {".git", "node_modules", "__pycache__", ".venv", "venv", "dist", "build", ".next", "target", ".cache"}
_SKIP_EXTENSIONS = {".lock", ".png", ".jpg", ".jpeg", ".gif", ".pdf", ".zip", ".gz", ".tar", ".bin", ".so", ".dll", ".exe", ".woff", ".woff2", ".ttf", ".eot", ".mp3", ".mp4", ".webm", ".ogg"}
_MAX_FILE_BYTES = 256 * 1024
_MAX_FILES = 5000
_CACHE_TTL = 3600  # 1h

_cache: Dict[int, Tuple[float, int]] = {}


def _scan(root: Path) -> int:
    if not root.exists() or not root.is_dir():
        return 0
    count = 0
    visited = 0
    for path in root.rglob("*"):
        if visited >= _MAX_FILES:
            break
        if not path.is_file():
            continue
        # Skip dossiers blacklistés (dans n'importe quelle profondeur)
        if any(part in _SKIP_DIRS or part.startswith(".") for part in path.parts):
            continue
        if path.suffix.lower() in _SKIP_EXTENSIONS:
            continue
        try:
            if path.stat().st_size > _MAX_FILE_BYTES:
                continue
        except OSError:
            continue
        visited += 1
        try:
            with path.open("r", encoding="utf-8", errors="ignore") as f:
                for line in f:
                    if _TODO_RE.search(line):
                        count += 1
                        if count >= 1000:  # cap absolu — au-delà c'est du bruit
                            return count
        except Exception:
            continue
    return count


def count_workspace_todos(user_id: int) -> int:
    """TODO/FIXME du workspace de l'user. Mémoïsé 1h."""
    now = time.time()
    cached = _cache.get(int(user_id))
    if cached and (now - cached[0]) < _CACHE_TTL:
        return cached[1]
    user_root = _WORKSPACE_ROOT / str(user_id)
    n = _scan(user_root)
    _cache[int(user_id)] = (now, n)
    return n


def invalidate_cache(user_id: int | None = None) -> None:
    if user_id is None:
        _cache.clear()
    else:
        _cache.pop(int(user_id), None)
