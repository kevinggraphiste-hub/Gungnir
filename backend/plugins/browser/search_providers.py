"""
HuntR — Search Providers (multi-topic).

Two providers, same interface:
  - DDGProvider    : free, no API key. Supports topic=web|news|academic|code.
  - TavilyProvider : per-user API key. Supports topic via Tavily params.
"""
import asyncio
import html
import logging
from dataclasses import dataclass, field
from urllib.parse import urlsplit, urlunsplit

logger = logging.getLogger("gungnir.plugins.huntr")


def _clean(text: str) -> str:
    """Decode HTML entities (&#x27; &amp; &quot; …) returned by DDG/Tavily."""
    if not text:
        return ""
    return html.unescape(text)


# ── Topic presets ───────────────────────────────────────────────────────────

ACADEMIC_DOMAINS = [
    "arxiv.org",
    "scholar.google.com",
    "jstor.org",
    "pubmed.ncbi.nlm.nih.gov",
    "ncbi.nlm.nih.gov",
    "researchgate.net",
    "semanticscholar.org",
    "sciencedirect.com",
    "nature.com",
    "plos.org",
    "hal.science",
]

CODE_DOMAINS = [
    "github.com",
    "stackoverflow.com",
    "stackexchange.com",
    "developer.mozilla.org",
    "dev.to",
    "docs.python.org",
    "docs.rs",
    "pkg.go.dev",
    "docs.oracle.com",
    "kubernetes.io",
    "docs.docker.com",
]

VALID_TOPICS = {"web", "news", "academic", "code"}


def _site_filter(domains: list[str]) -> str:
    """Build a DDG-compatible site: filter OR-chain."""
    return "(" + " OR ".join(f"site:{d}" for d in domains) + ")"


@dataclass
class SearchResult:
    """Unified search result from any provider.

    `source` garde le provider dominant (Tavily si dispo — seul à retourner
    le contenu complet — sinon le premier provider qui a ramené l'URL).
    `providers` liste tous les providers qui ont contribué cette URL, utilisé
    pour le scoring de consensus et l'affichage des badges en UI.
    """
    title: str
    url: str
    snippet: str
    content: str  # full extracted text (Tavily only, empty otherwise)
    source: str
    providers: list[str] = field(default_factory=list)


# ═══════════════════════════════════════════════════════════════════════════
# DuckDuckGo — free, no key
# ═══════════════════════════════════════════════════════════════════════════

class DDGProvider:
    """Free web search via DDG. Supports multi-topic."""

    async def search(self, query: str, max_results: int = 10,
                     topic: str = "web") -> list[SearchResult]:
        topic = topic if topic in VALID_TOPICS else "web"

        if topic == "news":
            return await self._search_news(query, max_results)
        if topic == "academic":
            return await self._search_text(
                f"{query} {_site_filter(ACADEMIC_DOMAINS)}", max_results
            )
        if topic == "code":
            return await self._search_text(
                f"{query} {_site_filter(CODE_DOMAINS)}", max_results
            )
        return await self._search_text(query, max_results)

    async def _search_text(self, query: str, max_results: int) -> list[SearchResult]:
        """Standard DDG text search via core web_search_lite (has HTML fallback)."""
        try:
            from backend.core.agents.tools.web_fetch import web_search_lite
            data = await web_search_lite(query, num_results=max_results)
            if not data.get("ok"):
                logger.warning(f"[HuntR][DDG] search failed: {data.get('error', 'unknown')}")
                return []

            results = []
            for r in data.get("results", []):
                url = r.get("url", "") or r.get("href", "")
                if not url:
                    continue
                results.append(SearchResult(
                    title=_clean(r.get("title", "")),
                    url=url,
                    snippet=_clean((r.get("snippet", "") or r.get("body", ""))[:500]),
                    content="",
                    source="duckduckgo",
                ))
            logger.info(f"[HuntR][DDG text] {len(results)} results for: {query[:60]}")
            return results
        except Exception as e:
            logger.warning(f"[HuntR][DDG text] search failed: {e}")
            return []

    async def _search_news(self, query: str, max_results: int) -> list[SearchResult]:
        """DDG news search — uses duckduckgo-search lib directly."""
        try:
            import asyncio
            from duckduckgo_search import DDGS

            def _blocking():
                with DDGS() as ddgs:
                    return list(ddgs.news(query, max_results=max_results, safesearch="moderate"))

            raw = await asyncio.to_thread(_blocking)

            results = []
            for r in raw:
                url = r.get("url", "")
                if not url:
                    continue
                title = r.get("title", "")
                body = r.get("body", "") or ""
                source_name = r.get("source", "")
                date = r.get("date", "")
                # Annotate snippet with date/source for LLM context
                snippet_prefix = ""
                if date:
                    snippet_prefix += f"[{date}] "
                if source_name:
                    snippet_prefix += f"{source_name} — "
                results.append(SearchResult(
                    title=_clean(title),
                    url=url,
                    snippet=_clean((snippet_prefix + body)[:500]),
                    content="",
                    source="duckduckgo",
                ))
            logger.info(f"[HuntR][DDG news] {len(results)} news for: {query[:60]}")
            return results
        except Exception as e:
            logger.warning(f"[HuntR][DDG news] search failed: {e}, fallback to text")
            return await self._search_text(f"{query} actualités", max_results)


