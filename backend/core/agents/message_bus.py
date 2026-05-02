"""
Gungnir — Message Bus inter-agents (per-user, per-conversation).

Permet aux sous-agents qui tournent en parallèle (``subagent_invoke_parallel``)
de s'échanger des messages courts sous la supervision de Gungnir (le super-
agent orchestrateur).

**Design — option A "approbation par règles"** (validé avec Kevin 2026-05-02) :

- Pas d'appel LLM par message (coût) ni d'UI bloquante. L'approbation se fait
  par règles purement mécaniques : ``max 3 messages par agent par cycle``,
  ``content ≤ 600 chars``, ``target ≠ vide``, ``timeout 30s``.
- Un message posté ne déclenche **pas** l'exécution automatique du target.
  Il est queué + auto-approuvé, et exposé à Gungnir dans le snapshot retourné
  par ``subagent_invoke_parallel``. C'est Gungnir qui décide de relancer un
  agent avec ses messages dans son ``task`` enrichi (round 2 explicite).
- Cette indirection volontaire empêche les boucles A → B → A → B sans fin :
  chaque round 2 coûte un appel LLM à Gungnir, donc convergence garantie.

**Per-user strict** : chaque bus est indexé par ``(user_id, conversation_id)``,
log dans ``data/message_bus/uid_<uid>.log`` (per-user comme le reste).

**Async safety** : on utilise un ``contextvars.ContextVar`` pour passer le
sender courant aux tools — chaque task créée par ``asyncio.gather`` a sa
propre copie du context (PEP 567), donc 4 sub-agents en parallèle ne
s'écrasent pas mutuellement le sender. ``threading.Lock`` pour les mutations
du bus lui-même au cas où des threads vrais y accèdent (rare ici, mais sûr).
"""
from __future__ import annotations

import contextvars
import json
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

DATA_DIR = Path(__file__).parent.parent.parent.parent / "data"


# ── Context du sender courant ───────────────────────────────────────────────
# Set par _subagent_invoke avant d'exécuter les tools de l'agent. Lu par le
# tool ``bus_post`` pour identifier qui poste sans devoir le passer en arg
# (le LLM n'aurait aucun moyen de connaître son propre nom de toute façon).
_CURRENT_SENDER: contextvars.ContextVar[str] = contextvars.ContextVar(
    "gungnir_msgbus_sender", default=""
)


def set_current_sender(name: str) -> None:
    _CURRENT_SENDER.set(name)


def get_current_sender() -> str:
    return _CURRENT_SENDER.get()


# ── Bus ─────────────────────────────────────────────────────────────────────


