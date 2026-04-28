"""
Forge — wolf_tools utilitaires pour les workflows.

- wait_seconds  : pause asyncio (rate limit, backoff manuel, timing)
- http_request  : POST/PUT/DELETE/PATCH avec body et headers (étend le
  GET-only de web_fetch — sans dépendance Playwright)

Comme `llm_tools.py`, ces tools sont concaténés dans `agent_tools.py`
pour profiter de l'auto-discovery. Disponibles aussi en chat normal.
"""
from __future__ import annotations

import asyncio
import logging
from typing import Any, Optional

logger = logging.getLogger("gungnir.plugins.forge.flow_tools")


FLOW_TOOL_SCHEMAS: list[dict] = [
    {
        "type": "function",
        "function": {
            "name": "wait_seconds",
            "description": (
                "Met le workflow en pause pendant N secondes (max 300). "
                "Utile pour respecter un rate limit, espacer des appels API, "
                "ou ajouter un délai humain dans un script."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "seconds": {"type": "number", "description": "Durée en secondes (max 300)."},
                },
                "required": ["seconds"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "http_request",
            "description": (
                "Requête HTTP avancée (POST/PUT/DELETE/PATCH/GET) avec body et headers. "
                "Pour un GET simple texte, préférer web_fetch. Ce tool est destiné aux "
                "appels d'API REST avec auth/payload."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "url": {"type": "string"},
                    "method": {"type": "string", "description": "GET / POST / PUT / PATCH / DELETE (défaut: POST)."},
                    "json": {"type": "object", "description": "Body JSON (envoyé avec Content-Type: application/json)."},
                    "form": {"type": "object", "description": "Body form-urlencoded (alternative à json)."},
                    "headers": {"type": "object", "description": "Headers HTTP custom (ex: Authorization)."},
                    "timeout": {"type": "number", "description": "Timeout en secondes, défaut 30."},
                    "max_chars": {"type": "integer", "description": "Tronque la réponse à N caractères, défaut 5000."},
                },
                "required": ["url"],
            },
        },
    },
]


# ── Executors ────────────────────────────────────────────────────────────

async def _wait_seconds(seconds: float) -> dict:
    try:
        s = float(seconds or 0)
    except Exception:
        return {"ok": False, "error": "Argument 'seconds' invalide"}
    if s < 0:
        return {"ok": False, "error": "Délai négatif refusé"}
    s = min(s, 300.0)  # safety cap : pas de sleep > 5min dans un step
    await asyncio.sleep(s)
    return {"ok": True, "waited_seconds": s}


async def _http_request(url: str, method: str = "POST",
                        json: Optional[dict] = None,
                        form: Optional[dict] = None,
                        headers: Optional[dict] = None,
                        timeout: float = 30.0,
                        max_chars: int = 5000) -> dict:
    if not url:
        return {"ok": False, "error": "URL requise"}
    method = (method or "POST").upper()
    if method not in ("GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"):
        return {"ok": False, "error": f"Méthode HTTP non supportée : {method}"}

    # SSRF check : bloque le réseau privé / metadata cloud / loopback.
    # Réutilise le helper du registre WOLF (lazy import pour éviter les
    # cycles, c'est le même check que _web_fetch).
    try:
        from backend.core.agents.wolf_tools import _is_private_url
        if _is_private_url(url):
            return {"ok": False, "error": "URL pointe vers un réseau privé/interne (bloqué pour SSRF)."}
    except Exception:
        pass

    try:
        import httpx
    except ImportError:
        return {"ok": False, "error": "httpx non installé côté serveur"}
    req_kwargs: dict = {"timeout": float(timeout or 30.0)}
    h = dict(headers or {})
    if json is not None and form is not None:
        return {"ok": False, "error": "Spécifie 'json' OU 'form', pas les deux"}
    if json is not None:
        req_kwargs["json"] = json
        h.setdefault("Content-Type", "application/json")
    elif form is not None:
        req_kwargs["data"] = form
    if h:
        req_kwargs["headers"] = h

    # Suit les redirects MANUELLEMENT pour re-check SSRF à chaque step
    # (sinon un site externe légitime peut rediriger vers 127.0.0.1
    # ou 169.254.169.254 = AWS metadata = leak credentials).
    MAX_REDIRECTS = 10
    current_url = url
    try:
        async with httpx.AsyncClient(follow_redirects=False) as client:
            for hop in range(MAX_REDIRECTS + 1):
                resp = await client.request(method, current_url, **req_kwargs)
                # 301/302/303/307/308 → on suit MANUELLEMENT après check
                if resp.status_code in (301, 302, 303, 307, 308):
                    next_url = resp.headers.get("location", "")
                    if not next_url:
                        break
                    # Résolution relative si le Location est /path
                    from urllib.parse import urljoin as _urljoin
                    next_url = _urljoin(current_url, next_url)
                    if _is_private_url(next_url):
                        return {
                            "ok": False,
                            "error": (
                                f"Redirect SSRF bloqué : '{current_url}' "
                                f"redirigeait vers réseau privé '{next_url}'."
                            ),
                            "status": resp.status_code,
                        }
                    if hop >= MAX_REDIRECTS:
                        return {"ok": False, "error": f"Trop de redirects (>{MAX_REDIRECTS})"}
                    # 303 force GET sur le suivant ; sinon on garde le method
                    if resp.status_code == 303:
                        method = "GET"
                        req_kwargs.pop("json", None)
                        req_kwargs.pop("data", None)
                    current_url = next_url
                    continue
                break

        text = resp.text or ""
        if max_chars and max_chars > 0:
            text = text[: int(max_chars)]
        # Essai de parse JSON pour exposer .data utilisable directement.
        parsed_json: Any = None
        ctype = resp.headers.get("content-type", "")
        if "application/json" in ctype.lower():
            try:
                parsed_json = resp.json()
            except Exception:
                parsed_json = None
        return {
            "ok": 200 <= resp.status_code < 400,
            "status": resp.status_code,
            "headers": dict(resp.headers),
            "text": text,
            "data": parsed_json,
            "url": str(resp.url),
        }
    except Exception as e:
        return {"ok": False, "error": f"Requête HTTP échouée : {e}"}


FLOW_EXECUTORS: dict[str, Any] = {
    "wait_seconds":  _wait_seconds,
    "http_request":  _http_request,
}
