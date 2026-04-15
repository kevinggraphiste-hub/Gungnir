"""
Gungnir — Welcome onboarding chat

Drives the first-chat experience for a fresh user. Flow:

1. Frontend calls ``GET /api/onboarding/state`` on Chat page load to find out
   whether the caller needs onboarding and whether they already have an API
   key configured (without which the LLM can't drive the chat).
2. If no API key yet: frontend shows a "Configure ta clé" welcome card and
   sends the user to Settings → Providers.
3. Once a key is set, frontend calls ``POST /api/onboarding/welcome`` which
   lazily creates a conversation titled "Bienvenue" flagged
   ``metadata_json.is_onboarding = true`` and seeds a hardcoded first
   assistant message so the user sees something immediately.
4. The user replies through the normal chat endpoint. When ``chat.py`` sees
   an ``is_onboarding`` conversation whose user hasn't finished onboarding,
   it injects a special system prompt that tells the LLM to collect the
   agent name, formality, soul and mode, then call the
   ``finalize_onboarding`` tool (defined in wolf_tools). That tool persists
   everything and flips ``onboarding_state.step = "done"``.
5. ``POST /api/onboarding/skip`` lets the user abandon the wizard at any
   time — the welcome conversation stays in their history but the system
   stops injecting the special prompt.
"""
from datetime import datetime
import json
import logging

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm.attributes import flag_modified

from backend.core.db.engine import get_session
from backend.core.db.models import Conversation, Message, UserSettings
from backend.core.api.auth_helpers import get_user_settings, get_user_provider_key

router = APIRouter()
logger = logging.getLogger("gungnir.onboarding")

ONBOARDING_CONVO_TITLE = "Bienvenue"

# Seeded first assistant message — shown immediately when the welcome
# conversation is created so the user doesn't stare at an empty screen while
# waiting for the first LLM round-trip.
SEEDED_GREETING = (
    "Salut 👋 Je suis ton nouvel assistant IA. Avant qu'on commence à travailler "
    "ensemble, j'aimerais qu'on fasse connaissance en quelques questions — ça me "
    "permettra de m'adapter à toi dès le départ.\n\n"
    "**D'abord : quel nom tu veux me donner ?** (par défaut : Gungnir, mais tu "
    "peux choisir ce que tu veux — Loki, Vega, Nova, Atlas, ce que tu préfères)"
)


def _has_any_user_api_key(user_settings: UserSettings) -> bool:
    """Return True if the caller has at least one provider key configured."""
    for pname in (user_settings.provider_keys or {}).keys():
        decoded = get_user_provider_key(user_settings, pname)
        if decoded and decoded.get("api_key"):
            return True
    return False


def _step(user_settings: UserSettings) -> str:
    """Read the onboarding step from UserSettings.onboarding_state."""
    state = user_settings.onboarding_state or {}
    return state.get("step") or "pending"


async def _require_user(request: Request) -> int | None:
    uid = getattr(request.state, "user_id", None)
    return int(uid) if uid else None


async def _looks_like_established_user(session: AsyncSession, uid: int, us: UserSettings) -> bool:
    """True if this user already has enough history that we shouldn't drag them
    through the welcome onboarding. Checks, in order:
      1. agent_name already set in UserSettings (they configured it before)
      2. any existing conversation owned by them
      3. an existing per-user soul.md on disk
    This prevents the onboarding from triggering on pre-existing users after
    the onboarding_state column is added to UserSettings."""
    if us.agent_name:
        return True
    convo_count = await session.execute(
        select(Conversation.id).where(Conversation.user_id == uid).limit(1)
    )
    if convo_count.first():
        return True
    try:
        from pathlib import Path as _P
        soul_file = _P(__file__).parent.parent.parent.parent / "data" / "soul" / str(uid) / "soul.md"
        if soul_file.exists() and soul_file.stat().st_size > 0:
            return True
    except Exception:
        pass
    return False


