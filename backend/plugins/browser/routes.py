"""
HuntR v3 — Perplexity-like Search Plugin for Gungnir

Two modes:
  - Classique (free) : DuckDuckGo → formatted results, no LLM
  - Pro              : Tavily (per-user key) → LLM synthesis with inline citations

Everything is per-user: search API keys, LLM provider/model, search history,
favorites, and Tavily cache.
"""
from fastapi import APIRouter, Request, Depends, HTTPException
from fastapi.responses import StreamingResponse, JSONResponse
from pydantic import BaseModel, Field
from typing import Optional
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, delete, desc
import json
import time
import logging

from backend.core.config.settings import Settings
from backend.core.providers import get_provider, ChatMessage
from backend.core.db.engine import get_session
from backend.core.db.models import HuntRSearch
from backend.core.api.auth_helpers import (
    get_user_settings, get_user_provider_key, get_user_service_key,
)

from .search_providers import DDGProvider, TavilyProvider, SearchResult
from .cache import tavily_cache

logger = logging.getLogger("gungnir.plugins.huntr")

router = APIRouter()


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

    key_preview = f"{api_key[:8]}...{api_key[-4:]}" if len(api_key) > 12 else "***"
    logger.info(f"[HuntR] LLM resolved: provider={pname}, model={model}, key={key_preview}, base_url={base_url}")

    return get_provider(pname, api_key, base_url), model


# ── LLM Prompts ──────────────────────────────────────────────────────────

SYSTEM_PROMPT = """\
Tu es HuntR, un assistant de recherche web. Tu transformes des passages web bruts en une réponse reformulée, structurée et sourcée.

STRUCTURE OBLIGATOIRE :

# [Titre principal — une phrase qui résume la réponse]

## [Aspect 1 — sous-titre descriptif]
Un paragraphe développé (5-8 phrases min.) qui explore ce premier aspect. Contexte, explications, nuances, exemples concrets. Chaque affirmation cite sa source [1], [2] directement dans la phrase.

## [Aspect 2 — sous-titre descriptif]
Un paragraphe développé explorant un deuxième angle. Croise les sources, compare les points de vue [3], ajoute du contexte [1].

## [Aspect 3 — sous-titre descriptif]
Un paragraphe développé sur un troisième aspect. Détails supplémentaires, implications, exemples [2][4].

## Conclusion
3 à 5 phrases de synthèse reprenant les points clés. Pas de nouvelles informations, juste un résumé clair.

REGLES :
- REFORMULE intégralement — ne recopie JAMAIS un passage tel quel
- Cite DANS la phrase : « Python domine [1], devant Rust [3]. » (PAS de citation détachée)
- Utilise TOUS les passages fournis, chaque source doit être citée au moins une fois
- Réponds dans la MÊME LANGUE que la question
- Si l'info manque ou est contradictoire, dis-le clairement
- N'utilise JAMAIS tes propres connaissances — UNIQUEMENT les passages fournis"""


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


def _row_to_dict(row: HuntRSearch) -> dict:
    """Serialize a HuntRSearch row as a history entry for the frontend."""
    return {
        "id": row.id,
        "query": row.query,
        "mode": row.mode,
        "sources_count": row.sources_count,
        "time_ms": row.time_ms,
        "timestamp": row.created_at.timestamp() if row.created_at else 0,
        "answer": row.answer or "",
        "citations": row.citations or [],
        "related_questions": row.related_questions or [],
        "engines": row.engines or [],
        "model": row.model or "",
        "is_favorite": bool(row.is_favorite),
    }


async def _save_to_history(
    session: AsyncSession, user_id: int,
    query: str, mode: str, sources: int, time_ms: int,
    answer: str = "", citations: list[dict] | None = None,
    related: list[str] | None = None, engines: list[str] | None = None,
    model: str = "",
) -> HuntRSearch:
    """Persist a search to DB (per-user)."""
    row = HuntRSearch(
        user_id=user_id,
        query=query,
        mode=mode,
        answer=answer,
        citations=citations or [],
        related_questions=related or [],
        engines=engines or [],
        sources_count=sources,
        time_ms=time_ms,
        model=model,
        is_favorite=False,
    )
    session.add(row)
    await session.commit()
    await session.refresh(row)
    return row


# ═══════════════════════════════════════════════════════════════════════════
# Main search endpoint — SSE stream
# ═══════════════════════════════════════════════════════════════════════════

