"""
Webhooks — agent_tools.py : permet à Gungnir de déclencher ses propres
webhooks sortants depuis le chat.

Sans ces tools, l'agent voyait les webhooks dans `/api/plugins/webhooks/webhooks`
mais ne pouvait pas les invoquer — gap pour les workflows de notification
(Slack, Discord webhook, IFTTT, Zapier, n8n…).

Convention auto-découverte : `TOOL_SCHEMAS` + `EXECUTORS` agrégés par
`backend/core/agents/wolf_tools.py` au boot.
"""
from __future__ import annotations

import json
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any, Optional

from backend.core.agents.wolf_tools import get_user_context


_DATA_DIR = Path("data")


def _user_dir(uid: int) -> Path:
    p = _DATA_DIR / "webhooks" / str(uid)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.mkdir(exist_ok=True)
    return p


def _load_json(path: Path, default):
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default


def _save_json(path: Path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


# ── Schémas ──────────────────────────────────────────────────────────────

TOOL_SCHEMAS: list[dict] = [
    {
        "type": "function",
        "function": {
            "name": "webhook_list",
            "description": "Liste les webhooks configurés (entrants + sortants). Les secrets sont masqués.",
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "webhook_trigger",
            "description": (
                "Déclenche un webhook SORTANT par son id. Envoie le `payload` JSON "
                "vers l'URL configurée du webhook. Utile pour notifier Slack/"
                "Discord/n8n/Zapier/IFTTT depuis le chat (« notifie sur Slack… »)."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "webhook_id": {"type": "string", "description": "ID court du webhook (8 chars). Voir webhook_list."},
                    "payload": {"type": "object", "description": "Corps JSON à envoyer (clés/valeurs libres)."},
                },
                "required": ["webhook_id", "payload"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "webhook_logs",
            "description": "Liste les derniers logs de webhooks (entrants reçus + sortants déclenchés). Utile pour debug.",
            "parameters": {
                "type": "object",
                "properties": {
                    "limit": {"type": "integer", "description": "Nombre max d'entrées (default 20).", "default": 20},
                },
            },
        },
    },
]


# ── Executors ────────────────────────────────────────────────────────────

async def _webhook_list() -> dict:
    uid = get_user_context()
    if not uid:
        return {"ok": False, "error": "Utilisateur non authentifié."}
    f = _user_dir(uid) / "webhooks.json"
    webhooks = _load_json(f, [])
    for wh in webhooks:
        if wh.get("secret"):
            wh["secret"] = "***"
    return {"ok": True, "count": len(webhooks), "webhooks": webhooks}


async def _webhook_trigger(webhook_id: str, payload: dict) -> dict:
    uid = get_user_context()
    if not uid:
        return {"ok": False, "error": "Utilisateur non authentifié."}
    import httpx

    base = _user_dir(uid)
    webhooks = _load_json(base / "webhooks.json", [])
    wh = next((w for w in webhooks if w.get("id") == webhook_id), None)
    if not wh:
        return {"ok": False, "error": f"Webhook `{webhook_id}` introuvable."}
    if wh.get("direction") != "outgoing":
        return {"ok": False, "error": "Ce webhook n'est pas sortant."}
    if not wh.get("enabled", True):
        return {"ok": False, "error": "Webhook désactivé."}
    if not wh.get("url"):
        return {"ok": False, "error": "URL non configurée."}

    headers = {**(wh.get("headers", {}) or {}), "Content-Type": "application/json"}
    if wh.get("secret"):
        headers["X-Webhook-Secret"] = wh["secret"]

    log_entry = {
        "id": str(uuid.uuid4())[:8],
        "webhook_id": webhook_id,
        "webhook_name": wh.get("name", webhook_id),
        "direction": "outgoing",
        "timestamp": datetime.now().isoformat(),
        "url": wh["url"],
        "payload": payload,
    }

    try:
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.post(wh["url"], json=payload, headers=headers)
            log_entry["status"] = "sent"
            log_entry["response_status"] = resp.status_code
            log_entry["response_body"] = resp.text[:500]
        success = True
    except Exception as e:
        log_entry["status"] = "error"
        log_entry["error"] = str(e)[:300]
        success = False

    logs = _load_json(base / "webhook_logs.json", [])
    logs.insert(0, log_entry)
    if len(logs) > 200:
        logs = logs[:200]
    _save_json(base / "webhook_logs.json", logs)

    return {"ok": success, "log": log_entry}


async def _webhook_logs(limit: int = 20) -> dict:
    uid = get_user_context()
    if not uid:
        return {"ok": False, "error": "Utilisateur non authentifié."}
    logs = _load_json(_user_dir(uid) / "webhook_logs.json", [])
    return {"ok": True, "count": len(logs), "logs": logs[: int(limit)]}


EXECUTORS: dict[str, Any] = {
    "webhook_list": _webhook_list,
    "webhook_trigger": _webhook_trigger,
    "webhook_logs": _webhook_logs,
}

# ── Connectors OAuth — agrégation auto ──────────────────────────────────
# Chaque module dans connectors/ expose ses propres TOOL_SCHEMAS + EXECUTORS.
# On les merge ici pour qu'ils soient découverts par wolf_tools._discover_plugin_tools().
def _aggregate_connectors() -> None:
    import importlib
    import pkgutil
    try:
        from backend.plugins.webhooks import connectors as _conn_pkg
    except Exception:
        return
    for _modinfo in pkgutil.iter_modules(_conn_pkg.__path__):
        try:
            _mod = importlib.import_module(f"backend.plugins.webhooks.connectors.{_modinfo.name}")
            schemas = getattr(_mod, "TOOL_SCHEMAS", []) or []
            execs = getattr(_mod, "EXECUTORS", {}) or {}
            if schemas:
                TOOL_SCHEMAS.extend(schemas)
            if execs:
                EXECUTORS.update(execs)
        except Exception as _e:
            import logging
            logging.getLogger("gungnir.webhooks").warning(
                f"Connector {_modinfo.name} failed to load: {_e}"
            )


_aggregate_connectors()
