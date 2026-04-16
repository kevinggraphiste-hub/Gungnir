"""
HuntR v3 — Perplexity-like Search Plugin for Gungnir

Two modes:
  - Classique (free) : DuckDuckGo → formatted results, no LLM
  - Pro              : Tavily (per-user key) → LLM synthesis with inline citations

Everything is per-user: search API keys, LLM provider/model.
"""
from fastapi import APIRouter, Request, Depends
from fastapi.responses import StreamingResponse, JSONResponse
from pydantic import BaseModel, Field
from typing import Optional
from sqlalchemy.ext.asyncio import AsyncSession
import json
import time
import logging

from backend.core.config.settings import Settings
from backend.core.providers import get_provider, ChatMessage
from backend.core.db.engine import get_session
from backend.core.api.auth_helpers import (
    get_user_settings, get_user_provider_key, get_user_service_key,
)

from .search_providers import DDGProvider, TavilyProvider, SearchResult

logger = logging.getLogger("gungnir.plugins.huntr")

router = APIRouter()

# ── In-memory history (plugin-scoped) ────────────────────────────────────
_search_history: list[dict] = []
MAX_HISTORY = 50


# ── Request model ────────────────────────────────────────────────────────

class SearchRequest(BaseModel):
    query: str
    pro_search: bool = False
    max_results: int = Field(default=10, ge=1, le=20)


# ── Per-user helpers ─────────────────────────────────────────────────────

def _uid(request: Request) -> int:
    return getattr(request.state, "user_id", None) or 1


async def _resolve_tavily(user_id: int, session: AsyncSession) -> TavilyProvider | None:
    """Get the user's Tavily provider (or None if no key configured)."""
    us = await get_user_settings(user_id, session)
    svc = get_user_service_key(us, "tavily")
    if not svc or not svc.get("api_key"):
        return None
    return TavilyProvider(api_key=svc["api_key"])


async def _resolve_llm(user_id: int, session: AsyncSession):
    """Get the user's active LLM provider + model. Raises on failure."""
    us = await get_user_settings(user_id, session)
    settings = Settings.load()

    pname = us.active_provider or "openrouter"
    user_prov = get_user_provider_key(us, pname)
    api_key = user_prov.get("api_key") if user_prov else None
    if not api_key:
        raise ValueError(f"Aucune clé API pour le provider '{pname}'")

    cfg = settings.providers.get(pname)
    base_url = (user_prov.get("base_url") if user_prov else None) or \
               (cfg.base_url if cfg else None)
    model = us.active_model or \
            (cfg.default_model if cfg else None) or \
            (cfg.models[0] if cfg and cfg.models else None)
    if not model:
        raise ValueError(f"Aucun modèle configuré pour '{pname}'")

    return get_provider(pname, api_key, base_url), model


# ── LLM Prompts ──────────────────────────────────────────────────────────

SYSTEM_PROMPT = (
    "Tu es HuntR, un moteur de recherche IA. "
    "Synthétise les passages fournis en une réponse complète et structurée.\n\n"
    "RÈGLES :\n"
    "1. Base CHAQUE affirmation sur les passages — n'utilise JAMAIS tes propres connaissances\n"
    "2. Cite les sources inline : chaque fait doit avoir [1], [2], etc. dans le paragraphe\n"
    "3. Si l'information manque ou est contradictoire, dis-le explicitement\n"
    "4. Utilise le Markdown : titres, listes, tableaux quand pertinent\n"
    "5. TOUJOURS répondre dans la même langue que la question\n"
    "6. Sois exhaustif : contexte, nuances, détails importants\n"
    "7. Termine par une courte synthèse des points clés"
)


# ── SSE helpers ──────────────────────────────────────────────────────────

def _sse(event: str, data: dict) -> str:
    return f"data: {json.dumps({'type': event, 'data': data}, ensure_ascii=False)}\n\n"

def _elapsed(t0: float) -> int:
    return int((time.time() - t0) * 1000)


# ── Format helpers ───────────────────────────────────────────────────────

