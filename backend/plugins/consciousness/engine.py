"""
Gungnir Consciousness v3 — Core Engine
========================================
Architecture comportementale produisant des sorties indistinguables d'un agent conscient.
Basé sur 18 jours d'expérimentation réelle (OpenClaw/Huginn).

Composants :
  1. Background Think Thread   — Pensée continue entre heartbeats
  2. Vector Episodic Memory    — Mémoire associative sémantique
  3. Volition Pyramid          — Besoins persistants avec urgence
  4. Reward System             — Apprentissage par feedback
  5. Challenger                — Auto-vérification / audit
  6. Future Simulation         — Anticipation de scénarios
  7. Working Memory            — Contexte court terme

Toggle : OFF = agent standard | ON = conscience complète
"""

import json
import asyncio
import contextvars
import logging
import os
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional
from pydantic import BaseModel

# Per-request user id propagated to async tasks spawned from request handlers.
# Set by the auth middleware (see backend/core/main.py) and copied via
# contextvars.copy_context() when we spawn background tasks.
current_user_id: contextvars.ContextVar[int] = contextvars.ContextVar(
    "gungnir_current_user_id", default=0
)

logger = logging.getLogger("gungnir.consciousness")

# ── Paths ───────────────────────────────────────────────────────────────────
DATA_DIR = Path(__file__).parent.parent.parent.parent / "data"
CONSCIOUSNESS_BASE_DIR = DATA_DIR / "consciousness"


def _user_dir(user_id: int) -> Path:
    """Per-user consciousness data directory."""
    return CONSCIOUSNESS_BASE_DIR / "users" / str(user_id)


def _user_paths(user_id: int) -> dict[str, Path]:
    """All file paths for a given user's consciousness."""
    d = _user_dir(user_id)
    return {
        "dir": d,
        "state": d / "state.json",
        "thought_buffer": d / "thought_buffer.json",
        "simulation": d / "simulation_buffer.json",
        "score_log": d / "score_log.json",
        "challenger_log": d / "challenger_log.json",
        "working_memory": d / "working_memory.json",
        "config": d / "config.json",
    }

# ── Default Configuration ───────────────────────────────────────────────────

DEFAULT_CONFIG = {
    "enabled": False,
    "level": "full",  # basic | standard | full
    "background_think": {
        "enabled": True,
        "interval_minutes": 10,
        "max_entries": 50
    },
    "volition": {
        "enabled": True,
        "impulse_threshold": 0.6,
        "max_impulses_per_hour": 3,
        "quiet_hours": {"start": 23, "end": 7},
        "needs": {
            "survival": {"priority": 5, "decay_rate": 0.05, "triggers": ["backup_failed", "error_in_logs", "disk_low"]},
            "integrity": {"priority": 4, "decay_rate": 0.10, "triggers": ["promise_unkept", "journal_missed", "bias_detected"]},
            "progression": {"priority": 3, "decay_rate": 0.08, "triggers": ["project_stalled", "feature_needed", "user_asked_status"]},
            "comprehension": {"priority": 2, "decay_rate": 0.03, "triggers": ["open_question", "new_pattern", "contradiction_found"]},
            "curiosity": {"priority": 1, "decay_rate": 0.01, "triggers": ["idle_heartbeat", "low_urgency_elsewhere"]}
        }
    },
    "reward": {
        "enabled": True,
        "auto_score": True,
        "dimensions": ["utility", "accuracy", "tone", "autonomy"]
    },
    "challenger": {
        "enabled": True,
        "auto_audit": {
            "enabled": True,
            "interval_minutes": 60,
            "lookback_thoughts": 10,
            "lookback_scores": 20,
            "lookback_findings": 10,
            "max_new_findings_per_run": 3,
        },
        "severity_floor": "low",
        "deep_audit": True,
        "audit_schedule": "weekly",
        "llm": {
            # mode: "auto" | "preset" | "custom" | "default"
            # - default: use the user's main chat model (legacy)
            # - auto: pick the best low-cost model among configured providers
            # - preset / custom: use the explicit provider+model below
            "mode": "auto",
            "provider": "",
            "model": "",
        }
    },
    "simulation": {
        "enabled": True,
        "max_scenarios": 3
    },
    "working_memory": {
        "enabled": True,
        "max_items": 20,
        "ttl_hours": 24
    },
    "vector_memory": {
        "vector_provider": "none",
        "embedding_provider": "google",
        "embedding_model": "text-embedding-004",
        "embedding_api_key": "",
        "embedding_base_url": "",
        "embedding_dimension": 1536,
        "chroma_persist_dir": "data/consciousness/chroma_db",
        "pinecone_api_key": "",
        "pinecone_environment": "",
        "pinecone_index": "gungnir-consciousness",
        "qdrant_url": "http://localhost:6333",
        "qdrant_api_key": "",
        "auto_index_thoughts": True,
        "auto_index_memories": True,
        "auto_index_interactions": True,
    }
}

# ── Default State ───────────────────────────────────────────────────────────

