"""
browser.py — Outil de navigation web complet via Playwright.
Capacités :
  ✅ Naviguer sur Internet (sites externes)
  ✅ Accéder à n'importe quelle URL
  ✅ Crawler un site web (suivre les liens, collecter le contenu)
  ✅ Voir le rendu d'une page (screenshot)
  ✅ Charger les ressources externes (CSS, JS, images, fonts)
  ✅ Extraire les liens, métadonnées, texte, HTML
  ✅ Évaluer du JavaScript arbitraire
"""
import asyncio
import uuid
import base64
from typing import Optional
from datetime import datetime
from urllib.parse import urljoin, urlparse
from pydantic import BaseModel


class BrowserConfig(BaseModel):
    headless: bool = True
    user_data_dir: Optional[str] = None
    proxy: Optional[str] = None
    timeout: int = 30000
    viewport_width: int = 1280
    viewport_height: int = 720
    user_agent: str = (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/125.0.0.0 Safari/537.36"
    )
    # Permettre le chargement de toutes les ressources externes
    block_resources: list[str] = []  # ex: ["image", "font"] pour bloquer
    java_script_enabled: bool = True
    accept_downloads: bool = True
    locale: str = "fr-FR"
    timezone_id: str = "Europe/Paris"


class BrowserPage(BaseModel):
    id: str
    url: str
    title: str
    created_at: datetime = None


