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
import re
import time
import logging

from backend.core.config.settings import Settings
from backend.core.providers import get_provider, ChatMessage
from backend.core.db.engine import get_session
from backend.core.db.models import HuntRSearch
from backend.core.api.auth_helpers import (
    get_user_settings, get_user_provider_key, get_user_service_key,
    open_mode_fallback_user_id,
)

from .search_providers import (
    DDGProvider, TavilyProvider, BraveProvider, ExaProvider,
    SerperProvider, SerpAPIProvider, KagiProvider, BingProvider,
    SearXNGProvider, SearchResult, VALID_TOPICS,
    FREE_PROVIDERS, PROVIDER_WEIGHTS, multi_search,
)
from .source_filters import apply_source_filters, STARTER_BLOCKLIST, has_active_filters as _has_active_filters
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

async def _uid(request: Request, session: AsyncSession) -> int:
    """Return the caller's user_id. In open mode we only fall back to user #1
    if it's the SOLE user in the DB — otherwise we refuse to resolve (returns
    0) to prevent cross-user leakage of API keys/services."""
    uid = getattr(request.state, "user_id", None)
    if uid:
        return uid
    fallback = await open_mode_fallback_user_id(session)
    return fallback or 0


async def _resolve_tavily(user_id: int, session: AsyncSession) -> TavilyProvider | None:
    """Legacy single-provider resolver (kept for cache-key back-compat)."""
    us = await get_user_settings(user_id, session)
    svc = get_user_service_key(us, "tavily")
    if not svc or not svc.get("api_key"):
        return None
    return TavilyProvider(api_key=svc["api_key"])


# Registre des providers HuntR : chaque entrée décrit comment instancier le
# provider à partir de la config service user, et si le provider est
# utilisable en mode Classique (FREE_PROVIDERS).
HUNTR_PROVIDER_SPECS: dict[str, dict] = {
    "duckduckgo": {
        "label": "DuckDuckGo",
        "needs_key": False,
        "factory": lambda svc: DDGProvider(),
    },
    "tavily": {
        "label": "Tavily",
        "needs_key": True,
        "factory": lambda svc: TavilyProvider(api_key=svc["api_key"]),
    },
    "brave": {
        "label": "Brave Search",
        "needs_key": True,
        "factory": lambda svc: BraveProvider(api_key=svc["api_key"]),
    },
    "exa": {
        "label": "Exa",
        "needs_key": True,
        "factory": lambda svc: ExaProvider(api_key=svc["api_key"]),
    },
    "serper": {
        "label": "Serper.dev",
        "needs_key": True,
        "factory": lambda svc: SerperProvider(api_key=svc["api_key"]),
    },
    "serpapi": {
        "label": "SerpAPI",
        "needs_key": True,
        "factory": lambda svc: SerpAPIProvider(api_key=svc["api_key"]),
    },
    "kagi": {
        "label": "Kagi",
        "needs_key": True,
        "factory": lambda svc: KagiProvider(api_key=svc["api_key"]),
    },
    "bing": {
        "label": "Bing Web Search",
        "needs_key": True,
        "factory": lambda svc: BingProvider(api_key=svc["api_key"]),
    },
    "searxng": {
        "label": "SearXNG (self-hosted)",
        "needs_key": False,  # clé optionnelle, URL obligatoire
        "factory": lambda svc: SearXNGProvider(
            base_url=svc.get("base_url", ""),
            api_key=svc.get("api_key", ""),
        ),
    },
}


def _provider_has_requirements(name: str, svc: dict | None) -> bool:
    """Vrai si les prérequis (clé ou URL) sont présents pour ce provider."""
    if name == "duckduckgo":
        return True
    if name == "searxng":
        return bool((svc or {}).get("base_url"))
    return bool((svc or {}).get("api_key"))


def _default_enabled(name: str, us) -> bool:
    """Valeur par défaut du toggle quand l'user n'a rien explicitement configuré.

    - DDG : toujours activé (pas de clé requise, pas de fuite possible).
    - Autres providers : activés SEULEMENT si l'user a déjà fourni sa propre
      clé/URL. Évite d'afficher Tavily/Brave/... comme "enabled" sans clé
      (trompeur), et migre automatiquement les users existants qui avaient
      configuré Tavily avant le multi-provider.

    IMPORTANT : chaque clé lue ici vient strictement de `us` (user_settings
    de l'user courant). Aucun fallback vers une clé admin/globale, aucune
    lecture d'env var : chaque utilisateur doit fournir la sienne.
    """
    if name == "duckduckgo":
        return True
    svc = get_user_service_key(us, name)
    return _provider_has_requirements(name, svc)