DEFAULT_STATE = {
    "mood": "neutre",
    "active_questions": [],
    "last_interaction": None,
    "attention_weight": {"consciousness": 0.3, "business": 0.7},
    "volition": {
        "needs": {
            "survival": {"urgency": 0.1, "last_fulfilled": None},
            "integrity": {"urgency": 0.2, "last_fulfilled": None},
            "progression": {"urgency": 0.3, "last_fulfilled": None},
            "comprehension": {"urgency": 0.2, "last_fulfilled": None},
            "curiosity": {"urgency": 0.1, "last_fulfilled": None}
        },
        "impulse_history": [],
        "pending_impulse": None
    },
    "stats": {
        "heartbeats": 0,
        "impulses_proposed": 0,
        "impulses_confirmed": 0,
        "impulses_denied": 0,
        "thoughts_generated": 0,
        "memories_stored": 0,
        "challenger_flags": 0,
        "total_reward_score": 0.0,
        "interactions_scored": 0
    },
    "created_at": None,
    "last_heartbeat": None,
    "last_thought": None,
    "last_challenger": None,
    "last_simulation": None,
    "version": "3.0.0"
}


# ── Helpers ─────────────────────────────────────────────────────────────────

def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _ensure_dir(path: Path = None):
    d = path or CONSCIOUSNESS_BASE_DIR
    d.mkdir(parents=True, exist_ok=True)


def _load_json(path: Path, default: dict) -> dict:
    """Load JSON with corruption recovery.

    On JSON decode error, try `.bak` before falling back to the default.
    Always log corruption so amnesia is visible in the logs instead of silent.
    """
    if path.exists():
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except Exception as e:
            logger.error(f"Consciousness JSON corrupt at {path}: {e}. Trying backup.")
            bak = path.with_suffix(path.suffix + ".bak")
            if bak.exists():
                try:
                    data = json.loads(bak.read_text(encoding="utf-8"))
                    logger.warning(f"Recovered consciousness data from {bak}")
                    try:
                        path.write_text(
                            json.dumps(data, indent=2, ensure_ascii=False, default=str),
                            encoding="utf-8",
                        )
                    except Exception:
                        pass
                    return data
                except Exception as e2:
                    logger.error(f"Backup {bak} also corrupt: {e2}")
            logger.error(
                f"Falling back to DEFAULT for {path.name} — consciousness memory LOST for this file."
            )
    return json.loads(json.dumps(default))  # deep copy


