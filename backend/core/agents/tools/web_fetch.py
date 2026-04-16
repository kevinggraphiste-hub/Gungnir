"""
web_fetch.py — Outil léger de fetch web (HTTP GET + extraction de contenu).
Pas besoin de Playwright — utilise aiohttp + extraction HTML propre.
Comme OpenClaw : simple, rapide, fiable.

Capacités :
  ✅ Fetch n'importe quelle URL (HTTP GET)
  ✅ Extraire le contenu en texte propre (readability-like)
  ✅ Extraire les métadonnées (title, description, links)
  ✅ Recherche web via DuckDuckGo (sans navigateur)
  ✅ Fonctionne avec TOUS les modèles LLM (pas besoin de function calling natif)
"""
import aiohttp
import asyncio
import ipaddress
import logging

logger = logging.getLogger("gungnir.web_fetch")
import re
import socket
from typing import Optional
from urllib.parse import urljoin, urlparse, quote_plus
from html.parser import HTMLParser


def _is_private_url(url: str) -> bool:
    """Check if a URL resolves to a private/internal IP address."""
    try:
        hostname = urlparse(url).hostname
        if not hostname:
            return True
        # Block obvious internal hostnames
        if hostname in ("localhost", "127.0.0.1", "0.0.0.0", "::1"):
            return True
        if hostname.startswith("169.254.") or hostname.startswith("10.") or hostname.startswith("192.168."):
            return True
        if hostname.startswith("172."):
            parts = hostname.split(".")
            if len(parts) >= 2 and 16 <= int(parts[1]) <= 31:
                return True
        # DNS resolution check
        try:
            ip = socket.gethostbyname(hostname)
            addr = ipaddress.ip_address(ip)
            return addr.is_private or addr.is_loopback or addr.is_link_local
        except (socket.gaierror, ValueError):
            return False
    except Exception:
        return False


# ═══════════════════════════════════════════════════════════════════════════════
# HTML → Texte propre (readability-like)
# ═══════════════════════════════════════════════════════════════════════════════

class _ReadabilityParser(HTMLParser):
    """Extracteur de contenu propre depuis du HTML brut.
    Supprime scripts, styles, nav, footer, ads.
    Retourne du texte lisible comme un Ctrl+A / Ctrl+C intelligent."""

    SKIP_TAGS = {
        'script', 'style', 'noscript', 'iframe', 'svg', 'path',
        'nav', 'footer', 'header',  # éléments de navigation
    }
    BLOCK_TAGS = {
        'p', 'div', 'section', 'article', 'main', 'aside',
        'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
        'li', 'tr', 'td', 'th', 'dt', 'dd',
        'blockquote', 'pre', 'figcaption',
        'br', 'hr',
    }

    def __init__(self):
        super().__init__()
        self._skip_depth = 0
        self._chunks: list[str] = []
        self._current_tag = ""
        self._title = ""
        self._in_title = False
        self._meta_desc = ""
        self._meta_og_title = ""
        self._meta_og_image = ""
        self._links: list[dict] = []
        self._base_url = ""

    def handle_starttag(self, tag, attrs):
        tag_lower = tag.lower()
        self._current_tag = tag_lower
        attrs_dict = dict(attrs)

        if tag_lower in self.SKIP_TAGS:
            self._skip_depth += 1
            return

        if self._skip_depth > 0:
            return

        if tag_lower == 'title':
            self._in_title = True

        if tag_lower == 'meta':
            name = attrs_dict.get('name', '').lower()
            prop = attrs_dict.get('property', '').lower()
            content = attrs_dict.get('content', '')
            if name == 'description':
                self._meta_desc = content
            elif prop == 'og:title':
                self._meta_og_title = content
            elif prop == 'og:image':
                self._meta_og_image = content

        if tag_lower == 'a':
            href = attrs_dict.get('href', '')
            if href and not href.startswith(('#', 'javascript:', 'mailto:')):
                self._links.append({'href': href, 'text': ''})

        if tag_lower in self.BLOCK_TAGS:
            self._chunks.append('\n')

        if tag_lower in ('h1', 'h2', 'h3', 'h4', 'h5', 'h6'):
            level = tag_lower[1]
            self._chunks.append('\n' + '#' * int(level) + ' ')

    def handle_endtag(self, tag):
        tag_lower = tag.lower()
        if tag_lower in self.SKIP_TAGS:
            self._skip_depth = max(0, self._skip_depth - 1)
            return

        if tag_lower == 'title':
            self._in_title = False

        if tag_lower in self.BLOCK_TAGS:
            self._chunks.append('\n')

    def handle_data(self, data):
        if self._skip_depth > 0:
            return

        text = data.strip()
        if not text:
            return

        if self._in_title:
            self._title += text

        # Remplir le texte du dernier lien
        if self._current_tag == 'a' and self._links and not self._links[-1]['text']:
            self._links[-1]['text'] = text[:120]

        self._chunks.append(text)

    def get_clean_text(self) -> str:
        raw = ' '.join(self._chunks)
        # Nettoyer les espaces multiples et lignes vides
        raw = re.sub(r'[ \t]+', ' ', raw)
        raw = re.sub(r'\n[ \t]+', '\n', raw)
        raw = re.sub(r'\n{3,}', '\n\n', raw)
        return raw.strip()

    def get_metadata(self) -> dict:
        return {
            'title': self._title.strip(),
            'description': self._meta_desc,
            'og_title': self._meta_og_title,
            'og_image': self._meta_og_image,
        }

    def get_links(self, base_url: str = "") -> list[dict]:
        result = []
        seen = set()
        for link in self._links:
            href = link['href']
            if base_url and not href.startswith('http'):
                href = urljoin(base_url, href)
            if href in seen or not href.startswith('http'):
                continue
            seen.add(href)
            result.append({'href': href, 'text': link['text']})
        return result[:200]


