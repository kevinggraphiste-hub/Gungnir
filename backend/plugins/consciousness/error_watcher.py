"""Watcher d'erreurs runtime pour alimenter le trigger `error_in_logs`.

Au boot, on attache un `logging.Handler` minimal au root logger qui compte les
records de niveau ≥ ERROR émis sur la dernière fenêtre glissante (5 min).
Le tick conscience appelle `recent_error_count()` ; si > seuil, il émet
`error_in_logs` (signal système, pas user-specific).

Design :
- **Zéro coût en l'absence d'erreur** : un append + filter sur la fenêtre.
- **Pas de persistence** : si le backend redémarre, le compteur repart à 0
  (les vraies erreurs persistent dans les logs OS / journalctl, pas notre job
  de les rejouer côté conscience).
- **Best-effort** : un échec d'attachement ne casse rien, le handler est
  simplement absent et `recent_error_count()` retourne 0.
"""
from __future__ import annotations

import logging
import threading
import time
from collections import deque
from typing import Deque

_WINDOW_SECONDS = 5 * 60  # garde 5 min d'historique
_MAX_RECORDS = 500        # cap absolu pour éviter de gonfler en cas de tempête

_lock = threading.Lock()
_timestamps: Deque[float] = deque(maxlen=_MAX_RECORDS)
_attached = False


class _ErrorRateHandler(logging.Handler):
    def __init__(self) -> None:
        super().__init__(level=logging.ERROR)

    def emit(self, record: logging.LogRecord) -> None:  # noqa: D401
        try:
            with _lock:
                _timestamps.append(time.time())
        except Exception:
            pass


def attach_root_handler() -> None:
    """Attache le handler au root logger (idempotent)."""
    global _attached
    if _attached:
        return
    try:
        root = logging.getLogger()
        handler = _ErrorRateHandler()
        handler.setLevel(logging.ERROR)
        root.addHandler(handler)
        _attached = True
    except Exception:
        pass


def recent_error_count(window_seconds: int = _WINDOW_SECONDS) -> int:
    """Nombre de records ≥ ERROR observés dans les `window_seconds` derniers."""
    cutoff = time.time() - window_seconds
    with _lock:
        # Évacue les vieux timestamps (deque non triée vue depuis l'ext mais
        # FIFO en interne — popleft est sûr tant qu'on respecte l'ordre).
        while _timestamps and _timestamps[0] < cutoff:
            _timestamps.popleft()
        return len(_timestamps)


def reset() -> None:
    """Test-only : vide le compteur."""
    with _lock:
        _timestamps.clear()
