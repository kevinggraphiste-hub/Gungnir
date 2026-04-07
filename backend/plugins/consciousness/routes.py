"""
Gungnir Consciousness v3 — API Routes
=======================================
Endpoints pour le contrôle et monitoring de la conscience.
"""

from fastapi import APIRouter
from pydantic import BaseModel
from typing import Optional
from .engine import consciousness

router = APIRouter()


# ── Models ──────────────────────────────────────────────────────────────────

class ToggleRequest(BaseModel):
    enabled: bool

class LevelRequest(BaseModel):
    level: str  # basic | standard | full

class ConfigUpdate(BaseModel):
    updates: dict

class MoodRequest(BaseModel):
    mood: str

class QuestionRequest(BaseModel):
    question: str

class ThoughtRequest(BaseModel):
    type: str = "observation"
    content: str
    source_files: list = []
    confidence: float = 0.5

class WorkingMemoryRequest(BaseModel):
    key: str
    value: str
    category: str = "context"

class ScoreRequest(BaseModel):
    interaction_type: str
    scores: dict
    triggered_by: str = "user"
    description: str = ""

class FindingRequest(BaseModel):
    type: str
    severity: str = "medium"
    finding: str
    evidence: list = []
    action: str = ""

class SimulationRequest(BaseModel):
    scenario: str
    probability: float = 0.5
    prepared_response: str = ""
    trigger: str = ""

class ImpulseRequest(BaseModel):
    need: str
    action: str
    urgency: float = 0.5

class ResolveImpulseRequest(BaseModel):
    impulse_id: str
    decision: str  # approved | denied | deferred

class TriggerNeedRequest(BaseModel):
    need: str
    trigger: str


# ── Dashboard ───────────────────────────────────────────────────────────────

@router.get("/dashboard")
async def get_dashboard():
    """Données complètes pour le frontend."""
    return consciousness.get_dashboard()

@router.get("/status")
async def get_status():
    """État rapide : activé/désactivé + niveau."""
    return {
        "enabled": consciousness.enabled,
        "level": consciousness.level,
        "mood": consciousness.state.get("mood", "neutre"),
        "pending_impulse": consciousness.state.get("volition", {}).get("pending_impulse"),
        "stats": consciousness.state.get("stats", {})
    }


# ── Toggle & Config ─────────────────────────────────────────────────────────

@router.post("/toggle")
async def toggle_consciousness(req: ToggleRequest):
    """Active/désactive la conscience."""
    consciousness.set_enabled(req.enabled)
    return {"enabled": consciousness.enabled, "message": f"Conscience {'activée' if req.enabled else 'désactivée'}"}

@router.post("/level")
async def set_level(req: LevelRequest):
    """Change le niveau : basic / standard / full."""
    try:
        consciousness.set_level(req.level)
        return {"level": consciousness.level}
    except ValueError as e:
        return {"error": str(e)}

@router.get("/config")
async def get_config():
    return consciousness.config

@router.post("/config")
async def update_config(req: ConfigUpdate):
    consciousness.update_config(req.updates)
    return {"ok": True, "config": consciousness.config}


# ── State ───────────────────────────────────────────────────────────────────

@router.get("/state")
async def get_state():
    return consciousness.state

@router.post("/mood")
async def set_mood(req: MoodRequest):
    consciousness.set_mood(req.mood)
    return {"mood": req.mood}

@router.post("/question/add")
async def add_question(req: QuestionRequest):
    consciousness.add_question(req.question)
    return {"questions": consciousness.state.get("active_questions", [])}

@router.post("/question/remove")
async def remove_question(req: QuestionRequest):
    consciousness.remove_question(req.question)
    return {"questions": consciousness.state.get("active_questions", [])}


# ── Volition ────────────────────────────────────────────────────────────────

@router.get("/volition")
async def get_volition():
    """État complet de la pyramide de besoins."""
    return {
        "urgencies": consciousness.calculate_urgencies(),
        "top_need": consciousness.get_top_need(),
        "pending_impulse": consciousness.state.get("volition", {}).get("pending_impulse"),
        "impulse_history": consciousness.state.get("volition", {}).get("impulse_history", [])[-20:]
    }

@router.post("/volition/fulfill")
async def fulfill_need(req: TriggerNeedRequest):
    consciousness.fulfill_need(req.need)
    return {"ok": True, "need": req.need}

@router.post("/volition/trigger")
async def trigger_need(req: TriggerNeedRequest):
    consciousness.trigger_need(req.need, req.trigger)
    return {"ok": True, "need": req.need, "trigger": req.trigger}

