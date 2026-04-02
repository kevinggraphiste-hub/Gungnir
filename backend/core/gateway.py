"""
gateway.py — Web Gateway style OpenClaw.

PRINCIPE : Le gateway intercepte TOUT message utilisateur AVANT qu'il arrive au LLM.
Il détecte les URLs, les intentions de recherche, et récupère le contenu web
côté serveur. Le LLM reçoit le contenu pré-chargé — il n'a JAMAIS besoin
d'appeler un outil web lui-même.

Fonctionne avec TOUS les modèles, même ceux sans function calling.

Flow :
  1. Message utilisateur arrive
  2. Gateway analyse le message (URLs ? recherche ? domaines ?)
  3. Gateway fetch/search le contenu web en parallèle
  4. Gateway construit un message enrichi avec le contenu web
  5. Le LLM reçoit le message enrichi et répond directement

C'est ce qui fait la magie d'OpenClaw : le modèle n'a jamais besoin de "savoir"
qu'il a des outils web. Le contenu est déjà là.
"""

import re
import asyncio
from typing import Optional
from urllib.parse import quote_plus


# ═══════════════════════════════════════════════════════════════════════════════
# Détection d'intent web
# ═══════════════════════════════════════════════════════════════════════════════

# Regex pour extraire les URLs explicites
_URL_PATTERN = re.compile(r'https?://[^\s<>"\'`,\)\]\}]+')

# Regex pour les domaines sans protocole (scarletwolf.fr, google.com/path...)
_DOMAIN_TLDS = (
    "fr|com|org|net|io|dev|ai|co|app|me|info|eu|tech|xyz|be|ch|ca|uk|de|es|it|"
    "nl|pt|ru|jp|cn|kr|au|us|gg|tv|cc|club|online|site|store|shop|pro|biz|"
    "live|world|space|fun|zone|link|today|rocks|cloud|design|art|solutions|"
    "agency|studio|digital|media|software|tools|work|services|page|one|new"
)
_DOMAIN_PATTERN = re.compile(
    rf'(?<![/\w])([a-zA-Z0-9][-a-zA-Z0-9]*\.(?:{_DOMAIN_TLDS})[a-zA-Z0-9/.?&=_-]*)'
)

# Triggers de recherche — mots qui indiquent une intention de recherche web
_SEARCH_TRIGGERS = [
    # FR — verbes d'action
    "cherche", "recherche", "trouve", "va sur", "va voir", "regarde",
    "consulte", "vérifie", "verifie", "explore", "fouille", "scrute", "analyse le site",
    "ouvre", "visite", "accède", "accede",
    # FR — demandes d'info
    "qu'est-ce que", "c'est quoi", "donne-moi des infos", "donne moi des infos",
    "infos sur", "informations sur", "renseigne", "dis-moi", "dis moi",
    "parle-moi de", "parle moi de", "montre-moi", "montre moi",
    "fais une recherche", "lance une recherche",
    # FR — contexte web
    "sur internet", "sur le web", "sur google", "en ligne",
    "actualité", "actualite", "actualités", "actualites",
    "news", "dernières nouvelles", "dernieres nouvelles",
    "prix de", "météo", "meteo", "horaires", "résultats", "resultats",
    "site web", "page web", "site de",
    # EN
    "search", "look up", "find", "google", "browse",
    "what is", "what are", "who is", "tell me about",
    "latest", "current", "news about", "price of",
    "check out", "go to", "visit",
]


def _normalize(text: str) -> str:
    """Normalise le texte pour le matching (lowercase, sans accents courants)."""
    t = text.lower()
    for a, b in [("è","e"),("é","e"),("ê","e"),("ë","e"),("à","a"),("â","a"),
                 ("ô","o"),("î","i"),("ù","u"),("û","u"),("ç","c")]:
        t = t.replace(a, b)
    return t


class WebIntent:
    """Résultat de l'analyse d'intent web."""
    def __init__(self):
        self.urls: list[str] = []           # URLs explicites à fetcher
        self.domains: list[str] = []        # Domaines détectés (sans http)
        self.search_query: str = ""         # Requête de recherche détectée
        self.has_web_intent: bool = False   # Y a-t-il une intention web ?

    def __repr__(self):
        return f"WebIntent(urls={self.urls}, domains={self.domains}, search='{self.search_query}', has_intent={self.has_web_intent})"