@router.post("/search/stream")
async def search_stream(req: SearchRequest, request: Request,
                        session: AsyncSession = Depends(get_session)):
    uid = _uid(request)

    # ── Resolve per-user resources BEFORE the stream ─────────────────
    tavily = await _resolve_tavily(uid, session)
    llm_provider = None
    llm_model = ""
    llm_error = None

    if req.pro_search:
        if not tavily:
            return JSONResponse(
                {"error": "Mode Pro nécessite une clé Tavily. "
                          "Ajoutez-la dans Paramètres → Services → Tavily."},
                status_code=400,
            )
        try:
            llm_provider, llm_model = await _resolve_llm(uid, session)
        except Exception as e:
            llm_error = str(e)

    # Cache check (Pro only — Classique reste 100% gratuit/frais)
    cache_key = None
    cached_payload = None
    if req.pro_search:
        cache_key = tavily_cache.make_key(uid, req.query, "pro", req.max_results)
        cached_payload = tavily_cache.get(cache_key)

    async def _stream():
        t0 = time.time()

        try:
            query = req.query.strip()

            # ══════════════════════════════════════════════════════════
            # CACHE HIT (Pro) — replay the cached answer as SSE events
            # ══════════════════════════════════════════════════════════
            if cached_payload is not None:
                yield _sse("status", {"message": "Résultat mis en cache (récent)", "step": 4, "total_steps": 4})
                yield _sse("search", {
                    "count": cached_payload["sources_count"],
                    "engines": cached_payload["engines"],
                    "results": cached_payload["live_results"],
                })
                yield _sse("citation", {"citations": cached_payload["citations"]})
                yield _sse("content", {"answer": cached_payload["answer"]})
                yield _sse("related", {"questions": cached_payload["related"]})

                # Still log as a separate history entry so the user sees it
                await _save_to_history(
                    session, uid, query, "pro",
                    cached_payload["sources_count"], _elapsed(t0),
                    answer=cached_payload["answer"],
                    citations=cached_payload["citations"],
                    related=cached_payload["related"],
                    engines=cached_payload["engines"],
                    model=cached_payload["model"],
                )
                yield _sse("done", {
                    "time_ms": _elapsed(t0),
                    "search_count": cached_payload["sources_count"],
                    "pro_search": True,
                    "engines": cached_payload["engines"],
                    "model": cached_payload["model"],
                    "cached": True,
                })
                return

            if not req.pro_search:
                # ══════════════════════════════════════════════════════
                # MODE CLASSIQUE — DDG only, 100% gratuit, 0 API key
                # ══════════════════════════════════════════════════════
                yield _sse("status", {"message": "Recherche (DuckDuckGo)...", "step": 1})

                ddg = DDGProvider()
                results = await ddg.search(query, max_results=req.max_results)
                engines = ["duckduckgo"]

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
                answer = _format_classic_answer(query, results)
                related = _related_fallback(query)

                yield _sse("citation", {"citations": citations})
                yield _sse("content", {"answer": answer})
                yield _sse("related", {"questions": related})

                await _save_to_history(session, uid, query, "classique",
                                       len(results), _elapsed(t0),
                                       answer=answer, citations=citations,
                                       related=related, engines=engines)

                yield _sse("done", {
                    "time_ms": _elapsed(t0),
                    "search_count": len(results),
                    "pro_search": False,
                    "engines": engines,
                })
                return

            # ══════════════════════════════════════════════════════════
            # MODE PRO — Tavily + LLM (4 steps)
            # ══════════════════════════════════════════════════════════

            # Step 1: Tavily search
            yield _sse("status", {"message": "Recherche approfondie (Tavily)...", "step": 1, "total_steps": 4})
            results = await tavily.search(query, max_results=req.max_results)

            if not results:
                yield _sse("status", {"message": "Fallback DuckDuckGo...", "step": 1, "total_steps": 4})
                ddg = DDGProvider()
                results = await ddg.search(query, max_results=req.max_results)

            engines = list(set(r.source for r in results)) if results else ["tavily"]

            live_results = [
                {"title": r.title, "url": r.url, "snippet": r.snippet, "source": r.source}
                for r in results[:10]
            ]

            # Step 2: sources found
            yield _sse("status", {"message": f"{len(results)} sources trouvées", "step": 2, "total_steps": 4})
            yield _sse("search", {"count": len(results), "engines": engines, "results": live_results})

            # Step 3: preparing context
            yield _sse("status", {"message": "Préparation du contexte...", "step": 3, "total_steps": 4})
            citations = _build_citations(results)
            yield _sse("citation", {"citations": citations})

            # ── LLM synthesis ─────────────────────────────────────────
            if not llm_provider:
                answer = _format_classic_answer(query, results)
                yield _sse("content", {"answer": answer})
                yield _sse("status", {"message": f"⚠ LLM indisponible ({llm_error})"})
                yield _sse("related", {"questions": _related_fallback(query)})
                yield _sse("done", {
                    "time_ms": _elapsed(t0), "search_count": len(results),
                    "pro_search": True, "engines": engines, "error": True,
                })
                return

            # Step 4: LLM synthesis (streamed)
            yield _sse("status", {"message": "Synthèse par l'IA en cours...", "step": 4, "total_steps": 4})

            context = _build_llm_context(results)
            messages = [
                ChatMessage(role="system", content=SYSTEM_PROMPT),
                ChatMessage(
                    role="user",
                    content=(
                        f"QUESTION : {query}\n\n"
                        f"PASSAGES WEB (numérotés [1] à [{min(len(results), 10)}]) :\n\n"
                        f"{context}\n\n"
                        f"---\n"
                        f"Rédige une réponse LONGUE et DÉTAILLÉE (minimum 400 mots).\n"
                        f"Suis EXACTEMENT la structure : # Titre → ## Aspect 1 → ## Aspect 2 → ## Aspect 3 → ## Conclusion\n"
                        f"REFORMULE, ne copie pas. Cite [1], [2] etc. DANS chaque phrase.\n"
                        f"Exploite TOUS les passages — chaque source citée au moins une fois."
                    ),
                ),
            ]

            llm_ok = False
            answer = ""
            try:
                logger.info(f"[HuntR] Streaming LLM: provider={type(llm_provider).__name__}, model={llm_model}")
                async for token in llm_provider.chat_stream(messages, llm_model, max_tokens=4096):
                    answer += token
                    yield _sse("chunk", {"token": token})
                logger.info(f"[HuntR] LLM stream done: {len(answer)} chars")
                if answer.strip():
                    llm_ok = True
            except Exception as e:
                logger.error(f"[HuntR] LLM FAILED: {type(e).__name__}: {e}", exc_info=True)
                yield _sse("status", {"message": f"⚠ Erreur LLM ({type(e).__name__}): {e}"})

            if not llm_ok:
                logger.warning("[HuntR] Using classic fallback (LLM empty or failed)")
                answer = _format_classic_answer(query, results)

            related = _related_fallback(query)
            yield _sse("content", {"answer": answer})
            yield _sse("related", {"questions": related})

            await _save_to_history(session, uid, query, "pro",
                                   len(results), _elapsed(t0),
                                   answer=answer, citations=citations,
                                   related=related, engines=engines,
                                   model=llm_model)

            # Store in cache (only if LLM succeeded — don't cache fallbacks)
            if llm_ok and cache_key:
                tavily_cache.set(cache_key, {
                    "answer": answer,
                    "citations": citations,
                    "related": related,
                    "engines": engines,
                    "sources_count": len(results),
                    "live_results": live_results,
                    "model": llm_model,
                })

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
# History endpoints (per-user, DB-backed)
# ═══════════════════════════════════════════════════════════════════════════

