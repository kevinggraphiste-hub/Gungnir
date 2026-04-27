"""
Forge — registry de streams SSE pour les runs async.

Quand un run est lancé en async, on crée une asyncio.Queue par run_id.
Le runner pousse ses events de log dedans, et l'endpoint SSE consomme
la queue pour streamer aux clients connectés.

On ne supporte qu'un seul listener SSE par run pour simplifier — si l'UI
ouvre 2 onglets sur le même run, le second ne verra que les events qui
arrivent après son ouverture (les events déjà drainés par le 1er sont
perdus, ce qui est ok pour un MVP).

Cleanup automatique : la queue est supprimée 30 secondes après le `finish`
event pour permettre aux clients lents de finir leur lecture.
"""
from __future__ import annotations

import asyncio
import logging
from typing import Optional

logger = logging.getLogger("gungnir.plugins.forge.streams")


_QUEUES: dict[int, asyncio.Queue] = {}
_FINISHED_AT: dict[int, float] = {}


def register_run(run_id: int) -> asyncio.Queue:
    """Crée et retourne la queue pour ce run_id. Idempotent : si elle
    existe déjà (cas rare de retry), on la retourne telle quelle."""
    q = _QUEUES.get(run_id)
    if q is None:
        q = asyncio.Queue(maxsize=500)
        _QUEUES[run_id] = q
    return q


def get_queue(run_id: int) -> Optional[asyncio.Queue]:
    return _QUEUES.get(run_id)


def mark_finished(run_id: int):
    """Marque le run comme fini (pour cleanup différé)."""
    import time
    _FINISHED_AT[run_id] = time.time()


def cleanup_finished_queues(grace_seconds: float = 30.0):
    """Supprime les queues des runs finis depuis plus de `grace_seconds`.

    Appelé périodiquement par le SSE endpoint à chaque connexion. On
    pourrait avoir un task dédié pour ça, mais c'est overkill pour le
    volume attendu (qq runs/jour par user en MVP).
    """
    import time
    now = time.time()
    for rid, ts in list(_FINISHED_AT.items()):
        if now - ts > grace_seconds:
            _QUEUES.pop(rid, None)
            _FINISHED_AT.pop(rid, None)


async def push_event(run_id: int, event: dict):
    """Pousse un event dans la queue (no-op si pas de queue enregistrée).

    On ne bloque jamais le runner si la queue est pleine — on drop le
    plus vieux event en silence. Le runner ne doit pas être ralenti par
    un client SSE lent.
    """
    q = _QUEUES.get(run_id)
    if q is None:
        return
    try:
        q.put_nowait(event)
    except asyncio.QueueFull:
        try:
            q.get_nowait()  # drop oldest
            q.put_nowait(event)
        except Exception:
            pass
