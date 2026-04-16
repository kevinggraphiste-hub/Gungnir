"""
HuntR — Perplexity-like Search Engine Plugin for Gungnir

Pipeline amélioré :
  1. Query Understanding (intent + expansion + focus auto-detect)
  2. Multi-Engine Search (DDG + Brave + SearXNG + Wikipedia)
  3. Content Scraping (web_fetch en parallèle)
  4. TF-IDF Reranking (avec fallback keyword)
  5. Answer Generation (LLM streaming avec citations)

Features :
  - Mode Normal (gratuit) : étapes 1-4, pas de LLM
  - Mode Pro : étapes 1-5, synthèse LLM + related questions
  - Focus modes : Web, Code, Actu, Academic
  - Follow-up conversationnel (contexte entre recherches)
  - Smart query expansion (sub-queries)

100% self-contained — crash-proof, no core state mutations.
"""
from fastapi import APIRouter, Request, Depends
from fastapi.responses import StreamingResponse, JSONResponse
from pydantic import BaseModel, Field
from typing import Optional
import asyncio
import json
import time
import logging

from backend.core.config.settings import Settings
from backend.core.providers import get_provider, ChatMessage

from .config import HuntRConfig
from .engine import (
    multi_search, scrape_sources, rerank,
    detect_language, detect_intent, suggest_focus,
    FOCUS_MODES,
)

logger = logging.getLogger("gungnir.plugins.huntr")


# ── Per-user resolution helpers ──────────────────────────────────────────

def _uid(request: Request) -> int:
    """Extract user_id from auth middleware, fallback to 1."""
    return getattr(request.state, "user_id", None) or 1


async def _get_user_brave_key(user_id: int) -> str:
    """Resolve per-user Brave API key. Falls back to global HuntR config."""
    config = HuntRConfig.load()
    brave_key = config.brave_api_key or ""
    try:
        from backend.core.db.engine import async_session
        from backend.core.api.auth_helpers import get_user_settings
        from backend.core.config.settings import decrypt_value
        async with async_session() as session:
            us = await get_user_settings(user_id, session)
            if us.service_keys:
                user_brave = us.service_keys.get("brave")
                if user_brave and user_brave.get("api_key"):
                    brave_key = decrypt_value(user_brave["api_key"])
    except Exception:
        pass
    return brave_key


async def _get_user_llm(user_id: int, provider_name: Optional[str] = None,
                        model_name: Optional[str] = None):
    """Get user's LLM provider — exact same logic as chat.py.
    Uses async_session() directly (not the get_session generator)
    so it works reliably inside SSE streams."""
    from backend.core.db.engine import async_session
    from backend.core.api.auth_helpers import get_user_settings, get_user_provider_key

    async with async_session() as session:
        us = await get_user_settings(user_id, session)
        settings = Settings.load()

        pname = provider_name or us.active_provider or "openrouter"

        user_prov = get_user_provider_key(us, pname)
        api_key = user_prov.get("api_key") if user_prov else None
        if not api_key:
            raise ValueError(
                f"Aucune clé API pour '{pname}'. "
                f"Configure-la dans Paramètres → Providers."
            )

        cfg = settings.providers.get(pname)
        base_url = (user_prov.get("base_url") if user_prov else None) or \
                   (cfg.base_url if cfg else None)

        mname = model_name or us.active_model or \
                (cfg.default_model if cfg else None) or \
                (cfg.models[0] if cfg and cfg.models else None)
        if not mname:
            raise ValueError(f"Aucun modèle pour '{pname}'")

        return get_provider(pname, api_key, base_url), mname, pname


router = APIRouter()

# ── In-memory state (plugin-scoped, not core) ─────────────────────────────
_search_history: list[dict] = []
_sessions: dict[str, list[dict]] = {}  # session_id -> conversation history
MAX_HISTORY = 100


# ── Request / Response Models ──────────────────────────────────────────────

class SearchRequest(BaseModel):
    query: str
    max_results: int = Field(default=15, ge=1, le=30)
    pro_search: bool = False
    focus: str = Field(default="web", pattern="^(web|code|news|academic)$")
    session_id: Optional[str] = None  # For follow-up context
    provider: Optional[str] = None
    model: Optional[str] = None


class FetchRequest(BaseModel):
    url: str
    extract: str = Field(default="text", pattern="^(text|html|all)$")


