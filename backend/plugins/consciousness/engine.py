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
import logging
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional
from pydantic import BaseModel

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
        "light_check": True,
        "deep_audit": True,
        "audit_schedule": "weekly"
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
    if path.exists():
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            pass
    return json.loads(json.dumps(default))  # deep copy


def _save_json(path: Path, data: dict):
    _ensure_dir()
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False, default=str), encoding="utf-8")


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

        # Auto-detect: if vector_provider is "none", try to pull Qdrant from services
        if vm_config.get("vector_provider", "none") == "none":
            try:
                from backend.core.config.settings import Settings, decrypt_value
                settings = Settings.load()
                qdrant_url = ""
                qdrant_key = ""
                embedding_key = ""

                # 1. Try per-user service keys first
                if self.user_id:
                    try:
                        from backend.core.db.engine import engine
                        from backend.core.api.auth_helpers import get_user_settings, get_user_service_key, get_user_provider_key
                        from sqlalchemy.ext.asyncio import AsyncSession
                        async with AsyncSession(engine) as session:
                            us = await get_user_settings(self.user_id, session)
                            user_qdrant = get_user_service_key(us, "qdrant")
                            if user_qdrant and user_qdrant.get("base_url"):
                                qdrant_url = user_qdrant["base_url"]
                                qdrant_key = user_qdrant.get("api_key", "")
                            # Per-user Google key for embeddings
                            user_google = get_user_provider_key(us, "google")
                            if user_google and user_google.get("api_key"):
                                embedding_key = user_google["api_key"]
                    except Exception:
                        pass

                # 2. Fallback to global config
                if not qdrant_url:
                    qdrant_svc = settings.services.get("qdrant")
                    if qdrant_svc and qdrant_svc.base_url:
                        qdrant_url = qdrant_svc.base_url
                        qdrant_key = decrypt_value(qdrant_svc.api_key) if qdrant_svc.api_key else ""
                if not embedding_key:
                    google_prov = settings.providers.get("google")
                    if google_prov and google_prov.api_key:
                        embedding_key = decrypt_value(google_prov.api_key) if google_prov.api_key.startswith("enc:") else google_prov.api_key

                if qdrant_url:
                    vm_config["vector_provider"] = "qdrant"
                    vm_config["qdrant_url"] = qdrant_url
                    vm_config["qdrant_api_key"] = qdrant_key
                    if embedding_key:
                        vm_config["embedding_provider"] = "google"
                        vm_config["embedding_api_key"] = embedding_key
                    logger.info(f"Auto-detected Qdrant for user {self.user_id}: {qdrant_url}")
            except Exception as e:
                logger.debug(f"Auto-detect Qdrant failed: {e}")

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
                asyncio.get_event_loop().create_task(
                    self._vector_memory.store_interaction(interaction_id, description, interaction_type, composite)
                )
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
        """Remove a user's instance from cache (e.g. after reset)."""
        if user_id in self._instances:
            del self._instances[user_id]

    def active_count(self) -> int:
        return len(self._instances)


consciousness_manager = ConsciousnessManager()

# Backward-compatible shortcut for user_id=0 (setup/no-auth mode)
consciousness = consciousness_manager.get(0)
