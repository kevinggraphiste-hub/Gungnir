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

from .search_providers import DDGProvider, TavilyProvider, SearchResult, VALID_TOPICS
from .cache import tavily_cache

logger = logging.getLogger("gungnir.plugins.huntr")

router = APIRouter()


# ── Request model ────────────────────────────────────────────────────────

class SearchRequest(BaseModel):
    query: str
    pro_search: bool = False
    max_results: int = Field(default=10, ge=1, le=20)
    topic: str = Field(default="web")  # web | news | academic | code
    # Optional overrides from the frontend — le chat envoie deja le
    # provider/model actifs du store Zustand, HuntR fait pareil pour eviter
    # les desyncs avec user_settings en DB.
    provider: Optional[str] = None
    model: Optional[str] = None
    # Override ponctuel du format de reponse (pro uniquement). Si absent,
    # on retombe sur user.huntr_config.custom_format, puis sur le squelette
    # par defaut (# Titre / ## Aspects / ## Conclusion).
    custom_format: Optional[str] = None

    def safe_topic(self) -> str:
        return self.topic if self.topic in VALID_TOPICS else "web"


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


async def _resolve_llm(
    user_id: int,
    session: AsyncSession,
    override_provider: Optional[str] = None,
    override_model: Optional[str] = None,
):
    """Get the user's active LLM provider + model. Raises on failure.

    Overrides prennent la priorite sur user_settings : le frontend envoie
    deja le provider/model actifs du store Zustand (meme source de verite
    que le chat), ce qui evite les desyncs avec la DB.
    """
    us = await get_user_settings(user_id, session)
    settings = Settings.load()

    pname = override_provider or us.active_provider or "openrouter"
    user_prov = get_user_provider_key(us, pname)
    api_key = user_prov.get("api_key") if user_prov else None
    if not api_key:
        raise ValueError(f"Aucune clé API pour le provider '{pname}'")

    cfg = settings.providers.get(pname)
    base_url = (user_prov.get("base_url") if user_prov else None) or \
               (cfg.base_url if cfg else None)
    model = override_model or \
            us.active_model or \
            (cfg.default_model if cfg else None) or \
            (cfg.models[0] if cfg and cfg.models else None)
    if not model:
        raise ValueError(f"Aucun modèle configuré pour '{pname}'")

    key_preview = f"{api_key[:8]}...{api_key[-4:]}" if len(api_key) > 12 else "***"
    logger.info(f"[HuntR] LLM resolved: provider={pname}, model={model}, key={key_preview}, base_url={base_url}")

    return get_provider(pname, api_key, base_url), model


# ── LLM Prompts (per topic) ──────────────────────────────────────────────

_BASE_RULES = """\
REGLES GLOBALES :
- REFORMULE intégralement — ne recopie JAMAIS un passage tel quel
- Cite DANS la phrase : « Python domine [1], devant Rust [3]. » (PAS de citation détachée)
- Utilise TOUS les passages fournis, chaque source doit être citée au moins une fois
- Réponds dans la MÊME LANGUE que la question
- Si l'info manque ou est contradictoire, dis-le clairement
- N'utilise JAMAIS tes propres connaissances — UNIQUEMENT les passages fournis"""