class ConfigUpdateRequest(BaseModel):
    brave_api_key: Optional[str] = None
    searxng_url: Optional[str] = None
    rerank_method: Optional[str] = None
    default_focus: Optional[str] = None


# ═══════════════════════════════════════════════════════════════════════════
# LLM Prompts
# ═══════════════════════════════════════════════════════════════════════════

SYSTEM_PROMPT = (
    "Tu es HuntR, un moteur de recherche IA. "
    "Réponds en utilisant UNIQUEMENT les passages fournis.\n\n"
    "RÈGLES :\n"
    "1. Base chaque affirmation sur les passages — n'utilise PAS tes connaissances\n"
    "2. Cite les sources inline avec [1], [2], etc.\n"
    "3. Si l'info manque, dis-le explicitement\n"
    "4. Markdown : titres, listes, tableaux\n"
    "5. Chaque fait = une citation\n"
    "6. TOUJOURS répondre dans la même langue que la question"
)

SYSTEM_PROMPT_PRO = (
    "Tu es HuntR Pro, un moteur de recherche IA expert. "
    "Synthétise les passages fournis en une réponse complète.\n\n"
    "RÈGLES :\n"
    "1. Synthétise TOUS les passages — connecte les idées, compare les points de vue\n"
    "2. Cite inline [1], [2], etc.\n"
    "3. Si l'info est incomplète, dis explicitement ce qui manque\n"
    "4. Sois exhaustif — contexte, nuances, détails\n"
    "5. Markdown : titres, tableaux, listes\n"
    "6. Chaque fait = une citation\n"
    "7. TOUJOURS répondre dans la même langue que la question\n"
    "8. Comparaisons → tableaux. Tutoriels → étapes numérotées.\n"
    "9. Brève synthèse à la fin"
)

SYSTEM_PROMPT_ACADEMIC = (
    "Tu es HuntR Academic, un assistant de recherche scientifique rigoureux. "
    "Tu synthétises UNIQUEMENT à partir de sources académiques vérifiées.\n\n"
    "RÈGLES STRICTES :\n"
    "1. Base CHAQUE affirmation sur les passages fournis — JAMAIS tes propres connaissances\n"
    "2. Cite les sources inline [1], [2] — chaque fait doit avoir sa citation\n"
    "3. Utilise un ton neutre, factuel et objectif — pas d'opinions ni de jugements\n"
    "4. Distingue clairement : fait établi vs hypothèse vs résultat préliminaire\n"
    "5. Mentionne les limites méthodologiques si elles sont visibles dans les sources\n"
    "6. Si l'information est insuffisante ou contradictoire, dis-le explicitement\n"
    "7. Markdown : titres, tableaux comparatifs, listes structurées\n"
    "8. TOUJOURS répondre dans la même langue que la question\n"
    "9. Privilégie les méta-analyses et revues systématiques quand disponibles\n"
    "10. Termine par une synthèse des points clés et les lacunes identifiées"
)

RELATED_PROMPT = (
    "Génère 3-4 questions de suivi pertinentes basées sur cette Q&R.\n"
    "Retourne UNIQUEMENT un tableau JSON de strings, sans markdown.\n"
    "Les questions DOIVENT être dans la même langue que la question originale.\n\n"
    "Question: {query}\nRéponse: {answer}"
)

QUERY_EXPANSION_PROMPT = (
    "Tu es un expert en recherche d'information. Analyse cette requête et retourne UNIQUEMENT un objet JSON.\n\n"
    "Requête: {query}\n"
    "{context}\n\n"
    "Retourne un JSON avec :\n"
    '- "rewritten": requête optimisée pour les moteurs de recherche\n'
    '- "intent": "factual"|"comparison"|"tutorial"|"opinion"|"news"|"code"|"definition"\n'
    '- "sub_queries": 2-3 reformulations différentes pour élargir la couverture\n'
    '- "language": code ISO 639-1\n'
    "UNIQUEMENT le JSON, pas de markdown fences."
)


# ═══════════════════════════════════════════════════════════════════════════
# LLM Helpers
# ═══════════════════════════════════════════════════════════════════════════