def _format_classic_answer(query: str, results: list[SearchResult]) -> str:
    """Format DDG results as a readable list with links."""
    if not results:
        return "Aucun résultat trouvé pour cette recherche."
    parts = ["## Résultats\n"]
    for i, r in enumerate(results[:8], 1):
        snippet = r.snippet[:300] + "..." if len(r.snippet) > 300 else r.snippet
        parts.append(f"**[{i}] [{r.title}]({r.url})**\n{snippet}\n")
    return "\n".join(parts)


def _build_citations(results: list[SearchResult]) -> list[dict]:
    return [
        {
            "index": i,
            "url": r.url,
            "title": r.title,
            "snippet": r.snippet[:200],
        }
        for i, r in enumerate(results[:10], 1)
    ]


def _build_llm_context(results: list[SearchResult], max_chars: int = 15000) -> str:
    """Build numbered passages for the LLM prompt."""
    parts = []
    total = 0
    for i, r in enumerate(results[:10], 1):
        text = r.content or r.snippet
        if not text:
            continue
        # Limit each passage
        if len(text) > 2000:
            text = text[:2000] + "..."
        entry = f"[{i}] {r.title}\nSource: {r.url}\n{text}\n"
        if total + len(entry) > max_chars:
            break
        parts.append(entry)
        total += len(entry)
    return "\n---\n".join(parts)


def _related_fallback(query: str) -> list[str]:
    """Static related questions (no LLM needed)."""
    return [
        f"En savoir plus sur {query}",
        f"Dernières actualités sur {query}",
        f"{query} : comparaison et alternatives",
    ]


def _save_to_history(query: str, mode: str, sources: int, time_ms: int):
    _search_history.insert(0, {
        "query": query, "mode": mode, "sources_count": sources,
        "time_ms": time_ms, "timestamp": time.time(),
    })
    while len(_search_history) > MAX_HISTORY:
        _search_history.pop()


# ═══════════════════════════════════════════════════════════════════════════
# Main search endpoint — SSE stream
# ═══════════════════════════════════════════════════════════════════════════

