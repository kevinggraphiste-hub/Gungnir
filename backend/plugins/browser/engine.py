"""
HuntR — Search Engine & Reranking

Multi-source search (DDG + Brave + SearXNG + Wikipedia), TF-IDF reranking,
focus modes, query expansion. 100% self-contained — no core state mutations.
"""
import asyncio
import json
import re
import math
import logging
from typing import Optional
from collections import Counter

logger = logging.getLogger("gungnir.plugins.huntr")

# ═══════════════════════════════════════════════════════════════════════════
# Focus Mode Definitions
# ═══════════════════════════════════════════════════════════════════════════

FOCUS_MODES = {
    "web": {
        "label": "Web",
        "description": "Recherche web generale",
        "site_filter": "",
        "boost_domains": [],
        "time_filter": "",
    },
    "code": {
        "label": "Code",
        "description": "GitHub, Stack Overflow, docs techniques",
        "site_filter": "",
        "boost_domains": ["github.com", "stackoverflow.com", "developer.mozilla.org",
                          "docs.python.org", "doc.rust-lang.org", "learn.microsoft.com",
                          "pkg.go.dev", "npmjs.com", "pypi.org"],
        "time_filter": "",
    },
    "news": {
        "label": "Actu",
        "description": "Actualites recentes (< 7 jours)",
        "site_filter": "",
        "boost_domains": ["reuters.com", "bbc.com", "techcrunch.com", "theverge.com",
                          "lemonde.fr", "lefigaro.fr", "arstechnica.com"],
        "time_filter": "w",  # last week
    },
    "academic": {
        "label": "Academic",
        "description": "Sources fiables uniquement : Wikipedia, arXiv, publications scientifiques",
        "site_filter": "",
        "boost_domains": ["arxiv.org", "wikipedia.org",
                          "nature.com", "sciencedirect.com", "pubmed.ncbi.nlm.nih.gov",
                          "hal.science", "jstor.org", "springer.com", "wiley.com",
                          "ieee.org", "acm.org", "researchgate.net", "semanticscholar.org",
                          "ncbi.nlm.nih.gov", "who.int", "europa.eu", "cairn.info",
                          "persee.fr", "openedition.org", "theses.fr",
                          "frontiersin.org", "plos.org", "bmj.com", "thelancet.com",
                          "academic.oup.com", "tandfonline.com", "mdpi.com"],
        "time_filter": "",
        "strict_filter": True,  # Only allow results from boost_domains
    },
}


# ═══════════════════════════════════════════════════════════════════════════
# Multi-Engine Search
# ═══════════════════════════════════════════════════════════════════════════

async def search_ddg(query: str, max_results: int = 15, time_filter: str = "") -> list[dict]:
    """DuckDuckGo via core web_search_lite."""
    try:
        from backend.core.agents.tools.web_fetch import web_search_lite
        result = await web_search_lite(query, num_results=max_results)
        items = result.get("results", []) if isinstance(result, dict) else []
        return [
            {
                "title": r.get("title", ""),
                "url": r.get("url") or r.get("href", ""),
                "snippet": r.get("snippet", ""),
                "source": "duckduckgo",
                "text": "",
            }
            for r in items if r.get("url") or r.get("href")
        ]
    except Exception as e:
        logger.debug(f"DDG search error: {e}")
        return []


async def search_brave(query: str, api_key: str, max_results: int = 10,
                       time_filter: str = "") -> list[dict]:
    """Brave Search API (free: 2000 req/month)."""
    if not api_key:
        return []
    try:
        import aiohttp
        headers = {
            "Accept": "application/json",
            "Accept-Encoding": "gzip",
            "X-Subscription-Token": api_key,
        }
        params = {"q": query, "count": min(max_results, 20)}
        if time_filter:
            params["freshness"] = time_filter

        async with aiohttp.ClientSession(
            headers=headers, timeout=aiohttp.ClientTimeout(total=10)
        ) as session:
            async with session.get("https://api.search.brave.com/res/v1/web/search",
                                   params=params) as resp:
                if resp.status != 200:
                    logger.debug(f"Brave API {resp.status}")
                    return []
                data = await resp.json()

        results = []
        for r in data.get("web", {}).get("results", []):
            results.append({
                "title": r.get("title", ""),
                "url": r.get("url", ""),
                "snippet": r.get("description", ""),
                "source": "brave",
                "text": "",
            })
        return results
    except Exception as e:
        logger.debug(f"Brave search error: {e}")
        return []