# ═══════════════════════════════════════════════════════════════════════════
# Tavily — per-user API key, returns full content
# ═══════════════════════════════════════════════════════════════════════════

class TavilyProvider:
    """Tavily Search API — multi-topic support (news/academic/code via include_domains)."""

    def __init__(self, api_key: str):
        self.api_key = api_key

    async def search(self, query: str, max_results: int = 10,
                     search_depth: str = "basic",
                     topic: str = "web",
                     news_days: int = 7) -> list[SearchResult]:
        topic = topic if topic in VALID_TOPICS else "web"
        try:
            import aiohttp
            payload: dict = {
                "api_key": self.api_key,
                "query": query,
                "max_results": min(max_results, 20),
                "search_depth": search_depth,
                "include_answer": False,
                "include_raw_content": False,
            }

            if topic == "news":
                payload["topic"] = "news"
                payload["days"] = max(1, min(news_days, 30))
            elif topic == "academic":
                payload["include_domains"] = ACADEMIC_DOMAINS
            elif topic == "code":
                payload["include_domains"] = CODE_DOMAINS
            # else topic=web → no extra params

            async with aiohttp.ClientSession(
                timeout=aiohttp.ClientTimeout(total=15)
            ) as session:
                async with session.post(
                    "https://api.tavily.com/search", json=payload
                ) as resp:
                    if resp.status != 200:
                        body = await resp.text()
                        logger.warning(f"[HuntR][Tavily] API {resp.status}: {body[:200]}")
                        return []
                    data = await resp.json()

            results = []
            for r in data.get("results", []):
                url = r.get("url", "")
                if not url:
                    continue
                # News topic returns 'published_date' in some cases
                prefix = ""
                pd = r.get("published_date") or r.get("date")
                if topic == "news" and pd:
                    prefix = f"[{pd}] "
                content = r.get("content", "") or ""
                results.append(SearchResult(
                    title=_clean(r.get("title", "")),
                    url=url,
                    snippet=_clean((prefix + content)[:500]),
                    content=_clean(prefix + content),
                    source="tavily",
                ))
            logger.info(f"[HuntR][Tavily {topic}] {len(results)} results for: {query[:60]}")
            return results
        except Exception as e:
            logger.warning(f"[HuntR][Tavily] search failed: {e}")
            return []


# ═══════════════════════════════════════════════════════════════════════════
# Brave Search API — per-user key, free tier 2000/mo
# ═══════════════════════════════════════════════════════════════════════════

