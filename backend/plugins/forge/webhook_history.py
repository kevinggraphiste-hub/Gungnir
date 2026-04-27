"""
Forge — historique des POSTs webhook reçus, en mémoire (par trigger).

Permet à l'user de voir les 10 derniers payloads reçus pour un webhook
et de les replayer sans avoir à demander à l'expéditeur. Indispensable
pour debug les intégrations externes (GitHub, Stripe, etc.).

Pas persisté en DB pour rester rapide et léger ; en cas de redémarrage,
on perd l'historique. Pour persister il faudrait une nouvelle table
forge_webhook_payloads — non prioritaire en MVP.
"""
from __future__ import annotations

import asyncio
from collections import deque
from datetime import datetime
from typing import Optional

# trigger_id (int) → deque des derniers payloads reçus
_HISTORY: dict[int, deque] = {}
_LOCK = asyncio.Lock()
_MAX_PER_TRIGGER = 10


async def push(trigger_id: int, payload: dict):
    async with _LOCK:
        dq = _HISTORY.get(trigger_id)
        if dq is None:
            dq = deque(maxlen=_MAX_PER_TRIGGER)
            _HISTORY[trigger_id] = dq
        dq.appendleft({
            "ts": datetime.utcnow().isoformat(),
            **payload,
        })


def list_for_trigger(trigger_id: int) -> list[dict]:
    dq = _HISTORY.get(trigger_id)
    if not dq:
        return []
    return list(dq)


def get_payload(trigger_id: int, index: int) -> Optional[dict]:
    dq = _HISTORY.get(trigger_id)
    if not dq or index < 0 or index >= len(dq):
        return None
    return list(dq)[index]


def clear(trigger_id: int):
    _HISTORY.pop(trigger_id, None)