async def search_tavily(query: str, api_key: str, max_results: int = 10,
                        search_depth: str = "basic") -> list[dict]:
    """Tavily Search API — structured web search optimized for LLMs.
    Free tier: 1000 req/month. search_depth: 'basic' (free) or 'advanced'."""
    if not api_key:
        return []
    try:
        import aiohttp
        payload = {
            "api_key": api_key,
            "query": query,
            "max_results": min(max_results, 20),
            "search_depth": search_depth,
            "include_answer": False,
        }
        async with aiohttp.ClientSession(
            timeout=aiohttp.ClientTimeout(total=15)
        ) as session:
            async with session.post("https://api.tavily.com/search",
                                    json=payload) as resp:
                if resp.status != 200:
                    logger.debug(f"Tavily API {resp.status}")
                    return []
                data = await resp.json()

        results = []
        for r in data.get("results", []):
            results.append({
                "title": r.get("title", ""),
                "url": r.get("url", ""),
                "snippet": r.get("content", "")[:500],
                "source": "tavily",
                "text": r.get("content", ""),  # Tavily returns full content!
            })
        return results
    except Exception as e:
        logger.debug(f"Tavily search error: {e}")
        return []


async def search_searxng(query: str, base_url: str, max_results: int = 10,
                         time_filter: str = "") -> list[dict]:
    """SearXNG instance search (self-hosted, free)."""
    if not base_url:
        return []
    try:
        import aiohttp
        params = {
            "q": query, "format": "json",
            "engines": "google,bing,duckduckgo",
            "pageno": 1,
        }
        if time_filter:
            params["time_range"] = time_filter

        async with aiohttp.ClientSession(
            timeout=aiohttp.ClientTimeout(total=10)
        ) as session:
            url = f"{base_url.rstrip('/')}/search"
            async with session.get(url, params=params) as resp:
                if resp.status != 200:
                    return []
                data = await resp.json()

        results = []
        for r in data.get("results", [])[:max_results]:
            results.append({
                "title": r.get("title", ""),
                "url": r.get("url", ""),
                "snippet": r.get("content", ""),
                "source": "searxng",
                "text": "",
            })
        return results
    except Exception as e:
        logger.debug(f"SearXNG search error: {e}")
        return []


async def search_wikipedia(query: str, max_results: int = 5,
                           lang: str = "en") -> list[dict]:
    """Wikipedia API — intros des articles pertinents."""
    try:
        import aiohttp
        results = []
        headers = {"User-Agent": "Gungnir-HuntR/2.0", "Accept": "application/json"}
        wiki_lang = "fr" if lang == "fr" else "en"
        api_url = f"https://{wiki_lang}.wikipedia.org/w/api.php"

        params = {
            "action": "query", "list": "search", "srsearch": query,
            "srlimit": max_results, "format": "json", "utf8": 1,
        }
        async with aiohttp.ClientSession(
            headers=headers, timeout=aiohttp.ClientTimeout(total=10)
        ) as session:
            async with session.get(api_url, params=params) as resp:
                data = await resp.json()
            titles = [r["title"] for r in data.get("query", {}).get("search", [])]
            if titles:
                ext_params = {
                    "action": "query", "titles": "|".join(titles[:max_results]),
                    "prop": "extracts", "exintro": True, "explaintext": True,
                    "exsentences": 5, "format": "json", "utf8": 1,
                }
                async with session.get(api_url, params=ext_params) as resp:
                    pages = (await resp.json()).get("query", {}).get("pages", {})
                for _, page in pages.items():
                    title = page.get("title", "")
                    extract = page.get("extract", "")
                    if extract and len(extract) > 50:
                        results.append({
                            "title": title,
                            "url": f"https://{wiki_lang}.wikipedia.org/wiki/{title.replace(' ', '_')}",
                            "snippet": extract[:200],
                            "source": "wikipedia",
                            "text": extract,
                        })
        return results
    except Exception as e:
        logger.debug(f"Wikipedia search error: {e}")
        return []