class BraveProvider:
    """Brave Search API — topic via goggles/freshness."""

    def __init__(self, api_key: str):
        self.api_key = api_key

    async def search(self, query: str, max_results: int = 10,
                     topic: str = "web") -> list[SearchResult]:
        topic = topic if topic in VALID_TOPICS else "web"
        try:
            import aiohttp
            params = {
                "q": query,
                "count": min(max_results, 20),
                "safesearch": "moderate",
                "text_decorations": "false",
            }
            if topic == "news":
                # Brave news subendpoint
                endpoint = "https://api.search.brave.com/res/v1/news/search"
                params["freshness"] = "pd"  # past day
            else:
                endpoint = "https://api.search.brave.com/res/v1/web/search"
                if topic == "academic":
                    query = f"{query} {_site_filter(ACADEMIC_DOMAINS)}"
                    params["q"] = query
                elif topic == "code":
                    query = f"{query} {_site_filter(CODE_DOMAINS)}"
                    params["q"] = query

            headers = {
                "X-Subscription-Token": self.api_key,
                "Accept": "application/json",
            }
            async with aiohttp.ClientSession(
                timeout=aiohttp.ClientTimeout(total=15)
            ) as session:
                async with session.get(endpoint, params=params, headers=headers) as resp:
                    if resp.status != 200:
                        body = await resp.text()
                        logger.warning(f"[HuntR][Brave] API {resp.status}: {body[:200]}")
                        return []
                    data = await resp.json()

            results = []
            raw_items = (data.get("web", {}) or {}).get("results", []) \
                        or data.get("results", []) \
                        or []
            for r in raw_items[:max_results]:
                url = r.get("url", "")
                if not url:
                    continue
                desc = r.get("description", "") or r.get("snippet", "") or ""
                prefix = ""
                if topic == "news":
                    age = r.get("age") or r.get("page_age")
                    if age:
                        prefix = f"[{age}] "
                results.append(SearchResult(
                    title=_clean(r.get("title", "")),
                    url=url,
                    snippet=_clean((prefix + desc)[:500]),
                    content="",
                    source="brave",
                ))
            logger.info(f"[HuntR][Brave {topic}] {len(results)} results for: {query[:60]}")
            return results
        except Exception as e:
            logger.warning(f"[HuntR][Brave] search failed: {e}")
            return []


# ═══════════════════════════════════════════════════════════════════════════
# Exa — neural / semantic search, per-user key, free 1000/mo
# ═══════════════════════════════════════════════════════════════════════════

class ExaProvider:
    """Exa (ex-metaphor.systems) — recherche sémantique neurale."""

    def __init__(self, api_key: str):
        self.api_key = api_key

    async def search(self, query: str, max_results: int = 10,
                     topic: str = "web") -> list[SearchResult]:
        topic = topic if topic in VALID_TOPICS else "web"
        try:
            import aiohttp
            payload: dict = {
                "query": query,
                "num_results": min(max_results, 20),
                "use_autoprompt": True,
                "type": "auto",  # exa bascule neural/keyword selon la query
            }
            if topic == "academic":
                payload["include_domains"] = ACADEMIC_DOMAINS
                payload["category"] = "research paper"
            elif topic == "code":
                payload["include_domains"] = CODE_DOMAINS
                payload["category"] = "github"
            elif topic == "news":
                payload["category"] = "news"
                payload["start_published_date"] = None  # serveur gère

            headers = {
                "x-api-key": self.api_key,
                "Content-Type": "application/json",
            }
            async with aiohttp.ClientSession(
                timeout=aiohttp.ClientTimeout(total=20)
            ) as session:
                async with session.post(
                    "https://api.exa.ai/search", json=payload, headers=headers
                ) as resp:
                    if resp.status != 200:
                        body = await resp.text()
                        logger.warning(f"[HuntR][Exa] API {resp.status}: {body[:200]}")
                        return []
                    data = await resp.json()

            results = []
            for r in data.get("results", [])[:max_results]:
                url = r.get("url", "")
                if not url:
                    continue
                # Exa renvoie `text` si demandé ; sinon on a juste `title` + `author`.
                snippet = r.get("text") or r.get("summary") or r.get("author") or ""
                prefix = ""
                published = r.get("published_date")
                if published:
                    prefix = f"[{published[:10]}] "
                results.append(SearchResult(
                    title=_clean(r.get("title", "")),
                    url=url,
                    snippet=_clean((prefix + snippet)[:500]),
                    content="",
                    source="exa",
                ))
            logger.info(f"[HuntR][Exa {topic}] {len(results)} results for: {query[:60]}")
            return results
        except Exception as e:
            logger.warning(f"[HuntR][Exa] search failed: {e}")
            return []