def detect_web_intent(message: str) -> WebIntent:
    """
    Analyse un message pour détecter les intentions web.
    Retourne un WebIntent avec les URLs, domaines et/ou requête de recherche.
    """
    intent = WebIntent()
    if not message or len(message.strip()) < 2:
        return intent

    # 1. URLs explicites
    intent.urls = _URL_PATTERN.findall(message)

    # 2. Domaines sans protocole
    raw_domains = _DOMAIN_PATTERN.findall(message)
    for d in raw_domains:
        full = f"https://{d}" if not d.startswith("http") else d
        if full not in intent.urls:
            intent.urls.append(full)
            intent.domains.append(d)

    # 3. Triggers de recherche
    msg_norm = _normalize(message)
    for trigger in _SEARCH_TRIGGERS:
        trigger_norm = _normalize(trigger)
        if trigger_norm in msg_norm:
            intent.search_query = message  # La requête est le message entier
            break

    # Intent web = URLs trouvées OU recherche détectée
    intent.has_web_intent = bool(intent.urls) or bool(intent.search_query)

    return intent


# ═══════════════════════════════════════════════════════════════════════════════
# Web Gateway — le coeur du système
# ═══════════════════════════════════════════════════════════════════════════════

class WebGateway:
    """
    Gateway web style OpenClaw.
    Intercepte les messages, détecte l'intent web, fetch/search le contenu,
    et retourne un message enrichi prêt à envoyer au LLM.
    """

    def __init__(self):
        self.tool_events: list[dict] = []   # Log des actions effectuées
        self._fetch_fn = None
        self._search_fn = None

    async def _get_fetch(self):
        """Lazy import de web_fetch."""
        if not self._fetch_fn:
            from backend.core.agents.tools.web_fetch import web_fetch
            self._fetch_fn = web_fetch
        return self._fetch_fn

    async def _get_search(self):
        """Lazy import de web_search_lite."""
        if not self._search_fn:
            from backend.core.agents.tools.web_fetch import web_search_lite
            self._search_fn = web_search_lite
        return self._search_fn

    async def process_message(self, message: str) -> dict:
        """
        Point d'entrée principal du gateway.

        Analyse le message, exécute les actions web nécessaires,
        et retourne un dict avec :
        - enriched_message: le message enrichi à envoyer au LLM (ou None si rien à faire)
        - original_message: le message original
        - web_content: le contenu web brut récupéré
        - tool_events: les actions effectuées
        - has_web_content: bool

        Usage dans routes.py :
            gateway = WebGateway()
            result = await gateway.process_message(user_message)
            if result["has_web_content"]:
                # Remplacer le message user par le message enrichi
                chat_messages[-1].content = result["enriched_message"]
        """
        self.tool_events = []
        intent = detect_web_intent(message)

        if not intent.has_web_intent:
            return {
                "enriched_message": None,
                "original_message": message,
                "web_content": [],
                "tool_events": [],
                "has_web_content": False,
            }

        print(f"[Gateway] Web intent detected: {intent}")

        # Récupérer le contenu web
        web_content = []

        # Phase 1: Fetch les URLs trouvées (max 3)
        if intent.urls:
            fetched = await self._fetch_urls(intent.urls[:3])
            web_content.extend(fetched)

        # Phase 2: Si recherche détectée ET pas d'URLs (ou URLs vides), search
        if intent.search_query and not web_content:
            searched = await self._search_and_fetch(intent.search_query)
            web_content.extend(searched)

        if not web_content:
            print(f"[Gateway] No web content retrieved despite intent")
            return {
                "enriched_message": None,
                "original_message": message,
                "web_content": [],
                "tool_events": self.tool_events,
                "has_web_content": False,
            }

        # Construire le message enrichi
        enriched = self._build_enriched_message(message, web_content)

        print(f"[Gateway] Enriched message ready: {len(web_content)} content blocks, {len(enriched)} chars")

        return {
            "enriched_message": enriched,
            "original_message": message,
            "web_content": web_content,
            "tool_events": self.tool_events,
            "has_web_content": True,
        }

    async def force_search(self, query: str) -> dict:
        """
        Recherche forcée — utilisé par le refusal handler quand le modèle refuse.
        Même logique que process_message mais avec une recherche garantie.
        """
        self.tool_events = []
        web_content = []

        # Essayer d'abord d'extraire des URLs du query
        urls = _URL_PATTERN.findall(query)
        if urls:
            fetched = await self._fetch_urls(urls[:2])
            web_content.extend(fetched)

        # Toujours faire une recherche en plus
        searched = await self._search_and_fetch(query)
        web_content.extend(searched)

        if not web_content:
            return {"enriched_content": None, "tool_events": self.tool_events, "has_content": False}

        content = "\n\n---\n\n".join(web_content)
        return {
            "enriched_content": content,
            "tool_events": self.tool_events,
            "has_content": True,
        }

    # ── Méthodes internes ─────────────────────────────────────────────────

    async def _fetch_urls(self, urls: list[str]) -> list[str]:
        """Fetch une liste d'URLs et retourne le contenu formaté."""
        fetch = await self._get_fetch()
        results = []

        for url in urls:
            try:
                print(f"[Gateway] Fetching: {url}")
                result = await fetch(url, extract="all")

                if result.get("ok"):
                    title = result.get("title", "")
                    text = result.get("text", "")[:8000]
                    desc = result.get("description", "")
                    links_count = result.get("links_total", 0)

                    formatted = f"## {title or url}\n**URL:** {result.get('url', url)}\n"
                    if desc:
                        formatted += f"**Description:** {desc}\n"
                    formatted += f"**Liens trouvés:** {links_count}\n\n{text}"

                    results.append(formatted)
                    self.tool_events.append({
                        "tool": "gateway:web_fetch",
                        "args": {"url": url},
                        "result": {"ok": True, "title": title, "text_length": len(text)},
                    })
                    print(f"[Gateway] Fetched OK: {title or url} ({len(text)} chars)")
                else:
                    error = result.get("error", "?")
                    print(f"[Gateway] Fetch failed: {url} → {error}")
                    self.tool_events.append({
                        "tool": "gateway:web_fetch",
                        "args": {"url": url},
                        "result": {"ok": False, "error": error},
                    })
            except Exception as e:
                print(f"[Gateway] Fetch error: {url} → {e}")

        return results

    async def _search_and_fetch(self, query: str) -> list[str]:
        """Recherche web + fetch des top résultats."""
        search = await self._get_search()
        fetch = await self._get_fetch()
        results = []

        try:
            print(f"[Gateway] Searching: {query[:80]}...")
            search_result = await search(query, num_results=8)

            if not search_result.get("ok") or not search_result.get("results"):
                print(f"[Gateway] Search failed or empty: {search_result.get('error', '?')}")
                self.tool_events.append({
                    "tool": "gateway:web_search",
                    "args": {"query": query},
                    "result": {"ok": False, "error": search_result.get("error", "Pas de résultats")},
                })
                return []

            # Formater les résultats de recherche
            search_text = f"## Résultats de recherche : {query}\n\n"
            for i, r in enumerate(search_result["results"][:8], 1):
                search_text += f"**{i}. [{r.get('title', 'Sans titre')}]({r.get('url', '')})**\n"
                if r.get("snippet"):
                    search_text += f"   {r['snippet']}\n"
                search_text += "\n"

            results.append(search_text)
            self.tool_events.append({
                "tool": "gateway:web_search",
                "args": {"query": query},
                "result": {"ok": True, "results_count": len(search_result["results"])},
            })
            print(f"[Gateway] Search OK: {len(search_result['results'])} results")

            # Fetch le top 2 résultats pour du contenu riche
            for top in search_result["results"][:2]:
                top_url = top.get("url", "")
                if not top_url:
                    continue
                try:
                    page = await fetch(top_url, extract="text")
                    if page.get("ok") and page.get("text"):
                        results.append(
                            f"## Contenu : {top.get('title', top_url)}\n"
                            f"**URL:** {top_url}\n\n"
                            f"{page['text'][:5000]}"
                        )
                        self.tool_events.append({
                            "tool": "gateway:web_fetch_enrich",
                            "args": {"url": top_url},
                            "result": {"ok": True, "title": page.get("title", "")},
                        })
                        print(f"[Gateway] Enriched: {top_url}")
                except Exception as e:
                    print(f"[Gateway] Enrich failed: {top_url} → {e}")

        except Exception as e:
            print(f"[Gateway] Search error: {e}")

        return results

    def _build_enriched_message(self, original_message: str, web_content: list[str]) -> str:
        """
        Construit le message enrichi final.
        Structure : instruction claire → contenu web → demande originale.
        Le modèle voit d'abord l'instruction, puis le contenu, puis la question.
        """
        content = "\n\n---\n\n".join(web_content)

        return (
            f"**Ma demande :** {original_message}\n\n"
            "---\n\n"
            "[SYSTÈME — CONTENU WEB PRÉ-CHARGÉ]\n"
            "Le contenu web demandé a été automatiquement récupéré par le système. "
            "Voici les données :\n\n"
            f"{content}\n\n"
            "---\n"
            "Utilise les données ci-dessus pour répondre à ma demande."
        )


