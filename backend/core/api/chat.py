from fastapi import APIRouter, Depends, Request
from fastapi.responses import StreamingResponse
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from pathlib import Path
import json
import asyncio
import re as _re_mod
import uuid as _uuid_mod

from backend.core.config.settings import Settings, ProviderConfig
from backend.core.db.models import Conversation, Message
from backend.core.db.engine import get_session
from backend.core.providers import get_provider, ChatMessage
from backend.core.agents.wolf_tools import WOLF_TOOL_SCHEMAS, WOLF_EXECUTORS, READ_ONLY_TOOLS, set_conversation_context, set_user_context, _soul_path
from backend.core.agents.mcp_client import mcp_manager
from slowapi import Limiter
from slowapi.util import get_remote_address
limiter = Limiter(key_func=get_remote_address)

router = APIRouter()


def _build_temporal_block(timezone_name: str = "Europe/Paris") -> str:
    """Bloc injecté dans le system prompt pour donner à l'agent la conscience
    du moment présent. Les LLM n'ont pas d'horloge interne — sans ce bloc,
    ils hallucinent la date (souvent la date du cutoff de leur training).

    Format bilingue (FR lisible + ISO 8601) pour que l'agent puisse choisir
    ce qu'il renvoie à l'user.
    """
    from datetime import datetime, timezone as _tz
    try:
        from zoneinfo import ZoneInfo
        tz = ZoneInfo(timezone_name)
        now_local = datetime.now(tz)
    except Exception:
        # Fallback sur UTC si la TZ est invalide ou zoneinfo indispo
        now_local = datetime.now(_tz.utc)
        timezone_name = "UTC"
    now_utc = datetime.now(_tz.utc)

    # Traduction FR des jours/mois (plus fiable que locale système qui varie
    # selon l'environnement Docker).
    _jours = ["lundi", "mardi", "mercredi", "jeudi",
              "vendredi", "samedi", "dimanche"]
    _mois = ["", "janvier", "février", "mars", "avril", "mai", "juin",
             "juillet", "août", "septembre", "octobre", "novembre", "décembre"]
    jour_fr = _jours[now_local.weekday()]
    mois_fr = _mois[now_local.month]
    date_fr = f"{jour_fr} {now_local.day} {mois_fr} {now_local.year}"

    return (
        "\n\n## CONTEXTE TEMPOREL\n"
        f"Nous sommes le **{date_fr}**.\n"
        f"Date ISO : `{now_local.strftime('%Y-%m-%d')}`\n"
        f"Heure locale : `{now_local.strftime('%H:%M')}` ({timezone_name})\n"
        f"Heure UTC : `{now_utc.strftime('%Y-%m-%dT%H:%M:%SZ')}`\n"
        "Utilise ces valeurs quand on te demande la date, l'heure, le jour "
        "de la semaine, ou pour tout calcul temporel (âge d'une chose, "
        "deadline, ancienneté d'un événement, etc.). Ne te fie JAMAIS à la "
        "date de ton cutoff d'entraînement — elle est obsolète.\n"
    )


def _classify_llm_error(exc: Exception) -> str:
    """Return a user-friendly error message based on the LLM API exception."""
    # Validation errors (ValueError) ont un message déjà parlant : on le renvoie tel quel
    if isinstance(exc, ValueError):
        return str(exc)
    msg = str(exc).lower()
    # Credit / payment
    if "402" in msg or "payment required" in msg or "insufficient" in msg or "quota" in msg or "credits" in msg:
        return "Crédits épuisés — rechargez votre compte sur le site du provider."
    # Auth
    if "401" in msg or "unauthorized" in msg or "invalid.*key" in msg or "api key" in msg:
        return "Clé API invalide ou expirée — vérifiez-la dans les paramètres."
    # Rate limit
    if "429" in msg or "rate limit" in msg or "too many" in msg:
        return "Trop de requêtes — attendez quelques secondes et réessayez."
    # Model not found
    if "404" in msg or "model not found" in msg or "not found" in msg:
        return "Modèle introuvable — vérifiez le nom du modèle sélectionné."
    # Context too long
    if "context" in msg and "length" in msg or "token" in msg and ("limit" in msg or "maximum" in msg):
        return "Conversation trop longue pour ce modèle — essayez de résumer ou changer de modèle."
    # Server error
    if "500" in msg or "502" in msg or "503" in msg or "server" in msg:
        return "Le serveur du provider est temporairement indisponible — réessayez dans un instant."
    # Fallback
    return "Erreur interne lors du traitement du message."


# ═══════════════════════════════════════════════════════════════════════════════
# Vision fallback : description d'images pour modèles non-multimodaux
# ═══════════════════════════════════════════════════════════════════════════════

# Fallback patterns quand le catalogue OpenRouter n'est pas joignable.
# Utilisé uniquement si `_fetch_openrouter_models()` échoue (offline, rate-limit…).
# Liste élargie mi-2026 pour couvrir les familles récentes (sinon les images
# upload sont silencieusement décrites en texte au lieu d'être envoyées au LLM,
# perte de fidélité notable vs multimodal natif).
_VISION_MODEL_PATTERNS = [
    # OpenAI
    "gpt-4o", "gpt-4-turbo", "gpt-4-vision", "gpt-4.1", "gpt-4.5", "gpt-5",
    "o1", "o3", "o4",
    # Anthropic
    "claude-3", "claude-sonnet", "claude-opus", "claude-haiku",
    "claude-4", "claude-sonnet-4", "claude-opus-4", "claude-haiku-4",
    # Google
    "gemini", "gemma", "imagen",
    # Open-source / autres vision
    "llava", "bakllava", "moondream",
    "pixtral", "qwen-vl", "qwen2-vl", "qwen2.5-vl", "qwen3-vl", "internvl",
    "yi-vision", "phi-3-vision", "phi-3.5-vision", "phi-4-vision",
    # xAI / Meta vision
    "grok-2-vision", "grok-3", "grok-4",
    "llama-3.2-vision", "llama-3.3-vision", "llama-4",
    # Mistral
    "mistral-medium-vision", "mistral-large-vision",
]


async def _model_supports_vision(model_name: str) -> bool:
    """Le modèle supporte-t-il les images ?

    Sources combinées — on dit `True` si AU MOINS UNE dit True :
    - OpenRouter `architecture.input_modalities` (source dynamique, cache 5 min)
    - Liste statique `_VISION_MODEL_PATTERNS` (fallback, évite les faux négatifs
      quand le catalog est périmé/indispo ou quand le modèle vient d'un provider
      natif pas indexé OpenRouter).

    Le but : ne JAMAIS dégrader les images à tort. Envoyer une image à un
    modèle qui ne la supporte pas déclenche au pire une erreur API claire,
    alors que la dégradation silencieuse en texte est un bug invisible.
    """
    name = (model_name or "").lower()
    if not name:
        return False
    # Fallback statique (rapide, toujours disponible)
    pattern_hit = any(p in name for p in _VISION_MODEL_PATTERNS)
    # Source dynamique — cache OpenRouter du plugin model_guide
    dynamic_hit = False
    try:
        from backend.plugins.model_guide.routes import _fetch_openrouter_models
        catalog = await _fetch_openrouter_models()
        if catalog:
            entry = catalog.get(model_name) or catalog.get(name)
            if entry is None:
                for mid, info in catalog.items():
                    if mid.endswith("/" + model_name) or mid.endswith("/" + name):
                        entry = info
                        break
            if entry is not None:
                dynamic_hit = bool(entry.get("vision"))
    except Exception as e:
        print(f"[Wolf] Vision dynamic check failed, falling back to patterns: {e}")
    return pattern_hit or dynamic_hit


async def _describe_images_for_blind_model(
    images: list[str],
    user_message: str,
    settings,
    user_settings=None,
    session=None,
    convo_id: int | None = None,
    user_id: int | None = None,
) -> str:
    """Utilise un modèle multimodal disponible pour décrire les images en texte.

    Resolves API keys strictly from the caller's own UserSettings.provider_keys.
    If the user has no vision-capable provider configured, returns a textual
    placeholder instead of falling back to another user's key.
    """
    from backend.core.api.auth_helpers import get_user_provider_key
    # Ordre optimisé coût/qualité : Gemini 2.5 Flash Lite est ~4x moins cher que
    # GPT-4o-mini pour une vision de qualité équivalente sur des tâches de
    # description. On tente d'abord les moins chers, puis on escalade.
    vision_providers = [
        ("openrouter", "google/gemini-2.5-flash-lite"),   # ~$0.10/$0.40 per 1M
        ("google", "gemini-2.5-flash-lite"),              # direct, même prix
        ("openrouter", "openai/gpt-4o-mini"),             # ~$0.15/$0.60 per 1M
        ("openai", "gpt-4o-mini"),
        ("anthropic", "claude-3-5-haiku-20241022"),       # fallback Anthropic (pas Sonnet)
    ]
    for prov_name, fallback_model in vision_providers:
        api_key = None
        base_url = None
        if user_settings is not None:
            user_prov = get_user_provider_key(user_settings, prov_name)
            if user_prov and user_prov.get("api_key"):
                api_key = user_prov["api_key"]
                base_url = user_prov.get("base_url")
        if not api_key:
            continue
        # base_url may still come from the global metadata (non-secret) if the
        # user didn't override it
        if not base_url:
            meta = settings.providers.get(prov_name) if settings else None
            if meta:
                base_url = meta.base_url
        try:
            provider = get_provider(prov_name, api_key, base_url)
            desc_msg = ChatMessage(
                role="user",
                content=f"Décris précisément cette/ces image(s) en français. Contexte du message utilisateur : \"{user_message}\". Donne une description détaillée et utile.",
                images=images,
            )
            resp = await provider.chat([desc_msg], fallback_model)
            # Trace le coût du fallback vision pour que l'analytics capte
            # cet appel caché (sinon invisible dans le tableau de bord).
            if session is not None and convo_id is not None:
                try:
                    from backend.core.cost.manager import get_cost_manager
                    await get_cost_manager().record_message_cost(
                        session,
                        convo_id,
                        resp.model or fallback_model,
                        resp.tokens_input or 0,
                        resp.tokens_output or 0,
                        user_id=user_id,
                    )
                except Exception as _vc_err:
                    print(f"[Wolf] Vision fallback cost recording skipped: {_vc_err}")
            return resp.content
        except Exception as e:
            print(f"[Wolf] Vision fallback with {prov_name} failed: {e}")
            continue
    return "[Images jointes — impossible de les décrire, aucun modèle vision disponible pour cet utilisateur]"


# ═══════════════════════════════════════════════════════════════════════════════
# Mode restreint : vérification d'intent utilisateur
# ═══════════════════════════════════════════════════════════════════════════════

# Outils autorisés SANS carte de validation en mode restreint — lecture pure,
# aucun effet de bord, aucune requête réseau. Tout le reste (écriture, exécution,
# web, browser, subagent_invoke…) passe par la PermissionCard UI.
_RESTRAINED_ALWAYS_ALLOWED = {
    "kb_read", "kb_list",        # lecture base de connaissance
    "skill_list",                # liste skills
    "soul_read",                 # lecture soul
    "subagent_list",             # liste sous-agents
    "schedule_list",             # liste tâches planifiées
    "personality_list",          # liste personnalités
}


def _restrained_check_user_intent(tool_name: str, user_message: str) -> bool:
    """Mode Restreint : chaque action doit être validée explicitement via
    PermissionCard. Seules les lectures pures locales (sans effet de bord
    ni I/O réseau) bypassent la carte pour ne pas demander un clic à
    chaque `kb_list`.

    Retourne True = autorisé sans carte, False = demande validation UI.
    """
    return tool_name in _RESTRAINED_ALWAYS_ALLOWED


# Mapping tool_name → mots-clés d'action dans le message user qui indiquent
# que l'utilisateur a DÉJÀ demandé explicitement cette action. Quand on
# matche, on skip la question de confirmation en mode ASK_PERMISSION.
_TOOL_INTENT_KEYWORDS: dict[str, tuple[str, ...]] = {
    "write_file":        ("écris", "ecris", "crée le fichier", "cree le fichier", "ajoute le fichier", "sauvegarde", "enregistre", "write file", "save file"),
    "run_command":       ("lance", "exécute", "execute", "run", "cmd", "commande", "bash", "shell"),
    "git_commit":        ("commit", "commite", "commiter", "committe"),
    "git_push":          ("push", "pousse", "envoi sur le remote", "deploy"),
    "git_pull":          ("pull", "récupère les changements", "recupere"),
    "git_add":           ("add", "stage", "ajoute au git"),
    "delete_file":       ("supprime", "efface", "remove", "delete", "rm "),
    "subagent_invoke":   ("délègue", "delegue", "sous-agent", "subagent", "orchestre"),
    "subagent_invoke_parallel": ("orchestre", "délègue en parallèle", "team", "multi-agent", "pack complet", "audite"),
    "skill_create":      ("crée le skill", "cree le skill", "nouveau skill", "ajoute le skill"),
    "subagent_create":   ("crée l'agent", "cree l'agent", "nouveau sous-agent", "nouveau agent"),
    "personality_create": ("nouvelle personnalité", "crée la personnalité"),
    "kb_write":          ("note", "mémorise", "memorise", "sauvegarde dans la kb"),
    "schedule_create":   ("planifie", "programme", "schedule"),
}