async def multi_search(
    query: str,
    max_results: int = 15,
    brave_api_key: str = "",
    tavily_api_key: str = "",
    searxng_url: str = "",
    focus: str = "web",
    pro: bool = False,
    language: str = "en",
) -> list[dict]:
    """
    Multi-engine search with deduplication and focus mode filtering.
    Engines are queried in parallel. Results are merged and deduplicated by URL.
    """
    mode = FOCUS_MODES.get(focus, FOCUS_MODES["web"])
    time_filter = mode["time_filter"]

    # Build search query with focus context
    search_query = query
    if focus == "code" and not any(kw in query.lower() for kw in ["github", "stackoverflow", "code"]):
        search_query = f"{query} programming code"
    elif focus == "news":
        search_query = f"{query} news latest"

    # Launch all engines in parallel
    # DDG is ALWAYS the primary engine (free, no API key needed)
    tasks = []

    if focus == "academic":
        # Multiple targeted searches to maximize academic coverage
        tasks.append(search_wikipedia(query, 8, language))
        tasks.append(search_ddg(f"{query} site:wikipedia.org", max_results, time_filter))
        tasks.append(search_ddg(f"{query} site:arxiv.org", max_results // 2, time_filter))
        tasks.append(search_ddg(f"{query} site:pubmed.ncbi.nlm.nih.gov", max_results // 2, time_filter))
        tasks.append(search_ddg(f"{query} scientific study research", max_results, time_filter))
        if tavily_api_key:
            tasks.append(search_tavily(f"{query} research paper", tavily_api_key, max_results))
        if brave_api_key:
            tasks.append(search_brave(f"{query} research paper", brave_api_key, max_results, time_filter))
    else:
        # Normal: DDG always. Pro: DDG + Tavily + Wikipedia + Brave (if keys)
        tasks.append(search_ddg(search_query, max_results, time_filter))
        if pro:
            tasks.append(search_wikipedia(query, 5, language))
            if tavily_api_key:
                tasks.append(search_tavily(search_query, tavily_api_key, max_results))
            if brave_api_key:
                tasks.append(search_brave(search_query, brave_api_key, max_results, time_filter))

    if searxng_url:
        tasks.append(search_searxng(search_query, searxng_url, max_results, time_filter))

    raw_results = await asyncio.gather(*tasks, return_exceptions=True)

    # Merge and deduplicate
    results = []
    seen_urls = set()
    boost_domains = set(mode.get("boost_domains", []))

    strict = mode.get("strict_filter", False)

    for batch in raw_results:
        if isinstance(batch, Exception):
            continue
        for r in batch:
            url = r.get("url", "")
            if not url or url in seen_urls:
                continue

            # Domain matching
            try:
                from urllib.parse import urlparse
                domain = urlparse(url).hostname or ""
                domain = domain.replace("www.", "")
                is_trusted = any(d in domain for d in boost_domains)
            except Exception:
                is_trusted = False

            # In strict mode (academic), drop results from non-trusted domains
            if strict and not is_trusted:
                continue

            seen_urls.add(url)
            r["domain_boost"] = 2.0 if is_trusted else 1.0
            r["position"] = len(results) + 1
            results.append(r)

    # Sort by domain boost (focus-relevant domains first), then by original position
    results.sort(key=lambda x: (-x.get("domain_boost", 1.0), x.get("position", 999)))

    limit = max_results + (10 if pro else 5)
    return results[:limit]


# ═══════════════════════════════════════════════════════════════════════════
# Content Scraping
# ═══════════════════════════════════════════════════════════════════════════

async def scrape_sources(urls: list[str], concurrency: int = 8,
                         timeout: int = 12) -> list[dict]:
    """Fetch and extract content from multiple URLs in parallel."""
    from backend.core.agents.tools.web_fetch import web_fetch

    sem = asyncio.Semaphore(concurrency)

    async def _one(url: str) -> dict:
        async with sem:
            try:
                result = await web_fetch(url, extract="all", timeout=timeout)
                if result.get("ok"):
                    text = result.get("text", "")
                    if text and len(text) >= 100:
                        return {
                            "url": result.get("url", url),
                            "title": result.get("title", ""),
                            "text": text,
                            "words": len(text.split()),
                        }
            except Exception:
                pass
            return {"url": url, "title": "", "text": ""}

    results = await asyncio.gather(*[_one(u) for u in urls])
    return [r for r in results if r.get("text")]


# ═══════════════════════════════════════════════════════════════════════════
# TF-IDF Reranking (with keyword fallback)
# ═══════════════════════════════════════════════════════════════════════════

def _tokenize(text: str) -> list[str]:
    """Simple tokenizer: lowercase, split on non-alpha, filter short words."""
    return [w for w in re.findall(r'[a-zA-ZàâéèêëîïôùûüçœæÀÂÉÈ]+', text.lower()) if len(w) > 2]


def _compute_tfidf(documents: list[str], query: str) -> list[float]:
    """Compute TF-IDF similarity scores between query and documents."""
    if not documents:
        return []

    # Tokenize all
    query_tokens = _tokenize(query)
    doc_tokens = [_tokenize(d) for d in documents]

    if not query_tokens:
        return [0.0] * len(documents)

    # Build vocabulary from query terms
    vocab = set(query_tokens)

    # Document frequency
    n_docs = len(documents)
    df = Counter()
    for tokens in doc_tokens:
        unique = set(tokens)
        for term in vocab:
            if term in unique:
                df[term] += 1

    # IDF
    idf = {}
    for term in vocab:
        idf[term] = math.log((n_docs + 1) / (df[term] + 1)) + 1

    # Query TF-IDF vector
    query_tf = Counter(query_tokens)
    query_vec = {term: (query_tf[term] / len(query_tokens)) * idf.get(term, 1)
                 for term in vocab}

    # Score each document
    scores = []
    for tokens in doc_tokens:
        if not tokens:
            scores.append(0.0)
            continue
        doc_tf = Counter(tokens)
        doc_vec = {term: (doc_tf[term] / len(tokens)) * idf.get(term, 1)
                   for term in vocab}

        # Cosine similarity
        dot = sum(query_vec.get(t, 0) * doc_vec.get(t, 0) for t in vocab)
        mag_q = math.sqrt(sum(v ** 2 for v in query_vec.values()))
        mag_d = math.sqrt(sum(v ** 2 for v in doc_vec.values()))
        sim = dot / (mag_q * mag_d) if mag_q and mag_d else 0.0
        scores.append(sim)

    return scores


def _keyword_score(query: str, text: str, title: str = "") -> float:
    """Simple keyword-based scoring (fallback)."""
    query_words = set(w.lower() for w in query.split() if len(w) > 2)
    if not query_words:
        return 0.0
    text_lower = text.lower()
    title_lower = title.lower()
    score = 0
    for w in query_words:
        score += text_lower.count(w) * 2
        score += title_lower.count(w) * 5
    return score / max(len(text), 1)


def rerank(query: str, passages: list[dict], top_k: int = 8,
           method: str = "auto") -> list[dict]:
    """
    Rerank passages by relevance. Methods:
      - "tfidf": TF-IDF cosine similarity
      - "keyword": simple keyword counting
      - "auto": try TF-IDF, fall back to keyword
    """
    if not passages:
        return []

    use_tfidf = method in ("tfidf", "auto")

    if use_tfidf:
        texts = [f"{p.get('title', '')} {p['text']}" for p in passages]
        scores = _compute_tfidf(texts, query)
        for p, score in zip(passages, scores):
            p["score"] = score * p.get("domain_boost", 1.0)
    else:
        for p in passages:
            p["score"] = _keyword_score(query, p["text"], p.get("title", "")) * p.get("domain_boost", 1.0)

    passages.sort(key=lambda x: x["score"], reverse=True)

    # Chunk top passages into digestible pieces
    result = []
    chunk_size = 300 if top_k > 5 else 200
    for p in passages[:top_k * 2]:
        words = p["text"].split()[:3000]
        for i in range(0, max(len(words), 1), chunk_size):
            chunk = " ".join(words[i:i + chunk_size])
            if len(chunk) > 80:
                result.append({
                    "text": chunk,
                    "url": p["url"],
                    "title": p["title"],
                    "score": p["score"],
                })
            if len(result) >= top_k:
                break
        if len(result) >= top_k:
            break

    return result[:top_k]


# ═══════════════════════════════════════════════════════════════════════════
# Query Understanding & Expansion
# ═══════════════════════════════════════════════════════════════════════════

def detect_language(query: str) -> str:
    q = query.lower()
    # French
    fr_words = {"comment", "pourquoi", "qu'est", "quel", "quelle", "est-ce",
                "peux-tu", "c'est", "dans", "avec", "pour", "les", "des", "une",
                "je", "tu", "nous", "leur", "aussi", "mais", "donc", "entre"}
    if any(w in q for w in fr_words) or any(c in query for c in "àâéèêëîïôùûüçœæ"):
        return "fr"
    # Spanish
    es_words = {"cómo", "qué", "por qué", "dónde", "cuál", "puede", "como",
                "para", "los", "las", "está", "tiene", "hacer", "mejor"}
    if any(w in q for w in es_words) or any(c in query for c in "ñ¿¡áéíóú"):
        return "es"
    # German
    de_words = {"wie", "warum", "was", "welche", "können", "ist", "nicht",
                "werden", "haben", "diese", "eine", "über", "nach"}
    if any(w in q for w in de_words) or any(c in query for c in "äöüß"):
        return "de"
    # Italian
    it_words = {"come", "perché", "cosa", "quale", "può", "sono", "questo",
                "della", "nella", "anche", "fare", "migliore"}
    if any(w in q for w in it_words) or any(c in query for c in "àèìòù"):
        return "it"
    # Portuguese
    pt_words = {"como", "por que", "onde", "qual", "pode", "fazer", "melhor",
                "também", "não", "isso", "esta", "mais"}
    if any(w in q for w in pt_words) or any(c in query for c in "ãõ"):
        return "pt"
    return "en"


def detect_intent(query: str) -> str:
    q = query.lower()
    if any(w in q for w in ["vs", "versus", "compar", "différence", "difference",
                            "meilleur", "better", "best"]):
        return "comparison"
    if any(w in q for w in ["how to", "comment", "tutorial", "guide", "créer",
                            "faire", "étapes", "implement"]):
        return "tutorial"
    if any(w in q for w in ["code", "function", "script", "program", "debug",
                            "error", "python", "javascript", "typescript", "rust"]):
        return "code"
    if any(w in q for w in ["news", "actualité", "dernier", "latest", "récent",
                            "today", "2026", "2025"]):
        return "news"
    if any(w in q for w in ["what is", "qu'est", "define", "définition", "meaning",
                            "signifie", "c'est quoi"]):
        return "definition"
    return "factual"


def suggest_focus(intent: str) -> str:
    """Auto-suggest focus mode based on intent."""
    return {
        "code": "code",
        "news": "news",
        "definition": "web",
        "tutorial": "web",
        "comparison": "web",
        "factual": "web",
    }.get(intent, "web")