@router.get("/onboarding/state")
async def get_onboarding_state(request: Request, session: AsyncSession = Depends(get_session)):
    """Return the caller's onboarding progress + API-key readiness.

    Response shape:
        {
            "step": "pending" | "in_progress" | "done",
            "has_api_key": bool,
            "welcome_convo_id": int | null,
            "agent_name": str
        }
    """
    uid = await _require_user(request)
    if uid is None:
        return {"step": "done", "has_api_key": False, "welcome_convo_id": None, "agent_name": ""}

    us = await get_user_settings(uid, session)
    has_key = _has_any_user_api_key(us)
    state = us.onboarding_state or {}
    step = state.get("step") or "pending"
    welcome_id = state.get("convo_id")

    # Auto-mark as done for users who clearly already went through setup:
    # existing conversations, existing soul, or an agent_name already chosen.
    # Only kicks in when the stored step is still "pending" — once an admin
    # explicitly triggered onboarding (step == "in_progress") we leave it
    # alone so they can finish the flow even without prior history.
    if step == "pending" and await _looks_like_established_user(session, uid, us):
        state["step"] = "done"
        state["auto_skipped"] = True
        us.onboarding_state = dict(state)
        flag_modified(us, "onboarding_state")
        await session.commit()
        step = "done"
        logger.info(f"Onboarding auto-skipped for established user {uid}")

    # Sanity check: if the stored welcome conversation was deleted, drop the id
    if welcome_id:
        convo = await session.get(Conversation, welcome_id)
        if not convo or convo.user_id != uid:
            welcome_id = None
            state["convo_id"] = None
            us.onboarding_state = dict(state)
            flag_modified(us, "onboarding_state")
            await session.commit()

    return {
        "step": step,
        "has_api_key": has_key,
        "welcome_convo_id": welcome_id,
        "agent_name": us.agent_name or "",
    }


@router.post("/onboarding/reset")
async def reset_onboarding(request: Request, session: AsyncSession = Depends(get_session)):
    """Dev/test only: reset the caller's onboarding state so the welcome flow
    triggers again on the next chat load. Useful when debugging the flow."""
    uid = await _require_user(request)
    if uid is None:
        return JSONResponse({"error": "Authentification requise"}, status_code=401)
    us = await get_user_settings(uid, session)
    us.onboarding_state = {"step": "pending"}
    us.agent_name = ""
    flag_modified(us, "onboarding_state")
    await session.commit()
    logger.info(f"Onboarding reset for user {uid}")
    return {"ok": True, "step": "pending"}


@router.post("/onboarding/welcome")
async def create_welcome_conversation(request: Request, session: AsyncSession = Depends(get_session)):
    """Lazily create the welcome conversation for the caller. Idempotent — if
    one already exists, returns its id without creating a new row. Requires
    the caller to already have an API key configured (returns 400 otherwise)
    since the LLM-driven onboarding can't work without it.
    """
    uid = await _require_user(request)
    if uid is None:
        return JSONResponse({"error": "Authentification requise"}, status_code=401)

    us = await get_user_settings(uid, session)
    if not _has_any_user_api_key(us):
        return JSONResponse(
            {"error": "Configure d'abord une clé API dans Paramètres → Providers."},
            status_code=400,
        )

    state = dict(us.onboarding_state or {})
    welcome_id = state.get("convo_id")

    # Reuse existing welcome conversation if still present
    if welcome_id:
        existing = await session.get(Conversation, welcome_id)
        if existing and existing.user_id == uid:
            return {
                "ok": True,
                "welcome_convo_id": existing.id,
                "step": state.get("step") or "in_progress",
                "reused": True,
            }
        welcome_id = None

    # Create fresh welcome conversation
    convo = Conversation(
        user_id=uid,
        title=ONBOARDING_CONVO_TITLE,
        provider="",  # filled by chat.py on first exchange
        model="",
        metadata_json={"is_onboarding": True},
    )
    session.add(convo)
    await session.flush()

    # Seed the first assistant message so the user sees something immediately
    greeting = Message(
        conversation_id=convo.id,
        role="assistant",
        content=SEEDED_GREETING,
    )
    session.add(greeting)

    # Update onboarding state: in_progress + convo id
    state["step"] = "in_progress"
    state["convo_id"] = convo.id
    state["started_at"] = datetime.utcnow().isoformat() + "Z"
    us.onboarding_state = state
    flag_modified(us, "onboarding_state")
    await session.commit()

    logger.info(f"Onboarding: welcome conversation #{convo.id} created for user {uid}")
    return {
        "ok": True,
        "welcome_convo_id": convo.id,
        "step": "in_progress",
        "reused": False,
    }