async def _resolve_huntr_providers(
    user_id: int,
    session: AsyncSession,
    pro: bool,
) -> list[tuple[str, object]]:
    """Retourne la liste des (nom, instance) de providers à utiliser.

    - En Classique : uniquement les providers "gratuits" (DDG + SearXNG
      configuré), parmi ceux activés par l'utilisateur (défaut : DDG seul).
    - En Pro : tous les providers pour lesquels l'utilisateur a une clé ET
      qui sont activés dans `huntr_config.providers`.

    Si aucun provider n'est résolvable (ex: aucune clé en Pro), on retombe
    sur DDG pour garantir qu'il y a toujours un résultat.
    """
    us = await get_user_settings(user_id, session)
    cfg = (us.huntr_config or {})
    user_flags: dict = (cfg.get("providers") or {})

    def _is_enabled(name: str) -> bool:
        entry = user_flags.get(name)
        if isinstance(entry, dict):
            return bool(entry.get("enabled", True))  # présent = intentionnel
        # Défaut : DDG toujours on, autres providers on uniquement si l'user a
        # déjà fourni sa propre clé (pas de faux positif UI).
        return _default_enabled(name, us)

    out: list[tuple[str, object]] = []
    for name, spec in HUNTR_PROVIDER_SPECS.items():
        if not _is_enabled(name):
            continue
        if not pro and name not in FREE_PROVIDERS:
            continue
        svc = get_user_service_key(us, name) if spec["needs_key"] or name == "searxng" else None
        if not _provider_has_requirements(name, svc):
            continue
        try:
            out.append((name, spec["factory"](svc or {})))
        except Exception as e:
            logger.warning(f"[HuntR] provider '{name}' instantiation failed: {e}")

    if not out:
        logger.info(f"[HuntR] No provider resolved for user {user_id} pro={pro} → fallback DDG")
        out.append(("duckduckgo", DDGProvider()))
    return out


async def _providers_status(user_id: int, session: AsyncSession) -> list[dict]:
    """État par provider pour l'UI : label, has_key, enabled, supports_classic."""
    us = await get_user_settings(user_id, session)
    cfg = (us.huntr_config or {})
    user_flags: dict = (cfg.get("providers") or {})
    rows = []
    for name, spec in HUNTR_PROVIDER_SPECS.items():
        svc = get_user_service_key(us, name)
        has_req = _provider_has_requirements(name, svc)
        entry = user_flags.get(name)
        if isinstance(entry, dict) and "enabled" in entry:
            enabled = bool(entry["enabled"])
        else:
            enabled = _default_enabled(name, us)
        rows.append({
            "id": name,
            "label": spec["label"],
            "needs_key": spec["needs_key"] or name == "searxng",
            "has_requirements": has_req,
            "enabled": enabled,
            "supports_classic": name in FREE_PROVIDERS,
            "weight": PROVIDER_WEIGHTS.get(name, 1.0),
        })
    return rows


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