# ═══════════════════════════════════════════════════════════════════════════════
# Détection de refus web (V2 — regex fuzzy)
# ═══════════════════════════════════════════════════════════════════════════════

# Mots-clés exacts (substring match rapide)
_REFUSAL_EXACT = [
    "pas d'acces internet", "pas d'acces au web", "pas d'outil web",
    "aucun acces web", "aucun acces internet", "aucun outil web",
    "no web access", "no internet access", "no browsing capability",
    "can't access the web", "cannot access the web", "unable to access",
    "unable to browse", "can't browse", "cannot browse",
    "don't have access", "don't have web", "don't have internet",
    "copier-coller le html", "copier-coller le contenu", "colle le contenu",
    "pas active de mon cote", "ma liste d'outils", "ma configuration actuelle",
    "il faudrait ajouter", "il faudrait un outil", "il manque un outil",
]

# Regex fuzzy — tolèrent des mots intercalés (malheureusement, actuellement...)
_REFUSAL_REGEX = [
    re.compile(p, re.IGNORECASE) for p in [
        r"n.ai\b.{0,30}\bpas\b.{0,20}\bacces",
        r"n.ai\b.{0,30}\bpas\b.{0,20}\bde capacite",
        r"ne peux\b.{0,20}\bpas\b.{0,20}\bacceder",
        r"ne peux\b.{0,20}\bpas\b.{0,20}\bnaviguer",
        r"ne peux\b.{0,20}\bpas\b.{0,20}\bvisiter",
        r"ne dispose\b.{0,20}\bpas\b.{0,20}\bd.outil",
        r"ne dispose\b.{0,20}\bpas\b.{0,20}\bd.acces",
        r"pas\b.{0,20}\ben mesure\b.{0,20}\bd.acceder",
        r"pas\b.{0,20}\ben mesure\b.{0,20}\bde naviguer",
        r"pas\b.{0,20}\bacces\b.{0,30}\b(?:web|internet|outils|navigation)",
        r"impossible\b.{0,20}\bd.acceder",
        r"pas\b.{0,20}\bde capacite\b.{0,20}\bd.acces",
        r"pas\b.{0,20}\bacceder\b.{0,20}\bau web",
        r"pas\b.{0,20}\bacceder\b.{0,20}\ba internet",
        r"outil.{0,15}n.est pas",
        r"pas\b.{0,15}\bactive\b.{0,15}\bde mon cote",
        r"je ne suis pas.{0,30}\b(?:capable|en mesure)",
        r"malheureusement.{0,40}\bpas.{0,20}\bacces",
        r"(?:visiter|consulter|acceder).{0,20}\bdirectement.{0,20}\b(?:site|page|url|web)",
        r"je.{0,10}recommande.{0,30}visiter.{0,10}directement",
    ]
]