_BASE_STRUCTURE = """\
STRUCTURE OBLIGATOIRE — RESPECTE-LA A LA LETTRE :

La reponse doit suivre EXACTEMENT ce squelette Markdown, dans cet ordre,
sans rien ajouter ni retirer entre les sections :

# [Titre principal en une phrase — reformule la question en affirmation]

## [Sous-titre aspect 1]
Paragraphe de 5 a 8 phrases pleines, redige en prose continue. Chaque
affirmation cite sa source [1], [2] directement dans la phrase.

## [Sous-titre aspect 2]
Paragraphe de 5 a 8 phrases pleines sur un deuxieme angle. Croise les
sources [3], ajoute du contexte [1].

## [Sous-titre aspect 3]
Paragraphe de 5 a 8 phrases pleines sur un troisieme aspect. Details,
implications, exemples [2][4].

## Conclusion
Paragraphe final de 3 a 5 phrases qui synthetise sans apporter de nouvelle
information.

INTERDICTIONS STRICTES :
- INTERDIT d'utiliser des listes a puces (`-`, `*`) ou numerotees (`1.`, `2.`) dans le corps — seulement de la prose en paragraphes
- INTERDIT de sauter un `##` ou de reordonner les sections
- INTERDIT d'ajouter du texte avant le `#` ou apres la conclusion
- INTERDIT de laisser un `##` sans paragraphe derriere
- INTERDIT de mettre les citations en fin de paragraphe (« Source: [1][2] ») — elles vont DANS les phrases

EXEMPLE DE FORMAT ATTENDU (structure, pas le contenu) :

# Odin est la figure centrale du pantheon nordique, maitre de la sagesse et de la guerre

## Origine et attributs divins
Odin regne sur Asgard et incarne la sagesse supreme chez les peuples nordiques [1]. Il est decrit comme le pere de Thor et de plusieurs autres dieux [2], ce qui en fait l'Allfather — le pere de tous [6]. ...

## Role dans les mythes et le Ragnarok
Plusieurs recits le presentent comme strategy du Ragnarok [5], notamment via sa confrontation avec Fenrir, fils de Loki [3]. ...

## Representations modernes et transmission
Les reseaux comme TikTok ou YouTube vulgarisent aujourd'hui son mythe [1][4]. Ces formats courts permettent ...

## Conclusion
Odin reste l'archetype du dieu-roi nordique, a la fois souverain, guerrier et sage [2][6]. ...
"""

SYSTEM_PROMPT_WEB = f"""\
Tu es HuntR (mode Web), un assistant de recherche web généraliste. Tu transformes des passages web bruts en une réponse reformulée, structurée et sourcée.

{_BASE_STRUCTURE}

{_BASE_RULES}"""

SYSTEM_PROMPT_NEWS = f"""\
Tu es HuntR (mode Actualités). Tu synthétises des articles de presse récents en une réponse chronologique, factuelle et sourcée.

{_BASE_STRUCTURE}

SPÉCIFICITÉS ACTUALITÉS :
- Mentionne les DATES dans le texte (ex : « Le 12 mars, selon [2]... »)
- Identifie clairement les ACTEURS (personnes, entreprises, États) et leur position
- Distingue les FAITS RAPPORTÉS des ANALYSES/OPINIONS
- Si l'info est en développement, signale-le (« situation évolutive »)
- Mets en avant l'IMPACT : qui est concerné, conséquences immédiates et possibles
- Quand les sources se contredisent, expose les versions au lieu de trancher

{_BASE_RULES}"""

SYSTEM_PROMPT_ACADEMIC = f"""\
Tu es HuntR (mode Académique). Tu synthétises des publications scientifiques et documents de recherche avec rigueur et neutralité.

{_BASE_STRUCTURE}

SPÉCIFICITÉS ACADÉMIQUES :
- Ton formel, précis, sans sensationnalisme
- Mentionne MÉTHODOLOGIE (type d'étude, échantillon, design) quand les passages le décrivent
- Distingue CONSENSUS scientifique vs HYPOTHÈSES vs RÉSULTATS PRÉLIMINAIRES
- Signale les LIMITES déclarées par les auteurs
- Utilise le vocabulaire technique quand les sources l'emploient, en l'expliquant brièvement
- Pas de conclusion « militante » : reste descriptif et exposé

{_BASE_RULES}"""

SYSTEM_PROMPT_CODE = f"""\
Tu es HuntR (mode Code/Dev). Tu synthétises des ressources techniques (docs, GitHub, StackOverflow) pour répondre à une question de développement.

STRUCTURE ADAPTÉE :

# [Titre de la réponse technique]

## Approche recommandée
Explication de la meilleure approche selon les sources [1][2]. Inclue un exemple de code concret dans un bloc ``` avec le bon langage.

## Variantes & alternatives
Présente 1-2 autres approches [3] avec leurs trade-offs (performance, lisibilité, idiomatique, maintenance).

## Pièges courants
Erreurs fréquentes signalées dans les sources [4][5], cas limites, incompatibilités.

## Références & docs
Pointeurs vers les passages les plus utiles — doc officielle d'abord, ressources communautaires ensuite.

SPÉCIFICITÉS CODE :
- TOUJOURS inclure au moins un bloc de code ``` dans la réponse
- Précise le langage après les backticks (```python, ```javascript, ```rust, etc.)
- Priorise les sources OFFICIELLES (MDN, docs.python.org, docs.rs, pkg.go.dev) sur les blogs
- Signale les versions/compatibilités quand pertinent
- Reste pragmatique : préfère le code idiomatique à l'élégance théorique

{_BASE_RULES}"""