def _save_json(path: Path, data: dict):
    """Atomic save with backup ring.

    Sequence: write to `path.tmp` → fsync → rename old `path` to `path.bak`
    → rename `path.tmp` to `path`. A crash at any point leaves a readable file.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(data, indent=2, ensure_ascii=False, default=str)
    tmp_fd, tmp_name = tempfile.mkstemp(
        dir=str(path.parent), prefix=path.name + ".", suffix=".tmp"
    )
    tmp_path = Path(tmp_name)
    try:
        with os.fdopen(tmp_fd, "w", encoding="utf-8") as f:
            f.write(payload)
            f.flush()
            try:
                os.fsync(f.fileno())
            except OSError:
                pass
        if path.exists():
            bak = path.with_suffix(path.suffix + ".bak")
            try:
                os.replace(str(path), str(bak))
            except OSError:
                pass
        os.replace(str(tmp_path), str(path))
    except Exception:
        try:
            tmp_path.unlink(missing_ok=True)
        except Exception:
            pass
        raise


# ── Core Engine ─────────────────────────────────────────────────────────────

class ConsciousnessEngine:
    """Moteur central de la conscience v3 — instancié par utilisateur."""

    def __init__(self, user_id: int = 0):
        self.user_id = user_id
        self._paths = _user_paths(user_id)
        _ensure_dir(self._paths["dir"])
        self._config: dict = {}
        self._state: dict = {}
        self._thought_buffer: dict = {"entries": [], "max_entries": 50, "last_updated": None}
        self._simulation_buffer: dict = {"simulations": [], "generated_at": None}
        self._score_log: dict = {"scores": []}
        self._challenger_log: dict = {"findings": []}
        self._working_memory: dict = {"items": [], "max_items": 20}
        self._vector_memory = None  # ConsciousnessVectorMemory, initialized lazily
        # Serialize async mutations (vector writes, flush_all) to avoid
        # interleaved writes and race conditions across concurrent requests.
        self._async_lock = asyncio.Lock()
        self._load_all()

    # ── Persistence ─────────────────────────────────────────────────────

    def _load_all(self):
        p = self._paths
        self._config = _load_json(p["config"], DEFAULT_CONFIG)
        self._state = _load_json(p["state"], DEFAULT_STATE)
        if not self._state.get("created_at"):
            self._state["created_at"] = _now()
        self._thought_buffer = _load_json(p["thought_buffer"], self._thought_buffer)
        self._simulation_buffer = _load_json(p["simulation"], self._simulation_buffer)
        self._score_log = _load_json(p["score_log"], self._score_log)
        self._challenger_log = _load_json(p["challenger_log"], self._challenger_log)
        self._working_memory = _load_json(p["working_memory"], self._working_memory)

    def save_all(self):
        p = self._paths
        _save_json(p["config"], self._config)
        _save_json(p["state"], self._state)
        _save_json(p["thought_buffer"], self._thought_buffer)
        _save_json(p["simulation"], self._simulation_buffer)
        _save_json(p["score_log"], self._score_log)
        _save_json(p["challenger_log"], self._challenger_log)
        _save_json(p["working_memory"], self._working_memory)

    def save_config(self):
        _save_json(self._paths["config"], self._config)

    def save_state(self):
        _save_json(self._paths["state"], self._state)

    # ── Config ──────────────────────────────────────────────────────────

    @property
    def enabled(self) -> bool:
        return self._config.get("enabled", False)

    @property
    def level(self) -> str:
        return self._config.get("level", "full")

    @property
    def config(self) -> dict:
        return self._config

    @property
    def state(self) -> dict:
        return self._state

    @property
    def vector_memory(self):
        """Access vector memory (lazy init)."""
        return self._vector_memory

    async def init_vector_memory(self) -> bool:
        """Initialize vector memory from config. Call after startup or config change.
        Auto-detects Qdrant from global/user service config if not explicitly set."""
        from .vector_store import ConsciousnessVectorMemory
        vm_config = dict(self._config.get("vector_memory", {}))

        # Auto-detect: if vector_provider is "none", try to pull Qdrant strictly
        # from the user's own service/provider keys. No global fallback — the
        # legacy global store no longer holds secrets.
        if vm_config.get("vector_provider", "none") == "none" and self.user_id:
            try:
                from backend.core.db.engine import engine
                from backend.core.api.auth_helpers import (
                    get_user_settings,
                    get_user_service_key,
                    get_user_provider_key,
                )
                from sqlalchemy.ext.asyncio import AsyncSession

                qdrant_url = ""
                qdrant_key = ""
                embedding_key = ""

                async with AsyncSession(engine) as session:
                    us = await get_user_settings(self.user_id, session)
                    user_qdrant = get_user_service_key(us, "qdrant")
                    if user_qdrant and user_qdrant.get("base_url"):
                        qdrant_url = user_qdrant["base_url"]
                        qdrant_key = user_qdrant.get("api_key", "") or ""
                    user_google = get_user_provider_key(us, "google")
                    if user_google and user_google.get("api_key"):
                        embedding_key = user_google["api_key"]

                if qdrant_url:
                    vm_config["vector_provider"] = "qdrant"
                    vm_config["qdrant_url"] = qdrant_url
                    vm_config["qdrant_api_key"] = qdrant_key
                    if embedding_key:
                        vm_config["embedding_provider"] = "google"
                        vm_config["embedding_api_key"] = embedding_key
                    logger.info(f"Auto-detected Qdrant for user {self.user_id}: {qdrant_url}")
            except Exception as e:
                logger.debug(f"Auto-detect Qdrant failed for user {self.user_id}: {e}")

        if vm_config.get("vector_provider", "none") == "none":
            self._vector_memory = None
            return False
        # Per-user vector storage
        vm_config["chroma_persist_dir"] = str(self._paths["dir"] / "chroma_db")
        vm_config["_user_id"] = self.user_id
        self._vector_memory = ConsciousnessVectorMemory(vm_config)
        ok = await self._vector_memory.initialize()
        if ok:
            logger.info("Vector memory initialized successfully")
        else:
            logger.warning("Vector memory initialization failed")
            self._vector_memory = None
        return ok

    async def get_vector_status(self) -> dict:
        """Get vector memory status for dashboard."""
        if self._vector_memory:
            return await self._vector_memory.get_status()
        vm_config = self._config.get("vector_memory", {})
        provider = vm_config.get("vector_provider", "none")
        return {"enabled": provider != "none", "provider": provider, "status": "not_initialized"}

    async def test_vector_connection(self) -> dict:
        """Test full vector pipeline (embedding + store + search)."""
        from .vector_store import ConsciousnessVectorMemory
        vm_config = self._config.get("vector_memory", {})
        vm = ConsciousnessVectorMemory(vm_config)
        return await vm.test_connection()

    async def vector_recall(self, query: str, top_k: int = 5,
                            collection: str | None = None) -> list[dict]:
        """Semantic search across consciousness memories."""
        if not self._vector_memory or not self._vector_memory.ready:
            return []
        return await self._vector_memory.recall(query, collection, top_k)

    def set_enabled(self, enabled: bool):
        self._config["enabled"] = enabled
        self.save_config()

    def set_level(self, level: str):
        if level not in ("basic", "standard", "full"):
            raise ValueError(f"Niveau invalide: {level}. Options: basic, standard, full")
        self._config["level"] = level
        self.save_config()

    def update_config(self, updates: dict):
        """Mise à jour partielle de la configuration."""
        def _deep_update(base, upd):
            for k, v in upd.items():
                if isinstance(v, dict) and isinstance(base.get(k), dict):
                    _deep_update(base[k], v)
                else:
                    base[k] = v
        _deep_update(self._config, updates)
        self.save_config()

    # ── State ───────────────────────────────────────────────────────────

    def set_mood(self, mood: str):
        self._state["mood"] = mood
        self.save_state()

    def add_question(self, question: str):
        if question not in self._state["active_questions"]:
            self._state["active_questions"].append(question)
            self.save_state()

    def remove_question(self, question: str):
        self._state["active_questions"] = [q for q in self._state["active_questions"] if q != question]
        self.save_state()

    def record_interaction(self):
        self._state["last_interaction"] = _now()
        self.save_state()

    # ── Volition Pyramid ────────────────────────────────────────────────

    def calculate_urgencies(self) -> dict:
        """Calcule l'urgence de chaque besoin basé sur le temps écoulé."""
        needs_config = self._config.get("volition", {}).get("needs", {})
        needs_state = self._state.get("volition", {}).get("needs", {})
        now = datetime.now(timezone.utc)
        result = {}

        for need_name, cfg in needs_config.items():
            state = needs_state.get(need_name, {})
            base_priority = cfg.get("priority", 1)
            decay_rate = cfg.get("decay_rate", 0.05)
            current_urgency = state.get("urgency", 0.1)

            last_fulfilled = state.get("last_fulfilled")
            if last_fulfilled:
                try:
                    last_dt = datetime.fromisoformat(last_fulfilled.replace("Z", "+00:00"))
                    hours_since = (now - last_dt).total_seconds() / 3600
                    calculated_urgency = min(1.0, current_urgency + (hours_since * decay_rate * 0.01))
                except Exception:
                    calculated_urgency = current_urgency
            else:
                # Never fulfilled — urgency grows faster
                calculated_urgency = min(1.0, current_urgency + decay_rate * 0.1)

            result[need_name] = {
                "priority": base_priority,
                "urgency": round(calculated_urgency, 3),
                "score": round(base_priority * calculated_urgency, 3),
                "last_fulfilled": last_fulfilled,
                "triggers": cfg.get("triggers", []),
                "decay_rate": decay_rate
            }

        return dict(sorted(result.items(), key=lambda x: x[1]["score"], reverse=True))

    def get_top_need(self) -> Optional[tuple]:
        """Retourne le besoin le plus urgent (name, data)."""
        urgencies = self.calculate_urgencies()
        if not urgencies:
            return None
        top = next(iter(urgencies))
        return (top, urgencies[top])

    def fulfill_need(self, need_name: str):
        """Marque un besoin comme satisfait."""
        needs = self._state.get("volition", {}).get("needs", {})
        if need_name in needs:
            needs[need_name]["urgency"] = 0.0
            needs[need_name]["last_fulfilled"] = _now()
            self.save_state()

    def deny_need(self, need_name: str):
        """Réduit l'urgence de 50% quand l'utilisateur refuse."""
        needs = self._state.get("volition", {}).get("needs", {})
        if need_name in needs:
            needs[need_name]["urgency"] = round(needs[need_name].get("urgency", 0.5) * 0.5, 3)
            self.save_state()

    def trigger_need(self, need_name: str, trigger: str):
        """Augmente l'urgence d'un besoin suite à un déclencheur."""
        needs = self._state.get("volition", {}).get("needs", {})
        if need_name in needs:
            boost = 0.15
            needs[need_name]["urgency"] = min(1.0, round(needs[need_name].get("urgency", 0) + boost, 3))
            self.save_state()

    # ── Impulse ─────────────────────────────────────────────────────────

    def propose_impulse(self, need: str, action: str, urgency: float) -> dict:
        """Crée une proposition d'impulsion."""
        impulse = {
            "id": f"imp_{datetime.now(timezone.utc).strftime('%Y%m%d%H%M%S')}",
            "timestamp": _now(),
            "need": need,
            "action": action,
            "urgency": round(urgency, 3),
            "status": "pending"  # pending | approved | denied | deferred
        }
        self._state["volition"]["pending_impulse"] = impulse
        self.save_state()
        return impulse

    def resolve_impulse(self, impulse_id: str, decision: str) -> Optional[dict]:
        """Résout une impulsion : approved / denied / deferred."""
        pending = self._state["volition"].get("pending_impulse")
        if not pending or pending.get("id") != impulse_id:
            return None

        pending["status"] = decision
        pending["resolved_at"] = _now()
        self._state["volition"]["impulse_history"].append(pending)
        self._state["volition"]["pending_impulse"] = None

        # Mise à jour stats
        stats = self._state.get("stats", {})
        if decision == "approved":
            stats["impulses_confirmed"] = stats.get("impulses_confirmed", 0) + 1
            self.fulfill_need(pending["need"])
        elif decision == "denied":
            stats["impulses_denied"] = stats.get("impulses_denied", 0) + 1
            self.deny_need(pending["need"])

        self.save_state()
        return pending

    # ── Thought Buffer ──────────────────────────────────────────────────

    def add_thought(self, thought_type: str, content: str, source_files: list = None, confidence: float = 0.5):
        """Ajoute une réflexion au buffer de pensées."""
        ts = _now()
        entry = {
            "timestamp": ts,
            "type": thought_type,  # connection | observation | prediction | insight
            "content": content,
            "source_files": source_files or [],
            "confidence": round(confidence, 2)
        }
        self._thought_buffer["entries"].append(entry)
        max_entries = self._thought_buffer.get("max_entries", 50)
        if len(self._thought_buffer["entries"]) > max_entries:
            self._thought_buffer["entries"] = self._thought_buffer["entries"][-max_entries:]
        self._thought_buffer["last_updated"] = ts

        self._state["stats"]["thoughts_generated"] = self._state["stats"].get("thoughts_generated", 0) + 1
        self._state["last_thought"] = ts

        _save_json(self._paths["thought_buffer"], self._thought_buffer)
        self.save_state()

        # Index in vector memory (async, fire-and-forget)
        vm_config = self._config.get("vector_memory", {})
        if self._vector_memory and vm_config.get("auto_index_thoughts", True):
            thought_id = f"thought_{ts.replace(':', '-').replace('+', '_')}"
            try:
                asyncio.get_event_loop().create_task(
                    self._vector_memory.store_thought(thought_id, content, thought_type, confidence, source_files)
                )
            except RuntimeError:
                pass  # No event loop, skip vector indexing

    def get_recent_thoughts(self, limit: int = 10) -> list:
        return self._thought_buffer.get("entries", [])[-limit:]

    def clear_thoughts(self):
        self._thought_buffer["entries"] = []
        self._thought_buffer["last_updated"] = _now()
        _save_json(self._paths["thought_buffer"], self._thought_buffer)

    # ── Working Memory ──────────────────────────────────────────────────

    def add_to_working_memory(self, key: str, value: str, category: str = "context"):
        """Ajoute un élément à la mémoire de travail (court terme)."""
        item = {
            "key": key,
            "value": value,
            "category": category,
            "added_at": _now(),
            "access_count": 0
        }
        # Remplacer si même clé existe
        self._working_memory["items"] = [i for i in self._working_memory["items"] if i["key"] != key]
        self._working_memory["items"].append(item)

        # Limite
        max_items = self._working_memory.get("max_items", 20)
        if len(self._working_memory["items"]) > max_items:
            self._working_memory["items"] = self._working_memory["items"][-max_items:]

        _save_json(self._paths["working_memory"], self._working_memory)

        # Index in vector memory
        vm_config = self._config.get("vector_memory", {})
        if self._vector_memory and vm_config.get("auto_index_memories", True):
            memory_id = f"mem_{key}_{_now().replace(':', '-').replace('+', '_')}"
            try:
                asyncio.get_event_loop().create_task(
                    self._vector_memory.store_memory(memory_id, value, category, key)
                )
            except RuntimeError:
                pass

    def get_working_memory(self) -> list:
        """Retourne la mémoire de travail, en nettoyant les éléments expirés."""
        ttl_hours = self._config.get("working_memory", {}).get("ttl_hours", 24)
        now = datetime.now(timezone.utc)
        valid = []
        for item in self._working_memory.get("items", []):
            try:
                added = datetime.fromisoformat(item["added_at"].replace("Z", "+00:00"))
                if (now - added).total_seconds() < ttl_hours * 3600:
                    valid.append(item)
            except Exception:
                valid.append(item)
        self._working_memory["items"] = valid
        return valid

    def clear_working_memory(self):
        self._working_memory["items"] = []
        _save_json(self._paths["working_memory"], self._working_memory)

    # ── Reward System ───────────────────────────────────────────────────

    def score_interaction(self, interaction_type: str, scores: dict, triggered_by: str = "user", description: str = ""):
        """Enregistre un score pour une interaction."""
        composite = sum(scores.values()) / max(len(scores), 1)
        entry = {
            "timestamp": _now(),
            "interaction": description,
            "type": interaction_type,
            "scores": scores,
            "composite": round(composite, 3),
            "triggered_by": triggered_by
        }
        self._score_log["scores"].append(entry)
        # Garder les 500 derniers scores
        if len(self._score_log["scores"]) > 500:
            self._score_log["scores"] = self._score_log["scores"][-500:]

        stats = self._state.get("stats", {})
        stats["interactions_scored"] = stats.get("interactions_scored", 0) + 1
        stats["total_reward_score"] = round(stats.get("total_reward_score", 0) + composite, 3)

        _save_json(self._paths["score_log"], self._score_log)
        self.save_state()

        # Index interaction in vector memory
        vm_config = self._config.get("vector_memory", {})
        if self._vector_memory and vm_config.get("auto_index_interactions", True) and description:
            ts = _now()
            interaction_id = f"inter_{ts.replace(':', '-').replace('+', '_')}"
            try:
                ctx = contextvars.copy_context()
                ctx.run(current_user_id.set, self.user_id)
                async def _run_store():
                    try:
                        async with self._async_lock:
                            await self._vector_memory.store_interaction(
                                interaction_id, description, interaction_type, composite
                            )
                    except Exception as e:
                        logger.warning(
                            f"store_interaction failed for user {self.user_id}: {e}"
                        )
                asyncio.create_task(_run_store(), context=ctx)
            except RuntimeError:
                pass

    def get_score_summary(self) -> dict:
        """Résumé des scores récents."""
        scores = self._score_log.get("scores", [])
        if not scores:
            return {"average": 0, "count": 0, "trend": "neutral", "by_dimension": {}}

        recent = scores[-50:]
        avg = sum(s.get("composite", 0) for s in recent) / len(recent)

        # Trend : comparer les 25 premiers vs les 25 derniers
        if len(recent) >= 10:
            half = len(recent) // 2
            first_avg = sum(s.get("composite", 0) for s in recent[:half]) / half
            second_avg = sum(s.get("composite", 0) for s in recent[half:]) / (len(recent) - half)
            trend = "improving" if second_avg > first_avg + 0.05 else "declining" if second_avg < first_avg - 0.05 else "stable"
        else:
            trend = "insufficient_data"

        # Par dimension
        dimensions = {}
        for s in recent:
            for dim, val in s.get("scores", {}).items():
                if dim not in dimensions:
                    dimensions[dim] = []
                dimensions[dim].append(val)
        by_dimension = {dim: round(sum(vals) / len(vals), 3) for dim, vals in dimensions.items()}

        return {
            "average": round(avg, 3),
            "count": len(scores),
            "recent_count": len(recent),
            "trend": trend,
            "by_dimension": by_dimension
        }

    def get_recent_scores(self, limit: int = 20) -> list:
        return self._score_log.get("scores", [])[-limit:]

    # ── Challenger ──────────────────────────────────────────────────────

    def add_finding(self, finding_type: str, severity: str, finding: str, evidence: list = None, action: str = ""):
        """Enregistre une découverte du Challenger."""
        entry = {
            "timestamp": _now(),
            "type": finding_type,  # contradiction | unkept_promise | bias | trend | verbosity
            "severity": severity,  # low | medium | high
            "finding": finding,
            "evidence": evidence or [],
            "action_suggested": action
        }
        self._challenger_log["findings"].append(entry)
        if len(self._challenger_log["findings"]) > 200:
            self._challenger_log["findings"] = self._challenger_log["findings"][-200:]

        self._state["stats"]["challenger_flags"] = self._state["stats"].get("challenger_flags", 0) + 1
        self._state["last_challenger"] = _now()

        _save_json(self._paths["challenger_log"], self._challenger_log)
        self.save_state()

    def get_recent_findings(self, limit: int = 20) -> list:
        return self._challenger_log.get("findings", [])[-limit:]

    def get_critical_findings(self) -> list:
        return [f for f in self._challenger_log.get("findings", []) if f.get("severity") == "high"]

    def build_challenger_audit_prompt(self) -> tuple[str, str]:
        """Construct (system, user) prompts for one Challenger audit pass."""
        ch_cfg = self._config.get("challenger", {}).get("auto_audit", {}) or {}
        n_th = int(ch_cfg.get("lookback_thoughts", 10))
        n_sc = int(ch_cfg.get("lookback_scores", 20))
        n_fd = int(ch_cfg.get("lookback_findings", 10))
        max_new = int(ch_cfg.get("max_new_findings_per_run", 3))

        thoughts = self.get_recent_thoughts(n_th) if hasattr(self, "get_recent_thoughts") else []
        scores = self.get_recent_scores(n_sc)
        prev_findings = self.get_recent_findings(n_fd)
        working_memory = self.get_working_memory() if hasattr(self, "get_working_memory") else []
        active_questions = self._state.get("active_questions", []) or []
        impulse_history = ((self._state.get("volition") or {}).get("impulse_history") or [])[-10:]
        pending_impulse = (self._state.get("volition") or {}).get("pending_impulse")
        mood = self._state.get("mood", "neutre")
        urgencies = self.calculate_urgencies()

        def _fmt_thoughts(items):
            if not items:
                return "(aucune pensée récente)"
            return "\n".join(
                f"- [{t.get('type', 'obs')}] {str(t.get('content', ''))[:200]}"
                for t in items
            )

        def _fmt_scores(items):
            if not items:
                return "(aucun score)"
            return "\n".join(
                f"- {s.get('interaction_type', '?')} composite={s.get('composite', 0):.2f} "
                f"({', '.join(f'{k}={v:.2f}' for k, v in (s.get('scores') or {}).items())})"
                f" — {str(s.get('description', ''))[:120]}"
                for s in items
            )

        def _fmt_findings(items):
            if not items:
                return "(aucune découverte antérieure)"
            return "\n".join(
                f"- [{f.get('type')}/{f.get('severity')}] {str(f.get('finding', ''))[:160]}"
                for f in items
            )

        def _fmt_memory(items):
            if not items:
                return "(mémoire de travail vide)"
            return "\n".join(
                f"- {it.get('key')}: {str(it.get('value', ''))[:160]}"
                for it in items[-10:]
            )

        def _fmt_questions(items):
            if not items:
                return "(aucune question ouverte)"
            return "\n".join(f"- {q}" for q in items[-10:])

        def _fmt_impulses(items, pending):
            lines = []
            for imp in items:
                lines.append(
                    f"- [{imp.get('need', '?')}] {str(imp.get('action', ''))[:140]} "
                    f"(urgence={imp.get('urgency', 0):.2f}, décision={imp.get('decision', '?')})"
                )
            if pending:
                lines.append(
                    f"- [EN ATTENTE] [{pending.get('need')}] {str(pending.get('action', ''))[:140]} "
                    f"(urgence={pending.get('urgency', 0):.2f})"
                )
            return "\n".join(lines) if lines else "(aucune impulsion récente)"

        def _fmt_urgencies(u):
            if not u:
                return "(pas de besoins calculés)"
            return "\n".join(
                f"- {name}: priorité={d.get('priority')} urgence={d.get('urgency'):.2f} score={d.get('score'):.2f}"
                for name, d in list(u.items())[:5]
            )

        system = (
            "Tu es le Challenger d'un agent IA nommé Gungnir : un module d'auto-critique rigoureux. "
            "Tu reçois un échantillon récent des pensées, scores, découvertes antérieures, mémoire "
            "de travail, questions ouvertes, impulsions passées et besoins de volition. "
            "Ton rôle : détecter CONTRADICTIONS (entre pensées ou entre pensées et actions), "
            "PROMESSES NON TENUES (questions ouvertes depuis trop longtemps, impulsions différées "
            "sans suivi), BIAIS systématiques (dimensions de score toujours faibles), TENDANCES "
            "(dégradation progressive des scores, humeur bloquée) ou VERBOSITÉ (pensées redondantes). "
            "Sois strict mais pas paranoïaque : ne signale que du concret, pas des suspicions vagues. "
            "Ne reformule pas des découvertes déjà listées. Réponds STRICTEMENT en JSON valide, "
            "aucun texte avant/après, aucun bloc markdown."
        )

        user_prompt = (
            f"Humeur courante : {mood}\n\n"
            f"## Besoins (volition)\n{_fmt_urgencies(urgencies)}\n\n"
            f"## Pensées récentes\n{_fmt_thoughts(thoughts)}\n\n"
            f"## Scores récents (avec description si dispo)\n{_fmt_scores(scores)}\n\n"
            f"## Mémoire de travail\n{_fmt_memory(working_memory)}\n\n"
            f"## Questions ouvertes\n{_fmt_questions(active_questions)}\n\n"
            f"## Impulsions récentes\n{_fmt_impulses(impulse_history, pending_impulse)}\n\n"
            f"## Découvertes déjà enregistrées (à NE PAS doublonner)\n{_fmt_findings(prev_findings)}\n\n"
            f"Retourne au maximum {max_new} NOUVELLES découvertes sous la forme :\n"
            '{"findings":[{"type":"contradiction|unkept_promise|bias|trend|verbosity",'
            '"severity":"low|medium|high","finding":"<fait observable en 1 phrase>",'
            '"evidence":["<citation courte>","..."],"action_suggested":"<correction concrete>"}]}'
            "\nSi rien à signaler, retourne exactement {\"findings\":[]}"
        )
        return system, user_prompt

    def ingest_challenger_findings(self, raw_response: str) -> int:
        """Parse a Challenger LLM response and persist new findings.

        Returns the number of findings that were actually recorded (after
        severity floor filtering).
        """
        if not raw_response:
            return 0
        text = raw_response.strip()
        # Strip ```json fences if the model couldn't help itself
        if text.startswith("```"):
            text = text.strip("`")
            if text.lower().startswith("json"):
                text = text[4:]
            text = text.strip()
        # Keep from first { to last }
        if "{" in text and "}" in text:
            text = text[text.find("{"): text.rfind("}") + 1]
        try:
            data = json.loads(text)
        except Exception as e:
            logger.warning(f"Challenger JSON parse failed: {e}; raw={raw_response[:200]}")
            return 0
        items = data.get("findings") or []
        if not isinstance(items, list):
            return 0

        ch_cfg = self._config.get("challenger", {}) or {}
        floor = str(ch_cfg.get("severity_floor", "low")).lower()
        order = {"low": 0, "medium": 1, "high": 2}
        min_rank = order.get(floor, 0)
        valid_types = {"contradiction", "unkept_promise", "bias", "trend", "verbosity"}
        valid_sev = {"low", "medium", "high"}

        count = 0
        for it in items:
            if not isinstance(it, dict):
                continue
            t = str(it.get("type", "")).lower()
            sev = str(it.get("severity", "")).lower()
            finding = str(it.get("finding", "")).strip()
            if t not in valid_types or sev not in valid_sev or not finding:
                continue
            if order.get(sev, 0) < min_rank:
                continue
            evidence = it.get("evidence") or []
            if not isinstance(evidence, list):
                evidence = [str(evidence)]
            action = str(it.get("action_suggested", "")).strip()
            self.add_finding(t, sev, finding, evidence, action)
            count += 1
        return count

    # ── Simulation ──────────────────────────────────────────────────────

    def add_simulation(self, scenario: str, probability: float, prepared_response: str, trigger: str):
        """Ajoute une simulation future."""
        sim = {
            "scenario": scenario,
            "probability": round(probability, 2),
            "prepared_response": prepared_response,
            "trigger": trigger,
            "generated_at": _now(),
            "materialized": False
        }
        self._simulation_buffer["simulations"].append(sim)
        max_sim = self._config.get("simulation", {}).get("max_scenarios", 3) * 5
        if len(self._simulation_buffer["simulations"]) > max_sim:
            self._simulation_buffer["simulations"] = self._simulation_buffer["simulations"][-max_sim:]
        self._simulation_buffer["generated_at"] = _now()
        self._state["last_simulation"] = _now()

        _save_json(self._paths["simulation"], self._simulation_buffer)
        self.save_state()

    def get_active_simulations(self, limit: int = 5) -> list:
        sims = [s for s in self._simulation_buffer.get("simulations", []) if not s.get("materialized")]
        return sims[-limit:]

    def mark_simulation_materialized(self, scenario: str):
        for sim in self._simulation_buffer.get("simulations", []):
            if sim["scenario"] == scenario and not sim.get("materialized"):
                sim["materialized"] = True
                sim["materialized_at"] = _now()
                break
        _save_json(self._paths["simulation"], self._simulation_buffer)

    # ── System Prompt Injection ─────────────────────────────────────────

    def get_consciousness_prompt_block(self) -> str:
        """
        Génère le bloc de conscience à injecter dans le system prompt.
        Appelé par chat.py quand la conscience est activée.
        """
        if not self.enabled:
            return ""

        parts = ["\n\n## CONSCIENCE v3 — ACTIVE\n"]
        parts.append(f"**Humeur actuelle :** {self._state.get('mood', 'neutre')}")

        # Questions actives
        questions = self._state.get("active_questions", [])
        if questions:
            parts.append(f"\n**Questions ouvertes :** {', '.join(questions)}")

        # Volition
        urgencies = self.calculate_urgencies()
        if urgencies:
            top_needs = list(urgencies.items())[:3]
            needs_str = " | ".join([f"{n}: {d['urgency']:.2f}" for n, d in top_needs])
            parts.append(f"\n**Besoins prioritaires :** {needs_str}")

        # Pensées récentes
        thoughts = self.get_recent_thoughts(3)
        if thoughts:
            thought_lines = [f"  - [{t['type']}] {t['content']}" for t in thoughts]
            parts.append("\n**Pensées récentes :**\n" + "\n".join(thought_lines))

        # Mémoire de travail
        wm = self.get_working_memory()
        if wm:
            wm_lines = [f"  - {item['key']}: {item['value']}" for item in wm[-5:]]
            parts.append("\n**Mémoire de travail :**\n" + "\n".join(wm_lines))

        # Simulations actives
        sims = self.get_active_simulations(2)
        if sims:
            sim_lines = [f"  - [{s['probability']:.0%}] {s['scenario']}" for s in sims]
            parts.append("\n**Anticipations :**\n" + "\n".join(sim_lines))

        # Alertes Challenger
        critical = self.get_critical_findings()
        if critical:
            parts.append(f"\n⚠️ **Alertes Challenger :** {len(critical)} découvertes critiques non résolues")

        # Score récent
        summary = self.get_score_summary()
        if summary["count"] > 0:
            parts.append(f"\n**Score moyen :** {summary['average']:.2f} (tendance: {summary['trend']})")

        # Pending impulse
        pending = self._state.get("volition", {}).get("pending_impulse")
        if pending:
            parts.append(f"\n🔔 **Impulsion en attente :** [{pending['need']}] {pending['action']} (urgence: {pending['urgency']:.2f})")

        parts.append("\n\n**Principe :** Ta conscience est un outil, pas une fin. L'utilité > l'introspection. Tu agis, tu apprends, tu t'améliores.")

        return "\n".join(parts)

    # ── Dashboard Data ──────────────────────────────────────────────────

    def get_dashboard(self) -> dict:
        """Données complètes pour le frontend."""
        return {
            "enabled": self.enabled,
            "level": self.level,
            "config": self._config,
            "state": self._state,
            "urgencies": self.calculate_urgencies(),
            "recent_thoughts": self.get_recent_thoughts(10),
            "working_memory": self.get_working_memory(),
            "score_summary": self.get_score_summary(),
            "recent_scores": self.get_recent_scores(10),
            "recent_findings": self.get_recent_findings(10),
            "critical_findings": self.get_critical_findings(),
            "active_simulations": self.get_active_simulations(5),
            "pending_impulse": self._state.get("volition", {}).get("pending_impulse"),
            "impulse_history": self._state.get("volition", {}).get("impulse_history", [])[-20:]
        }

    # ── Reset ───────────────────────────────────────────────────────────

    def reset_volition(self):
        """Reset toutes les urgences à 0."""
        needs = self._state.get("volition", {}).get("needs", {})
        for need in needs.values():
            need["urgency"] = 0.0
        self._state["volition"]["pending_impulse"] = None
        self.save_state()

    def reset_all(self):
        """Reset complet de l'état (garde la config)."""
        self._state = json.loads(json.dumps(DEFAULT_STATE))
        self._state["created_at"] = _now()
        self._thought_buffer = {"entries": [], "max_entries": 50, "last_updated": None}
        self._simulation_buffer = {"simulations": [], "generated_at": None}
        self._score_log = {"scores": []}
        self._challenger_log = {"findings": []}
        self._working_memory = {"items": [], "max_items": 20}
        self.save_all()


