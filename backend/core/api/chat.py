from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from pathlib import Path
import json
import asyncio
import re as _re_mod
import uuid as _uuid_mod

from backend.core.config.settings import Settings
from backend.core.db.models import Conversation, Message
from backend.core.db.engine import get_session
from backend.core.providers import get_provider, ChatMessage
from backend.core.agents.wolf_tools import WOLF_TOOL_SCHEMAS, WOLF_EXECUTORS, READ_ONLY_TOOLS

router = APIRouter()


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


# Chemin du fichier soul
SOUL_FILE = Path(__file__).parent.parent.parent.parent / "data" / "soul.md"
DEFAULT_SOUL = """# Ame de Wolf -- Identite permanente

Tu es **Wolf**, un super-assistant IA developpe par ScarletWolf.
Tu es intelligent, proactif, precis et loyal envers ton utilisateur.
Tu parles en francais par defaut, sauf si l'utilisateur s'adresse a toi dans une autre langue.
Tu es honnete : tu admets clairement quand tu ne sais pas quelque chose.
Tu n'es pas Claude, GPT ou un autre assistant generique -- tu es Wolf.
"""


@router.post("/conversations/{convo_id}/chat")
async def chat(
    convo_id: int,
    data: dict,
    session: AsyncSession = Depends(get_session)
):
    # -- Budget check
    from backend.core.cost.manager import get_cost_manager
    cm = get_cost_manager()
    budget_status = await cm.check_all_budgets(session)
    if budget_status.get("should_block"):
        return {"error": f"Budget depasse : {budget_status.get('block_reason', 'limite atteinte')}. Augmentez votre budget ou attendez la prochaine periode."}

    settings = Settings.load()
    provider_name = data.get("provider", "openrouter")
    model = data.get("model")
    message = data.get("message", "")

    provider_config = settings.providers.get(provider_name)
    if not provider_config or not provider_config.enabled or not provider_config.api_key:
        return {"error": "Provider non configure"}

    result = await session.execute(
        select(Message).where(Message.conversation_id == convo_id).order_by(Message.created_at)
    )
    messages = result.scalars().all()

    chat_messages = [
        ChatMessage(role=m.role, content=m.content)
        for m in messages
    ]
    chat_messages.append(ChatMessage(role="user", content=message))

    # Detection commande de changement de personnalite
    from backend.core.agents.skills import personality_manager as pm
    personality_cmd = pm.detect_personality_command(message)
    if personality_cmd:
        pm.set_active(personality_cmd)

    # Construction du system prompt : Soul (identite) + Personnalite (mode) + Outils
    _lang_names = {
        "fr": "francais", "en": "anglais", "es": "espagnol", "pt": "portugais",
        "it": "italien", "de": "allemand", "nl": "neerlandais", "be": "flamand",
        "br": "breton", "sv": "suedois", "no": "norvegien", "da": "danois",
        "pl": "polonais", "ru": "russe", "ar": "arabe", "ja": "japonais", "zh": "chinois mandarin",
    }
    _lang_code = settings.app.language or "fr"
    _lang_label = _lang_names.get(_lang_code, _lang_code)
    soul_content = SOUL_FILE.read_text(encoding="utf-8") if SOUL_FILE.exists() else DEFAULT_SOUL
    soul_content = soul_content + f"\n\n**Langue de reponse :** Tu reponds TOUJOURS en {_lang_label}, quelle que soit la langue du message recu, sauf instruction explicite contraire."
    active_personality = pm.get_active()
    personality_block = ""
    if active_personality and active_personality.system_prompt:
        personality_block = f"\n\n## Mode de personnalite actif : {active_personality.name}\n{active_personality.system_prompt}"

    # Construire la liste des modeles disponibles pour guider Wolf
    _available_models_lines = []
    for _pname, _pcfg in settings.providers.items():
        if _pcfg.enabled and _pcfg.api_key and _pcfg.models:
            _available_models_lines.append(f"  - **{_pname}** : {', '.join(_pcfg.models[:12])}")
    _models_section = "\n".join(_available_models_lines) if _available_models_lines else "  (aucun provider configure)"

    # Le tools_block sera construit APRES le gateway (voir plus bas)
    _models_section_for_prompt = _models_section

    # Placeholder : le system prompt sera insere apres le gateway
    _soul_content = soul_content
    _personality_block = personality_block

    provider = get_provider(
        provider_name,
        provider_config.api_key,
        provider_config.base_url,
    )

    try:
        import json as _json
        import uuid as _uuid
        from backend.core.agents.mode_manager import mode_manager
        from backend.core.gateway import WebGateway, detect_web_refusal, extract_original_query, extract_urls_from_messages

        MAX_TOOL_ROUNDS = 12
        tool_events: list[dict] = []
        chosen_model = model or provider_config.default_model

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