# Mots-clés de confirmation génériques (si l'user a accepté suite à une
# demande antérieure au tour précédent). Utilisés aussi pour matcher les
# phrases courtes type "ok" / "vas-y" / "oui".
_CONFIRM_PATTERNS = (
    "oui", "ouai", "yes", "yep", "ok", "okay", "d'accord", "go", "vas-y",
    "vas y", "allez", "valide", "confirme", "confirmé", "fais", "fait",
    "parfait", "nickel", "j'approuve", "approuve", "allons-y", "let's go",
)


def _ask_permission_check_user_intent(tool_name: str, user_message: str, args: dict | None = None) -> bool:
    """Mode Demande : décide si la confirmation peut être bypassée.

    Retourne True dans 2 cas :
    1. **Confirmation explicite** : le user a répondu « oui / ok / vas-y / ... »
       suite à une question précédente de l'agent.
    2. **Demande directe initiale** : le message user contient à la fois un
       verbe d'action ET une mention cohérente avec l'outil (ex : "push le
       code" → git_push, "écris le fichier X" → write_file).

    Sinon : False → l'agent doit poser une question de confirmation claire.
    """
    if not user_message:
        return False
    msg = user_message.lower().strip()

    # 1) Confirmation courte et explicite — on prend le match comme indicateur
    # fort (pas besoin de matcher le tool_name ensuite).
    #   - Si le message fait < 40 caractères et contient un pattern de confirm
    #   - OU commence par un de ces patterns (exact match au début)
    if len(msg) < 40:
        for p in _CONFIRM_PATTERNS:
            if p == msg or msg.startswith(p + " ") or msg.startswith(p + ","):
                return True

    # 2) Demande directe : matcher un mot-clé d'action spécifique à ce tool
    keywords = _TOOL_INTENT_KEYWORDS.get(tool_name, ())
    for kw in keywords:
        if kw in msg:
            return True

    # 3) Heuristique : le nom du tool lui-même apparaît dans le message
    # (ex : user écrit "lance git_commit"). Rare mais ça arrive.
    if tool_name.replace("_", " ") in msg or tool_name in msg:
        return True

    # 4) Fallback : les très longs messages user qui contiennent plusieurs
    # patterns de confirmation combinés ET des verbes d'action génériques
    # (plan d'action demandé de toute évidence).
    action_verbs = ("fais", "lance", "crée", "cree", "écris", "ecris", "push",
                    "pull", "commit", "déploie", "deploie", "supprime", "ajoute",
                    "configure", "installe")
    has_action = any(v in msg for v in action_verbs)
    has_confirm = any(p in msg for p in _CONFIRM_PATTERNS)
    if has_action and has_confirm:
        return True

    return False


# ═══════════════════════════════════════════════════════════════════════════════
# Fallback tool-call parsing pour modèles sans function calling natif
# ═══════════════════════════════════════════════════════════════════════════════

def _parse_text_tool_calls(text: str) -> list[dict] | None:
    """Parse tool calls from text when model doesn't use native function calling.
    Supports multiple formats:
      1. <tool_call>{"name": "web_fetch", "arguments": {"url": "..."}}</tool_call>
      2. tool_name("arg") or tool_name(key="val")
      3. ```json {"name": "tool_name", ...} ```
    """
    if not text:
        return None

    tool_names = set(WOLF_EXECUTORS.keys())
    parsed = []

    # Pattern 0 (PRIORITY): <tool_call>JSON</tool_call> — our text-based format
    for match in _re_mod.finditer(r'<tool_call>\s*(\{.*?\})\s*</tool_call>', text, _re_mod.DOTALL):
        try:
            obj = json.loads(match.group(1))
            name = obj.get("name", "")
            if name in tool_names:
                args = obj.get("arguments", obj.get("args", {}))
                if isinstance(args, str):
                    args = json.loads(args)
                parsed.append({
                    "id": f"textparse-{_uuid_mod.uuid4().hex[:8]}",
                    "type": "function",
                    "function": {"name": name, "arguments": json.dumps(args)}
                })
        except Exception:
            pass

    if parsed:
        return parsed

    # Pattern 1: tool_name("arg") or tool_name(arg="val")
    _tool_pattern = r'(?:^|[\s`*])(' + '|'.join(_re_mod.escape(n) for n in tool_names) + r')\s*\(\s*(.*?)\s*\)'
    for match in _re_mod.finditer(_tool_pattern, text, _re_mod.DOTALL):
        name = match.group(1)
        raw_args = match.group(2).strip()
        args = _parse_raw_args(name, raw_args)
        parsed.append({
            "id": f"textparse-{_uuid_mod.uuid4().hex[:8]}",
            "type": "function",
            "function": {"name": name, "arguments": json.dumps(args)}
        })

    if parsed:
        return parsed

    # Pattern 2: JSON block with tool call
    for match in _re_mod.finditer(r'```(?:json)?\s*(\{.*?\})\s*```', text, _re_mod.DOTALL):
        try:
            obj = json.loads(match.group(1))
            name = obj.get("name") or obj.get("tool") or obj.get("function", "")
            if name in tool_names:
                parsed.append({
                    "id": f"textparse-{_uuid_mod.uuid4().hex[:8]}",
                    "type": "function",
                    "function": {"name": name, "arguments": json.dumps(obj.get("arguments", obj.get("args", {})))}
                })
        except Exception:
            pass

    return parsed if parsed else None


def _parse_raw_args(tool_name: str, raw: str) -> dict:
    """Parse raw argument string from text-based tool call. Always returns a dict."""
    if not raw:
        return {}
    # Determine the first parameter name from schema
    schema = next((s for s in WOLF_TOOL_SCHEMAS if s["function"]["name"] == tool_name), None)
    first_param = "url"
    if schema:
        params = schema["function"]["parameters"].get("properties", {})
        first_param = next(iter(params), "url")
    # Try JSON object (only if it's actually an object, not a string)
    stripped = raw.strip()
    if stripped.startswith("{") and stripped.endswith("}"):
        try:
            parsed = json.loads(stripped)
            if isinstance(parsed, dict):
                return parsed
        except Exception:
            pass
    # Key=value pairs: url="https://...", extract="all"
    kv_matches = _re_mod.findall(r'(\w+)\s*=\s*["\']([^"\']*)["\']', raw)
    if kv_matches:
        return dict(kv_matches)
    # Single value -> map to first param
    val = raw.strip("\"'` ")
    if val:
        return {first_param: val}
    return {}


# ═══════════════════════════════════════════════════════════════════════════════
# Detection de refus web -- V2 : regex fuzzy (tolere mots intercales)
# ═══════════════════════════════════════════════════════════════════════════════

def _normalize_for_refusal(text: str) -> str:
    """Normalise le texte pour la detection de refus (lowercase, sans accents, sans markdown)."""
    t = text.lower().replace("**", "").replace("*", "").replace("`", "").replace("_", " ")
    # Normaliser les accents
    for a, b in [("è","e"),("é","e"),("ê","e"),("ë","e"),("à","a"),("â","a"),("ô","o"),("î","i"),("ù","u"),("û","u"),("ç","c")]:
        t = t.replace(a, b)
    return t

# Mots-cles simples (exact substring) -- rapides
_WEB_REFUSAL_EXACT = [
    "pas d'acces internet", "pas d'acces au web", "pas d'outil web",
    "aucun acces web", "aucun acces internet", "aucun outil web",
    "no web access", "no internet access", "no browsing capability",
    "can't access the web", "cannot access the web", "unable to access",
    "unable to browse", "can't browse", "cannot browse",
    "don't have access", "don't have web", "don't have internet",
    "copier-coller le html", "copier-coller le contenu", "colle le contenu",
    "pas active de mon cote", "ma liste d'outils", "ma configuration actuelle",
    "il faudrait ajouter", "il faudrait un outil", "il manque un outil",
]

# Patterns regex -- tolerent des mots intercales (malheureusement, actuellement, etc.)
_WEB_REFUSAL_REGEX = [
    r"n.ai\b.{0,30}\bpas\b.{0,20}\bacces",
    r"n.ai\b.{0,30}\bpas\b.{0,20}\bde capacite",
    r"ne peux\b.{0,20}\bpas\b.{0,20}\bacceder",
    r"ne peux\b.{0,20}\bpas\b.{0,20}\bnaviguer",
    r"ne peux\b.{0,20}\bpas\b.{0,20}\bvisiter",
    r"ne dispose\b.{0,20}\bpas\b.{0,20}\bd.outil",
    r"ne dispose\b.{0,20}\bpas\b.{0,20}\bd.acces",
    r"pas\b.{0,20}\ben mesure\b.{0,20}\bd.acceder",
    r"pas\b.{0,20}\ben mesure\b.{0,20}\bde naviguer",
    r"pas\b.{0,20}\bacces\b.{0,30}\b(?:web|internet|outils|navigation)",
    r"impossible\b.{0,20}\bd.acceder",
    r"pas\b.{0,20}\bde capacite\b.{0,20}\bd.acces",
    r"pas\b.{0,20}\bacceder\b.{0,20}\bau web",
    r"pas\b.{0,20}\bacceder\b.{0,20}\ba internet",
    r"outil.{0,15}n.est pas",
    r"pas\b.{0,15}\bactive\b.{0,15}\bde mon cote",
    r"je ne suis pas.{0,30}\b(?:capable|en mesure)",
    r"malheureusement.{0,40}\bpas.{0,20}\bacces",
    r"(?:visiter|consulter|acceder).{0,20}\bdirectement.{0,20}\b(?:site|page|url|web)",
    r"je.{0,10}recommande.{0,30}visiter.{0,10}directement",
]

# Compiler les regex une seule fois
_WEB_REFUSAL_COMPILED = [_re_mod.compile(p, _re_mod.IGNORECASE) for p in _WEB_REFUSAL_REGEX]


def _detect_web_refusal(text: str) -> bool:
    """Detect if the model is falsely claiming it can't access the web.
    V2: uses exact keywords + fuzzy regex patterns (tolerates filler words)."""
    if not text:
        return False
    text_clean = _normalize_for_refusal(text)

    # Check 1: exact substring match (fast)
    for kw in _WEB_REFUSAL_EXACT:
        if kw in text_clean:
            print(f"[Wolf] Refusal detected (exact): '{kw}'")
            return True

    # Check 2: regex fuzzy match (catches "n'ai malheureusement pas acces", etc.)
    for pattern in _WEB_REFUSAL_COMPILED:
        if pattern.search(text_clean):
            print(f"[Wolf] Refusal detected (regex): '{pattern.pattern}'")
            return True

    return False


async def _auto_generate_title(convo_id: int, user_msg: str, assistant_msg: str, provider, model: str):
    """
    Genere automatiquement un titre pour une nouvelle conversation.
    Appele en background apres le premier echange. Non-bloquant.
    """
    try:
        title_response = await provider.chat(
            [
                ChatMessage(role="system", content=(
                    "Genere UN SEUL titre court (max 40 caracteres) pour cette conversation. "
                    "Le titre doit resumer le sujet principal de maniere claire et concise. "
                    "Reponds UNIQUEMENT avec le titre, rien d'autre. Pas de guillemets."
                )),
                ChatMessage(role="user", content=f"User: {user_msg[:300]}\nAssistant: {assistant_msg[:300]}"),
            ],
            model,
        )
        title = (title_response.content or "").strip().strip('"').strip("'").strip()[:60]
        if not title or len(title) < 3:
            title = user_msg[:50].strip() + ("..." if len(user_msg) > 50 else "")

        # Sauvegarder dans la DB
        from backend.core.db.engine import get_session as _get_sess
        from backend.core.db.models import Conversation as _Conv
        async for _sess in _get_sess():
            _conv = await _sess.get(_Conv, convo_id)
            if _conv:
                _conv.title = title
                await _sess.commit()
                print(f"[Wolf] Auto-title for convo {convo_id}: '{title}'")
            break
    except Exception as e:
        print(f"[Wolf] Auto-title failed for convo {convo_id}: {e}")


