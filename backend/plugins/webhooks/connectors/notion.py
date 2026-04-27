"""
Connector Notion — recherche, lecture, écriture de pages et databases.

Tools :
- notion_search       : recherche full-text (pages + databases)
- notion_read_page    : récupère le contenu d'une page (blocs convertis en markdown)
- notion_append_page  : ajoute du contenu à la fin d'une page (blocs paragraphes)
- notion_query_db     : query une database (filtrage + tri)
- notion_create_page  : crée une page dans un parent (page ou database)

Auth : provider OAuth « notion ». Notion utilise un token longue durée
(pas de refresh).
"""
from __future__ import annotations

from typing import Any
import httpx

from backend.core.agents.wolf_tools import get_user_context


_NOTION_API = "https://api.notion.com/v1"
_NOTION_VERSION = "2022-06-28"


async def _notion_token(user_id: int) -> str | None:
    from backend.core.db.engine import async_session
    from backend.plugins.webhooks.oauth_core import get_user_oauth_token
    async with async_session() as session:
        return await get_user_oauth_token(user_id, "notion", session)


async def _notion_request(method: str, path: str, *, params=None, json_body=None) -> dict:
    uid = get_user_context()
    if not uid:
        return {"ok": False, "error": "Authentification requise"}
    token = await _notion_token(uid)
    if not token:
        return {"ok": False, "error": "Notion non connecté. Va dans Intégrations → Connecter Notion."}
    headers = {
        "Authorization": f"Bearer {token}",
        "Notion-Version": _NOTION_VERSION,
        "Content-Type": "application/json",
    }
    url = f"{_NOTION_API}{path}"
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            r = await client.request(method, url, params=params, json=json_body, headers=headers)
            if r.status_code >= 400:
                return {"ok": False, "status": r.status_code, "error": r.text[:300]}
            return {"ok": True, "data": r.json() if r.text else {}}
    except Exception as e:
        return {"ok": False, "error": str(e)[:300]}


def _rich_text_to_str(rich: list) -> str:
    """Concatène les segments rich_text Notion en texte brut."""
    return "".join((seg.get("plain_text") or "") for seg in (rich or []))


def _block_to_markdown(block: dict) -> str:
    btype = block.get("type", "")
    data = block.get(btype, {}) or {}
    rich = data.get("rich_text", []) or data.get("text", [])
    text = _rich_text_to_str(rich)
    if btype == "paragraph":
        return text
    if btype == "heading_1":
        return f"# {text}"
    if btype == "heading_2":
        return f"## {text}"
    if btype == "heading_3":
        return f"### {text}"
    if btype == "bulleted_list_item":
        return f"- {text}"
    if btype == "numbered_list_item":
        return f"1. {text}"
    if btype == "quote":
        return f"> {text}"
    if btype == "code":
        lang = data.get("language", "")
        return f"```{lang}\n{text}\n```"
    if btype == "to_do":
        checked = "x" if data.get("checked") else " "
        return f"- [{checked}] {text}"
    if btype == "divider":
        return "---"
    return text


# ── Schémas ──────────────────────────────────────────────────────────────