def detect_web_refusal(text: str) -> bool:
    """
    Détecte si le modèle refuse faussement l'accès web.
    Utilise des keywords exacts + regex fuzzy pour attraper tous les cas.
    """
    if not text:
        return False

    text_clean = _normalize(text).replace("**", "").replace("*", "").replace("`", "")

    # Check 1: exact substring
    for kw in _REFUSAL_EXACT:
        if kw in text_clean:
            print(f"[Gateway] Refusal detected (exact): '{kw}'")
            return True

    # Check 2: regex fuzzy
    for pattern in _REFUSAL_REGEX:
        if pattern.search(text_clean):
            print(f"[Gateway] Refusal detected (regex): '{pattern.pattern}'")
            return True

    return False


# ═══════════════════════════════════════════════════════════════════════════════
# Extraction d'URLs depuis une conversation
# ═══════════════════════════════════════════════════════════════════════════════

def extract_original_query(messages: list) -> str:
    """
    Extrait la vraie demande de l'utilisateur depuis l'historique.
    Gère le cas où le message a été enrichi par le gateway.
    """
    for m in reversed(messages):
        if hasattr(m, 'role') and m.role == "user" and hasattr(m, 'content') and m.content:
            content = m.content
            # Si c'est un message enrichi par le gateway, extraire la demande originale
            orig_match = re.search(r'\*\*Demande originale\s*:\*\*\s*(.+?)(?:\n|$)', content, re.DOTALL)
            if orig_match:
                return orig_match.group(1).strip()
            # Si c'est un message système injecté, skip
            if content.startswith("[SYSTÈME") or content.startswith("[Gateway"):
                continue
            return content[:300]
    return ""


def extract_urls_from_messages(messages: list) -> list[str]:
    """Extrait toutes les URLs mentionnées dans les messages user."""
    urls = []
    for m in messages:
        if hasattr(m, 'role') and m.role == "user" and hasattr(m, 'content') and m.content:
            found = _URL_PATTERN.findall(m.content)
            urls.extend(found)
            domains = _DOMAIN_PATTERN.findall(m.content)
            for d in domains:
                full = f"https://{d}" if not d.startswith("http") else d
                if full not in urls:
                    urls.append(full)
    return urls