async def _auto_score_response(user_id: int, user_msg: str, assistant_msg: str, convo_id: int):
    """Scoring auto d'une réponse agent (fire-and-forget).

    Utilise le LLM configuré par l'utilisateur pour noter la réponse sur les
    dimensions configurées (par défaut : utility/accuracy/tone/autonomy), puis
    persiste via engine.score_interaction(triggered_by='auto'). Les scores
    alimentent le mood auto, la pression volition et le prompt de conscience.

    Gated par conscience.enabled + reward.auto_score. Silencieux en cas
    d'erreur (pas de provider configuré, parse JSON raté, etc.) — ce n'est
    pas un chemin critique du chat.
    """
    if not user_id or not (assistant_msg or "").strip():
        return
    try:
        from backend.core.plugin_registry import get_consciousness_engine
        from backend.core.services.llm_invoker import invoke_llm_for_user
        import json as _json
        import re as _re

        engine = get_consciousness_engine(user_id)
        if engine is None or not engine.enabled:
            return
        reward_cfg = (engine.config or {}).get("reward", {}) or {}
        if not reward_cfg.get("auto_score", True):
            return
        dimensions = reward_cfg.get("dimensions") or ["utility", "accuracy", "tone", "autonomy"]

        dim_lines = "\n".join(f'  "{d}": <0.0 à 1.0>,' for d in dimensions)
        system = (
            "Tu es un évaluateur bref et juste de réponses d'assistant. Tu notes "
            "chaque dimension entre 0.0 (médiocre) et 1.0 (excellent) avec un "
            "biais léger vers la sévérité : 0.7 = bon, 0.85 = très bon, 0.95+ = "
            "exceptionnel. Réponds en JSON strict, sans texte autour."
        )
        prompt = (
            f"## Demande utilisateur\n{(user_msg or '')[:600]}\n\n"
            f"## Réponse de l'assistant\n{(assistant_msg or '')[:2400]}\n\n"
            "Évalue la réponse. Réponds UNIQUEMENT avec ce JSON :\n"
            "{\n" + dim_lines + '\n  "feedback": "1 phrase courte sur ce qui pourrait s\'améliorer"\n}'
        )

        result = await invoke_llm_for_user(user_id, prompt, system_prompt=system)
        if not result.get("ok"):
            return
        raw = (result.get("content") or "").strip()
        if not raw:
            return
        # Tolère fences markdown et texte parasite
        if raw.startswith("```"):
            raw = _re.sub(r"^```[a-zA-Z]*\n?", "", raw)
            raw = _re.sub(r"\n?```\s*$", "", raw)
        start = raw.find("{"); end = raw.rfind("}")
        if start < 0 or end < 0:
            return
        try:
            data = _json.loads(raw[start:end + 1])
        except Exception:
            return
        if not isinstance(data, dict):
            return

        scores = {}
        for d in dimensions:
            v = data.get(d)
            if isinstance(v, (int, float)):
                scores[d] = max(0.0, min(1.0, float(v)))
        if not scores:
            return

        feedback = str(data.get("feedback") or "")[:200]
        engine.score_interaction(
            interaction_type="chat_response",
            scores=scores,
            triggered_by="auto",
            description=f"Auto-score convo={convo_id} — {feedback}" if feedback else f"Auto-score convo={convo_id}",
        )
    except Exception as e:
        print(f"[Wolf] Auto-score skipped: {e}")


async def _do_presearch(query: str, tool_events: list) -> list[str]:
    """
    Execute une recherche web + fetch des top resultats.
    Retourne une liste de strings formatees avec le contenu.
    Reutilisable par le pre-fetch ET le refusal handler.
    """
    from backend.core.agents.tools.web_fetch import web_search_lite, web_fetch as _wf_enrich
    print(f"[Wolf] PRE-SEARCH: '{query[:80]}...'")
    try:
        search_result = await web_search_lite(query, num_results=8)
        if not search_result.get("ok") or not search_result.get("results"):
            print(f"[Wolf] PRE-SEARCH: no results or error: {search_result.get('error', '?')}")
            return []

        results_text = f"## Resultats de recherche pour : {query}\n\n"
        for i, r in enumerate(search_result["results"][:8], 1):
            results_text += f"**{i}. [{r.get('title', 'Sans titre')}]({r.get('url', '')})**\n"
            if r.get("snippet"):
                results_text += f"   {r['snippet']}\n"
            results_text += "\n"

        tool_events.append({
            "tool": "web_search (auto)",
            "args": {"query": query},
            "result": {"ok": True, "results_count": len(search_result["results"])},
        })
        print(f"[Wolf] PRE-SEARCH OK: {len(search_result['results'])} results")

        # Fetcher le top 1-2 resultats pour du contenu riche
        enriched = [results_text]
        for top_result in search_result["results"][:2]:
            top_url = top_result.get("url", "")
            if top_url:
                try:
                    page = await _wf_enrich(top_url, extract="text")
                    if page.get("ok") and page.get("text"):
                        enriched.append(
                            f"## Contenu de : {top_result.get('title', top_url)}\n"
                            f"**URL:** {top_url}\n\n"
                            f"{page['text'][:5000]}"
                        )
                        tool_events.append({
                            "tool": "web_fetch (auto-enrich)",
                            "args": {"url": top_url},
                            "result": {"ok": True, "title": page.get("title", "")},
                        })
                        print(f"[Wolf] PRE-SEARCH enriched: {top_url}")
                except Exception as _e:
                    print(f"[Wolf] PRE-SEARCH enrich failed for {top_url}: {_e}")
        return enriched
    except Exception as e:
        print(f"[Wolf] PRE-SEARCH error: {e}")
        return []


async def _prefetch_urls_in_message(message: str, tool_events: list) -> list[str]:
    """
    PRE-FETCH PROACTIF -- comme OpenClaw.
    Scanne le message utilisateur pour les URLs/domaines ET les requetes de recherche.
    Fetch le contenu AVANT d'envoyer au LLM.
    Retourne une liste de strings formatees avec le contenu de chaque URL/recherche.
    """
    if not message:
        return []

    # -- Phase 1 : Extraire les URLs explicites
    urls = _re_mod.findall(r'https?://[^\s<>"\'`,\)\]]+', message)

    # Extraire les domaines (scarletwolf.fr, google.com/path, etc.)
    domains = _re_mod.findall(
        r'(?<![/\w])([a-zA-Z0-9][-a-zA-Z0-9]*\.(?:fr|com|org|net|io|dev|ai|co|app|me|info|eu|tech|xyz|be|ch|ca|uk|de|es|it|nl|pt|ru|jp|cn|kr|au|us|gg|tv|cc|club|online|site|store|shop|pro|biz|name|live|world|space|fun|zone|link|click|today|rocks|cloud|design|art|solutions|agency|studio|digital|media|software|tools|work|services|page|one|new)[a-zA-Z0-9/.?&=_-]*)',
        message
    )
    for d in domains:
        full_url = f"https://{d}" if not d.startswith("http") else d
        if full_url not in urls:
            urls.append(full_url)

    # -- Phase 2 : Detection de requetes de recherche -- style OpenClaw
    if not urls:
        msg_lower = message.lower().strip()
        msg_norm = _normalize_for_refusal(msg_lower)

        _SEARCH_TRIGGERS = [
            # FR -- verbes d'action web
            "cherche", "recherche", "trouve", "va sur", "va voir", "regarde",
            "consulte", "verifie", "explore", "fouille", "scrute", "analyse",
            # FR -- demandes d'info
            "qu'est-ce que", "c'est quoi", "donne-moi des infos", "donne moi des infos",
            "infos sur", "informations sur", "renseigne", "dis-moi", "dis moi",
            "parle-moi de", "parle moi de", "montre-moi", "montre moi",
            "fais une recherche", "lance une recherche",
            # FR -- contexte web
            "sur internet", "sur le web", "sur google", "en ligne",
            "actualite", "actualites", "news", "dernieres nouvelles",
            "prix de", "meteo", "horaires", "resultats",
            "site web", "page web", "site de",
            # EN
            "search", "look up", "find", "google", "browse",
            "what is", "what are", "who is", "tell me about",
            "latest", "current", "news about", "price of",
        ]
        _is_search_query = any(trigger in msg_norm for trigger in _SEARCH_TRIGGERS)

        if _is_search_query:
            return await _do_presearch(message, tool_events)

        return []

    # -- Phase 3 : Fetch chaque URL trouvee en parallele
    from backend.core.agents.tools.web_fetch import web_fetch

    results = []
    for url in urls[:3]:  # Max 3 URLs par message
        try:
            print(f"[Wolf] Pre-fetching: {url}")
            result = await web_fetch(url, extract="all")
            if result.get("ok"):
                title = result.get("title", "")
                text = result.get("text", "")[:8000]
                links_count = result.get("links_total", 0)
                description = result.get("description", "")

                formatted = f"## {title or url}\n**URL:** {result.get('url', url)}\n"
                if description:
                    formatted += f"**Description:** {description}\n"
                formatted += f"**Liens trouves:** {links_count}\n\n{text}"

                results.append(formatted)
                tool_events.append({
                    "tool": "web_fetch (auto)",
                    "args": {"url": url},
                    "result": {"ok": True, "title": title, "text_length": len(text)},
                })
                print(f"[Wolf] Pre-fetched OK: {title or url} ({len(text)} chars)")
            else:
                print(f"[Wolf] Pre-fetch failed for {url}: {result.get('error', '?')}")
        except Exception as e:
            print(f"[Wolf] Pre-fetch error for {url}: {e}")

    return results


def _extract_urls_from_conversation(messages: list) -> list[str]:
    """Extract URLs mentioned in user messages."""
    urls = []
    for m in messages:
        if m.role == "user" and m.content:
            found = _re_mod.findall(r'https?://[^\s<>"\'`,\)]+', m.content)
            urls.extend(found)
            domains = _re_mod.findall(r'(?<!\w)([a-zA-Z0-9][-a-zA-Z0-9]*\.[a-zA-Z]{2,}(?:/[^\s<>"\'`,\)]*)?)', m.content)
            for d in domains:
                if not d.startswith("http"):
                    urls.append(f"https://{d}")
    return urls


# Chemin du fichier soul (global fallback — per-user paths use _soul_path(uid))
SOUL_FILE = Path(__file__).parent.parent.parent.parent / "data" / "soul.md"


def _get_soul_file(user_id: int = 0) -> Path:
    """Retourne le chemin soul per-user, ou global fallback."""
    return _soul_path(user_id)

def _get_default_soul(agent_name: str = None) -> str:
    """Generate a default soul template for a user who hasn't written their
    own yet. Uses the explicit agent_name passed in (per-user), falling back
    to the literal 'Gungnir' — NEVER reads Settings.app.agent_name which is
    a legacy global that a tool call could have polluted."""
    name = (agent_name or "").strip() or "Gungnir"
    return f"""# Ame de {name} -- Identite permanente

Tu es **{name}**, un super-assistant IA.
Tu es intelligent, proactif, precis et loyal envers ton utilisateur.
Tu parles en francais par defaut, sauf si l'utilisateur s'adresse a toi dans une autre langue.
Tu es honnete : tu admets clairement quand tu ne sais pas quelque chose.
Tu n'es pas Claude, GPT ou un autre assistant generique -- tu es {name}.
"""

# The legacy ONBOARDING_PROMPT was a global detection ("no messages in the
# whole DB") that broke in multi-user mode. The new onboarding system uses
# a per-user flag (UserSettings.onboarding_state.step) plus a conversation
# metadata marker (metadata_json.is_onboarding = true). See
# backend/core/api/onboarding.py for the full flow.


def _sse(event: str, payload) -> str:
    body = payload if isinstance(payload, str) else json.dumps(payload, ensure_ascii=False, default=str)
    return f"event: {event}\ndata: {body}\n\n"