def _extract_content(html: str, url: str = "") -> dict:
    """Parse HTML et extrait contenu propre + métadonnées."""
    parser = _ReadabilityParser()
    try:
        parser.feed(html)
    except Exception:
        pass
    return {
        'text': parser.get_clean_text(),
        'metadata': parser.get_metadata(),
        'links': parser.get_links(url),
    }


# ═══════════════════════════════════════════════════════════════════════════════
# Fetch HTTP
# ═══════════════════════════════════════════════════════════════════════════════

_HEADERS = {
    'User-Agent': (
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) '
        'AppleWebKit/537.36 (KHTML, like Gecko) '
        'Chrome/125.0.0.0 Safari/537.36'
    ),
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8',
    'Accept-Encoding': 'gzip, deflate',
}


async def web_fetch(url: str, extract: str = "text", timeout: int = 15) -> dict:
    """
    Fetch une URL et retourne son contenu.

    Args:
        url: URL à fetcher (http:// ou https://)
        extract: "text" (texte propre), "html" (HTML brut), "all" (texte + meta + links)
        timeout: timeout en secondes

    Returns:
        {"ok": True, "url": str, "title": str, "text": str, ...}
    """
    if not url.startswith(('http://', 'https://')):
        url = 'https://' + url

    if _is_private_url(url):
        return {"ok": False, "error": "URL interne bloquee (securite SSRF)"}

    try:
        connector = aiohttp.TCPConnector(ssl=False)  # Ignorer erreurs SSL comme Playwright
        async with aiohttp.ClientSession(
            connector=connector,
            headers=_HEADERS,
            timeout=aiohttp.ClientTimeout(total=timeout),
        ) as session:
            async with session.get(url, allow_redirects=True, max_redirects=5) as resp:
                if resp.status >= 400:
                    return {
                        "ok": False,
                        "error": f"HTTP {resp.status} — {resp.reason}",
                        "url": str(resp.url),
                    }

                content_type = resp.headers.get('Content-Type', '')

                # Si c'est pas du HTML, retourner les infos basiques
                if 'text/html' not in content_type and 'xhtml' not in content_type:
                    body = await resp.read()
                    return {
                        "ok": True,
                        "url": str(resp.url),
                        "content_type": content_type,
                        "size": len(body),
                        "text": body.decode('utf-8', errors='replace')[:10000] if 'text' in content_type or 'json' in content_type else f"[Fichier binaire: {content_type}, {len(body)} octets]",
                    }

                html = await resp.text(errors='replace')
                final_url = str(resp.url)

        parsed = _extract_content(html, final_url)

        if extract == "html":
            return {
                "ok": True,
                "url": final_url,
                "title": parsed['metadata']['title'],
                "html": html[:50000],
                "length": len(html),
            }
        elif extract == "all":
            text = parsed['text']
            return {
                "ok": True,
                "url": final_url,
                "title": parsed['metadata']['title'],
                "description": parsed['metadata']['description'],
                "text": text[:15000],
                "text_length": len(text),
                "links": parsed['links'][:50],
                "links_total": len(parsed['links']),
            }
        else:  # "text" — défaut
            text = parsed['text']
            return {
                "ok": True,
                "url": final_url,
                "title": parsed['metadata']['title'],
                "text": text[:15000],
                "text_length": len(text),
                "truncated": len(text) > 15000,
            }

    except asyncio.TimeoutError:
        return {"ok": False, "error": f"Timeout ({timeout}s) en accédant à {url}"}
    except aiohttp.ClientError as e:
        return {"ok": False, "error": f"Erreur réseau : {type(e).__name__}: {e}"}
    except Exception as e:
        return {"ok": False, "error": f"Erreur inattendue : {type(e).__name__}: {e}"}