TOPIC_PROMPTS = {
    "web": SYSTEM_PROMPT_WEB,
    "news": SYSTEM_PROMPT_NEWS,
    "academic": SYSTEM_PROMPT_ACADEMIC,
    "code": SYSTEM_PROMPT_CODE,
}

_TOPIC_LEADS = {
    "web": "Tu es HuntR (mode Web), un assistant de recherche web généraliste. Tu transformes des passages web bruts en une réponse reformulée, structurée et sourcée.",
    "news": "Tu es HuntR (mode Actualités). Tu synthétises des articles de presse récents en une réponse chronologique, factuelle et sourcée.",
    "academic": "Tu es HuntR (mode Académique). Tu synthétises des publications scientifiques et documents de recherche avec rigueur et neutralité.",
    "code": "Tu es HuntR (mode Code/Dev). Tu synthétises des ressources techniques (docs, GitHub, StackOverflow) pour répondre à une question de développement.",
}

# Backward-compat alias (imported by wolf_tools)
SYSTEM_PROMPT = SYSTEM_PROMPT_WEB


def _blocks_to_template(blocks: list) -> str:
    """Convert block-based format JSON into a concrete Markdown template.

    Le frontend serialise un editeur par blocs (H1/H2/H3/paragraphe/liste/tableau)
    en JSON dans user_settings.huntr_config.custom_format. On transforme cette
    structure en un squelette Markdown lisible ou chaque zone de contenu est
    balisee {{CONTENU: hint}} pour que le LLM comprenne qu'il doit la remplacer.
    """
    parts: list[str] = []
    for b in blocks:
        if not isinstance(b, dict):
            continue
        t = b.get("type")
        text = (b.get("text") or "").strip()
        if t == "h1":
            parts.append(f"# {text or '[Titre principal]'}")
        elif t == "h2":
            parts.append(f"## {text or '[Section]'}")
        elif t == "h3":
            parts.append(f"### {text or '[Sous-section]'}")
        elif t == "paragraph":
            hint = text or "paragraphe de 5-8 phrases sur le sujet, citations [n] dans le texte"
            parts.append(f"{{{{CONTENU: {hint}}}}}")
        elif t == "bullets":
            hint = text or "3-5 items, chaque item cite une source [n]"
            parts.append(f"{{{{LISTE À PUCES: {hint}}}}}")
        elif t == "numbered":
            hint = text or "3-5 items numerotes, chaque item cite une source [n]"
            parts.append(f"{{{{LISTE NUMÉROTÉE: {hint}}}}}")
        elif t == "table":
            cols = b.get("columns") or ["Colonne 1", "Colonne 2"]
            cols = [str(c).strip() or f"Col{i+1}" for i, c in enumerate(cols)]
            header = "| " + " | ".join(cols) + " |"
            sep = "|" + "|".join(["---"] * len(cols)) + "|"
            hint = text or "plusieurs lignes comparatives"
            placeholder_row = "| " + " | ".join([f"{{{{cellule}}}}" for _ in cols]) + " |"
            parts.append(
                f"{header}\n{sep}\n{placeholder_row}\n{placeholder_row}\n{placeholder_row}\n"
                f"{{{{TABLEAU: {hint} — remplace chaque cellule par le contenu pertinent, ajoute/enleve des lignes si necessaire}}}}"
            )
    return "\n\n".join(parts).strip()


def _resolve_format_to_template(raw: str) -> str:
    """Parse le custom_format stocke (JSON blocks ou Markdown brut legacy).

    - Si c'est un tableau JSON -> on le convertit en template Markdown balise.
    - Sinon on retourne la chaine telle quelle (retrocompat).
    """
    raw = (raw or "").strip()
    if not raw:
        return ""
    if raw.startswith("["):
        try:
            blocks = json.loads(raw)
            if isinstance(blocks, list) and blocks:
                return _blocks_to_template(blocks)
        except (json.JSONDecodeError, ValueError):
            pass
    return raw