@router.post("/search/stream")
async def search_stream(req: SearchRequest, request: Request,
                        session: AsyncSession = Depends(get_session)):
    uid = _uid(request)

    # ── Resolve per-user resources BEFORE the stream ─────────────────
    tavily = None
    llm_provider = None
    llm_model = ""
    llm_error = None

    if req.pro_search:
        # Tavily key
        tavily = await _resolve_tavily(uid, session)
        if not tavily:
            return JSONResponse(
                {"error": "Mode Pro nécessite une clé Tavily. "
                          "Ajoutez-la dans Paramètres → Services → Tavily."},
                status_code=400,
            )
        # LLM
        try:
            llm_provider, llm_model = await _resolve_llm(uid, session)
        except Exception as e:
            llm_error = str(e)

    async def _stream():
        t0 = time.time()

        try:
            query = req.query.strip()

            if not req.pro_search:
                # ══════════════════════════════════════════════════════
                # MODE CLASSIQUE — DDG only, no LLM
                # ══════════════════════════════════════════════════════
                yield _sse("status", {"message": "Recherche en cours...", "step": 1})

                ddg = DDGProvider()
                results = await ddg.search(query, max_results=req.max_results)

                yield _sse("search", {
                    "count": len(results),
                    "engines": ["duckduckgo"],
                    "results": [
                        {"title": r.title, "url": r.url, "snippet": r.snippet,
                         "source": r.source}
                        for r in results[:10]
                    ],
                })

                citations = _build_citations(results)
                answer = _format_classic_answer(query, results)

                yield _sse("citation", {"citations": citations})
                yield _sse("content", {"answer": answer})
                yield _sse("related", {"questions": _related_fallback(query)})

                _save_to_history(query, "classique", len(results), _elapsed(t0))

                yield _sse("done", {
                    "time_ms": _elapsed(t0),
                    "search_count": len(results),
                    "pro_search": False,
                    "engines": ["duckduckgo"],
                })
                return

            # ══════════════════════════════════════════════════════════
            # MODE PRO — Tavily + LLM
            # ══════════════════════════════════════════════════════════
            yield _sse("status", {"message": "Recherche approfondie (Tavily)...", "step": 1})

            results = await tavily.search(query, max_results=req.max_results)

            if not results:
                # Fallback DDG si Tavily retourne rien
                yield _sse("status", {"message": "Fallback DuckDuckGo...", "step": 1})
                ddg = DDGProvider()
                results = await ddg.search(query, max_results=req.max_results)

            engines = list(set(r.source for r in results))

            yield _sse("search", {
                "count": len(results),
                "engines": engines,
                "results": [
                    {"title": r.title, "url": r.url, "snippet": r.snippet,
                     "source": r.source}
                    for r in results[:10]
                ],
            })

            citations = _build_citations(results)
            yield _sse("citation", {"citations": citations})

            # ── LLM synthesis ─────────────────────────────────────────
            if not llm_provider:
                # No LLM → formatted results like classic mode
                answer = _format_classic_answer(query, results)
                yield _sse("content", {"answer": answer})
                yield _sse("status", {"message": f"⚠ LLM indisponible ({llm_error})"})
                yield _sse("related", {"questions": _related_fallback(query)})
                yield _sse("done", {
                    "time_ms": _elapsed(t0), "search_count": len(results),
                    "pro_search": True, "engines": engines, "error": True,
                })
                return

            yield _sse("status", {"message": "Synthèse LLM en cours...", "step": 2})

            context = _build_llm_context(results)
            messages = [
                ChatMessage(role="system", content=SYSTEM_PROMPT),
                ChatMessage(
                    role="user",
                    content=(
                        f"Question : {query}\n\n"
                        f"Passages :\n{context}\n\n"
                        f"Réponds avec des citations inline [1], [2], etc. "
                        f"Chaque affirmation doit citer sa source dans le paragraphe."
                    ),
                ),
            ]

            try:
                resp = await llm_provider.chat(messages, llm_model, max_tokens=2048)
                answer = resp.content or ""
            except Exception as e:
                logger.warning(f"[HuntR] LLM failed: {e}")
                answer = ""

            if not answer.strip():
                answer = _format_classic_answer(query, results)

            yield _sse("content", {"answer": answer})
            yield _sse("related", {"questions": _related_fallback(query)})

            _save_to_history(query, "pro", len(results), _elapsed(t0))

            yield _sse("done", {
                "time_ms": _elapsed(t0),
                "search_count": len(results),
                "pro_search": True,
                "engines": engines,
                "model": llm_model,
            })

        except Exception as e:
            logger.error(f"[HuntR] Stream error: {e}", exc_info=True)
            yield _sse("error", {"message": str(e)})
            yield _sse("done", {"time_ms": 0, "error": True})

    return StreamingResponse(_stream(), media_type="text/event-stream")


# ═══════════════════════════════════════════════════════════════════════════
# Utility endpoints
# ═══════════════════════════════════════════════════════════════════════════

@router.get("/health")
async def health():
    return {"plugin": "huntr", "status": "ok", "version": "3.0.0"}


@router.get("/history")
async def get_history(limit: int = 30):
    return {"history": _search_history[:limit]}


@router.delete("/history")
async def clear_history():
    _search_history.clear()
    return {"status": "ok"}


@router.get("/user-capabilities")
async def user_capabilities(request: Request,
                            session: AsyncSession = Depends(get_session)):
    """Check what the current user has configured (for frontend UI)."""
    uid = _uid(request)
    us = await get_user_settings(uid, session)

    has_tavily = False
    tavily_svc = get_user_service_key(us, "tavily")
    if tavily_svc and tavily_svc.get("api_key"):
        has_tavily = True

    has_llm = False
    pname = us.active_provider or "openrouter"
    user_prov = get_user_provider_key(us, pname)
    if user_prov and user_prov.get("api_key"):
        has_llm = True

    return {
        "has_tavily": has_tavily,
        "has_llm": has_llm,
        "provider": pname if has_llm else None,
        "model": us.active_model if has_llm else None,
    }
