"""
HuntR — Search Providers

Two providers, same interface:
  - DDGProvider  : free, no API key, uses core web_search_lite (with HTML fallback)
  - TavilyProvider : requires per-user API key, returns full extracted content
"""
import logging
from dataclasses import dataclass

logger = logging.getLogger("gungnir.plugins.huntr")


@dataclass
class SearchResult:
    """Unified search result from any provider."""
    title: str
    url: str
    snippet: str
    content: str  # full extracted text (Tavily only, empty for DDG)
    source: str   # "duckduckgo" | "tavily"


# ═══════════════════════════════════════════════════════════════════════════
# DuckDuckGo — free, no key, uses Gungnir core (with HTML fallback)
# ═══════════════════════════════════════════════════════════════════════════

class DDGProvider:
    """Free web search via core web_search_lite (DDGS lib + HTML fallback)."""

    async def search(self, query: str, max_results: int = 10) -> list[SearchResult]:
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
                    title=r.get("title", ""),
                    url=url,
                    snippet=(r.get("snippet", "") or r.get("body", ""))[:500],
                    content="",
                    source="duckduckgo",
                ))
            logger.info(f"[HuntR][DDG] {len(results)} results for: {query[:60]}")
            return results
        except Exception as e:
            logger.warning(f"[HuntR][DDG] search failed: {e}")
            return []


# ═══════════════════════════════════════════════════════════════════════════
# Tavily — per-user API key, returns full content
# ═══════════════════════════════════════════════════════════════════════════

class TavilyProvider:
    """Tavily Search API — returns clean extracted content ready for LLM."""

    def __init__(self, api_key: str):
        self.api_key = api_key

    async def search(self, query: str, max_results: int = 10,
                     search_depth: str = "basic") -> list[SearchResult]:
        try:
            import aiohttp
            payload = {
                "api_key": self.api_key,
                "query": query,
                "max_results": min(max_results, 20),
                "search_depth": search_depth,
                "include_answer": False,
                "include_raw_content": False,
            }
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
                results.append(SearchResult(
                    title=r.get("title", ""),
                    url=url,
                    snippet=r.get("content", "")[:500],
                    content=r.get("content", ""),
                    source="tavily",
                ))
            logger.info(f"[HuntR][Tavily] {len(results)} results for: {query[:60]}")
            return results
        except Exception as e:
            logger.warning(f"[HuntR][Tavily] search failed: {e}")
            return []
