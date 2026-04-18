"""
HuntR — Search Providers (multi-topic).

Two providers, same interface:
  - DDGProvider    : free, no API key. Supports topic=web|news|academic|code.
  - TavilyProvider : per-user API key. Supports topic via Tavily params.
"""
import html
import logging
from dataclasses import dataclass

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
    """Unified search result from any provider."""
    title: str
    url: str
    snippet: str
    content: str  # full extracted text (Tavily only, empty for DDG)
    source: str   # "duckduckgo" | "tavily"


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