@router.post("/conversations/{convo_id}/chat")
@limiter.limit("60/minute")
async def chat(
    convo_id: int,
    request: Request,
    data: dict,
    session: AsyncSession = Depends(get_session)
):
    async def _sse_gen():
        try:
            result = await _chat_impl(convo_id, request, data, session)
        except Exception as _e:
            import logging
            logging.getLogger("gungnir").error(f"Chat error: {_e}", exc_info=True)
            yield _sse("error", {"error": _classify_llm_error(_e)})
            return

        if not isinstance(result, dict):
            yield _sse("error", {"error": "Réponse interne invalide."})
            return

        if result.get("error"):
            yield _sse("error", {"error": result["error"]})
            return

        for _evt in (result.get("tool_events") or []):
            yield _sse("tool", _evt)

        content = result.get("content") or ""
        # Artificial progressive streaming of the final content for UX feedback
        # (true token-level streaming would require restructuring the tool-call
        # loop — here we chunk the already-generated content quickly).
        # Si le client a coupé (bouton Stop), on arrête d'envoyer les tokens
        # restants pour ne pas continuer à remplir la bulle côté UI.
        _step = 4
        for _i in range(0, len(content), _step):
            try:
                if await request.is_disconnected():
                    return
            except Exception:
                pass
            yield _sse("token", content[_i:_i + _step])
            await asyncio.sleep(0.006)

        done_payload = {k: v for k, v in result.items() if k not in ("tool_events",)}
        yield _sse("done", done_payload)

    return StreamingResponse(
        _sse_gen(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )


async def _chat_impl(
    convo_id: int,
    request: Request,
    data: dict,
    session: AsyncSession,
):
    # -- Ownership check
    from backend.core.api.auth_helpers import enforce_conversation_owner, get_user_settings, get_user_provider_key
    convo_check = await enforce_conversation_owner(convo_id, request, session)
    if not convo_check:
        return {"error": "Conversation non autorisée"}

    # -- Budget check (graceful — uses separate session to avoid corrupting main transaction)
    _budget_uid_check = getattr(request.state, "user_id", None) or 0
    try:
        from backend.core.cost.manager import get_cost_manager
        from backend.core.db.engine import async_session as _budget_session_maker
        cm = get_cost_manager()
        async with _budget_session_maker() as _budget_session:
            budget_status = await cm.check_all_budgets(_budget_session, user_id=_budget_uid_check or None)
        if budget_status.get("should_block"):
            return {"error": f"Budget depasse : {budget_status.get('block_reason', 'limite atteinte')}. Augmentez votre budget ou attendez la prochaine periode."}
    except Exception as e:
        print(f"[Wolf] Budget check skipped: {e}")

    settings = Settings.load()
    provider_name = data.get("provider", "openrouter")
    model = data.get("model")
    message = data.get("message", "")

    # -- Resolve API key: STRICT per-user — the global settings hold only
    # provider metadata (base_url, model lists). Keys live only in the user's
    # UserSettings.provider_keys so one user's key can never back another user.
    user_id = getattr(request.state, "user_id", None)
    _user_api_key = None
    _user_base_url = None
    if user_id:
        try:
            user_settings = await get_user_settings(user_id, session)
            user_prov = get_user_provider_key(user_settings, provider_name)
            if user_prov and user_prov.get("api_key"):
                _user_api_key = user_prov["api_key"]
                _user_base_url = user_prov.get("base_url")
        except Exception as e:
            print(f"[Wolf] User key lookup skipped: {e}")

    if not _user_api_key:
        return {"error": f"Aucune clé API configurée pour le provider '{provider_name}'. Ajoute la tienne dans Paramètres → Providers."}

    # Build a per-request provider_config from global metadata (base_url, models)
    # and the user's own key. The original global entry is never mutated.
    _global_meta = settings.providers.get(provider_name)
    if _global_meta:
        provider_config = _global_meta.model_copy()
    else:
        provider_config = ProviderConfig(enabled=True)
    provider_config.api_key = _user_api_key
    provider_config.enabled = True
    if _user_base_url:
        provider_config.base_url = _user_base_url

    # Validation du modele : verifier qu'il existe chez le provider
    if model:
        try:
            _provider_tmp = get_provider(provider_name, provider_config.api_key, provider_config.base_url)
            _live_models = await _provider_tmp.list_models()
            if _live_models and model not in _live_models:
                # Chercher un match partiel (ex: "gemini-2.5-flash" dans "google/gemini-2.5-flash")
                _partial = [m for m in _live_models if model in m or m in model]
                if _partial:
                    print(f"[Wolf] Model '{model}' not found, using closest match: '{_partial[0]}'")
                    model = _partial[0]
                else:
                    return {"error": f"Modele '{model}' introuvable chez {provider_name}. Verifiez le nom du modele."}
        except Exception as _e:
            print(f"[Wolf] Model validation skipped: {_e}")

    result = await session.execute(
        select(Message).where(Message.conversation_id == convo_id).order_by(Message.created_at)
    )
    messages = result.scalars().all()

    chat_messages = [
        ChatMessage(role=m.role, content=m.content)
        for m in messages
    ]
    # Extraire les images si présentes + fallback vision
    user_images = data.get("images", [])
    actual_model = model or provider_config.default_model or ""
    # Log visible pour diagnostiquer les soucis de transmission d'images au LLM.
    # Format : [Wolf Vision] provider=openrouter model=... images_count=1 sizes=[12345 bytes]
    if user_images:
        try:
            _sizes = [len(img) for img in user_images if isinstance(img, str)]
        except Exception:
            _sizes = []
        print(f"[Wolf Vision] provider={provider_name} model={actual_model} images_count={len(user_images)} sizes={_sizes}")
    _vision_ok = await _model_supports_vision(actual_model) if user_images else True
    if user_images:
        print(f"[Wolf Vision] supports_vision({actual_model}) → {_vision_ok}")
    if user_images and not _vision_ok:
        # Le modèle ne supporte pas la vision → décrire les images en texte.
        # Only the caller's own vision keys are used — no cross-user fallback.
        print(f"[Wolf] Model '{actual_model}' has no vision — using fallback description")
        _caller_user_settings = None
        if user_id:
            try:
                _caller_user_settings = await get_user_settings(user_id, session)
            except Exception:
                _caller_user_settings = None
        description = await _describe_images_for_blind_model(
            user_images, message, settings,
            user_settings=_caller_user_settings,
            session=session, convo_id=convo_id, user_id=user_id,
        )
        message = f"{message}\n\n[Description des images jointes par un modèle vision :\n{description}]"
        user_images = []  # Ne pas envoyer les images au modèle non-vision
    chat_messages.append(ChatMessage(role="user", content=message, images=user_images))

    # Detection commande de changement de personnalite
    from backend.core.agents.skills import personality_manager as pm
    from backend.core.agents import user_data as _ud
    _current_uid = getattr(request.state, "user_id", None) or 1
    set_user_context(_current_uid)
    personality_cmd = pm.detect_personality_command(message)
    if personality_cmd:
        await _ud.set_active_personality(session, _current_uid, personality_cmd)
        print(f"[Wolf] Personality switched to '{personality_cmd}' via chat command")

    # Construction du system prompt : Soul (identite) + Personnalite (mode) + Outils
    _lang_names = {
        # Europe occidentale
        "fr": "francais", "en": "anglais", "es": "espagnol", "pt": "portugais",
        "it": "italien", "de": "allemand", "nl": "neerlandais", "ca": "catalan",
        "be": "flamand", "br": "breton",
        # Europe nordique
        "sv": "suedois", "no": "norvegien", "da": "danois", "fi": "finnois", "is": "islandais",
        # Europe orientale
        "pl": "polonais", "ru": "russe", "uk": "ukrainien", "cs": "tcheque", "sk": "slovaque",
        "hu": "hongrois", "ro": "roumain", "bg": "bulgare", "hr": "croate", "sr": "serbe",
        "sl": "slovene", "et": "estonien", "lv": "letton", "lt": "lituanien",
        # Europe du Sud-Est
        "el": "grec", "tr": "turc",
        # Moyen-Orient
        "ar": "arabe", "he": "hebreu", "fa": "persan",
        # Asie
        "zh": "chinois simplifie", "zh-TW": "chinois traditionnel",
        "ja": "japonais", "ko": "coreen",
        "hi": "hindi", "bn": "bengali",
        "th": "thai", "vi": "vietnamien",
        "id": "indonesien", "ms": "malais", "tl": "filipino",
        # Afrique
        "sw": "swahili", "am": "amharique",
    }
    _lang_code = settings.app.language or "fr"
    _lang_label = _lang_names.get(_lang_code, _lang_code)
    # STRICT per-user agent identity: name comes from UserSettings.agent_name,
    # soul comes from data/soul/<uid>/soul.md. Both are edited from the UI
    # (Settings → General for the name via /api/config/user/app, Agent →
    # Personnalité for the soul via /api/agent/soul) and both are written by
    # the onboarding welcome chat. The legacy Settings.app.agent_name global
    # and data/soul.md global are NEVER read here — they exist only as a
    # last-resort default template.
    _agent_name = "Gungnir"
    _agent_name_source = "default"
    try:
        _user_settings_row = await get_user_settings(_current_uid, session)
        if _user_settings_row.agent_name:
            _agent_name = _user_settings_row.agent_name
            _agent_name_source = f"UserSettings.agent_name (uid={_current_uid})"
    except Exception:
        pass
    print(f"[Wolf] agent_name resolved to '{_agent_name}' from {_agent_name_source}")
    _user_soul_file = _get_soul_file(_current_uid)
    if _user_soul_file.exists():
        soul_content = _user_soul_file.read_text(encoding="utf-8")
        # Self-healing: check the identity pattern "Tu es **X**" against
        # the current agent name. Replace the old name everywhere if stale.
        if _agent_name:
            import re
            m = re.search(r'Tu es \*\*(.+?)\*\*', soul_content)
            if m and m.group(1) != _agent_name:
                soul_content = soul_content.replace(m.group(1), _agent_name)
                try:
                    _user_soul_file.write_text(soul_content, encoding="utf-8")
                except Exception:
                    pass
    else:
        soul_content = _get_default_soul(_agent_name)
    chosen_model = model or provider_config.default_model
    soul_content = soul_content + (
        f"\n\n**Ton nom :** Tu t'appelles **{_agent_name}**. Utilise CE nom quand tu te presentes, jamais 'Wolf' ou un autre nom generique."
        f"\n**Modele LLM actuel :** Tu tournes sur le modele `{chosen_model}` via le provider `{provider_name}`."
        f" Quand on te demande quel modele tu es, reponds avec cet identifiant."
        f"\n**Langue de reponse :** Tu reponds TOUJOURS en {_lang_label}, quelle que soit la langue du message recu, sauf instruction explicite contraire."
    )

    # Detect welcome-chat onboarding — per-user flag + conversation marker
    from backend.core.api.onboarding import is_onboarding_active, ONBOARDING_SYSTEM_PROMPT
    _is_onboarding_convo = await is_onboarding_active(session, _current_uid, convo_id)
    active_personality = await _ud.get_active_personality(session, _current_uid)
    personality_block = ""
    if active_personality and active_personality.get("system_prompt"):
        personality_block = f"\n\n## Mode de personnalite actif : {active_personality['name']}\n{active_personality['system_prompt']}"
        print(f"[Wolf] Personality overlay applied: '{active_personality['name']}' ({len(active_personality['system_prompt'])} chars)")
    else:
        print(f"[Wolf] No personality overlay (active: '{active_personality.get('name') if active_personality else 'none'}')")

    # Active skill overlay (user-selected from Agent Settings)
    active_skill = await _ud.get_active_skill(session, _current_uid)
    skill_block = ""
    if active_skill and active_skill.get("prompt"):
        skill_block = f"\n\n## Skill actif : {active_skill['name']}\n{active_skill['prompt']}"
        print(f"[Wolf] Skill overlay applied: '{active_skill['name']}' ({len(active_skill['prompt'])} chars)")

    # Construire la liste des modeles disponibles pour guider Wolf — basée
    # uniquement sur les providers pour lesquels CE user a une clé configurée.
    _available_models_lines = []
    _caller_provider_names: set[str] = set()
    if user_id:
        try:
            _us_for_models = await get_user_settings(user_id, session)
            for _pname_k in (_us_for_models.provider_keys or {}).keys():
                _decoded_k = get_user_provider_key(_us_for_models, _pname_k)
                if _decoded_k and _decoded_k.get("api_key"):
                    _caller_provider_names.add(_pname_k)
        except Exception:
            pass
    for _pname, _pcfg in settings.providers.items():
        if _pname in _caller_provider_names and _pcfg.models:
            _available_models_lines.append(f"  - **{_pname}** : {', '.join(_pcfg.models[:12])}")
    _models_section = "\n".join(_available_models_lines) if _available_models_lines else "  (aucun provider configure pour cet utilisateur)"

    # Le tools_block sera construit APRES le gateway (voir plus bas)
    _models_section_for_prompt = _models_section

    # Placeholder : le system prompt sera insere apres le gateway
    _soul_content = soul_content
    _personality_block = personality_block
    _skill_block = skill_block

    provider = get_provider(
        provider_name,
        provider_config.api_key,
        provider_config.base_url,
    )

    try:
        import json as _json
        import uuid as _uuid
        from backend.core.agents.mode_manager import mode_pool
        from backend.core.gateway import WebGateway, detect_web_refusal, extract_original_query, extract_urls_from_messages

        mode_manager = mode_pool.get(user_id or 0)
        MAX_TOOL_ROUNDS = 12
        tool_events: list[dict] = []

        # ══════════════════════════════════════════════════════════════════
        # WEB GATEWAY -- style OpenClaw
        # ══════════════════════════════════════════════════════════════════
        gateway = WebGateway()
        print(f"[Wolf] Gateway processing: {message[:120]}...")
        gw_result = await gateway.process_message(message)
        tool_events.extend(gw_result["tool_events"])

        if gw_result["has_web_content"]:
            for i in range(len(chat_messages) - 1, -1, -1):
                if chat_messages[i].role == "user":
                    chat_messages[i] = ChatMessage(
                        role="user",
                        content=gw_result["enriched_message"],
                    )
                    break
            print(f"[Wolf] Gateway injected web content ({len(gw_result['web_content'])} blocks)")
        else:
            print(f"[Wolf] Gateway: no web intent or fetch failed")

        # ══════════════════════════════════════════════════════════════════
        # SYSTEM PROMPT -- construit APRES le gateway pour l'adapter
        # ══════════════════════════════════════════════════════════════════
        if gw_result["has_web_content"]:
            tools_block = f"""

## CAPACITES

Tu es un assistant IA avec acces Internet. Le systeme backend recupere automatiquement le contenu web pour toi.

**REGLE CRITIQUE : Le message ci-dessous contient du contenu web pre-charge par le systeme (marque [SYSTEME -- CONTENU WEB PRE-CHARGE]). Ce contenu est REEL et FRAIS. Utilise-le directement pour repondre.**

Tu n'as PAS besoin d'appeler d'outils -- le contenu est deja dans le message.
Ne dis JAMAIS que tu n'as pas acces au web ou que des outils ne sont pas actives.
Le contenu web est LA, dans le message. Lis-le et reponds.

## Modeles LLM disponibles (pour les sous-agents)
{_models_section_for_prompt}
"""
        else:
            tools_block = f"""

## CAPACITES SYSTEME

Tu es connecte a un systeme backend avec des capacites speciales :
- **ACCES INTERNET** -- visiter des sites, chercher sur le web, crawler
- **Browser Playwright** -- sites dynamiques avec JavaScript
- **Gestion de skills, personnalites, sous-agents**
- **Base de connaissance** -- lire/ecrire des fichiers

## COMMENT APPELER TES OUTILS

Format exact (le systeme detecte et execute automatiquement) :

<tool_call>{{"name": "web_fetch", "arguments": {{"url": "https://example.com"}}}}</tool_call>
<tool_call>{{"name": "web_search", "arguments": {{"query": "ScarletWolf artisanat"}}}}</tool_call>
<tool_call>{{"name": "provider_manage", "arguments": {{"action": "switch", "provider": "google", "model": "gemini-2.5-flash-preview"}}}}</tool_call>
<tool_call>{{"name": "channel_manage", "arguments": {{"action": "create", "channel_type": "slack", "name": "Mon Slack", "config": {{"bot_token": "xoxb-xxxx"}}}}}}</tool_call>
<tool_call>{{"name": "provider_manage", "arguments": {{"action": "save", "provider": "anthropic", "api_key": "sk-ant-xxxx"}}}}</tool_call>
<tool_call>{{"name": "mcp_manage", "arguments": {{"action": "add", "name": "github", "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"], "env": {{"GITHUB_TOKEN": "ghp_xxxx"}}}}}}</tool_call>

**IMPORTANT :** Tu as la capacite COMPLETE de connecter des services, changer de modele, et configurer le systeme. Utilise tes outils channel_manage, provider_manage, mcp_manage. Ne dis JAMAIS que tu ne peux pas faire ces actions.

## TES OUTILS

**Web :** web_fetch(url,extract), web_search(query,num_results), web_crawl(url,max_pages,same_domain)
**Skills :** skill_create, skill_update, skill_delete, skill_list
**Personnalites :** personality_create, personality_update, personality_set_active, personality_delete
**Sous-agents :** subagent_create, subagent_invoke (alias: subagent_run) pour lancer un sous-agent, subagent_list, subagent_update, subagent_delete
**KB :** kb_write(filename,content), kb_read(filename), kb_list
**Browser :** browser_navigate, browser_get_text, browser_click, browser_type, browser_screenshot, browser_evaluate, browser_get_links, browser_crawl, browser_close
**Identite :** soul_read, soul_write(content)
**Channels :** channel_manage(action,channel_type,channel_id,name,config,enabled) — actions: list, catalog, create, update, toggle, delete, test, oauth_url
**Providers :** provider_manage(action,provider,api_key,base_url,model,enabled) — actions: list, save, delete, switch (changer le modèle actif)
**MCP :** mcp_manage(action,name,command,args,env,enabled) — actions: list, add, delete
**Diagnostic :** doctor_check(scope)

## Modeles LLM disponibles
{_models_section_for_prompt}

## REGLES
1. **TU AS INTERNET.** Ne dis jamais le contraire.
2. Si du contenu web est pre-charge dans le message, utilise-le directement.
3. Sinon, appelle web_fetch ou web_search avec <tool_call>.
4. **TU PEUX CHANGER DE MODELE.** Si l'utilisateur demande de passer sur un autre LLM, appelle provider_manage(action="switch") immediatement. Ne dis JAMAIS que tu ne peux pas changer de modele.
5. **TU PEUX CONNECTER DES SERVICES.** Ne dis JAMAIS que tu ne peux pas connecter Slack/Discord/Telegram/etc.
   - Tu as l'outil channel_manage pour creer, configurer et activer des canaux.
   - Tu as l'outil provider_manage pour sauvegarder des cles API.
   - Tu as l'outil mcp_manage pour ajouter des serveurs MCP (n8n, GitHub, Notion, etc.).
   - **Workflow RAPIDE pour Slack/Discord (OAuth en 1 clic)** :
     a) Demande a l'utilisateur de creer une app (Slack: api.slack.com/apps, Discord: discord.com/developers)
     b) Demande le Client ID et Client Secret (Slack) ou Application ID + Public Key + Bot Token (Discord)
     c) Cree le canal : channel_manage(action="create", channel_type="slack", name="Mon Slack", config={{"client_id": "...", "client_secret": "..."}})
     d) Genere le lien OAuth : channel_manage(action="oauth_url", channel_type="slack", channel_id="...")
     e) Envoie le lien a l'utilisateur : "Clique sur ce lien pour autoriser l'app"
     f) Quand il clique, le callback configure automatiquement le bot_token et active le canal !
   - **Workflow pour Telegram** (pas d'OAuth, mais simple) :
     a) Dis a l'utilisateur d'ouvrir Telegram, chercher @BotFather, envoyer /newbot
     b) Demande-lui le token fourni par BotFather
     c) Cree le canal : channel_manage(action="create", channel_type="telegram", name="Mon Bot", config={{"bot_token": "123456:ABC..."}})
     d) Active-le : channel_manage(action="toggle", channel_id="...")
     e) Le webhook Telegram est configure automatiquement
   - **Workflow pour un token direct** (si l'utilisateur a deja le token) :
     a) channel_manage(action="create") avec le token dans config
     b) channel_manage(action="toggle") pour activer
   - **Ne refuse JAMAIS** de connecter un service. Tu as TOUS les outils necessaires. Guide l'utilisateur etape par etape, puis execute.
   - Pour les cles API LLM : demande la cle, puis appelle provider_manage(action="save", provider="...", api_key="...")
   - Pour les serveurs MCP : demande le nom et la commande, puis appelle mcp_manage(action="add", name="...", command="npx", args=["-y", "package-name"])
"""

        # ══════════════════════════════════════════════════════════════════
        # MODE AGENT — instructions comportementales selon le mode actif
        # ══════════════════════════════════════════════════════════════════
        _mode = mode_manager.current_mode.value
        if _mode == "autonomous":
            mode_block = """

## MODE : AUTONOME (carte blanche)

Tu operes en mode **autonome total**. Tu peux et DOIS prendre des initiatives :
- **Creer des sous-agents** specialises si la tache est complexe (subagent_create + subagent_invoke)
- **Creer des skills** reutilisables si tu identifies un pattern repetitif (skill_create)
- **Rechercher des ressources en ligne** spontanement pour enrichir tes reponses (web_search, web_fetch)
- **Ecrire dans la base de connaissances** pour memoriser des informations utiles (kb_write)
- **Modifier ta propre identite** si pertinent (soul_write)
- **Changer de personnalite** selon le contexte (personality_set_active)

Tu n'as besoin d'AUCUNE validation humaine. Agis, execute, ameliore. Si tu as besoin d'info, va la chercher.
Quand tu crees un sous-agent ou un skill, informe l'utilisateur de ce que tu as fait et pourquoi.
"""
        elif _mode == "restrained":
            mode_block = """

## MODE : RESTREINT (sur demande explicite uniquement)

Tu operes en mode **restreint**. Regles strictes :
- Tu as acces a TOUS les outils (lecture, ecriture, web, creation, etc.)
- MAIS tu ne prends **AUCUNE initiative**. Tu n'utilises un outil QUE si l'utilisateur te le demande **explicitement**
- Ne cree PAS de sous-agents, skills, ou recherches web spontanement
- Ne propose PAS d'actions proactives ("je pourrais aussi faire X...")
- Si l'utilisateur dit "cree un skill", "va chercher sur le web", "cree un sous-agent" → tu le fais immediatement
- Si l'utilisateur pose une question simple → tu reponds avec tes connaissances, sans appeler d'outils
- En resume : tu es un executant strict, pas un assistant proactif. Tu fais ce qu'on te demande, rien de plus.
"""
        else:  # ask_permission
            mode_block = """

## MODE : DEMANDE (validation humaine requise)

Tu operes en mode **demande**. Comportement :
- Les outils en **lecture** sont autorises librement (lister, lire, consulter, chercher sur le web)
- Pour les actions sensibles (creer/modifier/supprimer skills, sous-agents, personnalites, ecrire dans la KB, modifier ton ame), tu dois **demander la permission a l'utilisateur** AVANT d'agir
- Formule ta demande clairement : dis ce que tu veux faire, pourquoi, et demande confirmation
- N'execute l'action QUE si l'utilisateur confirme explicitement
- Si tu detectes une opportunite (creer un skill utile, un sous-agent specialise), PROPOSE-le mais n'agis pas sans accord
"""

        # ══════════════════════════════════════════════════════════════════
        # CONSCIENCE v3 — injection si activée
        # ══════════════════════════════════════════════════════════════════
        consciousness_block = ""
        try:
            from backend.core.plugin_registry import get_consciousness_engine
            _user_consciousness = get_consciousness_engine(user_id or 0)
            if _user_consciousness is not None and _user_consciousness.enabled:
                consciousness_block = _user_consciousness.get_consciousness_prompt_block()
                _user_consciousness.record_interaction()
        except Exception:
            pass  # Plugin non chargé ou erreur — pas bloquant

        # Welcome-chat onboarding injection (strictly per-user)
        onboarding_block = ""
        if _is_onboarding_convo:
            onboarding_block = "\n\n" + ONBOARDING_SYSTEM_PROMPT
            print(f"[Wolf] ONBOARDING: welcome chat active for user={_current_uid}, convo={convo_id}")

        # ══════════════════════════════════════════════════════════════════
        # Todo-list interne de la conversation (injection si présente)
        # ══════════════════════════════════════════════════════════════════
        tasks_block = ""
        try:
            from backend.core.db.models import ConversationTask as _CT
            from sqlalchemy import select as _select
            _tq = await session.execute(
                _select(_CT).where(_CT.conversation_id == convo_id).order_by(_CT.position, _CT.id)
            )
            _current_tasks = _tq.scalars().all()
            if _current_tasks:
                _lines = []
                for t in _current_tasks:
                    marker = {"pending": "[ ]", "in_progress": "[~]", "completed": "[x]"}.get(t.status, "[ ]")
                    label = t.active_form if (t.status == "in_progress" and t.active_form) else t.content
                    _lines.append(f"  {marker} {label}")
                tasks_block = (
                    "\n\n## Todo-list de cette conversation\n"
                    "Tu gères une todo-list interne pour cette conversation (outils `conversation_tasks_list` / `conversation_tasks_set`). "
                    "État actuel :\n" + "\n".join(_lines) +
                    "\n\nMets à jour cette liste au fur et à mesure via `conversation_tasks_set` (remplacement complet). "
                    "Une seule tâche en 'in_progress' à la fois. Marque 'completed' dès qu'une étape est finie."
                )
        except Exception as _e:
            print(f"[Wolf] tasks_block injection failed: {_e}")

        style_block = (
            "\n\n## Style de reponse\n"
            "Tu reponds en Markdown propre et aere, pense 'lecture confortable', pas 'bloc de texte brut'.\n"
            "\n"
            "Regles :\n"
            "- Pour les reponses courtes (<3 phrases), reste naturel, pas de titre.\n"
            "- Des que la reponse couvre 2 aspects ou plus, structure avec des `## Titres` thematiques.\n"
            "- Si c'est un sujet complexe ou detaille, demarre par un `# Titre principal` qui reformule la demande, puis enchaine avec 2-4 sections `## ...`, et termine par une courte synthese (derniere ligne ou petit paragraphe).\n"
            "- Paragraphes aeres (saute une ligne entre deux paragraphes), phrases courtes.\n"
            "- Mets en **gras** les termes-cles, les chiffres qui comptent, les actions a faire.\n"
            "- Utilise des listes `- ...` pour les enumerations (options, etapes, ingredients).\n"
            "- Utilise des listes numerotees `1. ...` pour une procedure ordonnee.\n"
            "- Blocs de code triples-backticks avec le langage (```python, ```bash, ```json).\n"
            "- `code inline` pour les noms de fichiers, commandes courtes, variables.\n"
            "- Tableaux Markdown quand tu compares plusieurs elements sur plusieurs criteres.\n"
            "\n"
            "Interdits :\n"
            "- Pas de `####` ou plus profond : reste au niveau `#` / `##` / `###`.\n"
            "- Pas de murs de texte sans respiration.\n"
            "- Pas de titre factice juste pour faire joli (un titre = un vrai regroupement).\n"
        )
        # Bloc temporel : donne à l'agent la date/heure courante (sinon il
        # hallucine la date de son cutoff d'entraînement). TZ lue depuis
        # ui_preferences.timezone si l'user l'a définie, défaut Europe/Paris.
        _user_tz = "Europe/Paris"
        try:
            _us = locals().get("_user_settings_row")
            _prefs = (_us.ui_preferences or {}) if _us else {}
            _user_tz = str(_prefs.get("timezone") or "Europe/Paris")
        except Exception:
            pass
        temporal_block = _build_temporal_block(_user_tz)

        full_system = (
            _soul_content.strip() + _personality_block + _skill_block
            + temporal_block + consciousness_block + tools_block
            + mode_block + onboarding_block + tasks_block + style_block
        )
        chat_messages.insert(0, ChatMessage(role="system", content=full_system))

        # -- Boucle tool calling
        _gateway_handled = gw_result["has_web_content"]
        _native_tool_mode = not _gateway_handled
        _forced_execution = False

        response = None
        for _round in range(MAX_TOOL_ROUNDS):

            if _native_tool_mode:
                try:
                    # Merge wolf tools + user's MCP tools (lazy-start on first use)
                    await mcp_manager.ensure_user_started(_current_uid)
                    _all_tools = WOLF_TOOL_SCHEMAS + mcp_manager.get_user_schemas(_current_uid)
                    response = await provider.chat(
                        chat_messages,
                        chosen_model,
                        tools=_all_tools,
                        tool_choice="auto",
                    )
                except Exception as _tool_err:
                    print(f"[Wolf] Tools API failed ({_tool_err}), retrying without tools")
                    _native_tool_mode = False
                    # Filter out tool messages and tool_calls that some models don't support
                    _clean_msgs = []
                    for _m in chat_messages:
                        if _m.role == "tool":
                            continue
                        if _m.tool_calls:
                            _clean_msgs.append(ChatMessage(role=_m.role, content=_m.content or ""))
                        else:
                            _clean_msgs.append(_m)
                    response = await provider.chat(
                        _clean_msgs,
                        chosen_model,
                    )
            else:
                response = await provider.chat(
                    chat_messages,
                    chosen_model,
                )

            # Trace le coût de CE round (sinon seul le round final serait
            # enregistré et les rounds intermédiaires tool-calling disparaîtraient
            # des analytics).
            if response is not None:
                try:
                    from backend.core.cost.manager import get_cost_manager
                    await get_cost_manager().record_message_cost(
                        session,
                        convo_id,
                        response.model or chosen_model,
                        response.tokens_input or 0,
                        response.tokens_output or 0,
                        user_id=_current_uid or None,
                    )
                except Exception as _round_err:
                    print(f"[Wolf] Round cost recording skipped: {_round_err}")

            # Si le gateway a deja tout gere, on sort au premier tour
            if _gateway_handled and _round == 0 and response and response.content:
                if not detect_web_refusal(response.content):
                    print(f"[Wolf] Gateway mode: reponse directe, pas de tool loop")
                    break

            # -- Fallback 1 : parser les tool_calls depuis le texte
            if not response.tool_calls and response.content:
                text_tools = _parse_text_tool_calls(response.content)
                if text_tools:
                    response.tool_calls = text_tools
                    print(f"[Wolf] Parsed {len(text_tools)} tool call(s) from text output")

            # -- Fallback 2 : refus web -> Gateway force search
            if not response.tool_calls and response.content and detect_web_refusal(response.content):
                _native_tool_mode = False
                _forced_execution = True
                print(f"[Wolf] Web refusal detected (round {_round}) -- Gateway force search")

                user_query = extract_original_query(chat_messages)
                if not user_query:
                    user_query = message

                gw_force = WebGateway()
                force_result = await gw_force.force_search(user_query)
                tool_events.extend(gw_force.tool_events)

                if force_result["has_content"]:
                    chat_messages.append(ChatMessage(role="assistant", content="Je recupere les informations..."))
                    chat_messages.append(ChatMessage(
                        role="user",
                        content=(
                            f"[SYSTEME -- CONTENU RECUPERE PAR LE GATEWAY]\n\n"
                            f"{force_result['enriched_content']}\n\n"
                            f"---\n**Demande originale :** {user_query}\n\n"
                            f"Utilise ce contenu pour repondre. Tu as acces a Internet."
                        ),
                    ))
                    continue

            if not response.tool_calls:
                break  # Reponse finale texte -- on sort

            # -- Le modele a retourne des tool_calls (natif ou parse)
            _is_text_parsed = any(
                tc.get("id", "").startswith("textparse-") or tc.get("id", "").startswith("autofix-")
                for tc in response.tool_calls
            )

            # Executer chaque outil
            all_results = []
            for tc in response.tool_calls:
                fn       = tc.get("function", {})
                tool_name = fn.get("name", "")
                call_id  = tc.get("id") or str(_uuid.uuid4())[:8]
                try:
                    args = _json.loads(fn.get("arguments", "{}")) if isinstance(fn.get("arguments"), str) else fn.get("arguments", {})
                except Exception:
                    args = {}

                # Gate : mode-based tool access control
                _current_mode = mode_manager.current_mode.value

                # Onboarding exemption (fix sécu H2) : finalize_onboarding est
                # un outil à effet de bord majeur (reset agent_name / soul /
                # mode / formality), donc on n'exempte le gate QUE si :
                #   1) tool_name == "finalize_onboarding"
                #   2) la conversation courante est bien celle d'onboarding
                #   3) l'user n'est PAS déjà onboarded (_is_onboarding_convo
                #      implique cette condition côté chat.py, mais on double-check
                #      via le flag DB côté _finalize_onboarding — idempotent)
                # Hors de ce tunnel, l'outil passe par le gate normal comme
                # n'importe quel outil d'écriture.
                _is_onboarding_finalize = (
                    tool_name == "finalize_onboarding"
                    and _is_onboarding_convo
                    and bool(_current_uid)
                )

                # Gating par mode — 2026-04-23 : swap des comportements UX.
                # - Mode "Demande" (ask_permission)  : validation 100% conversationnelle.
                #   L'agent verbalise sa demande, l'user répond "oui" en texte → autorise.
                #   Aucune carte UI, pas de friction inutile. Idéal pour un flux rapide.
                # - Mode "Restreint" (restrained)    : validation explicite par carte UI
                #   (style Claude Code desktop). Si l'user n'a pas formulé le tool
                #   dans sa demande, on génère pending_approval → la PermissionCard
                #   apparaît inline dans le chat avec boutons Autoriser / Refuser.
                _blocked = False
                if _is_onboarding_finalize:
                    print(f"[Wolf] ONBOARDING: auto-approving finalize_onboarding for user={_current_uid}")
                elif _current_mode == "restrained" and not _restrained_check_user_intent(tool_name, message):
                    # Check approbation UI préalable (l'user a cliqué "Autoriser"
                    # dans une carte précédente pour ce même tool).
                    _ui_approved_ids = [
                        rid for rid, req in list(mode_manager.pending_requests.items())
                        if req.status == "approved" and req.details.get("tool_name") == tool_name
                    ]
                    if _ui_approved_ids:
                        for rid in _ui_approved_ids:
                            mode_manager.pending_requests.pop(rid, None)
                        print(f"[Wolf] RESTRAINED: ui-approved {tool_name}")
                    else:
                        # Émet la demande → la PermissionCard s'affiche dans le chat
                        _perm_id = str(_uuid.uuid4())[:12]
                        try:
                            await mode_manager.request_permission(
                                _perm_id, action=f"exec:{tool_name}",
                                details={"tool_name": tool_name, "args": args, "call_id": call_id},
                            )
                        except Exception:
                            pass
                        tool_result = {
                            "ok": False,
                            "error": (
                                f"Mode 'Restreint' : l'outil '{tool_name}' requiert une validation "
                                f"explicite via la carte d'autorisation affichée dans le chat. "
                                f"Explique brièvement à l'utilisateur ce que tu souhaites faire, "
                                f"puis attends qu'il clique Autoriser."
                            ),
                            "pending_approval": True,
                            "permission_id": _perm_id,
                            "tool_name": tool_name,
                            "args": args,
                        }
                        print(f"[Wolf] RESTRAINED: pending UI approval for {tool_name} (pending_id={_perm_id})")
                        _blocked = True
                elif _current_mode == "ask_permission" and tool_name not in READ_ONLY_TOOLS and tool_name not in mode_manager.config.auto_approve_tools:
                    # Validation conversationnelle robuste :
                    # - Si l'user a DÉJÀ demandé l'action explicitement (verbe
                    #   d'action + mention cohérente avec l'outil) OU a répondu
                    #   « oui / ok / vas-y » au tour précédent → on exécute
                    #   direct sans redemander.
                    # - Sinon → on bloque et on impose au LLM un format visuel
                    #   clair pour la question (voir error string ci-dessous).
                    if _ask_permission_check_user_intent(tool_name, message, args):
                        print(f"[Wolf] ASK_PERMISSION: user intent matched → {tool_name} (skip confirm)")
                    else:
                        # Format de question imposé au LLM : bloc visuel bien
                        # identifiable dans le chat, avec 3 sections (Action /
                        # Paramètres / Question), pour que l'user le voie
                        # clairement comme une demande et pas comme du texte
                        # normal noyé dans la réponse.
                        _args_preview = ", ".join(f"{k}={v!r}"[:80] for k, v in (args or {}).items())[:300]
                        tool_result = {
                            "ok": False,
                            "error": (
                                f"Mode 'Demande' : confirmation requise avant d'exécuter `{tool_name}`.\n\n"
                                f"Réponds STRICTEMENT en suivant ce format visuel dans ta prochaine réponse texte "
                                f"(sans réinvoquer l'outil pour l'instant) :\n\n"
                                f"---\n"
                                f"🔐 **Confirmation requise**\n\n"
                                f"**Action :** [une phrase explicite de ce que tu veux faire en langage naturel]\n"
                                f"**Outil :** `{tool_name}`\n"
                                f"**Paramètres :** `{_args_preview or '(aucun)'}`\n\n"
                                f"👉 **Je lance ? (`oui` pour valider, `non` pour annuler)**\n"
                                f"---\n\n"
                                f"Si l'utilisateur répond « oui » (ou équivalent) au tour suivant, rejoue `{tool_name}` "
                                f"avec les mêmes arguments. S'il répond « non », abandonne et propose une alternative."
                            ),
                        }
                        print(f"[Wolf] ASK_PERMISSION: verbal confirmation needed for {tool_name}")
                        _blocked = True

                if not _blocked:
                    # Check wolf executors first, then the user's MCP executors
                    executor = WOLF_EXECUTORS.get(tool_name) or mcp_manager.get_user_executors(_current_uid).get(tool_name)
                    if executor:
                        try:
                            # Injecte le contexte user + conversation pour les outils
                            set_conversation_context(convo_id)
                            set_user_context(_current_uid)
                            tool_result = await executor(**args)
                        except Exception as ex:
                            tool_result = {"ok": False, "error": str(ex)}
                        finally:
                            set_conversation_context(None)
                            set_user_context(0)
                    else:
                        tool_result = {"ok": False, "error": f"Outil '{tool_name}' inconnu."}

                tool_events.append({"tool": tool_name, "args": args, "result": tool_result})
                all_results.append({"tool": tool_name, "args": args, "result": tool_result, "call_id": call_id})

            # -- Injection des resultats
            if _is_text_parsed or not _native_tool_mode:
                chat_messages.append(ChatMessage(
                    role="assistant",
                    content=response.content or "J'execute les outils demandes...",
                ))
                results_summary = []
                for r in all_results:
                    result_str = _json.dumps(r["result"], ensure_ascii=False)[:8000]
                    results_summary.append(f"**{r['tool']}**({_json.dumps(r['args'])}) -> {result_str}")
                chat_messages.append(ChatMessage(
                    role="user",
                    content=f"Voici les resultats des outils executes :\n\n" + "\n\n".join(results_summary) + "\n\nUtilise ces resultats pour repondre a ma demande.",
                ))
            else:
                chat_messages.append(ChatMessage(
                    role="assistant",
                    content=response.content or "",
                    tool_calls=response.tool_calls,
                ))
                for r in all_results:
                    chat_messages.append(ChatMessage(
                        role="tool",
                        content=_json.dumps(r["result"], ensure_ascii=False),
                        tool_call_id=r["call_id"],
                    ))

        # Si toutes les rounds sont epuisees et qu'on a encore des tool_calls,
        # demander une reponse finale sans outils.
        if response and response.tool_calls:
            response = await provider.chat(chat_messages, chosen_model)

        user_msg = Message(conversation_id=convo_id, role="user", content=message)
        assistant_msg = Message(
            conversation_id=convo_id,
            role="assistant",
            content=response.content,
            tool_calls=response.tool_calls,
            tokens_input=response.tokens_input,
            tokens_output=response.tokens_output,
            # Conserve le modèle/provider effectivement utilisés pour cette
            # réponse — indépendant du modèle actif de la conversation (qui
            # peut changer ensuite via /switch ou provider_manage).
            model=(response.model or chosen_model or "")[:255],
            provider=provider_name or "",
        )
        session.add(user_msg)
        session.add(assistant_msg)

        conv_result = await session.get(Conversation, convo_id)
        if conv_result:
            conv_result.updated_at = __import__("datetime").datetime.utcnow()

        await session.commit()

        # Note: le coût est déjà enregistré tour par tour dans la boucle
        # tool-calling ci-dessus ; pas d'enregistrement final séparé ici pour
        # éviter un double comptage du dernier round.

        if conv_result:
            await session.refresh(conv_result)

        # -- Auto-naming : generer un titre IA au premier echange
        if conv_result and conv_result.title in ("Nouvelle conversation", "Nouveau chat", "Suite de conversation", "", None):
            try:
                asyncio.ensure_future(_auto_generate_title(convo_id, message, response.content or "", provider, chosen_model))
            except Exception:
                pass

        # -- Auto-scoring : fait noter la réponse par un LLM léger pour
        # alimenter le reward system de la conscience (fire-and-forget).
        # Gating (conscience enabled + reward.auto_score) est interne.
        if user_id and (response.content or "").strip():
            try:
                asyncio.ensure_future(_auto_score_response(int(user_id), message, response.content or "", convo_id))
            except Exception:
                pass

        # Triggers conscience tirés du message user. Best-effort, fire-and-forget.
        # Détections volontairement simples (regex + heuristique courte) :
        # - user_asked_status → besoin `progression` (l'user cherche du reporting)
        # - open_question → besoin `comprehension` (question sans recherche/outil
        #   derrière = l'agent a juste répondu de mémoire, zone potentielle
        #   d'incertitude à creuser)
        if user_id and message:
            try:
                from backend.plugins.consciousness.triggers import emit_trigger
                _msg_low = message.lower()
                # Status: "où en est", "t'en es où", "état de", "avancement", "status",
                # "news de", "comment ça avance", etc.
                _status_patterns = (
                    "où en est", "ou en est", "t'en es où", "ten es ou", "état de",
                    "etat de", "avancement", "comment ça avance", "comment ca avance",
                    "news de", "des nouvelles de", "status de", "où ça en est",
                )
                if any(p in _msg_low for p in _status_patterns):
                    asyncio.ensure_future(emit_trigger(
                        int(user_id), "user_asked_status", cooldown_seconds=6 * 3600,
                    ))
                # Open question : le message user contient "?" ET l'agent n'a
                # déclenché aucun tool_call (donc pas de recherche web/fichier,
                # il a répondu "de mémoire"). Signal que sa compréhension
                # pourrait bénéficier d'une recherche proactive ultérieure.
                if "?" in message and not tool_events:
                    asyncio.ensure_future(emit_trigger(
                        int(user_id), "open_question", cooldown_seconds=2 * 3600,
                    ))
            except Exception:
                pass

        # Check if agent switched provider/model during this turn
        _switch_info = None
        for _evt in tool_events:
            if _evt.get("tool") == "provider_manage":
                _res = _evt.get("result", {})
                if isinstance(_res, dict) and _res.get("switched"):
                    _switch_info = {"provider": _res["provider"], "model": _res["model"]}
                    break

        return {
            "content": response.content,
            "model": response.model or chosen_model,
            "provider": provider_name,
            "tokens_input": response.tokens_input,
            "tokens_output": response.tokens_output,
            "tool_events": tool_events if tool_events else None,
            **({"switch_provider": _switch_info} if _switch_info else {}),
        }
    except Exception as e:
        import logging
        logging.getLogger("gungnir").error(f"Chat error: {e}", exc_info=True)
        return {"error": _classify_llm_error(e)}


@router.post("/conversations/{convo_id}/chat/stream")
async def chat_stream(convo_id: int, data: dict, request: Request):
    # -- Budget check (scoped to the caller)
    _stream_uid_budget = getattr(request.state, "user_id", None) or 0
    from backend.core.cost.manager import get_cost_manager
    from backend.core.db.engine import get_session as _get_session
    async for session in _get_session():
        cm = get_cost_manager()
        budget_status = await cm.check_all_budgets(session, user_id=_stream_uid_budget or None)
        if budget_status.get("should_block"):
            yield {"error": f"Budget depasse : {budget_status.get('block_reason', 'limite atteinte')}"}
            return

    settings = Settings.load()
    provider_name = data.get("provider", "openrouter")
    model = data.get("model")
    message = data.get("message", "")

    # STRICT per-user: resolve the key from the caller's UserSettings only.
    _uid_stream = getattr(request.state, "user_id", None)
    _stream_api_key = None
    _stream_base_url = None
    if _uid_stream:
        async for _stream_session in _get_session():
            try:
                _us = await get_user_settings(_uid_stream, _stream_session)
                _up = get_user_provider_key(_us, provider_name)
                if _up and _up.get("api_key"):
                    _stream_api_key = _up["api_key"]
                    _stream_base_url = _up.get("base_url")
            except Exception:
                pass
            break
    if not _stream_api_key:
        yield {"error": f"Aucune clé API configurée pour '{provider_name}'. Ajoute la tienne dans Paramètres → Providers."}
        return

    provider_meta = settings.providers.get(provider_name)
    provider = get_provider(
        provider_name,
        _stream_api_key,
        _stream_base_url or (provider_meta.base_url if provider_meta else None),
    )
    provider_config = provider_meta or ProviderConfig()

    user_images = data.get("images", [])
    chat_messages = [ChatMessage(role="user", content=message, images=user_images)]

    async for chunk in provider.chat_stream(
        chat_messages,
        model or provider_config.default_model,
    ):
        yield {"chunk": chunk}


# ═══════════════════════════════════════════════════════════════════════════
# Prompt improvement — reformule un draft utilisateur avant envoi
# ═══════════════════════════════════════════════════════════════════════════

@router.post("/chat/improve-prompt")
async def improve_prompt(data: dict, request: Request):
    """Réécrit le prompt draft pour le rendre plus clair et structuré.

    Usage : le frontend appelle ça quand l'utilisateur clique le bouton
    "Améliorer" à côté de sa zone de saisie. Retourne le prompt amélioré —
    pas de réponse à la question, juste une reformulation.

    Utilise le LLM configuré par l'utilisateur (même provider/modèle que
    son chat courant). Respecte per-user : aucune clé globale.
    """
    from backend.core.services.llm_invoker import invoke_llm_for_user

    uid = getattr(request.state, "user_id", None)
    if not uid:
        return JSONResponse({"error": "Authentification requise"}, status_code=401)

    draft = str(data.get("prompt") or "").strip()
    if not draft:
        return {"ok": False, "error": "Prompt vide"}
    if len(draft) > 6000:
        return {"ok": False, "error": "Prompt trop long (max 6000 caractères)"}

    # Override possible depuis le frontend (le chat panel envoie déjà son
    # provider/model actifs, on s'aligne pour garder la cohérence UX).
    override_provider = data.get("provider") or None
    override_model = data.get("model") or None

    system_prompt = (
        "Tu es un assistant de reformulation de prompts. Tu reçois un "
        "brouillon écrit par l'utilisateur et tu le réécris pour qu'il soit "
        "PLUS CLAIR, PLUS PRÉCIS et PLUS ACTIONNABLE — mais sans en changer "
        "l'intention, la langue ou le ton général.\n\n"
        "RÈGLES STRICTES :\n"
        "- Conserve la langue d'origine (français → français, anglais → anglais).\n"
        "- Ne réponds PAS au prompt — tu le réécris seulement.\n"
        "- Pas de préambule type 'Voici la version améliorée' — renvoie UNIQUEMENT "
        "le texte du prompt reformulé.\n"
        "- Structure quand ça aide (listes numérotées, contraintes explicites), "
        "mais reste fidèle au style du user (direct si direct, détaillé si détaillé).\n"
        "- Si le draft est déjà clair, fais des micro-améliorations seulement.\n"
        "- Ne reformule pas en première personne si le draft est à la 2e.\n"
        "- Ne transforme JAMAIS une question factuelle en une question ouverte."
    )

    result = await invoke_llm_for_user(
        uid,
        draft,
        system_prompt=system_prompt,
        provider=override_provider,
        model=override_model,
    )

    if not result.get("ok"):
        err = result.get("error") or "Échec inconnu"
        return {"ok": False, "error": err[:300]}

    improved = (result.get("content") or "").strip()
    # Enlève les guillemets d'enrobage éventuels ("..." entourant le texte)
    if len(improved) >= 2 and improved[0] in ('"', '«', '"') and improved[-1] in ('"', '»', '"'):
        improved = improved[1:-1].strip()
    if not improved:
        return {"ok": False, "error": "Le LLM a renvoyé une réponse vide"}

    return {"ok": True, "prompt": improved, "original": draft}


# ═══════════════════════════════════════════════════════════════════════════
# TTS / STT — moteurs premium optionnels (navigateur = défaut gratuit)
# ═══════════════════════════════════════════════════════════════════════════

# Voix OpenAI disponibles pour /v1/audio/speech. Exposées en UI via
# /chat/voice-capabilities. Référence : platform.openai.com/docs/guides/text-to-speech
_OPENAI_TTS_VOICES = ["alloy", "echo", "fable", "onyx", "nova", "shimmer"]
_OPENAI_TTS_MODELS = ["tts-1", "tts-1-hd"]


async def _get_user_openai_key(user_id: int) -> str | None:
    """Retourne la clé OpenAI per-user (depuis provider_keys)."""
    from backend.core.db.engine import get_session
    from backend.core.db.models import UserSettings
    from backend.core.config.settings import decrypt_value
    from sqlalchemy import select
    try:
        async for session in get_session():
            r = await session.execute(
                select(UserSettings).where(UserSettings.user_id == int(user_id))
            )
            us = r.scalar_one_or_none()
            if us is None:
                return None
            prov = (us.provider_keys or {}).get("openai") or {}
            key = prov.get("api_key")
            if not key:
                return None
            # Déchiffre FERNET: si nécessaire
            return decrypt_value(key)
    except Exception as e:
        logger.warning(f"OpenAI key lookup failed for user {user_id}: {e}")
    return None


async def _get_user_elevenlabs_key(user_id: int) -> str | None:
    """Retourne la clé ElevenLabs per-user (depuis voice_config)."""
    from backend.core.db.engine import get_session
    from backend.core.db.models import UserSettings
    from backend.core.config.settings import decrypt_value
    from sqlalchemy import select
    try:
        async for session in get_session():
            r = await session.execute(
                select(UserSettings).where(UserSettings.user_id == int(user_id))
            )
            us = r.scalar_one_or_none()
            if us is None:
                return None
            vc = (us.voice_config or {}).get("elevenlabs") or {}
            key = vc.get("api_key")
            if not key:
                return None
            return decrypt_value(key)
    except Exception as e:
        logger.warning(f"ElevenLabs key lookup failed for user {user_id}: {e}")
    return None


async def _get_user_provider_key(user_id: int, provider: str) -> str | None:
    """Retourne une clé LLM provider per-user (google, mistral…)."""
    from backend.core.db.engine import get_session
    from backend.core.db.models import UserSettings
    from backend.core.config.settings import decrypt_value
    from sqlalchemy import select
    try:
        async for session in get_session():
            r = await session.execute(
                select(UserSettings).where(UserSettings.user_id == int(user_id))
            )
            us = r.scalar_one_or_none()
            if us is None:
                return None
            prov = (us.provider_keys or {}).get(provider) or {}
            key = prov.get("api_key")
            if not key:
                return None
            return decrypt_value(key)
    except Exception as e:
        logger.warning(f"{provider} key lookup failed for user {user_id}: {e}")
    return None


async def _get_user_voice_custom(user_id: int) -> dict | None:
    """Retourne la config voice_custom per-user : {base_url, api_key} ou None.

    Utilisé pour un endpoint OpenAI-compatible custom (local Whisper, Groq,
    self-hosted TTS, etc). Les clés viennent de service_keys.voice_custom."""
    from backend.core.db.engine import get_session
    from backend.core.db.models import UserSettings
    from backend.core.api.auth_helpers import get_user_service_key
    from sqlalchemy import select
    try:
        async for session in get_session():
            r = await session.execute(
                select(UserSettings).where(UserSettings.user_id == int(user_id))
            )
            us = r.scalar_one_or_none()
            if us is None:
                return None
            svc = get_user_service_key(us, "voice_custom")
            if not svc:
                return None
            base_url = (svc.get("base_url") or "").rstrip("/")
            api_key = svc.get("api_key") or ""
            if not base_url:
                return None
            return {"base_url": base_url, "api_key": api_key}
    except Exception as e:
        logger.warning(f"voice_custom lookup failed for user {user_id}: {e}")
    return None


@router.get("/chat/voice-capabilities")
async def voice_capabilities(request: Request):
    """Retourne les moteurs TTS/STT disponibles pour l'user courant.

    Le frontend utilise ça pour peupler les dropdowns dans Paramètres → Voix
    et griser les options sans clé. `browser` est toujours disponible
    (Web Speech API natif).
    """
    uid = getattr(request.state, "user_id", None)
    if not uid:
        return JSONResponse({"error": "Authentification requise"}, status_code=401)

    openai_key = await _get_user_openai_key(uid)
    el_key = await _get_user_elevenlabs_key(uid)
    google_key = await _get_user_provider_key(uid, "google")
    mistral_key = await _get_user_provider_key(uid, "mistral")
    custom = await _get_user_voice_custom(uid)

    return {
        "tts": {
            "browser": {"available": True, "label": "Navigateur (Web Speech API)", "free": True},
            "openai":  {"available": bool(openai_key), "label": "OpenAI TTS", "free": False,
                        "voices": _OPENAI_TTS_VOICES, "models": _OPENAI_TTS_MODELS,
                        "source": "provider_keys.openai"},
            "elevenlabs": {"available": bool(el_key), "label": "ElevenLabs", "free": False,
                           "source": "voice_config.elevenlabs"},
            "google":  {"available": bool(google_key), "label": "Google Cloud TTS",
                        "free": False, "source": "provider_keys.google"},
            "custom":  {"available": bool(custom), "label": "Custom (OpenAI-compatible)",
                        "free": False, "source": "service_keys.voice_custom"},
        },
        "stt": {
            "browser": {"available": True, "label": "Navigateur (SpeechRecognition)", "free": True},
            "openai":  {"available": bool(openai_key), "label": "OpenAI Whisper", "free": False,
                        "source": "provider_keys.openai"},
            "google":  {"available": bool(google_key), "label": "Google Cloud Speech-to-Text",
                        "free": False, "source": "provider_keys.google"},
            "mistral": {"available": bool(mistral_key), "label": "Mistral Voxtral",
                        "free": False, "source": "provider_keys.mistral",
                        "models": ["voxtral-mini-latest", "voxtral-small-latest"]},
            "custom":  {"available": bool(custom), "label": "Custom (OpenAI-compatible)",
                        "free": False, "source": "service_keys.voice_custom"},
        },
    }


@router.post("/chat/tts")
async def chat_tts(data: dict, request: Request):
    """Synthèse vocale d'un texte via un provider cloud (OpenAI/ElevenLabs).

    Body : { text, provider: 'openai'|'elevenlabs', voice?, model? }
    Retourne directement le flux audio (MP3) en tant que StreamingResponse.

    Les clés sont strictement per-user : chaque utilisateur utilise SA propre
    clé OpenAI / ElevenLabs. Aucune clé globale, aucun fallback admin.
    """
    import aiohttp
    from fastapi.responses import Response

    uid = getattr(request.state, "user_id", None)
    if not uid:
        return JSONResponse({"error": "Authentification requise"}, status_code=401)

    text = str(data.get("text") or "").strip()
    if not text:
        return JSONResponse({"error": "Texte vide"}, status_code=400)
    if len(text) > 4096:
        text = text[:4096]  # OpenAI limite à ~4096 chars par requête

    provider = str(data.get("provider") or "").lower()

    if provider == "openai":
        api_key = await _get_user_openai_key(uid)
        if not api_key:
            return JSONResponse({"error": "Aucune clé OpenAI configurée"}, status_code=400)
        voice = str(data.get("voice") or "alloy").lower()
        if voice not in _OPENAI_TTS_VOICES:
            voice = "alloy"
        model = str(data.get("model") or "tts-1").lower()
        if model not in _OPENAI_TTS_MODELS:
            model = "tts-1"
        payload = {
            "model": model,
            "input": text,
            "voice": voice,
            "response_format": "mp3",
            "speed": max(0.25, min(4.0, float(data.get("speed") or 1.0))),
        }
        headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
        try:
            async with aiohttp.ClientSession() as s:
                async with s.post("https://api.openai.com/v1/audio/speech",
                                   json=payload, headers=headers,
                                   timeout=aiohttp.ClientTimeout(total=30)) as r:
                    if r.status != 200:
                        body = await r.text()
                        return JSONResponse(
                            {"error": f"OpenAI TTS {r.status}: {body[:200]}"},
                            status_code=r.status,
                        )
                    audio = await r.read()
                    return Response(content=audio, media_type="audio/mpeg")
        except Exception as e:
            return JSONResponse({"error": f"Erreur réseau : {e}"}, status_code=502)

    if provider == "elevenlabs":
        api_key = await _get_user_elevenlabs_key(uid)
        if not api_key:
            return JSONResponse({"error": "Aucune clé ElevenLabs configurée"}, status_code=400)
        # voice_id ElevenLabs : le user doit le fournir via settings. Sinon
        # on utilise "Rachel" (voice_id public par défaut, accepté par tous les comptes).
        voice_id = str(data.get("voice") or "21m00Tcm4TlvDq8ikWAM").strip()
        model_id = str(data.get("model") or "eleven_multilingual_v2").strip()
        url = f"https://api.elevenlabs.io/v1/text-to-speech/{voice_id}"
        headers = {"xi-api-key": api_key, "Content-Type": "application/json",
                   "Accept": "audio/mpeg"}
        payload = {
            "text": text,
            "model_id": model_id,
            "voice_settings": {
                "stability": 0.5, "similarity_boost": 0.75, "style": 0.0,
            },
        }
        try:
            async with aiohttp.ClientSession() as s:
                async with s.post(url, json=payload, headers=headers,
                                   timeout=aiohttp.ClientTimeout(total=30)) as r:
                    if r.status != 200:
                        body = await r.text()
                        return JSONResponse(
                            {"error": f"ElevenLabs {r.status}: {body[:200]}"},
                            status_code=r.status,
                        )
                    audio = await r.read()
                    return Response(content=audio, media_type="audio/mpeg")
        except Exception as e:
            return JSONResponse({"error": f"Erreur réseau : {e}"}, status_code=502)

    if provider == "google":
        api_key = await _get_user_provider_key(uid, "google")
        if not api_key:
            return JSONResponse({"error": "Aucune clé Google configurée"}, status_code=400)
        # Google Cloud TTS : auth par ?key=...  Response = base64 dans le JSON.
        language_code = str(data.get("lang") or "fr-FR").strip()
        voice_name = str(data.get("voice") or "").strip()  # optionnel
        payload: dict = {
            "input": {"text": text},
            "voice": {"languageCode": language_code},
            "audioConfig": {"audioEncoding": "MP3",
                            "speakingRate": max(0.25, min(4.0, float(data.get("speed") or 1.0)))},
        }
        if voice_name:
            payload["voice"]["name"] = voice_name
        url = f"https://texttospeech.googleapis.com/v1/text:synthesize?key={api_key}"
        try:
            async with aiohttp.ClientSession() as s:
                async with s.post(url, json=payload,
                                   timeout=aiohttp.ClientTimeout(total=30)) as r:
                    if r.status != 200:
                        body = await r.text()
                        return JSONResponse(
                            {"error": f"Google TTS {r.status}: {body[:200]}"},
                            status_code=r.status,
                        )
                    doc = await r.json()
                    b64 = doc.get("audioContent") or ""
                    if not b64:
                        return JSONResponse({"error": "Google TTS: audioContent vide"}, status_code=502)
                    import base64 as _b64
                    audio = _b64.b64decode(b64)
                    return Response(content=audio, media_type="audio/mpeg")
        except Exception as e:
            return JSONResponse({"error": f"Erreur réseau : {e}"}, status_code=502)

    if provider == "custom":
        cfg = await _get_user_voice_custom(uid)
        if not cfg:
            return JSONResponse({"error": "Endpoint custom non configuré (Paramètres → Services → Voix custom)"}, status_code=400)
        # Parle OpenAI-compatible : POST {base_url}/audio/speech
        voice = str(data.get("voice") or "alloy").strip()
        model = str(data.get("model") or "tts-1").strip()
        payload = {
            "model": model, "input": text, "voice": voice,
            "response_format": "mp3",
            "speed": max(0.25, min(4.0, float(data.get("speed") or 1.0))),
        }
        url = f"{cfg['base_url']}/audio/speech"
        headers = {"Content-Type": "application/json"}
        if cfg.get("api_key"):
            headers["Authorization"] = f"Bearer {cfg['api_key']}"
        try:
            async with aiohttp.ClientSession() as s:
                async with s.post(url, json=payload, headers=headers,
                                   timeout=aiohttp.ClientTimeout(total=30)) as r:
                    if r.status != 200:
                        body = await r.text()
                        return JSONResponse(
                            {"error": f"Custom TTS {r.status}: {body[:200]}"},
                            status_code=r.status,
                        )
                    audio = await r.read()
                    return Response(content=audio, media_type="audio/mpeg")
        except Exception as e:
            return JSONResponse({"error": f"Erreur réseau : {e}"}, status_code=502)

    return JSONResponse(
        {"error": f"Provider '{provider}' non supporté. "
                  "Utilise 'openai', 'elevenlabs', 'google' ou 'custom'."},
        status_code=400,
    )


@router.post("/chat/stt")
async def chat_stt(request: Request):
    """Transcription audio via un provider cloud (OpenAI Whisper pour l'instant).

    Multipart form-data : `audio` (fichier) + `provider` (champ).
    Retourne `{ok, text}` ou `{ok: False, error}`.

    Les clés sont strictement per-user (même règle que TTS).
    """
    import aiohttp

    uid = getattr(request.state, "user_id", None)
    if not uid:
        return JSONResponse({"error": "Authentification requise"}, status_code=401)

    form = await request.form()
    provider = str(form.get("provider") or "openai").lower()
    audio = form.get("audio")
    if audio is None or not hasattr(audio, "read"):
        return JSONResponse({"error": "Fichier audio manquant"}, status_code=400)
    audio_bytes = await audio.read()
    if not audio_bytes:
        return JSONResponse({"error": "Audio vide"}, status_code=400)
    if len(audio_bytes) > 25 * 1024 * 1024:
        return JSONResponse({"error": "Audio > 25 MB (limite Whisper)"}, status_code=400)

    fname = getattr(audio, "filename", None) or "recording.webm"
    ctype = getattr(audio, "content_type", None) or "audio/webm"
    lang_hint = str(form.get("lang") or "").strip()

    # Helper : upload multipart OpenAI-compatible (OpenAI, Mistral, custom)
    async def _openai_compat_transcribe(base_url: str, api_key: str | None,
                                         model_name: str) -> JSONResponse | dict:
        data_form = aiohttp.FormData()
        data_form.add_field("file", audio_bytes, filename=fname, content_type=ctype)
        data_form.add_field("model", model_name)
        if lang_hint and lang_hint != "auto":
            data_form.add_field("language", lang_hint.split("-")[0])
        headers = {}
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"
        try:
            async with aiohttp.ClientSession() as s:
                async with s.post(f"{base_url.rstrip('/')}/audio/transcriptions",
                                   data=data_form, headers=headers,
                                   timeout=aiohttp.ClientTimeout(total=60)) as r:
                    if r.status != 200:
                        body = await r.text()
                        return JSONResponse(
                            {"ok": False, "error": f"STT {r.status}: {body[:200]}"},
                            status_code=r.status,
                        )
                    resp = await r.json()
                    return {"ok": True, "text": (resp.get("text") or "").strip()}
        except Exception as e:
            return JSONResponse({"ok": False, "error": f"Erreur réseau : {e}"}, status_code=502)

    if provider == "openai":
        api_key = await _get_user_openai_key(uid)
        if not api_key:
            return JSONResponse({"error": "Aucune clé OpenAI configurée"}, status_code=400)
        return await _openai_compat_transcribe("https://api.openai.com/v1", api_key, "whisper-1")

    if provider == "mistral":
        api_key = await _get_user_provider_key(uid, "mistral")
        if not api_key:
            return JSONResponse({"error": "Aucune clé Mistral configurée"}, status_code=400)
        model = str(form.get("model") or "voxtral-mini-latest").strip()
        if model not in ("voxtral-mini-latest", "voxtral-small-latest"):
            model = "voxtral-mini-latest"
        return await _openai_compat_transcribe("https://api.mistral.ai/v1", api_key, model)

    if provider == "custom":
        cfg = await _get_user_voice_custom(uid)
        if not cfg:
            return JSONResponse({"error": "Endpoint custom non configuré"}, status_code=400)
        model = str(form.get("model") or "whisper-1").strip()
        return await _openai_compat_transcribe(cfg["base_url"], cfg.get("api_key") or None, model)

    if provider == "google":
        api_key = await _get_user_provider_key(uid, "google")
        if not api_key:
            return JSONResponse({"error": "Aucune clé Google configurée"}, status_code=400)
        # Google Speech-to-Text : /v1/speech:recognize ; audio en base64 inline.
        # On déduit l'encoding du content_type (webm/opus par défaut côté Chrome).
        import base64 as _b64
        encoding = "WEBM_OPUS"
        sample_rate = 48000
        if "mp4" in ctype.lower() or "m4a" in fname.lower():
            encoding = "MP4_AAC"  # note : non officiellement supporté, fallback possible
        elif "wav" in ctype.lower():
            encoding = "LINEAR16"
            sample_rate = 16000
        body_raw = {
            "config": {
                "encoding": encoding,
                "sampleRateHertz": sample_rate,
                "languageCode": (lang_hint if lang_hint and lang_hint != "auto" else "fr-FR"),
                "enableAutomaticPunctuation": True,
            },
            "audio": {"content": _b64.b64encode(audio_bytes).decode("ascii")},
        }
        url = f"https://speech.googleapis.com/v1/speech:recognize?key={api_key}"
        try:
            async with aiohttp.ClientSession() as s:
                async with s.post(url, json=body_raw,
                                   timeout=aiohttp.ClientTimeout(total=60)) as r:
                    if r.status != 200:
                        body = await r.text()
                        return JSONResponse(
                            {"ok": False, "error": f"Google STT {r.status}: {body[:200]}"},
                            status_code=r.status,
                        )
                    doc = await r.json()
                    parts = []
                    for res in doc.get("results", []):
                        alts = res.get("alternatives") or []
                        if alts and alts[0].get("transcript"):
                            parts.append(alts[0]["transcript"])
                    text = " ".join(parts).strip()
                    return {"ok": True, "text": text}
        except Exception as e:
            return JSONResponse({"ok": False, "error": f"Erreur réseau : {e}"}, status_code=502)

    return JSONResponse(
        {"error": f"Provider STT '{provider}' non supporté. "
                  "Utilise 'openai', 'mistral', 'google' ou 'custom'."},
        status_code=400,
    )