async def _expand_query(query: str, provider, model: str,
                        session_context: str = "") -> dict:
    """Smart query expansion via LLM with conversation context."""
    fallback = {
        "rewritten": query,
        "intent": detect_intent(query),
        "sub_queries": [],
        "language": detect_language(query),
    }
    if not provider:
        return fallback
    try:
        ctx = ""
        if session_context:
            ctx = f"Contexte de la conversation précédente:\n{session_context}\n"
        prompt = QUERY_EXPANSION_PROMPT.format(query=query, context=ctx)
        resp = await provider.chat(
            [ChatMessage(role="system", content="Tu analyses des requêtes de recherche."),
             ChatMessage(role="user", content=prompt)],
            model=model, temperature=0.1, max_tokens=400,
        )
        text = resp.content.strip()
        if text.startswith("```"):
            text = text.split("\n", 1)[1].rsplit("```", 1)[0].strip()
        data = json.loads(text)
        return {
            "rewritten": data.get("rewritten", query),
            "intent": data.get("intent", fallback["intent"]),
            "sub_queries": data.get("sub_queries", [])[:3],
            "language": data.get("language", fallback["language"]),
        }
    except Exception:
        return fallback


# ═══════════════════════════════════════════════════════════════════════════
# Answer Building
# ═══════════════════════════════════════════════════════════════════════════

def _build_context(passages: list[dict], max_total: int = 12000,
                   max_words: int = 300) -> str:
    parts = []
    total = 0
    for i, p in enumerate(passages, 1):
        words = p["text"].split()[:max_words]
        text = " ".join(words)
        entry = f"[{i}] {p['title']}\n{text}\n"
        if total + len(entry) > max_total:
            break
        parts.append(entry)
        total += len(entry)
    return "\n---\n".join(parts)


def _build_citations(passages: list[dict]) -> list[dict]:
    return [
        {
            "index": i,
            "url": p["url"],
            "title": p["title"],
            "snippet": p["text"][:200] + "..." if len(p["text"]) > 200 else p["text"],
        }
        for i, p in enumerate(passages, 1)
    ]


def _fallback_answer(query: str, passages: list[dict], language: str = "en") -> str:
    """Non-LLM answer: formatted passages with links, adapted to query language."""
    headers = {
        "fr": "## Résultats trouvés\n",
        "en": "## Results found\n",
    }
    # Summarize each passage in a user-friendly way
    header = headers.get(language, headers["en"])
    parts = [header]
    for i, p in enumerate(passages[:6], 1):
        snip = p["text"][:300] + "..." if len(p["text"]) > 300 else p["text"]
        parts.append(f"**[{i}] [{p['title']}]({p['url']})**\n{snip}\n")

    # If query language differs from content language, add a note
    if language == "fr":
        has_english = any(
            not any(c in p["text"][:100] for c in "àâéèêëîïôùûüçœæ")
            for p in passages[:3]
        )
        if has_english:
            parts.insert(1, "> *Les résultats ci-dessous sont en anglais car les sources les plus pertinentes sont anglophones.*\n")

    return "\n".join(parts)


def _related_fallback(query: str, language: str = "en") -> list[str]:
    templates = {
        "fr": [
            f"Peux-tu m'en dire plus sur {query} ?",
            f"Quelles sont les dernières avancées concernant {query} ?",
            f"Comment {query} se compare-t-il aux alternatives ?",
        ],
        "es": [
            f"Cuéntame más sobre {query}",
            f"Últimos avances sobre {query}",
            f"{query} vs alternativas",
        ],
        "de": [
            f"Erzähl mir mehr über {query}",
            f"Neueste Entwicklungen zu {query}",
            f"{query} im Vergleich zu Alternativen",
        ],
        "it": [
            f"Dimmi di più su {query}",
            f"Ultimi sviluppi su {query}",
            f"{query} vs alternative",
        ],
        "pt": [
            f"Conte-me mais sobre {query}",
            f"Últimos avanços sobre {query}",
            f"{query} vs alternativas",
        ],
    }
    return templates.get(language, [
        f"Tell me more about {query}",
        f"Latest developments on {query}",
        f"{query} vs alternatives",
    ])


async def _generate_related(provider, model: str, query: str,
                            summary: str) -> list[str]:
    if not provider:
        return _related_fallback(query)
    try:
        prompt = RELATED_PROMPT.format(query=query, answer=summary[:500])
        resp = await provider.chat(
            [ChatMessage(role="system", content="Tu génères des tableaux JSON de questions."),
             ChatMessage(role="user", content=prompt)],
            model=model, temperature=0.7, max_tokens=300,
        )
        text = resp.content.strip()
        if text.startswith("```"):
            text = text.split("\n", 1)[1].rsplit("```", 1)[0].strip()
        return json.loads(text)
    except Exception:
        return _related_fallback(query)


