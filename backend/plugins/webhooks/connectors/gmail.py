"""
Connector Gmail — recherche, lecture, envoi.

Tools :
- gmail_search   : recherche de mails (syntaxe Gmail standard supportée)
- gmail_read     : lit le contenu d'un mail (subject + body texte)
- gmail_send     : envoie un mail
- gmail_label    : applique/retire des labels sur un mail (archiver, marquer lu, …)

Auth : provider OAuth « google » (partagé avec Drive). Scope :
`https://www.googleapis.com/auth/gmail.modify`.
"""
from __future__ import annotations

import base64
from email.message import EmailMessage
from typing import Any
import httpx

from backend.core.agents.wolf_tools import get_user_context


_GMAIL_API = "https://gmail.googleapis.com/gmail/v1"


async def _google_token(user_id: int) -> str | None:
    from backend.core.db.engine import async_session
    from backend.plugins.webhooks.oauth_core import get_user_oauth_token
    async with async_session() as session:
        return await get_user_oauth_token(user_id, "google", session)


async def _gmail_request(method: str, path: str, *, params=None, json_body=None) -> dict:
    uid = get_user_context()
    if not uid:
        return {"ok": False, "error": "Authentification requise"}
    token = await _google_token(uid)
    if not token:
        return {"ok": False, "error": "Google non connecté. Va dans Intégrations → Connecter Google."}
    headers = {"Authorization": f"Bearer {token}", "Accept": "application/json"}
    url = f"{_GMAIL_API}{path}"
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            r = await client.request(method, url, params=params, json=json_body, headers=headers)
            if r.status_code >= 400:
                return {"ok": False, "status": r.status_code, "error": r.text[:300]}
            return {"ok": True, "data": r.json() if r.text else {}}
    except Exception as e:
        return {"ok": False, "error": str(e)[:300]}


def _decode_b64url(s: str) -> bytes:
    if not s:
        return b""
    pad = "=" * (-len(s) % 4)
    return base64.urlsafe_b64decode(s + pad)


def _extract_text_from_payload(payload: dict) -> str:
    """Parcourt récursivement le payload pour extraire text/plain (fallback HTML brut stripped)."""
    if not payload:
        return ""
    mime = payload.get("mimeType", "")
    body = payload.get("body", {}) or {}
    data = body.get("data")
    parts = payload.get("parts") or []
    if mime == "text/plain" and data:
        return _decode_b64url(data).decode("utf-8", errors="replace")
    for p in parts:
        text = _extract_text_from_payload(p)
        if text:
            return text
    # Fallback HTML stripped
    if mime == "text/html" and data:
        import re
        html = _decode_b64url(data).decode("utf-8", errors="replace")
        return re.sub(r"<[^>]+>", " ", re.sub(r"\s+", " ", html))
    return ""


# ── Schémas ──────────────────────────────────────────────────────────────