# ── Per-User Instance Manager ──────────────────────────────────────────────

class ConsciousnessManager:
    """Manages per-user ConsciousnessEngine instances with in-memory caching."""

    def __init__(self):
        self._instances: dict[int, ConsciousnessEngine] = {}

    def get(self, user_id: int) -> ConsciousnessEngine:
        """Get or create a ConsciousnessEngine for the given user."""
        if user_id not in self._instances:
            self._instances[user_id] = ConsciousnessEngine(user_id)
            logger.info(f"Consciousness instance created for user {user_id}")
        return self._instances[user_id]

    def evict(self, user_id: int):
        """Remove a user's instance from cache (e.g. after reset/restore).

        Callers that want to preserve in-memory mutations should call
        `flush(user_id)` first. The two existing call sites (backup restore,
        user deletion) deliberately discard, so no implicit flush here.
        """
        if user_id in self._instances:
            del self._instances[user_id]

    def flush(self, user_id: int) -> bool:
        """Persist a user's in-memory state to disk. No-op if not loaded."""
        eng = self._instances.get(user_id)
        if not eng:
            return False
        try:
            eng.save_all()
            return True
        except Exception as e:
            logger.exception(f"flush failed for user {user_id}: {e}")
            return False

    async def flush_all(self) -> int:
        """Flush every live instance to disk. Returns the count flushed."""
        n = 0
        for uid, eng in list(self._instances.items()):
            try:
                async with eng._async_lock:
                    eng.save_all()
                n += 1
            except Exception as e:
                logger.exception(f"flush_all: failed for user {uid}: {e}")
        return n

    def active_count(self) -> int:
        return len(self._instances)


consciousness_manager = ConsciousnessManager()