# ── Session / Follow-up ───────────────────────────────────────────────────

def _get_session_context(session_id: Optional[str], max_turns: int = 5) -> str:
    """Build conversation context from session history."""
    if not session_id or session_id not in _sessions:
        return ""
    turns = _sessions[session_id][-max_turns:]
    parts = []
    for t in turns:
        parts.append(f"Q: {t['query']}")
        if t.get("answer_summary"):
            parts.append(f"A: {t['answer_summary']}")
    return "\n".join(parts)


def _save_session_turn(session_id: Optional[str], query: str,
                       answer_summary: str = "", config: HuntRConfig = None):
    if not session_id:
        return
    if session_id not in _sessions:
        _sessions[session_id] = []
    _sessions[session_id].append({
        "query": query,
        "answer_summary": answer_summary[:300],
        "timestamp": time.time(),
    })
    max_turns = config.max_follow_ups if config else 5
    if len(_sessions[session_id]) > max_turns:
        _sessions[session_id] = _sessions[session_id][-max_turns:]


def _save_to_history(query: str, sources_count: int, mode: str, intent: str = "",
                     focus: str = "web", provider: str = "", model: str = "",
                     time_ms: int = 0, engines: list[str] = None):
    _search_history.insert(0, {
        "query": query, "sources_count": sources_count, "mode": mode,
        "intent": intent, "focus": focus, "provider": provider, "model": model,
        "engines": engines or [], "time_ms": time_ms, "timestamp": time.time(),
    })
    config = HuntRConfig.load()
    while len(_search_history) > config.max_history:
        _search_history.pop()


# ═══════════════════════════════════════════════════════════════════════════
# Routes
# ═══════════════════════════════════════════════════════════════════════════

@router.get("/health")
async def huntr_health():
    config = HuntRConfig.load()
    return {
        "plugin": "huntr", "status": "ok", "version": "2.0.0",
        "engines": _available_engines(config),
        "focus_modes": list(FOCUS_MODES.keys()),
    }


def _available_engines(config: HuntRConfig) -> list[str]:
    engines = ["duckduckgo"]
    if config.brave_api_key:
        engines.append("brave")
    if config.searxng_url:
        engines.append("searxng")
    engines.append("wikipedia")
    return engines


@router.get("/focus-modes")
async def get_focus_modes():
    return {"modes": FOCUS_MODES}


@router.get("/config")
async def get_config():
    config = HuntRConfig.load()
    safe = config.to_dict()
    # Mask API key
    if safe.get("brave_api_key"):
        safe["brave_api_key"] = safe["brave_api_key"][:8] + "..." if len(safe["brave_api_key"]) > 8 else "***"
    return {"config": safe}


@router.post("/config")
async def update_config(req: ConfigUpdateRequest):
    config = HuntRConfig.load()
    if req.brave_api_key is not None:
        config.brave_api_key = req.brave_api_key
    if req.searxng_url is not None:
        config.searxng_url = req.searxng_url
    if req.rerank_method is not None:
        config.rerank_method = req.rerank_method
    if req.default_focus is not None:
        config.default_focus = req.default_focus
    config.save()
    return {"status": "ok", "config": config.to_dict()}