TOOL_SCHEMAS: list[dict] = [
    {
        "type": "function",
        "function": {
            "name": "gmail_search",
            "description": "Recherche dans Gmail (syntaxe complète supportée : from:, to:, subject:, has:attachment, after:, etc.).",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "Requête Gmail (ex: 'from:boss@x.com is:unread newer_than:7d')."},
                    "max_results": {"type": "integer", "description": "Nb max résultats (default 20, max 100).", "default": 20},
                },
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "gmail_read",
            "description": "Lit un mail (sujet + expéditeur + corps texte).",
            "parameters": {
                "type": "object",
                "properties": {
                    "message_id": {"type": "string"},
                },
                "required": ["message_id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "gmail_send",
            "description": "Envoie un email depuis le compte Gmail connecté.",
            "parameters": {
                "type": "object",
                "properties": {
                    "to": {"type": "string", "description": "Destinataire (email)."},
                    "subject": {"type": "string"},
                    "body": {"type": "string", "description": "Corps texte (markdown OK, sera envoyé en text/plain)."},
                    "cc": {"type": "string", "description": "CC (optionnel, plusieurs séparés par virgule)."},
                },
                "required": ["to", "subject", "body"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "gmail_label",
            "description": "Applique ou retire des labels sur un mail (ex: archiver = retirer INBOX, marquer lu = retirer UNREAD, mettre en STARRED, etc.).",
            "parameters": {
                "type": "object",
                "properties": {
                    "message_id": {"type": "string"},
                    "add": {"type": "array", "items": {"type": "string"}, "description": "Labels à ajouter (ex: STARRED, IMPORTANT, ou ID custom)."},
                    "remove": {"type": "array", "items": {"type": "string"}, "description": "Labels à retirer (ex: UNREAD, INBOX)."},
                },
                "required": ["message_id"],
            },
        },
    },
]


# ── Executors ────────────────────────────────────────────────────────────

async def _gmail_search(query: str, max_results: int = 20) -> dict:
    res = await _gmail_request("GET", "/users/me/messages", params={
        "q": query, "maxResults": min(int(max_results), 100),
    })
    if not res.get("ok"):
        return res
    msgs = (res.get("data") or {}).get("messages", []) or []
    # On enrichit avec les headers basiques pour chaque message
    out = []
    for m in msgs[:30]:  # limite secondaire pour la perf (20 fetch additionnels max)
        meta = await _gmail_request(
            "GET", f"/users/me/messages/{m['id']}",
            params={"format": "metadata", "metadataHeaders": "Subject,From,Date"},
        )
        if meta.get("ok"):
            data = meta["data"]
            headers = {h["name"]: h["value"] for h in (data.get("payload", {}).get("headers", []) or [])}
            out.append({
                "id": m["id"],
                "thread_id": data.get("threadId"),
                "snippet": data.get("snippet", ""),
                "subject": headers.get("Subject", ""),
                "from": headers.get("From", ""),
                "date": headers.get("Date", ""),
            })
    return {"ok": True, "count": len(out), "messages": out}


async def _gmail_read(message_id: str) -> dict:
    res = await _gmail_request("GET", f"/users/me/messages/{message_id}", params={"format": "full"})
    if not res.get("ok"):
        return res
    data = res.get("data") or {}
    payload = data.get("payload", {}) or {}
    headers = {h["name"]: h["value"] for h in (payload.get("headers", []) or [])}
    body = _extract_text_from_payload(payload)
    return {
        "ok": True,
        "id": message_id,
        "thread_id": data.get("threadId"),
        "subject": headers.get("Subject", ""),
        "from": headers.get("From", ""),
        "to": headers.get("To", ""),
        "date": headers.get("Date", ""),
        "snippet": data.get("snippet", ""),
        "body": body[:20000],
    }


async def _gmail_send(to: str, subject: str, body: str, cc: str = "") -> dict:
    msg = EmailMessage()
    msg["To"] = to
    if cc:
        msg["Cc"] = cc
    msg["Subject"] = subject
    msg.set_content(body)
    raw = base64.urlsafe_b64encode(msg.as_bytes()).decode().rstrip("=")
    res = await _gmail_request("POST", "/users/me/messages/send", json_body={"raw": raw})
    if not res.get("ok"):
        return res
    data = res.get("data") or {}
    return {"ok": True, "id": data.get("id"), "thread_id": data.get("threadId")}


async def _gmail_label(message_id: str, add: list | None = None, remove: list | None = None) -> dict:
    body: dict = {}
    if add:
        body["addLabelIds"] = list(add)
    if remove:
        body["removeLabelIds"] = list(remove)
    if not body:
        return {"ok": False, "error": "Aucun label à modifier."}
    res = await _gmail_request("POST", f"/users/me/messages/{message_id}/modify", json_body=body)
    if not res.get("ok"):
        return res
    data = res.get("data") or {}
    return {"ok": True, "id": message_id, "labels": data.get("labelIds", [])}


EXECUTORS: dict[str, Any] = {
    "gmail_search": _gmail_search,
    "gmail_read": _gmail_read,
    "gmail_send": _gmail_send,
    "gmail_label": _gmail_label,
}