def _md_to_marker_template(md: str) -> str:
    """Convert raw Markdown (from the WYSIWYG editor) into a marker template.

    Le LLM suit mieux une structure explicite {{...}} qu'un Markdown avec des
    hints en texte libre (certains modeles recopient les hints au lieu de les
    substituer). On transforme donc chaque bloc en marqueur cible :
    - Lignes `#`, `##`, `###` : gardees telles quelles (TITRES FIGES).
      Le marqueur `{{TITRE}}` a l'interieur est conserve -> le LLM le
      remplace par un titre d'une seule phrase reformulant la question.
    - Paragraphes : deviennent `{{CONTENU: <texte original comme hint>}}`.
    - Listes a puces : `{{LISTE À PUCES: <items joints par " / ">}}`.
    - Listes numerotees : `{{LISTE NUMÉROTÉE: <items>}}`.
    - Tableaux : conserve l'en-tete + separateur, chaque ligne de donnees
      devient une ligne de `{{cellule}}`, suivie de `{{TABLEAU: ...}}`.
    - Code fences, blockquotes, hr : gardes verbatim.
    """
    md = (md or "").replace("\r\n", "\n")
    if not md.strip():
        return ""

    lines = md.split("\n")
    out: list[str] = []
    paragraph: list[str] = []
    bullets: list[str] = []
    numbered = False

    marker_only_re = re.compile(r"^\{\{[A-ZÉÀÂÊÈËÎÏÔÙÛÜÇ ]+(?::[^}]*)?\}\}$")

    def flush_para() -> None:
        nonlocal paragraph
        if not paragraph:
            return
        hint = " ".join(x.strip() for x in paragraph if x.strip()).strip()
        if hint:
            if marker_only_re.match(hint):
                out.append(hint)
            else:
                out.append(f"{{{{CONTENU: {hint}}}}}")
        paragraph = []

    def flush_bullets() -> None:
        nonlocal bullets, numbered
        if not bullets:
            return
        tag = "LISTE NUMÉROTÉE" if numbered else "LISTE À PUCES"
        hint = " / ".join(x.strip() for x in bullets if x.strip())
        out.append(f"{{{{{tag}: {hint}}}}}")
        bullets = []
        numbered = False

    i = 0
    n = len(lines)
    while i < n:
        raw_line = lines[i]
        line = raw_line.strip()

        # Code fence
        if line.startswith("```"):
            flush_para(); flush_bullets()
            code = [raw_line]
            i += 1
            while i < n and not lines[i].strip().startswith("```"):
                code.append(lines[i])
                i += 1
            if i < n:
                code.append(lines[i])
                i += 1
            out.append("\n".join(code))
            continue

        # Heading (kept verbatim — {{TITRE}} passes through)
        if re.match(r"^#{1,3}\s+\S", line):
            flush_para(); flush_bullets()
            out.append(line)
            i += 1
            continue

        # Horizontal rule
        if re.fullmatch(r"[-_*]{3,}", line):
            flush_para(); flush_bullets()
            out.append("---")
            i += 1
            continue

        # Blockquote
        if line.startswith(">"):
            flush_para(); flush_bullets()
            quote = []
            while i < n and lines[i].strip().startswith(">"):
                quote.append(lines[i].rstrip())
                i += 1
            out.append("\n".join(quote))
            continue

        # Table
        if line.startswith("|") and line.endswith("|"):
            flush_para(); flush_bullets()
            tbl = []
            while i < n and lines[i].strip().startswith("|") and lines[i].strip().endswith("|"):
                tbl.append(lines[i].rstrip())
                i += 1
            if len(tbl) >= 2:
                header = tbl[0]
                sep = tbl[1]
                cols = [c.strip() for c in header.strip().strip("|").split("|")]
                ncols = max(1, len(cols))
                placeholder = "| " + " | ".join(["{{cellule}}"] * ncols) + " |"
                data_rows = tbl[2:]
                row_count = max(3, len(data_rows)) if data_rows else 3
                body = "\n".join([placeholder] * row_count)
                out.append(f"{header}\n{sep}\n{body}")
                out.append("{{TABLEAU: remplace chaque cellule par la donnee synthetisee, ajoute ou enleve des lignes selon les sources}}")
            else:
                out.extend(tbl)
            continue

        # Bullet list item
        mb = re.match(r"^[-*]\s+(.*)$", line)
        if mb:
            flush_para()
            if numbered and bullets:
                flush_bullets()
            numbered = False
            bullets.append(mb.group(1))
            i += 1
            continue

        # Numbered list item
        mn = re.match(r"^\d+\.\s+(.*)$", line)
        if mn:
            flush_para()
            if not numbered and bullets:
                flush_bullets()
            numbered = True
            bullets.append(mn.group(1))
            i += 1
            continue

        # Blank line separates blocks
        if not line:
            flush_para(); flush_bullets()
            i += 1
            continue

        paragraph.append(line)
        i += 1

    flush_para(); flush_bullets()
    return "\n\n".join(out).strip()