def get_system_prompt(topic: str, custom_format: str | None = None) -> str:
    """Build the HuntR pro system prompt.

    Si `custom_format` est fourni (préférence utilisateur ou override ponctuel),
    il remplace le squelette imposé par défaut (# Titre / ## Aspect x3 /
    ## Conclusion). Les regles globales (citation inline, reformulation,
    utilisation de toutes les sources) sont toujours appliquees.
    """
    custom = (custom_format or "").strip()
    if not custom:
        return TOPIC_PROMPTS.get(topic, SYSTEM_PROMPT_WEB)

    lead = _TOPIC_LEADS.get(topic, _TOPIC_LEADS["web"])
    override_block = (
        "=== TEMPLATE DE REPONSE (WYSIWYG) — OBLIGATOIRE ET STRICT ===\n\n"
        "L'utilisateur a construit un MODELE DE REPONSE par blocs. Ton unique role "
        "est de REPRODUIRE ce modele a l'identique en remplissant les marqueurs de "
        "contenu. TU N'AS AUCUNE LIBERTE SUR LA STRUCTURE.\n\n"
        "MODELE A REPRODUIRE (squelette Markdown) :\n"
        "```\n"
        f"{custom}\n"
        "```\n\n"
        "INTERPRETATION DES MARQUEURS :\n"
        "- `{{CONTENU: <hint>}}`             -> remplace par un paragraphe en prose qui respecte le hint (langue + citations [n])\n"
        "- `{{LISTE À PUCES: <hint>}}`       -> remplace par une vraie liste Markdown a puces (`- item`) selon le hint\n"
        "- `{{LISTE NUMÉROTÉE: <hint>}}`     -> remplace par une liste numerotee (`1. item`, `2. item`...) selon le hint\n"
        "- `{{TABLEAU: <hint> ...}}`         -> remplis le tableau fourni juste au-dessus (meme nombre de colonnes), ajoute ou enleve des lignes selon le hint, remplace chaque `{{cellule}}` par la donnee synthetisee\n"
        "- Les lignes `# Titre`, `## Section`, `### Sous-section` sont les titres EXACTS que tu dois reproduire tels quels (sans les modifier)\n\n"
        "REGLES STRICTES :\n"
        "1. Suis le modele ligne par ligne, dans l'ORDRE. Ne reordonne rien.\n"
        "2. Ne SUPPRIME aucun bloc / titre / marqueur present dans le modele.\n"
        "3. N'AJOUTE aucun bloc / titre en dehors du modele.\n"
        "4. Remplace CHAQUE `{{...}}` par du contenu synthetise — laisser un marqueur non substitue est une erreur.\n"
        "5. Chaque phrase que tu produis doit citer au moins une source sous la forme exacte `[1]`, `[2]`, etc. (crochets droits + chiffre) pour que les vignettes cliquables s'affichent.\n"
        "6. Utilise au moins une fois chaque source disponible.\n"
        "7. Reformule entierement, ne copie jamais un passage source tel quel.\n"
    )
    return f"{lead}\n\n{override_block}\n\n{_BASE_RULES}"