# ═══════════════════════════════════════════════════════════════════════════
# Serper.dev — Google-backed, per-user key
# ═══════════════════════════════════════════════════════════════════════════

class SerperProvider:
    """Serper.dev — scrape Google Search SERP via leur API."""

    def __init__(self, api_key: str):
        self.api_key = api_key

    async def search(self, query: str, max_results: int = 10,
                     topic: str = "web") -> list[SearchResult]:
        topic = topic if topic in VALID_TOPICS else "web"
        try:
            import aiohttp
            endpoint = "https://google.serper.dev/search"
            result_key = "organic"
            if topic == "news":
                endpoint = "https://google.serper.dev/news"
                result_key = "news"
            elif topic == "academic":
                endpoint = "https://google.serper.dev/scholar"
                result_key = "organic"
                query = query  # scholar prend la query telle quelle
            elif topic == "code":
                query = f"{query} {_site_filter(CODE_DOMAINS)}"

            payload = {"q": query, "num": min(max_results, 20), "hl": "fr"}
            headers = {"X-API-KEY": self.api_key, "Content-Type": "application/json"}
            async with aiohttp.ClientSession(
                timeout=aiohttp.ClientTimeout(total=15)
            ) as session:
                async with session.post(endpoint, json=payload, headers=headers) as resp:
                    if resp.status != 200:
                        body = await resp.text()
                        logger.warning(f"[HuntR][Serper] API {resp.status}: {body[:200]}")
                        return []
                    data = await resp.json()

            results = []
            for r in data.get(result_key, [])[:max_results]:
                url = r.get("link") or r.get("url") or ""
                if not url:
                    continue
                snippet = r.get("snippet", "") or r.get("description", "") or ""
                prefix = ""
                if topic == "news":
                    date = r.get("date")
                    if date:
                        prefix = f"[{date}] "
                results.append(SearchResult(
                    title=_clean(r.get("title", "")),
                    url=url,
                    snippet=_clean((prefix + snippet)[:500]),
                    content="",
                    source="serper",
                ))
            logger.info(f"[HuntR][Serper {topic}] {len(results)} results for: {query[:60]}")
            return results
        except Exception as e:
            logger.warning(f"[HuntR][Serper] search failed: {e}")
            return []


# ═══════════════════════════════════════════════════════════════════════════
# SerpAPI — Google Search API, per-user key
# ═══════════════════════════════════════════════════════════════════════════

class SerpAPIProvider:
    """SerpAPI — SERP Google officiel (concurrent de Serper.dev)."""

    def __init__(self, api_key: str):
        self.api_key = api_key

    async def search(self, query: str, max_results: int = 10,
                     topic: str = "web") -> list[SearchResult]:
        topic = topic if topic in VALID_TOPICS else "web"
        try:
            import aiohttp
            params: dict = {
                "api_key": self.api_key,
                "q": query,
                "num": min(max_results, 20),
                "engine": "google",
                "hl": "fr",
            }
            result_key = "organic_results"
            if topic == "news":
                params["tbm"] = "nws"
                result_key = "news_results"
            elif topic == "academic":
                params["engine"] = "google_scholar"
            elif topic == "code":
                params["q"] = f"{query} {_site_filter(CODE_DOMAINS)}"

            async with aiohttp.ClientSession(
                timeout=aiohttp.ClientTimeout(total=15)
            ) as session:
                async with session.get(
                    "https://serpapi.com/search", params=params
                ) as resp:
                    if resp.status != 200:
                        body = await resp.text()
                        logger.warning(f"[HuntR][SerpAPI] API {resp.status}: {body[:200]}")
                        return []
                    data = await resp.json()

            results = []
            for r in data.get(result_key, [])[:max_results]:
                url = r.get("link") or r.get("url") or ""
                if not url:
                    continue
                snippet = r.get("snippet") or r.get("description") or ""
                prefix = ""
                if topic == "news":
                    date = r.get("date")
                    if date:
                        prefix = f"[{date}] "
                results.append(SearchResult(
                    title=_clean(r.get("title", "")),
                    url=url,
                    snippet=_clean((prefix + snippet)[:500]),
                    content="",
                    source="serpapi",
                ))
            logger.info(f"[HuntR][SerpAPI {topic}] {len(results)} results for: {query[:60]}")
            return results
        except Exception as e:
            logger.warning(f"[HuntR][SerpAPI] search failed: {e}")
            return []