class AgentMessageBus:
    """Channel par ``(user_id, conversation_id)``. Une instance par paire,
    mémoire process (pas de persistance — chaque conversation repart à 0)."""

    MAX_PER_AGENT_PER_CYCLE = 3
    MAX_CONTENT_LEN = 600
    APPROVAL_TIMEOUT_SEC = 30
    MAX_BUS_HISTORY = 100  # cap pour ne pas exploser la mémoire

    def __init__(self, user_id: int, conversation_id: int):
        self.user_id = int(user_id) if user_id else 0
        self.conversation_id = int(conversation_id) if conversation_id else 0
        # Liste FIFO ordonnée chronologiquement. Statuts : pending_approval |
        # approved | dropped. ``delivered_to`` = liste des agents qui ont déjà
        # reçu ce message (pour ne pas le relivrer à un agent au round 3).
        self.messages: list[dict] = []
        # Compteur ``sender → nb_posts`` reset à chaque ``reset_cycle()``. Les
        # rate-limits sont par cycle car un cycle = un appel parallel, pas
        # toute la conversation (sinon un agent qui a déjà posté 3 messages
        # au cycle 1 ne pourrait plus rien dire dans les cycles suivants).
        self.posts_per_agent: dict[str, int] = {}
        self._lock = threading.Lock()

    def reset_cycle(self) -> None:
        """Réinitialise les compteurs entre 2 cycles parallel. Garde la
        mémoire des messages (Gungnir peut vouloir les voir au round 2)."""
        with self._lock:
            self.posts_per_agent.clear()

    def post_message(
        self, target: str, content: str, sender: Optional[str] = None
    ) -> dict:
        """Crée un message en attente d'approbation. Renvoie ``{ok, msg_id,
        status}`` ou ``{ok: False, error}`` si rejeté par les règles."""
        sender = (sender or get_current_sender() or "?").strip() or "?"
        target = (target or "").strip()
        content = (content or "").strip()
        if not target:
            return {"ok": False, "error": "target requis"}
        if not content:
            return {"ok": False, "error": "msg vide"}
        if len(content) > self.MAX_CONTENT_LEN:
            return {
                "ok": False,
                "error": f"msg trop long (max {self.MAX_CONTENT_LEN} chars)",
            }
        with self._lock:
            posted = self.posts_per_agent.get(sender, 0)
            if posted >= self.MAX_PER_AGENT_PER_CYCLE:
                self._log_event(
                    "drop",
                    {
                        "sender": sender,
                        "target": target,
                        "content": content[:200],
                        "drop_reason": "rate_limit",
                    },
                )
                return {
                    "ok": False,
                    "error": (
                        f"rate-limit : max {self.MAX_PER_AGENT_PER_CYCLE} "
                        "messages par agent par cycle"
                    ),
                }
            mid = f"m{int(time.time() * 1000)}{len(self.messages):04d}"
            entry = {
                "id": mid,
                "sender": sender,
                "target": target,
                "content": content,
                "status": "pending_approval",
                "created_at": time.time(),
                "delivered_to": [],
            }
            self.messages.append(entry)
            self.posts_per_agent[sender] = posted + 1
            self._cap()
        self._log_event("post", entry)
        return {"ok": True, "msg_id": mid, "status": "pending_approval"}

    def auto_approve(self) -> dict:
        """Passe les messages ``pending_approval`` à ``approved`` (les règles
        de validation ont déjà été vérifiées dans ``post_message``). Drop
        ceux qui ont dépassé ``APPROVAL_TIMEOUT_SEC``. Idempotent — peut
        être appelé plusieurs fois sans effet de bord."""
        now = time.time()
        approved, dropped = 0, 0
        with self._lock:
            for m in self.messages:
                if m["status"] != "pending_approval":
                    continue
                if now - m["created_at"] > self.APPROVAL_TIMEOUT_SEC:
                    m["status"] = "dropped"
                    m["drop_reason"] = "timeout"
                    dropped += 1
                    self._log_event("drop", m)
                    continue
                m["status"] = "approved"
                m["approved_at"] = now
                approved += 1
                self._log_event("approve", m)
        return {"approved": approved, "dropped": dropped}

    def get_pending_for_agent(self, agent_name: str) -> list[dict]:
        """Messages approuvés à destination de ``agent_name`` qui ne lui ont
        pas encore été livrés. Ne mute pas — appeler ``mark_delivered`` après
        avoir effectivement injecté les messages dans le task de l'agent."""
        agent_name = (agent_name or "").strip()
        if not agent_name:
            return []
        with self._lock:
            return [
                {
                    "id": m["id"],
                    "sender": m["sender"],
                    "content": m["content"],
                    "created_at": m["created_at"],
                }
                for m in self.messages
                if m["status"] == "approved"
                and m["target"] == agent_name
                and agent_name not in m["delivered_to"]
            ]

    def mark_delivered(self, msg_ids: list[str], agent_name: str) -> None:
        if not msg_ids:
            return
        with self._lock:
            ids = set(msg_ids)
            for m in self.messages:
                if m["id"] in ids and agent_name not in m["delivered_to"]:
                    m["delivered_to"].append(agent_name)

    def snapshot(self) -> dict:
        """État résumé renvoyé à Gungnir dans le résultat de
        ``subagent_invoke_parallel``. Lui permet de décider d'un round 2."""
        with self._lock:
            counts = {"pending_approval": 0, "approved": 0, "dropped": 0}
            for m in self.messages:
                counts[m["status"]] = counts.get(m["status"], 0) + 1
            return {
                "conversation_id": self.conversation_id,
                "total": len(self.messages),
                "by_status": counts,
                # Cap à 30 récents pour ne pas exploser le contexte du LLM
                "messages": [
                    {k: v for k, v in m.items() if k != "delivered_to"}
                    for m in self.messages[-30:]
                ],
            }

    def _cap(self) -> None:
        if len(self.messages) > self.MAX_BUS_HISTORY:
            self.messages = self.messages[-self.MAX_BUS_HISTORY:]

    def _log_event(self, kind: str, msg: dict) -> None:
        """Append-only JSONL dans ``data/message_bus/uid_<uid>.log``. Best-
        effort — n'échoue jamais (pas critique). 1 ligne = 1 événement."""
        try:
            log_dir = DATA_DIR / "message_bus"
            log_dir.mkdir(parents=True, exist_ok=True)
            log_path = log_dir / f"uid_{self.user_id}.log"
            with log_path.open("a", encoding="utf-8") as fp:
                fp.write(
                    json.dumps(
                        {
                            "ts": datetime.now(timezone.utc).isoformat(),
                            "convo": self.conversation_id,
                            "kind": kind,
                            "msg": {
                                k: v
                                for k, v in msg.items()
                                if k != "delivered_to"
                            },
                        },
                        ensure_ascii=False,
                    )
                    + "\n"
                )
        except Exception:
            pass


# ── Singleton manager par (user_id, conversation_id) ────────────────────────
_BUSES: dict[tuple[int, int], AgentMessageBus] = {}
_BUSES_LOCK = threading.Lock()


def get_bus(user_id: int, conversation_id: int) -> AgentMessageBus:
    key = (int(user_id) if user_id else 0, int(conversation_id) if conversation_id else 0)
    with _BUSES_LOCK:
        bus = _BUSES.get(key)
        if bus is None:
            bus = AgentMessageBus(user_id, conversation_id)
            _BUSES[key] = bus
        return bus


def evict_bus(user_id: int, conversation_id: int) -> None:
    """À appeler quand une conversation est supprimée pour ne pas leak en
    mémoire. Pas critique — le cap MAX_BUS_HISTORY borne la fuite."""
    key = (int(user_id) if user_id else 0, int(conversation_id) if conversation_id else 0)
    with _BUSES_LOCK:
        _BUSES.pop(key, None)
