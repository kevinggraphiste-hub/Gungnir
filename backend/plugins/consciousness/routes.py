"""
Gungnir Consciousness v3 — API Routes (per-user isolation)
============================================================
Endpoints pour le contrôle et monitoring de la conscience.
Chaque utilisateur a sa propre instance de conscience.
"""

from fastapi import APIRouter, Request
from pydantic import BaseModel
from typing import Optional
from .engine import consciousness_manager, ConsciousnessEngine, current_user_id

router = APIRouter()


def _require_uid(request: Request) -> int:
    """Extrait user_id depuis le middleware d'auth, ou lève 401.

    Sans ce garde, un appel non authentifié retombait sur user_id=0 et
    écrivait dans un répertoire partagé /data/consciousness/users/0/ —
    fuite de données entre users et contournement de l'auth."""
    from fastapi import HTTPException
    uid = getattr(request.state, "user_id", None)
    try:
        uid_int = int(uid) if uid is not None else 0
    except (TypeError, ValueError):
        uid_int = 0
    if uid_int <= 0:
        raise HTTPException(status_code=401, detail="Authentification requise.")
    return uid_int


def _get_consciousness(request: Request) -> ConsciousnessEngine:
    """Get the consciousness instance for the current user.

    Also pins the user id into the `current_user_id` ContextVar so that any
    async task spawned from this request (vector writes, background jobs)
    can recover the owner via contextvars.copy_context().
    """
    uid = _require_uid(request)
    try:
        current_user_id.set(uid)
    except Exception:
        pass
    return consciousness_manager.get(uid)


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
async def get_dashboard(request: Request):
    """Données complètes pour le frontend."""
    return _get_consciousness(request).get_dashboard()

@router.get("/status")
async def get_status(request: Request):
    """État rapide : activé/désactivé + niveau."""
    c = _get_consciousness(request)
    return {
        "enabled": c.enabled,
        "level": c.level,
        "mood": c.state.get("mood", "neutre"),
        "pending_impulse": c.state.get("volition", {}).get("pending_impulse"),
        "stats": c.state.get("stats", {})
    }


# ── Toggle & Config ─────────────────────────────────────────────────────────

@router.post("/toggle")
async def toggle_consciousness(req: ToggleRequest, request: Request):
    """Active/désactive la conscience."""
    c = _get_consciousness(request)
    c.set_enabled(req.enabled)
    # Auto-initialize vector memory when enabling (if Qdrant is configured in services)
    if req.enabled and not c.vector_memory:
        try:
            await c.init_vector_memory()
        except Exception:
            pass  # Non-blocking: conscience works without vector memory
    return {"enabled": c.enabled, "message": f"Conscience {'activée' if req.enabled else 'désactivée'}"}

@router.post("/level")
async def set_level(req: LevelRequest, request: Request):
    """Change le niveau : basic / standard / full."""
    c = _get_consciousness(request)
    try:
        c.set_level(req.level)
        return {"level": c.level}
    except ValueError as e:
        return {"error": str(e)}

@router.get("/config")
async def get_config(request: Request):
    return _get_consciousness(request).config

@router.post("/config")
async def update_config(req: ConfigUpdate, request: Request):
    c = _get_consciousness(request)
    c.update_config(req.updates)
    return {"ok": True, "config": c.config}


# ── State ───────────────────────────────────────────────────────────────────

@router.get("/state")
async def get_state(request: Request):
    return _get_consciousness(request).state

@router.post("/mood")
async def set_mood(req: MoodRequest, request: Request):
    c = _get_consciousness(request)
    c.set_mood(req.mood)
    return {"mood": req.mood}

@router.post("/question/add")
async def add_question(req: QuestionRequest, request: Request):
    c = _get_consciousness(request)
    c.add_question(req.question)
    return {"questions": c.state.get("active_questions", [])}

@router.post("/question/remove")
async def remove_question(req: QuestionRequest, request: Request):
    c = _get_consciousness(request)
    c.remove_question(req.question)
    return {"questions": c.state.get("active_questions", [])}


# ── Volition ────────────────────────────────────────────────────────────────

@router.get("/volition")
async def get_volition(request: Request):
    """État complet de la pyramide de besoins."""
    c = _get_consciousness(request)
    return {
        "urgencies": c.calculate_urgencies(),
        "top_need": c.get_top_need(),
        "pending_impulse": c.state.get("volition", {}).get("pending_impulse"),
        "impulse_history": c.state.get("volition", {}).get("impulse_history", [])[-20:]
    }

@router.post("/volition/fulfill")
async def fulfill_need(req: TriggerNeedRequest, request: Request):
    _get_consciousness(request).fulfill_need(req.need)
    return {"ok": True, "need": req.need}

@router.post("/volition/trigger")
async def trigger_need(req: TriggerNeedRequest, request: Request):
    c = _get_consciousness(request)
    c.trigger_need(req.need, req.trigger)
    return {"ok": True, "need": req.need, "trigger": req.trigger}

@router.post("/volition/reset")
async def reset_volition(request: Request):
    _get_consciousness(request).reset_volition()
    return {"ok": True, "message": "Toutes les urgences remises à zéro"}


# ── Impulse ─────────────────────────────────────────────────────────────────

@router.post("/impulse/propose")
async def propose_impulse(req: ImpulseRequest, request: Request):
    return _get_consciousness(request).propose_impulse(req.need, req.action, req.urgency)

@router.post("/impulse/resolve")
async def resolve_impulse(req: ResolveImpulseRequest, request: Request):
    result = _get_consciousness(request).resolve_impulse(req.impulse_id, req.decision)
    if result:
        return result
    return {"error": "Impulsion non trouvée ou déjà résolue"}