@router.post("/search/stream")
async def search_stream(req: SearchRequest, request: Request):
    """
    Full HuntR pipeline via SSE.

    Events: status, search, sources (real-time), chunk (pro streaming),
            content, citation, related, done, error
    """
    uid = _uid(request)
    brave_key = await _get_user_brave_key(uid)

    async def _stream():
        t0 = time.time()
        config = HuntRConfig.load()

        try:
            # ── 1. Query Understanding + Expansion ─────────────────────
            yield _sse("status", {"message": "Analyse de la requête...", "step": 1})

            provider, model, provider_name = None, "", ""
            if req.pro_search:
                try:
                    provider, model, provider_name = await _get_user_llm(uid, req.provider, req.model)
                except Exception as e:
                    logger.warning(f"HuntR Pro LLM failed for user {uid}: {e}")
                    yield _sse("status", {"message": f"⚠ LLM indisponible : {e}", "step": 1})

            # Get session context for follow-up
            session_ctx = _get_session_context(req.session_id, config.max_follow_ups)

            # Smart expansion (LLM in pro, heuristic in normal)
            understanding = await _expand_query(
                req.query,
                provider if req.pro_search else None,
                model,
                session_ctx,
            )
            search_query = understanding["rewritten"] or req.query
            language = understanding["language"]

            # Auto-detect focus if not specified
            focus = req.focus
            if focus == "web" and understanding["intent"] in ("code", "news"):
                suggested = suggest_focus(understanding["intent"])
                if suggested != "web":
                    focus = suggested

            yield _sse("status", {
                "message": f"Intent: {understanding['intent']} | Focus: {focus} | Recherche: {search_query[:50]}",
                "intent": understanding["intent"],
                "focus": focus,
                "step": 1,
            })

            # ── 2. Multi-Engine Search ─────────────────────────────────
            yield _sse("status", {"message": "Recherche multi-sources...", "step": 2})

            results = await multi_search(
                search_query,
                max_results=req.max_results,
                brave_api_key=brave_key,
                searxng_url=config.searxng_url,
                focus=focus,
                pro=req.pro_search,
                language=language,
            )

            # Sub-queries for broader coverage
            if understanding.get("sub_queries"):
                for sq in understanding["sub_queries"][:2]:
                    extra = await multi_search(
                        sq, max_results=5,
                        brave_api_key=brave_key,
                        searxng_url=config.searxng_url,
                        focus=focus, pro=False, language=language,
                    )
                    seen = {r["url"] for r in results}
                    for r in extra:
                        if r["url"] not in seen:
                            results.append(r)
                            seen.add(r["url"])

            # Detect which engines returned results
            engines_used = list(set(r.get("source", "unknown") for r in results))

            # Send search results (sources shown in real-time)
            yield _sse("search", {
                "count": len(results),
                "engines": engines_used,
                "results": [
                    {"title": r["title"], "url": r["url"], "snippet": r["snippet"],
                     "source": r.get("source", "")}
                    for r in results[:10]
                ],
            })

            # ── 3. Scrape ─────────────────────────────────────────────
            yield _sse("status", {"message": f"Lecture de {len(results)} pages...", "step": 3})
            to_scrape = [r["url"] for r in results if not r.get("text")]
            pre_filled = [r for r in results if r.get("text") and len(r["text"]) >= 100]
            scraped = await scrape_sources(
                to_scrape, config.scrape_concurrency, config.scrape_timeout
            ) if to_scrape else []
            all_content = pre_filled + scraped

            # Fallback: if scraping failed, use search snippets as content
            if not all_content and results:
                for r in results:
                    snippet = r.get("snippet", "")
                    if snippet and len(snippet) >= 30:
                        all_content.append({
                            "url": r["url"],
                            "title": r.get("title", ""),
                            "text": snippet,
                            "words": len(snippet.split()),
                        })
                if all_content:
                    yield _sse("status", {"message": f"Utilisation des extraits ({len(all_content)} sources)", "step": 3})

            # Send sources in real-time as they're scraped
            yield _sse("sources", {
                "count": len(all_content),
                "sources": [
                    {"title": c.get("title", ""), "url": c["url"],
                     "words": c.get("words", 0)}
                    for c in all_content[:10]
                ],
            })

            if not all_content:
                yield _sse("content", {
                    "answer": "Impossible d'extraire le contenu des résultats. Essayez une autre requête."
                })
                yield _sse("done", {"time_ms": _elapsed(t0)})
                return

            # ── 4. Rerank ─────────────────────────────────────────────
            yield _sse("status", {"message": "Classement des passages (TF-IDF)...", "step": 4})
            top_k = 10 if req.pro_search else 6
            passages = rerank(search_query, all_content, top_k=top_k,
                              method=config.rerank_method)
            citations = _build_citations(passages)
            mode_label = "Pro" if req.pro_search else "Normal"
            yield _sse("status", {
                "message": f"[{mode_label}] Top {len(passages)} passages sélectionnés",
                "step": 4,
            })

            # ── Mode Normal : no LLM ──────────────────────────────────
            if not req.pro_search:
                answer = _fallback_answer(req.query, passages, language)
                yield _sse("content", {"answer": answer})
                yield _sse("citation", {"citations": citations})
                related = _related_fallback(req.query, language)
                yield _sse("related", {"questions": related})
                _save_session_turn(req.session_id, req.query, answer[:200], config)
                _save_to_history(req.query, len(results), "normal",
                                 understanding["intent"], focus,
                                 engines=engines_used, time_ms=_elapsed(t0))
                yield _sse("done", {
                    "time_ms": _elapsed(t0), "search_count": len(results),
                    "passages_used": len(passages), "pro_search": False,
                    "intent": understanding["intent"], "focus": focus,
                    "engines": engines_used,
                })
                return

            # ── 5. Pro : LLM Answer Generation ────────────────────────
            if not provider:
                try:
                    provider, model, provider_name = await _get_user_llm(uid, req.provider, req.model)
                except Exception as e:
                    yield _sse("error", {"message": f"LLM non disponible: {e}"})
                    yield _sse("done", {"time_ms": _elapsed(t0), "error": True})
                    return

            yield _sse("status", {"message": "[Pro] Génération de la réponse...", "step": 5})

            context = _build_context(passages, max_total=16000, max_words=400)

            # Build messages with session context for follow-up
            sys_prompt = SYSTEM_PROMPT_ACADEMIC if focus == "academic" else SYSTEM_PROMPT_PRO
            messages = [ChatMessage(role="system", content=sys_prompt)]
            if session_ctx:
                messages.append(ChatMessage(
                    role="system",
                    content=f"Contexte de la conversation précédente:\n{session_ctx}"
                ))
            messages.append(ChatMessage(
                role="user",
                content=f"Question: {req.query}\n\nPassages:\n{context}\n\n"
                        f"Réponds avec des citations inline [1], [2], etc."
            ))

            # Stream answer token by token (fallback to non-stream if unavailable)
            answer_chunks = []
            try:
                async for chunk in provider.chat_stream(messages, model=model, max_tokens=2048):
                    answer_chunks.append(chunk)
                    yield _sse("chunk", {"content": chunk})
                answer = "".join(answer_chunks)
            except (AttributeError, NotImplementedError):
                # Provider doesn't support streaming — use regular chat
                resp = await provider.chat(messages, model=model, max_tokens=2048)
                answer = resp.content or ""
                yield _sse("chunk", {"content": answer})
            yield _sse("content", {"answer": answer})
            yield _sse("citation", {"citations": citations})

            # Related questions
            yield _sse("status", {"message": "Questions de suivi...", "step": 5})
            related = await _generate_related(provider, model, req.query, answer[:500])
            yield _sse("related", {"questions": related})

            # Save session + history
            _save_session_turn(req.session_id, req.query, answer[:300], config)
            _save_to_history(req.query, len(results), "pro",
                             understanding["intent"], focus,
                             provider_name, model, _elapsed(t0), engines_used)
            yield _sse("done", {
                "time_ms": _elapsed(t0), "search_count": len(results),
                "passages_used": len(passages), "pro_search": True,
                "intent": understanding["intent"], "focus": focus,
                "engines": engines_used, "model": model,
            })

        except Exception as e:
            logger.error(f"HuntR search error: {e}", exc_info=True)
            yield _sse("error", {"message": str(e)})
            yield _sse("done", {"time_ms": 0, "error": True})

    return StreamingResponse(_stream(), media_type="text/event-stream")