def _resolve_format_to_template(raw: str) -> str:
    """Parse le custom_format stocke (JSON blocks, Markdown WYSIWYG, ou legacy).

    - Tableau JSON (ancien block editor) -> _blocks_to_template
    - Sinon (Markdown brut du WYSIWYG) -> _md_to_marker_template
    Dans tous les cas on retourne un template a MARQUEURS, chemin unique.
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
    return _md_to_marker_template(raw)


_MARKER_RE = re.compile(r"\{\{[^{}\n]{1,200}\}\}")


def _validate_template_compliance(answer: str, template: str) -> tuple[bool, list[str]]:
    """Vérifie que la sortie LLM respecte le template marker.

    Le revert `d1cae46` a été motivé par "le LLM ne respectait pas fiablement
    le template" — en pratique, 90% des ratés observés tombent dans :
    1. Le LLM recopie les marqueurs `{{CONTENU: …}}` verbatim au lieu de les
       substituer par du contenu.
    2. Le LLM saute des sections (moins de `##` que prévu).

    Retourne (ok, issues). Non-destructif : c'est l'appelant qui décide s'il
    relance ou pas.
    """
    issues: list[str] = []
    if not (template or "").strip():
        return True, issues

    # 1. Aucun marqueur ne doit rester dans la réponse finale.
    leftover = _MARKER_RE.findall(answer or "")
    # On tolère {{TITRE}} vide car certains modèles le laissent comme "titre à
    # définir" — le garde-fou principal, c'est les {{CONTENU:}} / {{LISTE ...}}.
    hard_leftover = [m for m in leftover if not m.strip("{}").strip().upper().startswith("TITRE")]
    if hard_leftover:
        uniq = sorted(set(hard_leftover))[:5]
        issues.append(f"marqueurs non-substitués ({len(hard_leftover)} total) : {uniq}")

    # 2. Structure de titres : on compare le nombre de `#`, `##`, `###`
    # (hors lignes dans des fences ``` — les tableaux n'en ont pas normalement).
    def _count_headings(text: str) -> tuple[int, int, int]:
        h1 = h2 = h3 = 0
        in_fence = False
        for line in (text or "").splitlines():
            stripped = line.strip()
            if stripped.startswith("```"):
                in_fence = not in_fence
                continue
            if in_fence:
                continue
            if stripped.startswith("### "):
                h3 += 1
            elif stripped.startswith("## "):
                h2 += 1
            elif stripped.startswith("# "):
                h1 += 1
        return h1, h2, h3

    t_h1, t_h2, t_h3 = _count_headings(template)
    a_h1, a_h2, a_h3 = _count_headings(answer or "")

    # On tolère ±1 sur H2/H3 pour laisser au LLM une marge de style, mais un
    # écart net = violation.
    if t_h1 >= 1 and a_h1 == 0:
        issues.append("titre H1 manquant")
    if t_h2 > 0 and a_h2 < max(1, t_h2 - 1):
        issues.append(f"structure H2 dégradée (template {t_h2}, réponse {a_h2})")
    if t_h3 > 0 and a_h3 < max(1, t_h3 - 1):
        issues.append(f"structure H3 dégradée (template {t_h3}, réponse {a_h3})")

    return len(issues) == 0, issues


def _build_corrective_prompt(template: str, broken_answer: str, issues: list[str]) -> str:
    """Prompt de relance quand le LLM a produit une réponse non conforme.

    On montre au LLM le template exact + sa réponse actuelle + la liste des
    violations. Objectif : qu'il réécrive SANS re-poser les sources (il les
    citait déjà dans broken_answer), juste réparer la structure.
    """
    issues_block = "\n".join(f"- {i}" for i in issues) or "- structure globale non respectée"
    return (
        "La réponse ci-dessous ne respecte pas le template imposé. Réécris-la "
        "EN CONSERVANT le contenu, les citations `[1]`/`[2]`/... et les faits, "
        "mais en réparant la structure.\n\n"
        f"## Problèmes détectés\n{issues_block}\n\n"
        f"## Template à respecter\n{template}\n\n"
        f"## Réponse actuelle (à corriger)\n{broken_answer}\n\n"
        "Règles impératives :\n"
        "- AUCUN marqueur `{{...}}` ne doit rester dans la réponse finale (ils "
        "sont des hints pour toi, pas du contenu).\n"
        "- Conserve chaque citation [n] à l'endroit où elle était, ne les renumérote pas.\n"
        "- Garde la hiérarchie exacte de `#`/`##`/`###` du template.\n"
        "- Ne rajoute pas de préambule méta (« voici la version corrigée » etc.) : "
        "commence directement par le titre."
    )


def get_system_prompt(topic: str, custom_format: str | None = None) -> str:
    """Build the HuntR pro system prompt.

    Si `custom_format` est fourni (préférence utilisateur ou override ponctuel),
    il remplace le squelette imposé par défaut. Les regles globales (citation
    inline, reformulation, utilisation de toutes les sources) restent appliquees.

    Le template recu ici est TOUJOURS au format marker (normalise par
    _resolve_format_to_template en amont : JSON blocks et Markdown WYSIWYG
    convergent tous les deux vers la meme forme a marqueurs `{{...}}`).
    """
    custom = (custom_format or "").strip()
    if not custom:
        return TOPIC_PROMPTS.get(topic, SYSTEM_PROMPT_WEB)

    lead = _TOPIC_LEADS.get(topic, _TOPIC_LEADS["web"])
    override_block = (
        "=== TEMPLATE DE REPONSE — OBLIGATOIRE ET STRICT ===\n\n"
        "L'utilisateur a defini un MODELE DE REPONSE. Ton unique role est de "
        "REPRODUIRE ce modele a l'identique en remplissant chaque marqueur par "
        "du contenu synthetise a partir des passages. TU N'AS AUCUNE LIBERTE "
        "SUR LA STRUCTURE.\n\n"
        "MODELE A REPRODUIRE (squelette Markdown) :\n"
        "```\n"
        f"{custom}\n"
        "```\n\n"
        "INTERPRETATION DES MARQUEURS :\n"
        "- `{{TITRE}}`                       -> remplace par UN titre d'une seule phrase qui reformule la question de l'utilisateur en affirmation claire (sans les crochets, sans balise)\n"
        "- `{{CONTENU: <hint>}}`             -> remplace par un paragraphe en prose qui respecte le hint (sujet, longueur indicative, citations [n] DANS les phrases)\n"
        "- `{{LISTE À PUCES: <hint>}}`       -> remplace par une vraie liste Markdown a puces (`- item`) — chaque item est synthetise, pas recopie du hint\n"
        "- `{{LISTE NUMÉROTÉE: <hint>}}`     -> remplace par une liste numerotee (`1. item`, `2. item`...) selon le hint\n"
        "- `{{TABLEAU: <hint>}}`             -> remplis le tableau fourni juste au-dessus (meme nombre de colonnes), remplace chaque `{{cellule}}` par la donnee synthetisee, ajoute ou enleve des lignes si necessaire\n"
        "- `{{cellule}}`                     -> donnee synthetisee (un mot, un chiffre, une courte phrase selon la colonne)\n"
        "- Les lignes `# Titre`, `## Section`, `### Sous-section` SANS marqueur dedans sont des titres FIGES : recopie-les EXACTEMENT (meme texte, meme ordre, meme niveau)\n\n"
        "REGLES STRICTES :\n"
        "1. Suis le modele ligne par ligne, dans l'ORDRE. Ne reordonne rien.\n"
        "2. Ne SUPPRIME aucun bloc / titre / marqueur present dans le modele.\n"
        "3. N'AJOUTE aucun bloc / titre / section en dehors du modele.\n"
        "4. Remplace CHAQUE `{{...}}` par du contenu synthetise — aucun marqueur ne doit subsister dans la reponse finale.\n"
        "5. Le TEXTE des hints (ce qui est apres `:` dans un marqueur) ne doit PAS apparaitre tel quel dans ta reponse — c'est une instruction pour toi, pas du contenu a copier.\n"
        "6. Chaque affirmation doit citer au moins une source sous la forme EXACTE `[1]`, `[2]`, etc. (crochets droits + chiffre, pas de variante) DANS la phrase — ces citations deviennent des vignettes cliquables cote UI.\n"
        "7. Utilise AU MOINS UNE FOIS chaque source fournie.\n"
        "8. Reformule entierement les passages — ne copie JAMAIS un passage source tel quel.\n"
        "9. Reponds dans la MEME LANGUE que la question de l'utilisateur.\n"
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
    uid = await _uid(request, session)
    if not uid:
        return JSONResponse({"error": "Authentification requise."}, status_code=401)
    topic = req.safe_topic()

    # ── Resolve per-user resources BEFORE the stream ─────────────────
    providers_list = await _resolve_huntr_providers(uid, session, pro=req.pro_search)
    provider_names = [name for name, _ in providers_list]
    # Source reliability filters : blocklist starter (opt-in) + user block/
    # allowlist. Appliqué après multi_search, avant la synthèse LLM et le cache.
    _us_for_filters = await get_user_settings(uid, session)
    source_filter_cfg = ((_us_for_filters.huntr_config or {}).get("source_filters") or {})

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
        # Pro autorisé même sans clé spécifique : le fallback DDG garantit
        # qu'on a toujours au moins un provider. Ce qui nous manque vraiment
        # c'est un LLM configuré pour la synthèse.
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
        cache_key = tavily_cache.make_key(
            uid, req.query, "pro", req.max_results, topic,
            resolved_format_raw, providers=provider_names,
            source_filters=source_filter_cfg,
        )
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
                # MODE CLASSIQUE — providers gratuits, 0 LLM
                # ══════════════════════════════════════════════════════
                topic_label = TOPIC_LABELS.get(topic, "Web")
                sources_label = ", ".join(n.capitalize() for n in provider_names) or "DDG"
                yield _sse("status", {
                    "message": f"Recherche {topic_label} ({sources_label})...",
                    "step": 1, "topic": topic,
                })

                results = await multi_search(providers_list, query, req.max_results, topic)
                results, filter_report = apply_source_filters(results, source_filter_cfg)
                # Émet le rapport dès que des filtres sont activés, pas
                # seulement quand quelque chose a été bloqué — l'user doit
                # voir que son mode boost/strict a été pris en compte même
                # avec 0 blocage, sinon le feature paraît "inactif".
                if _has_active_filters(source_filter_cfg):
                    yield _sse("status", {
                        "message": (f"{filter_report['blocked_count']} source(s) filtrée(s)"
                                    if filter_report.get("blocked_count", 0) > 0
                                    else "Filtres appliqués"),
                        "step": 1, "topic": topic,
                        "filter_report": filter_report,
                    })
                # `engines` = union des providers qui ont contribué au moins un
                # résultat (pas juste ceux appelés).
                engines = sorted({p for r in results for p in (r.providers or [r.source])}) or provider_names

                yield _sse("search", {
                    "count": len(results),
                    "engines": engines,
                    "results": [
                        {"title": r.title, "url": r.url, "snippet": r.snippet,
                         "source": r.source, "providers": r.providers or [r.source]}
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
            # MODE PRO — multi-providers (parallèle + dédup) + LLM
            # ══════════════════════════════════════════════════════════
            topic_label = TOPIC_LABELS.get(topic, "Web")
            sources_label = ", ".join(n.capitalize() for n in provider_names) or "DDG"

            # Step 1: lancement parallèle de tous les providers activés
            yield _sse("status", {
                "message": f"Recherche {topic_label} ({sources_label})...",
                "step": 1, "total_steps": 4, "topic": topic,
            })
            results = await multi_search(providers_list, query, req.max_results, topic)
            results, filter_report = apply_source_filters(results, source_filter_cfg)
            if _has_active_filters(source_filter_cfg):
                yield _sse("status", {
                    "message": (f"{filter_report['blocked_count']} source(s) filtrée(s)"
                                if filter_report.get("blocked_count", 0) > 0
                                else "Filtres appliqués"),
                    "step": 1, "total_steps": 4, "topic": topic,
                    "filter_report": filter_report,
                })

            engines = sorted({p for r in results for p in (r.providers or [r.source])}) \
                      or provider_names

            live_results = [
                {"title": r.title, "url": r.url, "snippet": r.snippet,
                 "source": r.source, "providers": r.providers or [r.source]}
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
                n = min(len(results), 10)
                user_content = (
                    f"QUESTION DE L'UTILISATEUR : {query}\n\n"
                    f"PASSAGES WEB (numérotés [1] à [{n}]) :\n\n"
                    f"{context}\n\n"
                    f"---\n"
                    f"REPRODUIS EXACTEMENT le template defini dans le system prompt.\n"
                    f"- Recopie chaque `#`, `##`, `###` (hors marqueurs) mot pour mot\n"
                    f"- Remplace `{{{{TITRE}}}}` par un titre d'UNE SEULE PHRASE reformulant la question ci-dessus en affirmation\n"
                    f"- Substitue chaque `{{{{CONTENU: ...}}}}`, `{{{{LISTE À PUCES: ...}}}}`, "
                    f"`{{{{LISTE NUMÉROTÉE: ...}}}}`, `{{{{TABLEAU: ...}}}}` et `{{{{cellule}}}}` "
                    f"par du contenu synthetise — AUCUN marqueur ne doit rester dans la reponse finale\n"
                    f"- Les hints (texte apres `:` dans un marqueur) sont des INSTRUCTIONS pour toi, PAS du contenu a copier\n"
                    f"- Cite chaque affirmation avec `[1]`, `[2]`, … (format EXACT, crochets droits + chiffre)\n"
                    f"- Utilise au moins une fois chaque source ({n} au total)\n"
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
                f"raw_len={len(resolved_format_raw)} normalized_len={len(resolved_format)} "
                f"system_prompt_len={len(system_prompt)}"
            )
            if resolved_format:
                preview = resolved_format[:320].replace("\n", " ⏎ ")
                logger.info(f"[HuntR] Normalized template: {preview}{'…' if len(resolved_format) > 320 else ''}")

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

            # ── Post-process : si template personnalisé, vérifier qu'il est
            # respecté. Sinon relancer UN appel correctif (non-streamé cette
            # fois pour éviter d'abuser du temps user). Corrige le failure
            # mode qui avait motivé le revert d1cae46.
            if llm_ok and resolved_format:
                ok, issues = _validate_template_compliance(answer, resolved_format)
                if not ok:
                    logger.warning(f"[HuntR] Template non respecté : {issues}")
                    yield _sse("status", {"message": "Structure à corriger — relance…"})
                    try:
                        corrective = _build_corrective_prompt(resolved_format, answer, issues)
                        fixed = ""
                        async for token in llm_provider.chat_stream(
                            [
                                ChatMessage(role="system", content=system_prompt),
                                ChatMessage(role="user", content=corrective),
                            ],
                            llm_model, max_tokens=4096, temperature=0.1,
                        ):
                            fixed += token
                        ok2, issues2 = _validate_template_compliance(fixed, resolved_format)
                        if fixed.strip() and ok2:
                            logger.info(f"[HuntR] Correction réussie ({len(fixed)} chars)")
                            answer = fixed
                        else:
                            logger.warning(
                                f"[HuntR] Correction insuffisante (issues={issues2}) — "
                                "on garde la réponse initiale"
                            )
                    except Exception as e:
                        logger.warning(f"[HuntR] Corrective retry failed: {e}")

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
    # Toggle par provider — envoyé par la page Settings HuntR. Clés = ids
    # de providers ("brave", "exa", ...) ; valeur = {enabled: bool}. Un provider
    # absent reste sur le défaut (DDG/Tavily activés).
    providers: Optional[dict] = None
    # Filtres de fiabilité des sources (blocklist starter + user + allowlist).
    # Structure : {use_starter_blocklist: bool, blocklist: list[str],
    #              allowlist: list[str], allowlist_mode: 'off'|'boost'|'strict'}
    source_filters: Optional[dict] = None


_MAX_CUSTOM_FORMAT_LEN = 4000


@router.get("/preferences")
async def get_preferences(request: Request, session: AsyncSession = Depends(get_session)):
    uid = await _uid(request, session)
    if not uid:
        return JSONResponse({"error": "Authentification requise."}, status_code=401)
    us = await get_user_settings(uid, session)
    cfg = us.huntr_config or {}
    return {
        "custom_format": cfg.get("custom_format", "") or "",
        "providers": cfg.get("providers") or {},
        "source_filters": cfg.get("source_filters") or {
            "use_starter_blocklist": False,
            "blocklist": [],
            "allowlist": [],
            "allowlist_mode": "off",
        },
    }


@router.put("/preferences")
async def put_preferences(prefs: HuntRPreferences, request: Request,
                          session: AsyncSession = Depends(get_session)):
    uid = await _uid(request, session)
    if not uid:
        return JSONResponse({"error": "Authentification requise."}, status_code=401)
    us = await get_user_settings(uid, session)
    cfg = dict(us.huntr_config or {})

    # custom_format (inchangé)
    if prefs.custom_format is not None:
        fmt = (prefs.custom_format or "").strip()
        if len(fmt) > _MAX_CUSTOM_FORMAT_LEN:
            raise HTTPException(status_code=400, detail=f"custom_format trop long (max {_MAX_CUSTOM_FORMAT_LEN} caractères)")
        if fmt:
            cfg["custom_format"] = fmt
        else:
            cfg.pop("custom_format", None)

    # Providers toggles : on n'accepte que les noms connus, uniquement la clé
    # 'enabled' (pas d'injection de champs arbitraires).
    if prefs.providers is not None:
        if not isinstance(prefs.providers, dict):
            raise HTTPException(status_code=400, detail="providers doit être un objet")
        cleaned: dict = {}
        for name, entry in prefs.providers.items():
            if name not in HUNTR_PROVIDER_SPECS:
                continue
            if isinstance(entry, dict):
                cleaned[name] = {"enabled": bool(entry.get("enabled", True))}
            elif isinstance(entry, bool):
                cleaned[name] = {"enabled": entry}
        cfg["providers"] = cleaned

    # Source filters : sanitize pour éviter d'accepter des champs arbitraires
    # ou des types inattendus (une liste qui arrive en string par erreur).
    if prefs.source_filters is not None:
        if not isinstance(prefs.source_filters, dict):
            raise HTTPException(status_code=400, detail="source_filters doit être un objet")
        sf_raw = prefs.source_filters
        mode = str(sf_raw.get("allowlist_mode") or "off").lower()
        if mode not in ("off", "boost", "strict"):
            mode = "off"
        def _clean_domain_list(val) -> list[str]:
            if not isinstance(val, list):
                return []
            out = []
            for item in val:
                if isinstance(item, str):
                    d = item.strip().lower().lstrip(".")
                    if d and len(d) <= 253 and "/" not in d:
                        out.append(d)
            # Dédup en gardant l'ordre
            return list(dict.fromkeys(out))
        cfg["source_filters"] = {
            "use_starter_blocklist": bool(sf_raw.get("use_starter_blocklist", False)),
            "blocklist": _clean_domain_list(sf_raw.get("blocklist")),
            "allowlist": _clean_domain_list(sf_raw.get("allowlist")),
            "allowlist_mode": mode,
        }

    us.huntr_config = cfg
    # JSON Column mutation → flag the attribute so SQLAlchemy persists the change.
    from sqlalchemy.orm.attributes import flag_modified
    flag_modified(us, "huntr_config")
    await session.commit()
    # Invalidate user's cached Pro answers since structure/providers may have changed.
    tavily_cache.invalidate_user(uid)
    return {
        "ok": True,
        "custom_format": cfg.get("custom_format", "") or "",
        "providers": cfg.get("providers") or {},
        "source_filters": cfg.get("source_filters") or {
            "use_starter_blocklist": False,
            "blocklist": [],
            "allowlist": [],
            "allowlist_mode": "off",
        },
    }


@router.get("/source-filters/starter")
async def get_starter_blocklist(request: Request):
    """Retourne la starter blocklist pour affichage UI (lecture seule).

    Permet à l'utilisateur de voir ce qu'il active avant de cocher la case
    `use_starter_blocklist`. On expose domaine + raison documentée."""
    return {
        "entries": [
            {"domain": domain, "reason": reason}
            for domain, reason in STARTER_BLOCKLIST.items()
        ],
        "count": len(STARTER_BLOCKLIST),
    }


@router.get("/providers")
async def list_providers(request: Request, session: AsyncSession = Depends(get_session)):
    """Retourne l'état de chaque provider HuntR pour l'UI config.

    Inclut : label, si une clé est requise, si l'utilisateur a bien fourni
    la clé/URL, si le toggle est activé, et si le provider fonctionne en
    mode Classique (= gratuit)."""
    uid = await _uid(request, session)
    if not uid:
        return JSONResponse({"error": "Authentification requise."}, status_code=401)
    return {"providers": await _providers_status(uid, session)}


@router.get("/history")
async def get_history(request: Request, limit: int = 30, favorites_only: bool = False,
                      session: AsyncSession = Depends(get_session)):
    uid = await _uid(request, session)
    if not uid:
        return JSONResponse({"error": "Authentification requise."}, status_code=401)
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
    uid = await _uid(request, session)
    if not uid:
        return JSONResponse({"error": "Authentification requise."}, status_code=401)
    stmt = delete(HuntRSearch).where(HuntRSearch.user_id == uid)
    if keep_favorites:
        stmt = stmt.where(HuntRSearch.is_favorite == False)
    await session.execute(stmt)
    await session.commit()
    return {"status": "ok"}


@router.delete("/history/{entry_id}")
async def delete_entry(entry_id: int, request: Request,
                       session: AsyncSession = Depends(get_session)):
    uid = await _uid(request, session)
    if not uid:
        return JSONResponse({"error": "Authentification requise."}, status_code=401)
    row = await session.get(HuntRSearch, entry_id)
    if not row or row.user_id != uid:
        raise HTTPException(status_code=404, detail="Entrée introuvable")
    await session.delete(row)
    await session.commit()
    return {"status": "ok"}


@router.post("/history/{entry_id}/favorite")
async def favorite_entry(entry_id: int, request: Request,
                         session: AsyncSession = Depends(get_session)):
    uid = await _uid(request, session)
    if not uid:
        return JSONResponse({"error": "Authentification requise."}, status_code=401)
    row = await session.get(HuntRSearch, entry_id)
    if not row or row.user_id != uid:
        raise HTTPException(status_code=404, detail="Entrée introuvable")
    row.is_favorite = True
    await session.commit()
    return {"status": "ok", "is_favorite": True}


@router.delete("/history/{entry_id}/favorite")
async def unfavorite_entry(entry_id: int, request: Request,
                           session: AsyncSession = Depends(get_session)):
    uid = await _uid(request, session)
    if not uid:
        return JSONResponse({"error": "Authentification requise."}, status_code=401)
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
    uid = await _uid(request, session)
    if not uid:
        return JSONResponse({"error": "Authentification requise."}, status_code=401)
    us = await get_user_settings(uid, session)

    has_tavily = False
    tavily_svc = get_user_service_key(us, "tavily")
    if tavily_svc and tavily_svc.get("api_key"):
        has_tavily = True

    # Dispose-t-on d'au moins un provider de recherche au-delà de DDG ? (utile
    # pour relever les gates UI : Pro fonctionne même sur DDG seul désormais,
    # mais montrer "aucun provider configuré" a une valeur informative.)
    has_any_search_key = False
    for name, spec in HUNTR_PROVIDER_SPECS.items():
        if name == "duckduckgo":
            continue
        svc = get_user_service_key(us, name)
        if _provider_has_requirements(name, svc):
            has_any_search_key = True
            break

    has_llm = False
    pname = us.active_provider or "openrouter"
    user_prov = get_user_provider_key(us, pname)
    if user_prov and user_prov.get("api_key"):
        has_llm = True

    return {
        "has_tavily": has_tavily,
        "has_any_search_key": has_any_search_key,
        "has_llm": has_llm,
        "provider": pname if has_llm else None,
        "model": us.active_model if has_llm else None,
    }