@router.post("/volition/reset")
async def reset_volition():
    consciousness.reset_volition()
    return {"ok": True, "message": "Toutes les urgences remises à zéro"}


# ── Impulse ─────────────────────────────────────────────────────────────────

@router.post("/impulse/propose")
async def propose_impulse(req: ImpulseRequest):
    impulse = consciousness.propose_impulse(req.need, req.action, req.urgency)
    return impulse

@router.post("/impulse/resolve")
async def resolve_impulse(req: ResolveImpulseRequest):
    result = consciousness.resolve_impulse(req.impulse_id, req.decision)
    if result:
        return result
    return {"error": "Impulsion non trouvée ou déjà résolue"}


# ── Thoughts ────────────────────────────────────────────────────────────────

@router.get("/thoughts")
async def get_thoughts(limit: int = 10):
    return {"thoughts": consciousness.get_recent_thoughts(limit)}

@router.post("/thoughts")
async def add_thought(req: ThoughtRequest):
    consciousness.add_thought(req.type, req.content, req.source_files, req.confidence)
    return {"ok": True}

@router.delete("/thoughts")
async def clear_thoughts():
    consciousness.clear_thoughts()
    return {"ok": True}


# ── Working Memory ──────────────────────────────────────────────────────────

@router.get("/memory/working")
async def get_working_memory():
    return {"items": consciousness.get_working_memory()}

@router.post("/memory/working")
async def add_working_memory(req: WorkingMemoryRequest):
    consciousness.add_to_working_memory(req.key, req.value, req.category)
    return {"ok": True}

@router.delete("/memory/working")
async def clear_working_memory():
    consciousness.clear_working_memory()
    return {"ok": True}


# ── Reward ──────────────────────────────────────────────────────────────────

@router.get("/reward")
async def get_reward_summary():
    return {
        "summary": consciousness.get_score_summary(),
        "recent": consciousness.get_recent_scores(20)
    }

@router.post("/reward/score")
async def score_interaction(req: ScoreRequest):
    consciousness.score_interaction(req.interaction_type, req.scores, req.triggered_by, req.description)
    return {"ok": True}


# ── Challenger ──────────────────────────────────────────────────────────────

@router.get("/challenger")
async def get_challenger():
    return {
        "recent": consciousness.get_recent_findings(20),
        "critical": consciousness.get_critical_findings()
    }

@router.post("/challenger/finding")
async def add_finding(req: FindingRequest):
    consciousness.add_finding(req.type, req.severity, req.finding, req.evidence, req.action)
    return {"ok": True}


# ── Simulation ──────────────────────────────────────────────────────────────

@router.get("/simulation")
async def get_simulations():
    return {"simulations": consciousness.get_active_simulations(10)}

@router.post("/simulation")
async def add_simulation(req: SimulationRequest):
    consciousness.add_simulation(req.scenario, req.probability, req.prepared_response, req.trigger)
    return {"ok": True}


# ── System Prompt ───────────────────────────────────────────────────────────

@router.get("/prompt-block")
async def get_prompt_block():
    """Retourne le bloc conscience à injecter dans le system prompt."""
    return {"block": consciousness.get_consciousness_prompt_block()}


# ── Vector Memory ──────────────────────────────────────────────────────────

@router.get("/vector/status")
async def vector_status():
    """Statut de la mémoire vectorielle."""
    return await consciousness.get_vector_status()


@router.post("/vector/init")
async def vector_init():
    """Initialise ou réinitialise la connexion mémoire vectorielle."""
    ok = await consciousness.init_vector_memory()
    return {"ok": ok, "status": await consciousness.get_vector_status()}


@router.post("/vector/test")
async def vector_test():
    """Teste la connexion complète : embedding + store + search."""
    return await consciousness.test_vector_connection()


@router.post("/vector/search")
async def vector_search(data: dict):
    """Recherche sémantique dans la mémoire de conscience."""
    query = data.get("query", "")
    top_k = data.get("top_k", 5)
    collection = data.get("collection")
    if not query:
        return {"results": [], "error": "Query vide"}
    results = await consciousness.vector_recall(query, top_k, collection)
    return {"results": results, "count": len(results)}


# ── Reset ───────────────────────────────────────────────────────────────────

@router.post("/reset")
async def reset_all():
    """Reset complet de la conscience (garde la config)."""
    consciousness.reset_all()
    return {"ok": True, "message": "Conscience réinitialisée"}
