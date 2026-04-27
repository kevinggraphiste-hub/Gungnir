"""
Connector Google Drive — opérations sur fichiers/dossiers.

Tools :
- drive_list      : liste les fichiers/dossiers (avec filtres)
- drive_read      : lit le contenu texte d'un fichier
- drive_search    : recherche full-text sur le Drive
- drive_upload    : crée un fichier texte (Google Docs natif ou plain)

Auth : provider OAuth « google » (partagé avec Gmail). Scope requis :
`https://www.googleapis.com/auth/drive.file` (par défaut dans le registry).
"""
from __future__ import annotations

from typing import Any
import httpx

from backend.core.agents.wolf_tools import get_user_context


_DRIVE_API = "https://www.googleapis.com/drive/v3"
_DRIVE_UPLOAD = "https://www.googleapis.com/upload/drive/v3"


async def _google_token(user_id: int) -> str | None:
    from backend.core.db.engine import async_session
    from backend.plugins.webhooks.oauth_core import get_user_oauth_token
    async with async_session() as session:
        return await get_user_oauth_token(user_id, "google", session)


async def _drive_request(method: str, path: str, *, params=None, json_body=None, headers_extra=None, base=None) -> dict:
    uid = get_user_context()
    if not uid:
        return {"ok": False, "error": "Authentification requise"}
    token = await _google_token(uid)
    if not token:
        return {"ok": False, "error": "Google non connecté. Va dans Intégrations → Connecter Google."}
    headers = {"Authorization": f"Bearer {token}", "Accept": "application/json"}
    if headers_extra:
        headers.update(headers_extra)
    url = f"{base or _DRIVE_API}{path}"
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            r = await client.request(method, url, params=params, json=json_body, headers=headers)
            if r.status_code >= 400:
                return {"ok": False, "status": r.status_code, "error": r.text[:300]}
            return {"ok": True, "data": r.json() if r.text else {}}
    except Exception as e:
        return {"ok": False, "error": str(e)[:300]}


# ── Schémas ──────────────────────────────────────────────────────────────