TOOL_SCHEMAS: list[dict] = [
    {
        "type": "function",
        "function": {
            "name": "notion_search",
            "description": "Recherche full-text dans Notion (pages + databases visibles par l'app OAuth).",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string"},
                    "filter_type": {"type": "string", "description": "page | database (optionnel, filtre le type d'objet)."},
                    "page_size": {"type": "integer", "default": 20},
                },
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "notion_read_page",
            "description": "Récupère le contenu d'une page Notion (blocs convertis en markdown).",
            "parameters": {
                "type": "object",
                "properties": {
                    "page_id": {"type": "string"},
                },
                "required": ["page_id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "notion_append_page",
            "description": "Ajoute du contenu à la fin d'une page (paragraphes simples). Pour du formatage avancé, utilise plutôt l'éditeur Notion.",
            "parameters": {
                "type": "object",
                "properties": {
                    "page_id": {"type": "string"},
                    "content": {"type": "string", "description": "Texte à ajouter (lignes séparées par \\n créent des paragraphes distincts)."},
                },
                "required": ["page_id", "content"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "notion_query_db",
            "description": "Query une database Notion. Renvoie les pages avec leurs propriétés.",
            "parameters": {
                "type": "object",
                "properties": {
                    "database_id": {"type": "string"},
                    "page_size": {"type": "integer", "default": 30},
                },
                "required": ["database_id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "notion_create_page",
            "description": "Crée une nouvelle page sous un parent (page ou database). Pour une database, fournis les properties au format Notion.",
            "parameters": {
                "type": "object",
                "properties": {
                    "parent_id": {"type": "string", "description": "ID du parent (page ou database)."},
                    "parent_type": {"type": "string", "description": "page | database (default: page).", "default": "page"},
                    "title": {"type": "string", "description": "Titre de la page."},
                    "content": {"type": "string", "description": "Contenu initial (paragraphes texte). Ignoré pour les databases si tu fournis `properties`."},
                    "properties": {"type": "object", "description": "Properties Notion (pour parent=database). Format Notion natif."},
                },
                "required": ["parent_id", "title"],
            },
        },
    },
]


# ── Executors ────────────────────────────────────────────────────────────

async def _notion_search(query: str, filter_type: str = "", page_size: int = 20) -> dict:
    body: dict = {"query": query, "page_size": min(int(page_size), 100)}
    if filter_type in ("page", "database"):
        body["filter"] = {"value": filter_type, "property": "object"}
    res = await _notion_request("POST", "/search", json_body=body)
    if not res.get("ok"):
        return res
    items = (res.get("data") or {}).get("results", [])
    out = []
    for it in items:
        title = ""
        # Pages : title est dans properties.<title prop>.title
        # Databases : title est directement dans .title
        if it.get("object") == "database":
            title = _rich_text_to_str(it.get("title", []))
        else:
            for prop in (it.get("properties") or {}).values():
                if prop.get("type") == "title":
                    title = _rich_text_to_str(prop.get("title", []))
                    break
        out.append({
            "id": it.get("id"),
            "object": it.get("object"),
            "title": title,
            "url": it.get("url"),
            "last_edited_time": it.get("last_edited_time"),
        })
    return {"ok": True, "count": len(out), "results": out}


async def _notion_read_page(page_id: str) -> dict:
    # Récupère la page (pour le titre) puis ses blocs
    page_res = await _notion_request("GET", f"/pages/{page_id}")
    if not page_res.get("ok"):
        return page_res
    page_data = page_res.get("data") or {}
    title = ""
    for prop in (page_data.get("properties") or {}).values():
        if prop.get("type") == "title":
            title = _rich_text_to_str(prop.get("title", []))
            break

    # Blocs (cap à 100 ; pour pages très longues, l'agent peut paginer ensuite)
    blocks_res = await _notion_request("GET", f"/blocks/{page_id}/children", params={"page_size": 100})
    if not blocks_res.get("ok"):
        return blocks_res
    blocks = (blocks_res.get("data") or {}).get("results", [])
    md_lines = [_block_to_markdown(b) for b in blocks]
    md = "\n\n".join(line for line in md_lines if line)
    return {
        "ok": True, "id": page_id, "title": title,
        "url": page_data.get("url"),
        "markdown": md[:30000],
    }


async def _notion_append_page(page_id: str, content: str) -> dict:
    paragraphs = [p.strip() for p in content.split("\n") if p.strip()]
    if not paragraphs:
        return {"ok": False, "error": "Contenu vide."}
    children = [
        {
            "object": "block",
            "type": "paragraph",
            "paragraph": {
                "rich_text": [{"type": "text", "text": {"content": p[:2000]}}],
            },
        }
        for p in paragraphs[:50]  # cap
    ]
    res = await _notion_request("PATCH", f"/blocks/{page_id}/children", json_body={"children": children})
    if not res.get("ok"):
        return res
    return {"ok": True, "appended_blocks": len(children)}


async def _notion_query_db(database_id: str, page_size: int = 30) -> dict:
    res = await _notion_request("POST", f"/databases/{database_id}/query", json_body={
        "page_size": min(int(page_size), 100),
    })
    if not res.get("ok"):
        return res
    items = (res.get("data") or {}).get("results", [])
    out = []
    for it in items:
        props_simple: dict = {}
        for name, prop in (it.get("properties") or {}).items():
            ptype = prop.get("type", "")
            val = prop.get(ptype)
            if ptype == "title" or ptype == "rich_text":
                props_simple[name] = _rich_text_to_str(val or [])
            elif ptype == "select":
                props_simple[name] = (val or {}).get("name")
            elif ptype == "multi_select":
                props_simple[name] = [v.get("name") for v in (val or [])]
            elif ptype == "checkbox":
                props_simple[name] = bool(val)
            elif ptype == "date":
                props_simple[name] = (val or {}).get("start")
            elif ptype in ("number", "url", "email", "phone_number"):
                props_simple[name] = val
        out.append({
            "id": it.get("id"),
            "url": it.get("url"),
            "properties": props_simple,
        })
    return {"ok": True, "count": len(out), "items": out}


async def _notion_create_page(parent_id: str, title: str, parent_type: str = "page", content: str = "", properties: dict | None = None) -> dict:
    parent: dict
    if parent_type == "database":
        parent = {"database_id": parent_id}
    else:
        parent = {"page_id": parent_id}
    body: dict = {"parent": parent}

    if parent_type == "database" and properties:
        body["properties"] = properties
    else:
        # Page sous une page : title via properties Title (toujours nommée "title" pour les pages enfants)
        body["properties"] = {
            "title": {"title": [{"type": "text", "text": {"content": title[:200]}}]},
        }
    if content:
        paragraphs = [p.strip() for p in content.split("\n") if p.strip()]
        body["children"] = [
            {
                "object": "block", "type": "paragraph",
                "paragraph": {"rich_text": [{"type": "text", "text": {"content": p[:2000]}}]},
            }
            for p in paragraphs[:50]
        ]
    res = await _notion_request("POST", "/pages", json_body=body)
    if not res.get("ok"):
        return res
    data = res.get("data") or {}
    return {"ok": True, "id": data.get("id"), "url": data.get("url")}


EXECUTORS: dict[str, Any] = {
    "notion_search": _notion_search,
    "notion_read_page": _notion_read_page,
    "notion_append_page": _notion_append_page,
    "notion_query_db": _notion_query_db,
    "notion_create_page": _notion_create_page,
}