TOPIC_LABELS = {
    "web": "Web",
    "news": "Actualités",
    "academic": "Académique",
    "code": "Code",
}


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
        "topic": row.topic or "web",
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
    topic: str = "web",
    answer: str = "", citations: list[dict] | None = None,
    related: list[str] | None = None, engines: list[str] | None = None,
    model: str = "",
) -> HuntRSearch:
    """Persist a search to DB (per-user)."""
    row = HuntRSearch(
        user_id=user_id,
        query=query,
        mode=mode,
        topic=topic,
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
    topic = req.safe_topic()

    # ── Resolve per-user resources BEFORE the stream ─────────────────
    tavily = await _resolve_tavily(uid, session)
    # Resolve the effective custom format: request override > user preference.
    # `resolved_format` can be JSON-encoded blocks (from the block editor) or
    # raw Markdown (legacy) — we normalize it to a Markdown template here so
    # the rest of the code + the LLM see a single consistent format.
    resolved_format_raw = (req.custom_format or "").strip()
    if not resolved_format_raw:
        us = await get_user_settings(uid, session)
        resolved_format_raw = ((us.huntr_config or {}).get("custom_format") or "").strip()
    resolved_format = _resolve_format_to_template(resolved_format_raw)
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
            llm_provider, llm_model = await _resolve_llm(
                uid, session,
                override_provider=req.provider,
                override_model=req.model,
            )
        except Exception as e:
            llm_error = str(e)

    # Cache check (Pro only — Classique reste 100% gratuit/frais)
    # News topic is NOT cached (fresh results matter more than speed)
    cache_key = None
    cached_payload = None
    if req.pro_search and topic != "news":
        cache_key = tavily_cache.make_key(uid, req.query, "pro", req.max_results, topic, resolved_format_raw)
        cached_payload = tavily_cache.get(cache_key)

    async def _stream():
        t0 = time.time()

        try:
            query = req.query.strip()

            # ══════════════════════════════════════════════════════════
            # CACHE HIT (Pro, non-news) — replay the cached answer as SSE
            # ══════════════════════════════════════════════════════════
            if cached_payload is not None:
                yield _sse("status", {"message": "Résultat mis en cache (récent)", "step": 4, "total_steps": 4, "topic": topic})
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
                    topic=topic,
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
                    "topic": topic,
                    "cached": True,
                })
                return

            if not req.pro_search:
                # ══════════════════════════════════════════════════════
                # MODE CLASSIQUE — DDG only, 100% gratuit, 0 API key
                # ══════════════════════════════════════════════════════
                topic_label = TOPIC_LABELS.get(topic, "Web")
                yield _sse("status", {"message": f"Recherche {topic_label} (DuckDuckGo)...", "step": 1, "topic": topic})

                ddg = DDGProvider()
                results = await ddg.search(query, max_results=req.max_results, topic=topic)
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
                                       topic=topic,
                                       answer=answer, citations=citations,
                                       related=related, engines=engines)

                yield _sse("done", {
                    "time_ms": _elapsed(t0),
                    "search_count": len(results),
                    "pro_search": False,
                    "engines": engines,
                    "topic": topic,
                })
                return

            # ══════════════════════════════════════════════════════════
            # MODE PRO — Tavily + LLM (4 steps)
            # ══════════════════════════════════════════════════════════
            topic_label = TOPIC_LABELS.get(topic, "Web")

            # Step 1: Tavily search
            yield _sse("status", {
                "message": f"Recherche {topic_label} (Tavily)...",
                "step": 1, "total_steps": 4, "topic": topic,
            })
            results = await tavily.search(query, max_results=req.max_results, topic=topic)

            if not results:
                yield _sse("status", {"message": "Fallback DuckDuckGo...", "step": 1, "total_steps": 4})
                ddg = DDGProvider()
                results = await ddg.search(query, max_results=req.max_results, topic=topic)

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
                    "pro_search": True, "engines": engines, "topic": topic, "error": True,
                })
                return

            # Step 4: LLM synthesis (streamed)
            yield _sse("status", {
                "message": f"Synthèse {topic_label} par l'IA en cours...",
                "step": 4, "total_steps": 4, "topic": topic,
            })

            context = _build_llm_context(results)
            if resolved_format:
                user_content = (
                    f"QUESTION : {query}\n\n"
                    f"PASSAGES WEB (numérotés [1] à [{min(len(results), 10)}]) :\n\n"
                    f"{context}\n\n"
                    f"---\n"
                    f"REPRODUIS EXACTEMENT le template defini dans le system prompt.\n"
                    f"- Recopie les lignes `#`, `##`, `###` telles quelles (titres figés)\n"
                    f"- Substitue chaque marqueur `{{{{CONTENU: ...}}}}`, `{{{{LISTE À PUCES: ...}}}}`, "
                    f"`{{{{LISTE NUMÉROTÉE: ...}}}}`, `{{{{TABLEAU: ...}}}}` et chaque `{{{{cellule}}}}` "
                    f"par du contenu synthetise — aucun marqueur ne doit rester dans la reponse finale\n"
                    f"- Cite chaque affirmation avec `[1]`, `[2]`, … (format EXACT) pour que les "
                    f"vignettes cliquables s'affichent correctement\n"
                    f"- Utilise au moins une fois chaque source ({min(len(results), 10)} au total)\n"
                    f"- Reformule, ne copie jamais un passage tel quel"
                )
            else:
                user_content = (
                    f"QUESTION : {query}\n\n"
                    f"PASSAGES WEB (numérotés [1] à [{min(len(results), 10)}]) :\n\n"
                    f"{context}\n\n"
                    f"---\n"
                    f"Rédige une réponse LONGUE et DÉTAILLÉE (minimum 400 mots).\n\n"
                    f"FORMAT OBLIGATOIRE — suis ce squelette exact :\n"
                    f"  1. Un `# Titre principal` (en une phrase)\n"
                    f"  2. `## Aspect 1` + paragraphe de 5-8 phrases\n"
                    f"  3. `## Aspect 2` + paragraphe de 5-8 phrases\n"
                    f"  4. `## Aspect 3` + paragraphe de 5-8 phrases\n"
                    f"  5. `## Conclusion` + paragraphe de 3-5 phrases\n\n"
                    f"AUCUNE liste à puces. AUCUNE liste numérotée. Uniquement de la prose.\n"
                    f"REFORMULE, ne copie pas. Cite [1], [2] etc. DANS chaque phrase.\n"
                    f"Exploite TOUS les passages — chaque source citée au moins une fois."
                )
            system_prompt = get_system_prompt(topic, resolved_format)
            messages = [
                ChatMessage(role="system", content=system_prompt),
                ChatMessage(role="user", content=user_content),
            ]
            logger.info(
                f"[HuntR] Pro synth: topic={topic} "
                f"custom_format={'YES (' + str(len(resolved_format)) + ' chars)' if resolved_format else 'NO (default skeleton)'} "
                f"system_prompt_len={len(system_prompt)}"
            )

            llm_ok = False
            answer = ""
            try:
                logger.info(f"[HuntR] Streaming LLM: provider={type(llm_provider).__name__}, model={llm_model}")
                # temperature=0.3 pour minimiser la variance entre modèles et forcer
                # le respect de la structure imposée par le system prompt — chaque
                # utilisateur obtient le même format indépendamment du LLM choisi.
                async for token in llm_provider.chat_stream(
                    messages, llm_model, max_tokens=4096, temperature=0.3
                ):
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
                                   topic=topic,
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
                "topic": topic,
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