@router.get("/health")
async def health():
    return {"plugin": "huntr", "status": "ok", "version": "3.1.0"}


@router.get("/history")
async def get_history(request: Request, limit: int = 30, favorites_only: bool = False,
                      session: AsyncSession = Depends(get_session)):
    uid = _uid(request)
    stmt = select(HuntRSearch).where(HuntRSearch.user_id == uid)
    if favorites_only:
        stmt = stmt.where(HuntRSearch.is_favorite == True)
    stmt = stmt.order_by(desc(HuntRSearch.created_at)).limit(max(1, min(limit, 200)))
    result = await session.execute(stmt)
    rows = result.scalars().all()
    return {"history": [_row_to_dict(r) for r in rows]}


@router.delete("/history")
async def clear_history(request: Request, keep_favorites: bool = True,
                        session: AsyncSession = Depends(get_session)):
    """Clear the user's history. By default keeps favorites."""
    uid = _uid(request)
    stmt = delete(HuntRSearch).where(HuntRSearch.user_id == uid)
    if keep_favorites:
        stmt = stmt.where(HuntRSearch.is_favorite == False)
    await session.execute(stmt)
    await session.commit()
    return {"status": "ok"}


@router.delete("/history/{entry_id}")
async def delete_entry(entry_id: int, request: Request,
                       session: AsyncSession = Depends(get_session)):
    uid = _uid(request)
    row = await session.get(HuntRSearch, entry_id)
    if not row or row.user_id != uid:
        raise HTTPException(status_code=404, detail="Entrée introuvable")
    await session.delete(row)
    await session.commit()
    return {"status": "ok"}


@router.post("/history/{entry_id}/favorite")
async def favorite_entry(entry_id: int, request: Request,
                         session: AsyncSession = Depends(get_session)):
    uid = _uid(request)
    row = await session.get(HuntRSearch, entry_id)
    if not row or row.user_id != uid:
        raise HTTPException(status_code=404, detail="Entrée introuvable")
    row.is_favorite = True
    await session.commit()
    return {"status": "ok", "is_favorite": True}


@router.delete("/history/{entry_id}/favorite")
async def unfavorite_entry(entry_id: int, request: Request,
                           session: AsyncSession = Depends(get_session)):
    uid = _uid(request)
    row = await session.get(HuntRSearch, entry_id)
    if not row or row.user_id != uid:
        raise HTTPException(status_code=404, detail="Entrée introuvable")
    row.is_favorite = False
    await session.commit()
    return {"status": "ok", "is_favorite": False}


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