TOOL_SCHEMAS: list[dict] = [
    {
        "type": "function",
        "function": {
            "name": "drive_list",
            "description": "Liste les fichiers/dossiers Google Drive accessibles. Supporte les filtres par type MIME et nom.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "Filtre Drive Q (ex: \"name contains 'rapport'\")."},
                    "page_size": {"type": "integer", "description": "Nb max résultats (default 30, max 100).", "default": 30},
                    "order_by": {"type": "string", "description": "modifiedTime desc | name | createdTime desc", "default": "modifiedTime desc"},
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "drive_read",
            "description": "Lit le contenu texte d'un fichier Drive (Google Doc → export texte ; fichier brut → contenu binaire pour les types texte).",
            "parameters": {
                "type": "object",
                "properties": {
                    "file_id": {"type": "string", "description": "ID Drive du fichier."},
                },
                "required": ["file_id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "drive_search",
            "description": "Recherche full-text dans Google Drive (équivalent du champ recherche de l'UI).",
            "parameters": {
                "type": "object",
                "properties": {
                    "text": {"type": "string", "description": "Texte à rechercher (recherché dans nom + contenu)."},
                    "page_size": {"type": "integer", "default": 20},
                },
                "required": ["text"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "drive_upload",
            "description": "Crée un fichier dans Google Drive avec le contenu texte fourni. Si `as_doc` true, conversion en Google Doc natif.",
            "parameters": {
                "type": "object",
                "properties": {
                    "name": {"type": "string", "description": "Nom du fichier."},
                    "content": {"type": "string", "description": "Contenu texte (markdown ou plain)."},
                    "as_doc": {"type": "boolean", "description": "Convertir en Google Doc (par défaut false → fichier texte brut).", "default": False},
                    "folder_id": {"type": "string", "description": "ID du dossier parent (optionnel)."},
                },
                "required": ["name", "content"],
            },
        },
    },
]


# ── Executors ────────────────────────────────────────────────────────────

async def _drive_list(query: str = "", page_size: int = 30, order_by: str = "modifiedTime desc") -> dict:
    params = {
        "pageSize": min(int(page_size), 100),
        "orderBy": order_by,
        "fields": "files(id,name,mimeType,modifiedTime,size,webViewLink,parents)",
    }
    if query:
        params["q"] = query
    res = await _drive_request("GET", "/files", params=params)
    if not res.get("ok"):
        return res
    files = (res.get("data") or {}).get("files", [])
    return {"ok": True, "count": len(files), "files": files}


async def _drive_read(file_id: str) -> dict:
    # Récupère métadonnées + détermine méthode d'extraction
    meta = await _drive_request("GET", f"/files/{file_id}", params={"fields": "id,name,mimeType,size"})
    if not meta.get("ok"):
        return meta
    info = meta.get("data") or {}
    mime = info.get("mimeType", "")
    name = info.get("name", "")
    # Google Docs natifs → export
    if mime.startswith("application/vnd.google-apps."):
        export_map = {
            "application/vnd.google-apps.document": "text/plain",
            "application/vnd.google-apps.spreadsheet": "text/csv",
            "application/vnd.google-apps.presentation": "text/plain",
        }
        export_mime = export_map.get(mime)
        if not export_mime:
            return {"ok": False, "error": f"Type {mime} non exportable en texte."}
        uid = get_user_context()
        token = await _google_token(uid)
        async with httpx.AsyncClient(timeout=30.0) as client:
            r = await client.get(
                f"{_DRIVE_API}/files/{file_id}/export",
                params={"mimeType": export_mime},
                headers={"Authorization": f"Bearer {token}"},
            )
            if r.status_code >= 400:
                return {"ok": False, "status": r.status_code, "error": r.text[:300]}
            text = r.text[:50000]  # cap
            return {"ok": True, "name": name, "mime": export_mime, "content": text}
    # Fichier brut texte
    if mime.startswith("text/") or mime in ("application/json", "application/xml"):
        uid = get_user_context()
        token = await _google_token(uid)
        async with httpx.AsyncClient(timeout=30.0) as client:
            r = await client.get(
                f"{_DRIVE_API}/files/{file_id}",
                params={"alt": "media"},
                headers={"Authorization": f"Bearer {token}"},
            )
            if r.status_code >= 400:
                return {"ok": False, "status": r.status_code, "error": r.text[:300]}
            return {"ok": True, "name": name, "mime": mime, "content": r.text[:50000]}
    return {"ok": False, "error": f"Lecture binaire non supportée (mime={mime}). Utilise un Google Doc ou un fichier texte."}


async def _drive_search(text: str, page_size: int = 20) -> dict:
    # Drive Q : on quote le texte. fullText pour le contenu, name pour le titre.
    safe = text.replace("'", "\\'")
    q = f"(fullText contains '{safe}' or name contains '{safe}') and trashed = false"
    return await _drive_list(query=q, page_size=page_size)


async def _drive_upload(name: str, content: str, as_doc: bool = False, folder_id: str = "") -> dict:
    uid = get_user_context()
    if not uid:
        return {"ok": False, "error": "Authentification requise"}
    token = await _google_token(uid)
    if not token:
        return {"ok": False, "error": "Google non connecté."}
    metadata: dict = {"name": name}
    if as_doc:
        metadata["mimeType"] = "application/vnd.google-apps.document"
    if folder_id:
        metadata["parents"] = [folder_id]
    # Multipart upload
    boundary = "gungnirboundary"
    body_parts = [
        f"--{boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n",
        __import__("json").dumps(metadata) + "\r\n",
        f"--{boundary}\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n",
        content + "\r\n",
        f"--{boundary}--",
    ]
    body = "".join(body_parts).encode("utf-8")
    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            r = await client.post(
                f"{_DRIVE_UPLOAD}/files",
                params={"uploadType": "multipart", "fields": "id,name,webViewLink"},
                content=body,
                headers={
                    "Authorization": f"Bearer {token}",
                    "Content-Type": f"multipart/related; boundary={boundary}",
                },
            )
            if r.status_code >= 400:
                return {"ok": False, "status": r.status_code, "error": r.text[:300]}
            data = r.json()
            return {"ok": True, "id": data.get("id"), "name": data.get("name"), "url": data.get("webViewLink")}
    except Exception as e:
        return {"ok": False, "error": str(e)[:300]}


EXECUTORS: dict[str, Any] = {
    "drive_list": _drive_list,
    "drive_read": _drive_read,
    "drive_search": _drive_search,
    "drive_upload": _drive_upload,
}