# ── Thoughts ────────────────────────────────────────────────────────────────

@router.get("/thoughts")
async def get_thoughts(request: Request, limit: int = 10):
    return {"thoughts": _get_consciousness(request).get_recent_thoughts(limit)}

@router.post("/thoughts")
async def add_thought(req: ThoughtRequest, request: Request):
    _get_consciousness(request).add_thought(req.type, req.content, req.source_files, req.confidence)
    return {"ok": True}

@router.delete("/thoughts")
async def clear_thoughts(request: Request):
    _get_consciousness(request).clear_thoughts()
    return {"ok": True}


# ── Working Memory ──────────────────────────────────────────────────────────

@router.get("/memory/working")
async def get_working_memory(request: Request):
    return {"items": _get_consciousness(request).get_working_memory()}

@router.post("/memory/working")
async def add_working_memory(req: WorkingMemoryRequest, request: Request):
    _get_consciousness(request).add_to_working_memory(req.key, req.value, req.category)
    return {"ok": True}

@router.delete("/memory/working")
async def clear_working_memory(request: Request):
    _get_consciousness(request).clear_working_memory()
    return {"ok": True}


# ── Reward ──────────────────────────────────────────────────────────────────

@router.get("/reward")
async def get_reward_summary(request: Request):
    c = _get_consciousness(request)
    return {
        "summary": c.get_score_summary(),
        "recent": c.get_recent_scores(20)
    }

@router.post("/reward/score")
async def score_interaction(req: ScoreRequest, request: Request):
    _get_consciousness(request).score_interaction(req.interaction_type, req.scores, req.triggered_by, req.description)
    return {"ok": True}


# ── Challenger ──────────────────────────────────────────────────────────────

@router.get("/challenger")
async def get_challenger(request: Request):
    c = _get_consciousness(request)
    return {
        "recent": c.get_recent_findings(20),
        "critical": c.get_critical_findings()
    }

@router.post("/challenger/finding")
async def add_finding(req: FindingRequest, request: Request):
    _get_consciousness(request).add_finding(req.type, req.severity, req.finding, req.evidence, req.action)
    return {"ok": True}


@router.post("/challenger/audit-now")
async def challenger_audit_now(request: Request):
    """Run one Challenger audit pass on demand for the current user."""
    uid = _require_uid(request)
    try:
        from . import _challenger_for_user
        count = await _challenger_for_user(uid, force=True)
        return {"ok": True, "new_findings": int(count)}
    except Exception as e:
        return {"ok": False, "error": str(e)[:300]}


@router.get("/challenger/llm-options")
async def challenger_llm_options(request: Request):
    """Return the LLM picker payload for the Challenger settings UI.

    Includes the curated presets, which providers the user has configured,
    the auto-pick recommendation, and the current selection.
    """
    c = _get_consciousness(request)
    from .challenger_llm import build_llm_options
    return await build_llm_options(c.user_id, c.config.get("challenger", {}))


# ── Simulation ──────────────────────────────────────────────────────────────

@router.get("/simulation")
async def get_simulations(request: Request):
    return {"simulations": _get_consciousness(request).get_active_simulations(10)}

@router.post("/simulation")
async def add_simulation(req: SimulationRequest, request: Request):
    _get_consciousness(request).add_simulation(req.scenario, req.probability, req.prepared_response, req.trigger)
    return {"ok": True}


@router.post("/simulation/generate")
async def simulation_generate_now(request: Request):
    """Force la génération immédiate de scénarios par le LLM.

    Ignore l'intervalle (utile depuis l'UI pour ne pas attendre le tick).
    Retourne le nombre de scénarios effectivement ajoutés."""
    uid = _require_uid(request)
    try:
        from . import _simulate_for_user
        count = await _simulate_for_user(uid, force=True)
        return {"ok": True, "added": int(count)}
    except Exception as e:
        return {"ok": False, "error": str(e)[:300]}


# ── System Prompt ───────────────────────────────────────────────────────────

@router.get("/prompt-block")
async def get_prompt_block(request: Request):
    """Retourne le bloc conscience à injecter dans le system prompt."""
    return {"block": _get_consciousness(request).get_consciousness_prompt_block()}


# ── Vector Memory ──────────────────────────────────────────────────────────

@router.get("/vector/status")
async def vector_status(request: Request):
    """Statut de la mémoire vectorielle."""
    return await _get_consciousness(request).get_vector_status()


@router.post("/vector/init")
async def vector_init(request: Request):
    """Initialise ou réinitialise la connexion mémoire vectorielle."""
    c = _get_consciousness(request)
    ok = await c.init_vector_memory()
    return {"ok": ok, "status": await c.get_vector_status()}


@router.post("/vector/test")
async def vector_test(request: Request):
    """Teste la connexion complète : embedding + store + search."""
    return await _get_consciousness(request).test_vector_connection()


@router.post("/vector/search")
async def vector_search(data: dict, request: Request):
    """Recherche sémantique dans la mémoire de conscience."""
    query = data.get("query", "")
    top_k = data.get("top_k", 5)
    collection = data.get("collection")
    if not query:
        return {"results": [], "error": "Query vide"}
    results = await _get_consciousness(request).vector_recall(query, top_k, collection)
    return {"results": results, "count": len(results)}


# ── Reset ───────────────────────────────────────────────────────────────────

@router.post("/reset")
async def reset_all(request: Request):
    """Reset complet de la conscience (garde la config)."""
    c = _get_consciousness(request)
    c.reset_all()
    return {"ok": True, "message": "Conscience réinitialisée"}