# ═══════════════════════════════════════════════════════════════════════════
# Kagi — premium search API, per-user key
# ═══════════════════════════════════════════════════════════════════════════

class KagiProvider:
    """Kagi Search API — premium, pas de topic mais qualité très haute."""

    def __init__(self, api_key: str):
        self.api_key = api_key

    async def search(self, query: str, max_results: int = 10,
                     topic: str = "web") -> list[SearchResult]:
        topic = topic if topic in VALID_TOPICS else "web"
        q = query
        if topic == "academic":
            q = f"{query} {_site_filter(ACADEMIC_DOMAINS)}"
        elif topic == "code":
            q = f"{query} {_site_filter(CODE_DOMAINS)}"
        elif topic == "news":
            q = f"{query} actualités"
        try:
            import aiohttp
            headers = {"Authorization": f"Bot {self.api_key}"}
            params = {"q": q, "limit": min(max_results, 20)}
            async with aiohttp.ClientSession(
                timeout=aiohttp.ClientTimeout(total=15)
            ) as session:
                async with session.get(
                    "https://kagi.com/api/v0/search", params=params, headers=headers
                ) as resp:
                    if resp.status != 200:
                        body = await resp.text()
                        logger.warning(f"[HuntR][Kagi] API {resp.status}: {body[:200]}")
                        return []
                    data = await resp.json()

            results = []
            for r in data.get("data", [])[:max_results]:
                # Kagi retourne des items type t=0 (résultat organique) et t=1 (widgets)
                if r.get("t") not in (0, None):
                    continue
                url = r.get("url", "")
                if not url:
                    continue
                snippet = r.get("snippet", "") or ""
                results.append(SearchResult(
                    title=_clean(r.get("title", "")),
                    url=url,
                    snippet=_clean(snippet[:500]),
                    content="",
                    source="kagi",
                ))
            logger.info(f"[HuntR][Kagi {topic}] {len(results)} results for: {q[:60]}")
            return results
        except Exception as e:
            logger.warning(f"[HuntR][Kagi] search failed: {e}")
            return []


# ═══════════════════════════════════════════════════════════════════════════
# Bing Web Search (Azure Cognitive Services), per-user key
# ═══════════════════════════════════════════════════════════════════════════

class BingProvider:
    """Bing Web Search v7 — Azure Cognitive Services."""

    def __init__(self, api_key: str):
        self.api_key = api_key

    async def search(self, query: str, max_results: int = 10,
                     topic: str = "web") -> list[SearchResult]:
        topic = topic if topic in VALID_TOPICS else "web"
        try:
            import aiohttp
            if topic == "news":
                endpoint = "https://api.bing.microsoft.com/v7.0/news/search"
                params = {"q": query, "count": min(max_results, 20), "mkt": "fr-FR", "freshness": "Day"}
                result_key = "value"
            else:
                endpoint = "https://api.bing.microsoft.com/v7.0/search"
                q = query
                if topic == "academic":
                    q = f"{query} {_site_filter(ACADEMIC_DOMAINS)}"
                elif topic == "code":
                    q = f"{query} {_site_filter(CODE_DOMAINS)}"
                params = {"q": q, "count": min(max_results, 20), "mkt": "fr-FR"}
                result_key = None

            headers = {"Ocp-Apim-Subscription-Key": self.api_key}
            async with aiohttp.ClientSession(
                timeout=aiohttp.ClientTimeout(total=15)
            ) as session:
                async with session.get(endpoint, params=params, headers=headers) as resp:
                    if resp.status != 200:
                        body = await resp.text()
                        logger.warning(f"[HuntR][Bing] API {resp.status}: {body[:200]}")
                        return []
                    data = await resp.json()

            if topic == "news":
                raw_items = data.get(result_key, []) or []
            else:
                raw_items = ((data.get("webPages") or {}).get("value") or [])

            results = []
            for r in raw_items[:max_results]:
                url = r.get("url", "")
                if not url:
                    continue
                snippet = r.get("snippet") or r.get("description") or ""
                prefix = ""
                if topic == "news":
                    dt = r.get("datePublished")
                    if dt:
                        prefix = f"[{dt[:10]}] "
                results.append(SearchResult(
                    title=_clean(r.get("name", "") or r.get("title", "")),
                    url=url,
                    snippet=_clean((prefix + snippet)[:500]),
                    content="",
                    source="bing",
                ))
            logger.info(f"[HuntR][Bing {topic}] {len(results)} results for: {query[:60]}")
            return results
        except Exception as e:
            logger.warning(f"[HuntR][Bing] search failed: {e}")
            return []