class BrowserTool:
    def __init__(self):
        self.browser = None
        self.context = None
        self._pw = None  # instance playwright — garder la référence
        self.pages: dict[str, dict] = {}
        self.config = BrowserConfig()

    # ── Lifecycle ──────────────────────────────────────────────────────────────

    async def start(self, headless: bool = True) -> dict:
        """Démarre un navigateur Chromium complet capable d'accéder à Internet."""
        try:
            from playwright.async_api import async_playwright

            self._pw = await async_playwright().start()

            launch_args = [
                "--no-sandbox",
                "--disable-setuid-sandbox",
                "--disable-blink-features=AutomationControlled",
                "--disable-infobars",
            ]

            if self.config.proxy:
                launch_args.append(f"--proxy-server={self.config.proxy}")

            launch_options: dict = {
                "headless": headless,
                "args": launch_args,
            }

            self.browser = await self._pw.chromium.launch(**launch_options)

            # Context avec user-agent réaliste, viewport, locale, timezone
            context_opts: dict = {
                "viewport": {
                    "width": self.config.viewport_width,
                    "height": self.config.viewport_height,
                },
                "user_agent": self.config.user_agent,
                "locale": self.config.locale,
                "timezone_id": self.config.timezone_id,
                "java_script_enabled": self.config.java_script_enabled,
                "accept_downloads": self.config.accept_downloads,
                "ignore_https_errors": True,  # accéder à n'importe quel site
            }

            self.context = await self.browser.new_context(**context_opts)

            # Bloquer certaines ressources si configuré (accélère le scraping)
            if self.config.block_resources:
                await self.context.route(
                    "**/*",
                    lambda route: (
                        route.abort()
                        if route.request.resource_type in self.config.block_resources
                        else route.continue_()
                    ),
                )

            self.config.headless = headless
            return {"success": True, "message": f"Browser started ({'headless' if headless else 'visible'})"}

        except ImportError:
            return {
                "success": False,
                "error": (
                    "Playwright non installé. Exécuter :\n"
                    "  pip install playwright && python -m playwright install chromium"
                ),
            }
        except Exception as e:
            return {"success": False, "error": str(e)}

    async def stop(self) -> dict:
        try:
            for page_data in self.pages.values():
                try:
                    await page_data["page"].close()
                except Exception:
                    pass
            self.pages = {}
            if self.browser:
                await self.browser.close()
                self.browser = None
                self.context = None
            if self._pw:
                await self._pw.stop()
                self._pw = None
            return {"success": True, "message": "Browser stopped"}
        except Exception as e:
            return {"success": False, "error": str(e)}

    async def _ensure_browser(self) -> bool:
        """Démarre le browser automatiquement s'il n'est pas lancé."""
        if not self.browser or not self.context:
            result = await self.start(headless=self.config.headless)
            return result.get("success", False)
        return True

    # ── Navigation ─────────────────────────────────────────────────────────────

    async def new_page(self, url: str = "about:blank") -> dict:
        try:
            if not await self._ensure_browser():
                return {"success": False, "error": "Impossible de démarrer le browser"}

            page = await self.context.new_page()

            # Navigation avec attente du chargement DOM + réseau idle
            try:
                await page.goto(url, wait_until="domcontentloaded", timeout=self.config.timeout)
            except Exception:
                # Certains sites mettent du temps — on accepte quand même
                pass

            page_id = str(uuid.uuid4())[:8]
            self.pages[page_id] = {
                "page": page,
                "url": page.url,
                "title": await page.title(),
                "created_at": datetime.utcnow(),
            }

            return {
                "success": True,
                "page_id": page_id,
                "url": page.url,
                "title": self.pages[page_id]["title"],
            }

        except Exception as e:
            return {"success": False, "error": str(e)}

    async def goto(self, page_id: str, url: str) -> dict:
        try:
            page_data = self.pages.get(page_id)
            if not page_data:
                return {"success": False, "error": f"Page '{page_id}' non trouvée"}

            page = page_data["page"]
            try:
                await page.goto(url, wait_until="domcontentloaded", timeout=self.config.timeout)
            except Exception:
                pass

            self.pages[page_id]["url"] = page.url
            self.pages[page_id]["title"] = await page.title()

            return {
                "success": True,
                "url": page.url,
                "title": self.pages[page_id]["title"],
            }

        except Exception as e:
            return {"success": False, "error": str(e)}

    # ── Interaction ────────────────────────────────────────────────────────────

    async def click(self, page_id: str, selector: str) -> dict:
        try:
            page_data = self.pages.get(page_id)
            if not page_data:
                return {"success": False, "error": "Page not found"}

            page = page_data["page"]
            await page.click(selector, timeout=10000)

            # Mettre à jour l'URL/titre après click (navigation possible)
            await asyncio.sleep(0.5)
            self.pages[page_id]["url"] = page.url
            self.pages[page_id]["title"] = await page.title()

            return {"success": True, "new_url": page.url, "new_title": self.pages[page_id]["title"]}

        except Exception as e:
            return {"success": False, "error": str(e)}

    async def type_text(self, page_id: str, selector: str, text: str) -> dict:
        try:
            page_data = self.pages.get(page_id)
            if not page_data:
                return {"success": False, "error": "Page not found"}

            page = page_data["page"]
            await page.fill(selector, text, timeout=10000)

            return {"success": True}

        except Exception as e:
            return {"success": False, "error": str(e)}

    async def press_key(self, page_id: str, key: str) -> dict:
        """Appuie sur une touche (Enter, Tab, Escape, etc.)."""
        try:
            page_data = self.pages.get(page_id)
            if not page_data:
                return {"success": False, "error": "Page not found"}

            page = page_data["page"]
            await page.keyboard.press(key)

            await asyncio.sleep(0.3)
            self.pages[page_id]["url"] = page.url
            self.pages[page_id]["title"] = await page.title()

            return {"success": True, "key": key}

        except Exception as e:
            return {"success": False, "error": str(e)}

    # ── Extraction de contenu ──────────────────────────────────────────────────

    async def get_text(self, page_id: str, selector: str = "body") -> dict:
        try:
            page_data = self.pages.get(page_id)
            if not page_data:
                return {"success": False, "error": "Page not found"}

            page = page_data["page"]
            try:
                text = await page.inner_text(selector, timeout=10000)
            except Exception:
                text = await page.text_content(selector) or ""

            return {"success": True, "text": text or ""}

        except Exception as e:
            return {"success": False, "error": str(e)}

    async def get_html(self, page_id: str, selector: str = None) -> dict:
        try:
            page_data = self.pages.get(page_id)
            if not page_data:
                return {"success": False, "error": "Page not found"}

            page = page_data["page"]
            if selector:
                el = await page.query_selector(selector)
                html = await el.inner_html() if el else ""
            else:
                html = await page.content()

            return {"success": True, "html": html[:50000]}

        except Exception as e:
            return {"success": False, "error": str(e)}

    async def get_links(self, page_id: str) -> dict:
        """Extrait tous les liens <a> de la page avec leur texte."""
        try:
            page_data = self.pages.get(page_id)
            if not page_data:
                return {"success": False, "error": "Page not found"}

            page = page_data["page"]
            links = await page.evaluate("""
                () => Array.from(document.querySelectorAll('a[href]')).map(a => ({
                    href: a.href,
                    text: (a.innerText || '').trim().substring(0, 120),
                    rel: a.rel || '',
                })).filter(l => l.href.startsWith('http'))
            """)

            return {"success": True, "links": links[:500], "total": len(links)}

        except Exception as e:
            return {"success": False, "error": str(e)}

    async def get_page_info(self, page_id: str) -> dict:
        """Renvoie un résumé complet de la page : title, URL, meta, nombre d'éléments."""
        try:
            page_data = self.pages.get(page_id)
            if not page_data:
                return {"success": False, "error": "Page not found"}

            page = page_data["page"]
            info = await page.evaluate("""
                () => ({
                    title: document.title,
                    url: window.location.href,
                    meta_description: (document.querySelector('meta[name="description"]') || {}).content || '',
                    meta_keywords: (document.querySelector('meta[name="keywords"]') || {}).content || '',
                    og_title: (document.querySelector('meta[property="og:title"]') || {}).content || '',
                    og_image: (document.querySelector('meta[property="og:image"]') || {}).content || '',
                    canonical: (document.querySelector('link[rel="canonical"]') || {}).href || '',
                    h1: Array.from(document.querySelectorAll('h1')).map(e => e.innerText.trim()).slice(0, 5),
                    links_count: document.querySelectorAll('a[href]').length,
                    images_count: document.querySelectorAll('img').length,
                    scripts_count: document.querySelectorAll('script[src]').length,
                    stylesheets_count: document.querySelectorAll('link[rel="stylesheet"]').length,
                    forms_count: document.querySelectorAll('form').length,
                    language: document.documentElement.lang || '',
                })
            """)
            return {"success": True, **info}

        except Exception as e:
            return {"success": False, "error": str(e)}

    # ── Screenshot et rendu ────────────────────────────────────────────────────

    async def screenshot(self, page_id: str, path: Optional[str] = None, full_page: bool = True) -> dict:
        try:
            page_data = self.pages.get(page_id)
            if not page_data:
                return {"success": False, "error": "Page not found"}

            page = page_data["page"]

            if path:
                await page.screenshot(path=path, full_page=full_page)
                return {"success": True, "path": path}
            else:
                png_bytes = await page.screenshot(full_page=full_page)
                b64 = base64.b64encode(png_bytes).decode()
                return {"success": True, "image_b64": b64}

        except Exception as e:
            return {"success": False, "error": str(e)}

    # ── JavaScript ─────────────────────────────────────────────────────────────

    async def evaluate(self, page_id: str, script: str) -> dict:
        try:
            page_data = self.pages.get(page_id)
            if not page_data:
                return {"success": False, "error": "Page not found"}

            page = page_data["page"]
            result = await page.evaluate(script)

            return {"success": True, "result": str(result)[:10000]}

        except Exception as e:
            return {"success": False, "error": str(e)}

    # ── Attente ────────────────────────────────────────────────────────────────

    async def wait_for_selector(self, page_id: str, selector: str, timeout: int = 10000) -> dict:
        try:
            page_data = self.pages.get(page_id)
            if not page_data:
                return {"success": False, "error": "Page not found"}

            page = page_data["page"]
            await page.wait_for_selector(selector, timeout=timeout)

            return {"success": True}

        except Exception as e:
            return {"success": False, "error": str(e)}

    async def wait_for_navigation(self, page_id: str, timeout: int = 15000) -> dict:
        """Attend qu'une navigation se termine (utile après un click)."""
        try:
            page_data = self.pages.get(page_id)
            if not page_data:
                return {"success": False, "error": "Page not found"}

            page = page_data["page"]
            await page.wait_for_load_state("domcontentloaded", timeout=timeout)

            self.pages[page_id]["url"] = page.url
            self.pages[page_id]["title"] = await page.title()

            return {"success": True, "url": page.url, "title": self.pages[page_id]["title"]}

        except Exception as e:
            return {"success": False, "error": str(e)}

    # ── Crawl ──────────────────────────────────────────────────────────────────

    async def crawl(self, start_url: str, max_pages: int = 10, same_domain: bool = True) -> dict:
        """
        Crawler simple : part d'une URL, suit les liens, collecte title + texte de chaque page.
        Limité à max_pages pages, optionnellement restreint au même domaine.
        """
        try:
            if not await self._ensure_browser():
                return {"success": False, "error": "Impossible de démarrer le browser"}

            domain = urlparse(start_url).netloc
            visited: set[str] = set()
            to_visit: list[str] = [start_url]
            results: list[dict] = []

            page = await self.context.new_page()

            while to_visit and len(results) < max_pages:
                url = to_visit.pop(0)
                if url in visited:
                    continue
                visited.add(url)

                try:
                    await page.goto(url, wait_until="domcontentloaded", timeout=self.config.timeout)
                except Exception:
                    continue

                title = await page.title()
                try:
                    text = await page.inner_text("body")
                except Exception:
                    text = ""

                results.append({
                    "url": page.url,
                    "title": title,
                    "text_preview": (text or "")[:2000],
                    "text_length": len(text or ""),
                })

                # Collecter les liens pour continuer le crawl
                try:
                    links = await page.evaluate("""
                        () => Array.from(document.querySelectorAll('a[href]'))
                            .map(a => a.href)
                            .filter(h => h.startsWith('http'))
                    """)
                    for link in links:
                        if link not in visited:
                            if same_domain and urlparse(link).netloc != domain:
                                continue
                            to_visit.append(link)
                except Exception:
                    pass

            await page.close()

            return {
                "success": True,
                "pages_crawled": len(results),
                "results": results,
            }

        except Exception as e:
            return {"success": False, "error": str(e)}

    # ── Recherche web ─────────────────────────────────────────────────────────

    async def web_search(self, query: str, num_results: int = 10) -> dict:
        """
        Recherche web en un seul appel via DuckDuckGo HTML (pas de captcha).
        Retourne une liste de {title, url, snippet}.
        """
        try:
            if not await self._ensure_browser():
                return {"success": False, "error": "Impossible de démarrer le browser"}

            from urllib.parse import quote_plus
            search_url = f"https://html.duckduckgo.com/html/?q={quote_plus(query)}"
            page = await self.context.new_page()

            try:
                await page.goto(search_url, wait_until="domcontentloaded", timeout=self.config.timeout)
            except Exception:
                pass

            results = await page.evaluate(f"""
                () => {{
                    const items = [];
                    document.querySelectorAll('.result').forEach((el, i) => {{
                        if (i >= {num_results}) return;
                        const a = el.querySelector('.result__a');
                        const snippet = el.querySelector('.result__snippet');
                        if (a) {{
                            items.push({{
                                title: (a.innerText || '').trim(),
                                url: a.href || '',
                                snippet: snippet ? snippet.innerText.trim().substring(0, 300) : '',
                            }});
                        }}
                    }});
                    return items;
                }}
            """)

            await page.close()
            return {"success": True, "query": query, "results": results or []}

        except Exception as e:
            return {"success": False, "error": str(e)}

    # ── Scroll ────────────────────────────────────────────────────────────────

    async def scroll(self, page_id: str, direction: str = "down", amount: int = 500) -> dict:
        """Scroll la page (utile pour le chargement dynamique / infinite scroll)."""
        try:
            page_data = self.pages.get(page_id)
            if not page_data:
                return {"success": False, "error": "Page not found"}

            page = page_data["page"]
            pixels = amount if direction == "down" else -amount
            pos = await page.evaluate(f"""
                () => {{
                    window.scrollBy(0, {pixels});
                    return {{ scrollY: window.scrollY, scrollHeight: document.body.scrollHeight, innerHeight: window.innerHeight }};
                }}
            """)
            await asyncio.sleep(0.5)  # laisser le lazy-load se déclencher
            return {"success": True, **pos}

        except Exception as e:
            return {"success": False, "error": str(e)}

    # ── Extraction structurée ─────────────────────────────────────────────────

    async def extract_table(self, page_id: str, selector: str = "table") -> dict:
        """Extrait un tableau HTML en headers + rows."""
        try:
            page_data = self.pages.get(page_id)
            if not page_data:
                return {"success": False, "error": "Page not found"}

            page = page_data["page"]
            table = await page.evaluate(f"""
                () => {{
                    const tbl = document.querySelector('{selector}');
                    if (!tbl) return null;
                    const headers = Array.from(tbl.querySelectorAll('thead th, thead td, tr:first-child th'))
                        .map(c => c.innerText.trim());
                    const rows = [];
                    tbl.querySelectorAll('tbody tr, tr').forEach((tr, i) => {{
                        if (i === 0 && headers.length > 0) return; // skip header row
                        const cells = Array.from(tr.querySelectorAll('td, th')).map(c => c.innerText.trim());
                        if (cells.length > 0) rows.push(cells);
                    }});
                    return {{ headers, rows: rows.slice(0, 200) }};
                }}
            """)
            if table is None:
                return {"success": False, "error": f"Aucun tableau trouvé avec le sélecteur '{selector}'"}
            return {"success": True, **table}

        except Exception as e:
            return {"success": False, "error": str(e)}

    async def query_selector_all(self, page_id: str, selector: str, extract: str = "text") -> dict:
        """
        Extrait une valeur de tous les éléments correspondant au sélecteur.
        extract: "text" (innerText), "html" (innerHTML), ou un attribut ("href", "src", "data-id"...).
        """
        try:
            page_data = self.pages.get(page_id)
            if not page_data:
                return {"success": False, "error": "Page not found"}

            page = page_data["page"]
            items = await page.evaluate(f"""
                () => {{
                    const els = document.querySelectorAll('{selector}');
                    return Array.from(els).slice(0, 200).map(el => {{
                        const extract = '{extract}';
                        if (extract === 'text') return el.innerText.trim().substring(0, 500);
                        if (extract === 'html') return el.innerHTML.substring(0, 2000);
                        return el.getAttribute(extract) || '';
                    }});
                }}
            """)
            return {"success": True, "items": items or [], "count": len(items or [])}

        except Exception as e:
            return {"success": False, "error": str(e)}

    # ── Formulaires ───────────────────────────────────────────────────────────

    async def select_option(self, page_id: str, selector: str, value: str) -> dict:
        """Sélectionne une option dans un <select>."""
        try:
            page_data = self.pages.get(page_id)
            if not page_data:
                return {"success": False, "error": "Page not found"}

            page = page_data["page"]
            await page.select_option(selector, value=value, timeout=10000)
            return {"success": True, "selector": selector, "value": value}

        except Exception as e:
            return {"success": False, "error": str(e)}

    async def fill_form(self, page_id: str, fields: dict, submit_selector: str = None) -> dict:
        """
        Remplit un formulaire entier en une fois.
        fields: dict {selector: value} pour chaque champ.
        submit_selector: si fourni, clique dessus après avoir rempli.
        """
        try:
            page_data = self.pages.get(page_id)
            if not page_data:
                return {"success": False, "error": "Page not found"}

            page = page_data["page"]
            filled = []
            for sel, val in fields.items():
                try:
                    # Détecter le type d'input
                    tag = await page.evaluate(f"document.querySelector('{sel}')?.tagName?.toLowerCase()")
                    if tag == "select":
                        await page.select_option(sel, value=val, timeout=5000)
                    else:
                        await page.fill(sel, val, timeout=5000)
                    filled.append(sel)
                except Exception as e:
                    filled.append(f"{sel} (erreur: {e})")

            if submit_selector:
                await page.click(submit_selector, timeout=10000)
                await asyncio.sleep(1)
                self.pages[page_id]["url"] = page.url
                self.pages[page_id]["title"] = await page.title()

            return {"success": True, "filled": filled, "submitted": bool(submit_selector)}

        except Exception as e:
            return {"success": False, "error": str(e)}

    # ── Download ──────────────────────────────────────────────────────────────

    async def download_file(self, page_id: str, url: str, filename: str = None) -> dict:
        """Télécharge un fichier via l'URL et le sauve dans data/downloads/."""
        try:
            page_data = self.pages.get(page_id)
            if not page_data:
                return {"success": False, "error": "Page not found"}

            from pathlib import Path
            dl_dir = Path(__file__).parent.parent.parent.parent / "data" / "downloads"
            dl_dir.mkdir(parents=True, exist_ok=True)

            page = page_data["page"]

            # Utiliser fetch JS pour récupérer le fichier en base64
            b64_data = await page.evaluate(f"""
                async () => {{
                    try {{
                        const resp = await fetch('{url}');
                        const blob = await resp.blob();
                        return new Promise((resolve) => {{
                            const reader = new FileReader();
                            reader.onloadend = () => resolve(reader.result.split(',')[1]);
                            reader.readAsDataURL(blob);
                        }});
                    }} catch(e) {{
                        return null;
                    }}
                }}
            """)

            if not b64_data:
                return {"success": False, "error": "Impossible de télécharger le fichier"}

            # Déterminer le nom du fichier
            if not filename:
                from urllib.parse import urlparse as _up
                path_part = _up(url).path
                filename = Path(path_part).name or "download"

            file_path = dl_dir / filename
            file_path.write_bytes(base64.b64decode(b64_data))

            return {
                "success": True,
                "filename": filename,
                "path": str(file_path),
                "size": file_path.stat().st_size,
            }

        except Exception as e:
            return {"success": False, "error": str(e)}

    # ── Gestion des pages ──────────────────────────────────────────────────────

    async def close_page(self, page_id: str) -> dict:
        try:
            page_data = self.pages.get(page_id)
            if not page_data:
                return {"success": False, "error": "Page not found"}

            await page_data["page"].close()
            del self.pages[page_id]

            return {"success": True}

        except Exception as e:
            return {"success": False, "error": str(e)}

    def list_pages(self) -> list[dict]:
        result = []
        for pid, data in self.pages.items():
            result.append({
                "id": pid,
                "url": data.get("url", ""),
                "title": data.get("title", ""),
            })
        return result


browser_tool = BrowserTool()