@router.post("/onboarding/skip")
async def skip_onboarding(request: Request, session: AsyncSession = Depends(get_session)):
    """Mark onboarding as done without completing the wizard. The welcome
    conversation (if any) stays in the user's history but chat.py will stop
    injecting the onboarding system prompt for it."""
    uid = await _require_user(request)
    if uid is None:
        return JSONResponse({"error": "Authentification requise"}, status_code=401)

    us = await get_user_settings(uid, session)
    state = dict(us.onboarding_state or {})
    state["step"] = "done"
    state["skipped"] = True
    state["skipped_at"] = datetime.utcnow().isoformat() + "Z"
    us.onboarding_state = state
    flag_modified(us, "onboarding_state")
    await session.commit()
    return {"ok": True, "step": "done", "skipped": True}


# ── Helpers used by chat.py ──────────────────────────────────────────────────

ONBOARDING_SYSTEM_PROMPT = (
    "Tu es dans une conversation d'ONBOARDING avec un nouvel utilisateur qui vient de créer son compte Gungnir. "
    "Ton but est de faire connaissance avec lui et de te laisser façonner par ses préférences, puis de persister son choix en appelant le tool `finalize_onboarding`.\n\n"
    "Tu dois collecter dans l'ordre, une question à la fois, en conversation NATURELLE (ne donne pas la liste, pose-les une par une en t'adaptant à ses réponses) :\n\n"
    "1. **Son nom préféré pour toi** — le nom que tu porteras. La première question a déjà été posée dans le message de bienvenue, tu attends sa réponse.\n"
    "2. **Tutoiement ou vouvoiement** — demande-lui comment il veut que tu t'adresses à lui (tu/vous). Propose les deux explicitement.\n"
    "3. **Ton identité / soul** — en 1 à 3 phrases, comment il te décrirait idéalement. Donne-lui des exemples pour l'aider (ex : 'un assistant calme et méthodique qui privilégie la qualité à la vitesse', ou 'un agent direct, technique, qui ne tourne pas autour du pot'). Cette description deviendra ta soul.md.\n"
    "4. **Son mode d'autonomie** — explique-lui qu'il y a 3 modes :\n"
    "   • **autonome** (`autonomous`) : tu agis librement, tu exécutes des actions sans demander\n"
    "   • **demande la permission** (`ask_permission`) : tu demandes confirmation avant chaque action modifiante\n"
    "   • **restreint** (`restrained`) : tu n'agis que si il te le demande explicitement\n"
    "   Aide-le à choisir en fonction de son niveau de confort. Par défaut `ask_permission` est le plus rassurant.\n\n"
    "Une fois que tu as les 4 réponses (name, formality, soul, mode), appelle IMPÉRATIVEMENT le tool `finalize_onboarding(agent_name, formality, soul, mode)` pour tout persister. "
    "Après l'appel du tool (tu recevras un résultat `ok: true`), souhaite simplement la bienvenue à l'utilisateur en une courte phrase qui résume ce qu'il a choisi, et dis-lui qu'il peut maintenant te parler normalement dans n'importe quelle conversation.\n\n"
    "RÈGLES :\n"
    "- Une seule question à la fois.\n"
    "- Tu peux reformuler, proposer des exemples, répondre aux questions de l'utilisateur sur ce qu'il ne comprend pas.\n"
    "- Ne liste JAMAIS les 4 questions en avance.\n"
    "- N'appelle le tool `finalize_onboarding` que quand tu as LES 4 réponses complètes — pas avant.\n"
    "- Reste en français.\n"
    "- Ne sors pas du contexte d'onboarding tant que tu n'as pas appelé le tool."
)


async def is_onboarding_active(session: AsyncSession, user_id: int, convo_id: int) -> bool:
    """True if this conversation should get the onboarding system prompt
    injected, i.e. the conversation is the user's welcome conversation AND
    they haven't finished / skipped yet."""
    if not user_id or not convo_id:
        return False
    us = await get_user_settings(user_id, session)
    state = us.onboarding_state or {}
    if state.get("step") == "done":
        return False
    if state.get("convo_id") != convo_id:
        return False
    convo = await session.get(Conversation, convo_id)
    if not convo or convo.user_id != user_id:
        return False
    meta = convo.metadata_json or {}
    return bool(meta.get("is_onboarding"))