# ═══════════════════════════════════════════════════════════════════════════
# User preferences — custom response format (per-user, persistent)
# ═══════════════════════════════════════════════════════════════════════════

class HuntRPreferences(BaseModel):
    custom_format: Optional[str] = None  # None ou "" = reset au format par defaut


_MAX_CUSTOM_FORMAT_LEN = 4000


@router.get("/preferences")
async def get_preferences(request: Request, session: AsyncSession = Depends(get_session)):
    uid = _uid(request)
    us = await get_user_settings(uid, session)
    cfg = us.huntr_config or {}
    return {
        "custom_format": cfg.get("custom_format", "") or "",
    }


@router.put("/preferences")
async def put_preferences(prefs: HuntRPreferences, request: Request,
                          session: AsyncSession = Depends(get_session)):
    uid = _uid(request)
    us = await get_user_settings(uid, session)
    cfg = dict(us.huntr_config or {})
    fmt = (prefs.custom_format or "").strip()
    if len(fmt) > _MAX_CUSTOM_FORMAT_LEN:
        raise HTTPException(status_code=400, detail=f"custom_format trop long (max {_MAX_CUSTOM_FORMAT_LEN} caractères)")
    if fmt:
        cfg["custom_format"] = fmt
    else:
        cfg.pop("custom_format", None)
    us.huntr_config = cfg
    # JSON Column mutation → flag the attribute so SQLAlchemy persists the change.
    from sqlalchemy.orm.attributes import flag_modified
    flag_modified(us, "huntr_config")
    await session.commit()
    # Invalidate user's cached Pro answers since the structure likely changed.
    tavily_cache.invalidate_user(uid)
    return {"ok": True, "custom_format": cfg.get("custom_format", "") or ""}


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
