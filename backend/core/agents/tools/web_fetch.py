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
import re
from typing import Optional
from urllib.parse import urljoin, urlparse, quote_plus
from html.parser import HTMLParser


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
    Recherche web légère via DuckDuckGo HTML (pas besoin de Playwright).
    Parse directement la page de résultats DuckDuckGo.
    """
    search_url = f"https://html.duckduckgo.com/html/?q={quote_plus(query)}"

    try:
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

        # Parser les résultats DDG
        results = []
        # Pattern: <a class="result__a" href="...">TITLE</a> ... <a class="result__snippet">SNIPPET</a>
        result_blocks = re.findall(
            r'<a\s+rel="nofollow"\s+class="result__a"[^>]*href="([^"]*)"[^>]*>(.*?)</a>'
            r'.*?'
            r'<a\s+class="result__snippet"[^>]*>(.*?)</a>',
            html, re.DOTALL
        )

        for href, title_html, snippet_html in result_blocks[:num_results]:
            # Nettoyer le HTML des titres et snippets
            title = re.sub(r'<[^>]+>', '', title_html).strip()
            snippet = re.sub(r'<[^>]+>', '', snippet_html).strip()
            # DDG encode les URLs avec un redirect
            if '/l/?uddg=' in href:
                from urllib.parse import unquote
                match = re.search(r'uddg=([^&]+)', href)
                if match:
                    href = unquote(match.group(1))
            results.append({
                'title': title,
                'url': href,
                'snippet': snippet[:300],
            })

        if not results:
            # Fallback: pattern plus simple
            links = re.findall(
                r'class="result__a"[^>]*href="([^"]*)"[^>]*>(.*?)</a>',
                html, re.DOTALL
            )
            for href, title_html in links[:num_results]:
                title = re.sub(r'<[^>]+>', '', title_html).strip()
                if '/l/?uddg=' in href:
                    from urllib.parse import unquote
                    match = re.search(r'uddg=([^&]+)', href)
                    if match:
                        href = unquote(match.group(1))
                results.append({'title': title, 'url': href, 'snippet': ''})

        return {
            "ok": True,
            "query": query,
            "results": results,
            "results_count": len(results),
        }

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