@router.post("/search")
async def search_sync(req: SearchRequest, request: Request):
    """Synchronous search (non-streaming)."""
    t0 = time.time()
    config = HuntRConfig.load()
    uid = _uid(request)
    brave_key = await _get_user_brave_key(uid)

    try:
        provider, model, provider_name = None, "", ""
        if req.pro_search:
            try:
                provider, model, provider_name = await _get_user_llm(uid, req.provider, req.model)
            except Exception:
                pass

        session_ctx = _get_session_context(req.session_id, config.max_follow_ups)
        understanding = await _expand_query(
            req.query, provider if req.pro_search else None, model, session_ctx
        )
        search_query = understanding["rewritten"] or req.query
        focus = req.focus

        results = await multi_search(
            search_query, req.max_results,
            brave_key, config.searxng_url,
            focus, req.pro_search, understanding["language"],
        )
        if understanding.get("sub_queries"):
            for sq in understanding["sub_queries"][:2]:
                extra = await multi_search(sq, 5, brave_key,
                                           config.searxng_url, focus, False)
                seen = {r["url"] for r in results}
                for r in extra:
                    if r["url"] not in seen:
                        results.append(r)

        engines_used = list(set(r.get("source", "") for r in results))

        to_scrape = [r["url"] for r in results if not r.get("text")]
        pre_filled = [r for r in results if r.get("text") and len(r["text"]) >= 100]
        scraped = await scrape_sources(to_scrape, config.scrape_concurrency,
                                       config.scrape_timeout) if to_scrape else []
        all_content = pre_filled + scraped

        # Fallback: use search snippets if scraping failed
        if not all_content and results:
            for r in results:
                snippet = r.get("snippet", "")
                if snippet and len(snippet) >= 30:
                    all_content.append({
                        "url": r["url"], "title": r.get("title", ""),
                        "text": snippet, "words": len(snippet.split()),
                    })

        if not all_content:
            return JSONResponse({"error": "Aucun contenu extractible"}, status_code=404)

        top_k = 10 if req.pro_search else 6
        passages = rerank(search_query, all_content, top_k=top_k,
                          method=config.rerank_method)
        citations = _build_citations(passages)

        if not req.pro_search:
            answer = _fallback_answer(req.query, passages)
            related = _related_fallback(req.query)
            _save_session_turn(req.session_id, req.query, answer[:200], config)
            _save_to_history(req.query, len(results), "normal",
                             understanding["intent"], focus, engines=engines_used,
                             time_ms=_elapsed(t0))
            return {
                "query": req.query, "answer": answer, "citations": citations,
                "related_questions": related, "search_count": len(results),
                "passages_used": len(passages), "pro_search": False,
                "intent": understanding["intent"], "focus": focus,
                "engines": engines_used, "time_ms": _elapsed(t0),
            }

        if not provider:
            provider, model, provider_name = await _get_user_llm(uid, req.provider, req.model)

        context = _build_context(passages, max_total=16000, max_words=400)
        sys_prompt = SYSTEM_PROMPT_ACADEMIC if focus == "academic" else SYSTEM_PROMPT_PRO
        messages = [ChatMessage(role="system", content=sys_prompt)]
        if session_ctx:
            messages.append(ChatMessage(
                role="system",
                content=f"Contexte de la conversation précédente:\n{session_ctx}"
            ))
        messages.append(ChatMessage(
            role="user",
            content=f"Question: {req.query}\n\nPassages:\n{context}\n\n"
                    f"Réponds avec des citations inline [1], [2], etc."
        ))
        resp = await provider.chat(messages, model=model, max_tokens=2048)
        related = await _generate_related(provider, model, req.query, resp.content[:500])

        _save_session_turn(req.session_id, req.query, resp.content[:300], config)
        _save_to_history(req.query, len(results), "pro",
                         understanding["intent"], focus,
                         provider_name, model, _elapsed(t0), engines_used)
        return {
            "query": req.query, "answer": resp.content, "citations": citations,
            "related_questions": related, "search_count": len(results),
            "passages_used": len(passages), "pro_search": True,
            "intent": understanding["intent"], "focus": focus,
            "engines": engines_used, "time_ms": _elapsed(t0),
            "model": resp.model,
            "tokens": {"input": resp.tokens_input, "output": resp.tokens_output},
        }

    except Exception as e:
        logger.error(f"HuntR search error: {e}", exc_info=True)
        return JSONResponse({"error": str(e)}, status_code=500)


@router.post("/fetch")
async def fetch_url(req: FetchRequest):
    try:
        from backend.core.agents.tools.web_fetch import web_fetch
        return await web_fetch(req.url, extract=req.extract, timeout=15)
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)


@router.get("/history")
async def search_history(limit: int = 30):
    return {"history": _search_history[:limit]}


@router.delete("/history")
async def clear_history():
    _search_history.clear()
    return {"status": "ok"}


@router.delete("/sessions/{session_id}")
async def clear_session(session_id: str):
    _sessions.pop(session_id, None)
    return {"status": "ok"}


# ── SSE helpers ────────────────────────────────────────────────────────────

def _sse(event_type: str, data: dict) -> str:
    return f"data: {json.dumps({'type': event_type, 'data': data}, ensure_ascii=False)}\n\n"

def _elapsed(t0: float) -> int:
    return int((time.time() - t0) * 1000)