# ═══════════════════════════════════════════════════════════════════════════
# SearXNG — self-hosted méta-moteur, per-user URL (gratuit si auto-hébergé)
# ═══════════════════════════════════════════════════════════════════════════

class SearXNGProvider:
    """Client SearXNG (self-hosted). Requiert juste une URL de base.

    Topic : web | news (géré par &categories=). Pas de support academic/code
    natif — fallback vers web avec site filter.
    """

    def __init__(self, base_url: str, api_key: str = ""):
        self.base_url = (base_url or "").rstrip("/")
        self.api_key = api_key  # optionnel, certaines instances en exigent une

    async def search(self, query: str, max_results: int = 10,
                     topic: str = "web") -> list[SearchResult]:
        topic = topic if topic in VALID_TOPICS else "web"
        if not self.base_url:
            return []
        try:
            import aiohttp
            categories = "general"
            q = query
            if topic == "news":
                categories = "news"
            elif topic == "academic":
                categories = "science"
                q = f"{query} {_site_filter(ACADEMIC_DOMAINS)}"
            elif topic == "code":
                categories = "it"
                q = f"{query} {_site_filter(CODE_DOMAINS)}"

            params = {
                "q": q, "format": "json", "categories": categories,
                "language": "fr", "safesearch": "1",
            }
            headers = {"Accept": "application/json"}
            if self.api_key:
                headers["Authorization"] = f"Bearer {self.api_key}"
            async with aiohttp.ClientSession(
                timeout=aiohttp.ClientTimeout(total=20)
            ) as session:
                async with session.get(
                    f"{self.base_url}/search", params=params, headers=headers
                ) as resp:
                    if resp.status != 200:
                        body = await resp.text()
                        logger.warning(f"[HuntR][SearXNG] {resp.status}: {body[:200]}")
                        return []
                    data = await resp.json()

            results = []
            for r in data.get("results", [])[:max_results]:
                url = r.get("url", "")
                if not url:
                    continue
                snippet = r.get("content") or r.get("snippet") or ""
                prefix = ""
                pub = r.get("publishedDate") or r.get("publisheddate")
                if topic == "news" and pub:
                    prefix = f"[{pub[:10]}] "
                results.append(SearchResult(
                    title=_clean(r.get("title", "")),
                    url=url,
                    snippet=_clean((prefix + snippet)[:500]),
                    content="",
                    source="searxng",
                ))
            logger.info(f"[HuntR][SearXNG {topic}] {len(results)} results for: {query[:60]}")
            return results
        except Exception as e:
            logger.warning(f"[HuntR][SearXNG] search failed: {e}")
            return []


# ═══════════════════════════════════════════════════════════════════════════
# Multi-provider orchestrator : parallèle + dédup + scoring consensus
# ═══════════════════════════════════════════════════════════════════════════

# Poids relatif de chaque provider dans le scoring (plus haut = plus de confiance).
# Tavily = seul à ramener du contenu plein, donc privilégié. Kagi/Bing/Serper
# sont payants et généralement plus propres que DDG sur les requêtes pointues.
PROVIDER_WEIGHTS = {
    "tavily":     1.5,
    "kagi":       1.3,
    "brave":      1.2,
    "exa":        1.2,
    "bing":       1.1,
    "serpapi":    1.1,
    "serper":     1.0,
    "searxng":    0.9,
    "duckduckgo": 0.8,
}