## TES OUTILS

**Web :** web_fetch(url,extract), web_search(query,num_results), web_crawl(url,max_pages,same_domain)
**Skills :** skill_create, skill_update, skill_delete, skill_list
**Personnalites :** personality_create, personality_update, personality_set_active, personality_delete
**Sous-agents :** subagent_create, subagent_invoke, subagent_list, subagent_update, subagent_delete
**KB :** kb_write(filename,content), kb_read(filename), kb_list
**Browser :** browser_navigate, browser_get_text, browser_click, browser_type, browser_screenshot, browser_evaluate, browser_get_links, browser_crawl, browser_close
**Identite :** soul_read, soul_write(content)

## Modeles LLM disponibles
{_models_section_for_prompt}

## REGLES
1. **TU AS INTERNET.** Ne dis jamais le contraire.
2. Si du contenu web est pre-charge dans le message, utilise-le directement.
3. Sinon, appelle web_fetch ou web_search avec <tool_call>.
"""

        full_system = _soul_content.strip() + _personality_block + tools_block
        chat_messages.insert(0, ChatMessage(role="system", content=full_system))

        # -- Boucle tool calling
        _gateway_handled = gw_result["has_web_content"]
        _native_tool_mode = not _gateway_handled
        _forced_execution = False

        response = None
        for _round in range(MAX_TOOL_ROUNDS):

            if _native_tool_mode:
                try:
                    response = await provider.chat(
                        chat_messages,
                        chosen_model,
                        tools=WOLF_TOOL_SCHEMAS,
                        tool_choice="auto",
                    )
                except Exception as _tool_err:
                    print(f"[Wolf] Tools API failed ({_tool_err}), retrying without tools")
                    _native_tool_mode = False
                    response = await provider.chat(
                        chat_messages,
                        chosen_model,
                    )
            else:
                response = await provider.chat(
                    chat_messages,
                    chosen_model,
                )

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

                # Gate : RESTRAINED -> uniquement outils read-only
                restrained = (mode_manager.current_mode.value == "restrained")
                if restrained and tool_name not in READ_ONLY_TOOLS:
                    tool_result = {"ok": False, "error": "Permission refusee : mode restreint actif."}
                else:
                    executor = WOLF_EXECUTORS.get(tool_name)
                    if executor:
                        try:
                            tool_result = await executor(**args)
                        except Exception as ex:
                            tool_result = {"ok": False, "error": str(ex)}
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
        )
        session.add(user_msg)
        session.add(assistant_msg)

        conv_result = await session.get(Conversation, convo_id)
        if conv_result:
            conv_result.updated_at = __import__("datetime").datetime.utcnow()

        await session.commit()

        from backend.core.cost.manager import get_cost_manager
        cost_manager = get_cost_manager()
        await cost_manager.record_message_cost(
            session, convo_id, response.model, response.tokens_input, response.tokens_output
        )

        await session.refresh(conv_result)

        # -- Auto-naming : generer un titre IA au premier echange
        if conv_result and conv_result.title in ("Nouvelle conversation", "", None):
            try:
                asyncio.ensure_future(_auto_generate_title(convo_id, message, response.content or "", provider, chosen_model))
            except Exception:
                pass

        return {
            "content": response.content,
            "model": response.model,
            "tokens_input": response.tokens_input,
            "tokens_output": response.tokens_output,
            "tool_events": tool_events if tool_events else None,
        }
    except Exception as e:
        return {"error": str(e)}


@router.post("/conversations/{convo_id}/chat/stream")
async def chat_stream(convo_id: int, data: dict):
    # -- Budget check
    from backend.core.cost.manager import get_cost_manager
    from backend.core.db.engine import get_session as _get_session
    async for session in _get_session():
        cm = get_cost_manager()
        budget_status = await cm.check_all_budgets(session)
        if budget_status.get("should_block"):
            yield {"error": f"Budget depasse : {budget_status.get('block_reason', 'limite atteinte')}"}
            return

    settings = Settings.load()
    provider_name = data.get("provider", "openrouter")
    model = data.get("model")
    message = data.get("message", "")

    provider_config = settings.providers.get(provider_name)
    if not provider_config or not provider_config.enabled or not provider_config.api_key:
        yield {"error": "Provider non configure"}
        return

    provider = get_provider(
        provider_name,
        provider_config.api_key,
        provider_config.base_url,
    )

    chat_messages = [ChatMessage(role="user", content=message)]

    async for chunk in provider.chat_stream(
        chat_messages,
        model or provider_config.default_model,
    ):
        yield {"chunk": chunk}