async def web_search_lite(query: str, num_results: int = 10) -> dict:
    """
    Recherche web via la librairie duckduckgo-search (stable, pas de parsing HTML).
    Fallback sur le parsing HTML si la librairie échoue.
    """
    try:
        # Primary: use duckduckgo-search library (reliable, no HTML parsing)
        from duckduckgo_search import DDGS
        import asyncio

        def _sync_search():
            with DDGS() as ddgs:
                return list(ddgs.text(query, max_results=num_results))

        raw = await asyncio.get_event_loop().run_in_executor(None, _sync_search)
        results = []
        for r in raw:
            results.append({
                'title': r.get('title', ''),
                'url': r.get('href', '') or r.get('link', ''),
                'snippet': (r.get('body', '') or r.get('snippet', ''))[:500],
            })
        if results:
            return {
                "ok": True,
                "query": query,
                "results": results,
                "results_count": len(results),
            }
    except Exception as e:
        logger.debug(f"duckduckgo-search library failed, trying HTML fallback: {e}")

    # Fallback: parse DDG HTML directly
    try:
        search_url = f"https://html.duckduckgo.com/html/?q={quote_plus(query)}"
        connector = aiohttp.TCPConnector(ssl=False)
        async with aiohttp.ClientSession(
            connector=connector,
            headers=_HEADERS,
            timeout=aiohttp.ClientTimeout(total=15),
        ) as session:
            async with session.get(search_url, allow_redirects=True) as resp:
                if resp.status >= 400:
                    return {"ok": False, "error": f"DuckDuckGo HTTP {resp.status}"}
                html = await resp.text(errors='replace')

        results = []
        result_blocks = re.findall(
            r'<a\s+rel="nofollow"\s+class="result__a"[^>]*href="([^"]*)"[^>]*>(.*?)</a>'
            r'.*?'
            r'<a\s+class="result__snippet"[^>]*>(.*?)</a>',
            html, re.DOTALL
        )
        for href, title_html, snippet_html in result_blocks[:num_results]:
            title = re.sub(r'<[^>]+>', '', title_html).strip()
            snippet = re.sub(r'<[^>]+>', '', snippet_html).strip()
            if '/l/?uddg=' in href:
                from urllib.parse import unquote
                match = re.search(r'uddg=([^&]+)', href)
                if match:
                    href = unquote(match.group(1))
            results.append({'title': title, 'url': href, 'snippet': snippet[:300]})

        if not results:
            links = re.findall(r'class="result__a"[^>]*href="([^"]*)"[^>]*>(.*?)</a>', html, re.DOTALL)
            for href, title_html in links[:num_results]:
                title = re.sub(r'<[^>]+>', '', title_html).strip()
                if '/l/?uddg=' in href:
                    from urllib.parse import unquote
                    match = re.search(r'uddg=([^&]+)', href)
                    if match:
                        href = unquote(match.group(1))
                results.append({'title': title, 'url': href, 'snippet': title})

        return {"ok": True, "query": query, "results": results, "results_count": len(results)}

    except Exception as e:
        return {"ok": False, "error": f"Erreur recherche : {type(e).__name__}: {e}"}


async def web_crawl_lite(start_url: str, max_pages: int = 10, same_domain: bool = True) -> dict:
    """
    Crawler léger sans Playwright — suit les liens via HTTP GET.
    Collecte titre + texte de chaque page.
    """
    if not start_url.startswith(('http://', 'https://')):
        start_url = 'https://' + start_url

    domain = urlparse(start_url).netloc
    visited: set[str] = set()
    to_visit: list[str] = [start_url]
    results: list[dict] = []

    connector = aiohttp.TCPConnector(ssl=False, limit=5)
    async with aiohttp.ClientSession(
        connector=connector,
        headers=_HEADERS,
        timeout=aiohttp.ClientTimeout(total=15),
    ) as session:
        while to_visit and len(results) < max_pages:
            url = to_visit.pop(0)
            if url in visited:
                continue
            visited.add(url)

            try:
                async with session.get(url, allow_redirects=True, max_redirects=3) as resp:
                    if resp.status >= 400:
                        continue
                    content_type = resp.headers.get('Content-Type', '')
                    if 'text/html' not in content_type:
                        continue
                    html = await resp.text(errors='replace')
                    final_url = str(resp.url)
            except Exception:
                continue

            parsed = _extract_content(html, final_url)
            text = parsed['text']

            results.append({
                'url': final_url,
                'title': parsed['metadata']['title'],
                'text_preview': text[:2000],
                'text_length': len(text),
            })

            # Ajouter les liens trouvés
            for link in parsed['links']:
                href = link['href']
                if href not in visited:
                    if same_domain and urlparse(href).netloc != domain:
                        continue
                    to_visit.append(href)

    return {
        "ok": True,
        "pages_crawled": len(results),
        "results": results,
    }