# Providers qu'on peut activer en mode Classique : zéro coût utilisateur.
# Brave/Exa/Tavily ont des tiers gratuits mais exigent un compte → on les
# réserve au Pro par souci de prévisibilité.
FREE_PROVIDERS = {"duckduckgo", "searxng"}


def _normalize_url(url: str) -> str:
    """Canonicalise une URL pour la dédup :
    - lowercase host
    - strip 'www.'
    - drop query string + fragment
    - strip trailing slash
    """
    try:
        parts = urlsplit(url.strip())
        host = parts.netloc.lower()
        if host.startswith("www."):
            host = host[4:]
        path = parts.path.rstrip("/")
        return urlunsplit((parts.scheme.lower() or "https", host, path, "", ""))
    except Exception:
        return (url or "").strip().lower()


async def multi_search(
    providers: list[tuple[str, object]],
    query: str,
    max_results: int = 10,
    topic: str = "web",
) -> list[SearchResult]:
    """Lance tous les providers en parallèle, dédup par URL canonique, score
    par consensus (nombre de providers × poids × 1/rang_moyen) puis tronque.

    `providers` = liste de tuples (nom, instance). Pour Tavily/Brave/... on
    passe déjà un provider instancié avec sa clé.

    Retour : liste `SearchResult` triée par score décroissant, avec le champ
    `providers` rempli (liste des sources ayant contribué cette URL). Le
    `source` reste le provider "dominant" (celui avec le poids le plus haut
    parmi ceux qui ont ramené l'URL), ce qui garantit que si Tavily a le
    résultat, on garde son `content` pour la synthèse LLM.
    """
    if not providers:
        return []

    async def _one(name: str, prov) -> tuple[str, list[SearchResult]]:
        try:
            items = await prov.search(query, max_results=max_results, topic=topic)
            return name, items or []
        except Exception as e:
            logger.warning(f"[HuntR][multi_search] {name} crashed: {e}")
            return name, []

    pairs = await asyncio.gather(*[_one(name, prov) for name, prov in providers])

    # Agrégation par URL canonique
    bucket: dict[str, dict] = {}
    for name, items in pairs:
        for rank, item in enumerate(items):
            key = _normalize_url(item.url)
            if not key:
                continue
            entry = bucket.get(key)
            if entry is None:
                bucket[key] = {
                    "best": item,                 # on garde l'item du meilleur provider
                    "best_weight": PROVIDER_WEIGHTS.get(name, 1.0),
                    "providers": [name],
                    "ranks": [rank],
                    "score": PROVIDER_WEIGHTS.get(name, 1.0) * (1.0 / (rank + 1)),
                }
            else:
                w = PROVIDER_WEIGHTS.get(name, 1.0)
                entry["providers"].append(name)
                entry["ranks"].append(rank)
                entry["score"] += w * (1.0 / (rank + 1))
                # Si ce provider est plus "lourd" que l'actuel best, on bascule
                # sur son item — important pour récupérer le content complet de
                # Tavily quand d'autres providers ont la même URL.
                if w > entry["best_weight"]:
                    entry["best"] = item
                    entry["best_weight"] = w

    # Bonus consensus : une URL trouvée par N providers > 1 reçoit un multiplicateur
    for entry in bucket.values():
        n = len(entry["providers"])
        if n > 1:
            entry["score"] *= (1.0 + 0.25 * (n - 1))  # +25% / provider supplémentaire

    # Tri + hydratation du champ providers sur SearchResult
    merged: list[SearchResult] = []
    for entry in sorted(bucket.values(), key=lambda e: e["score"], reverse=True):
        best: SearchResult = entry["best"]
        best.providers = sorted(set(entry["providers"]))
        merged.append(best)

    # On garde un peu plus de résultats qu'un provider seul aurait renvoyés
    # (le LLM en profite) mais on plafonne raisonnablement.
    limit = min(max(max_results, 10), 30)
    logger.info(
        f"[HuntR][multi_search] {len(providers)} providers → {len(merged)} "
        f"unique URLs (top {limit}), topic={topic}"
    )
    return merged[:limit]
