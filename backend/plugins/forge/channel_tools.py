"""
Forge — wolf_tool channel_send : envoi générique vers les canaux Gungnir.

Route vers le bon protocole (Telegram/Discord/Slack/Email/etc.) en se
basant sur le type du canal stocké dans `data/channels/<uid>/channels.json`.

L'agent / le workflow n'a pas à connaître les détails de chaque API ;
il appelle juste channel_send avec un channel_id (ou nom) et un message.

Convention :
- channel_id : l'ID stable du canal Gungnir (UUID retourné par /channels)
- chat_id   : optionnel, ID du chat distant (chat Telegram, channel Slack…).
              Si absent, on tente d'utiliser le default_chat_id de la config.
- message   : texte à envoyer (auto-split si trop long pour la cible)
"""
from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any, Optional

from backend.core.agents.wolf_tools import get_user_context

logger = logging.getLogger("gungnir.plugins.forge.channel_tools")

CHANNELS_BASE = Path("data/channels")


CHANNEL_TOOL_SCHEMAS: list[dict] = [
    {
        "type": "function",
        "function": {
            "name": "channel_send",
            "description": (
                "Envoie un message via un canal Gungnir (Telegram, Discord, Slack, "
                "WhatsApp, Email, etc.). Le canal doit être configuré dans le plugin "
                "Channels. Pour Telegram, fournir chat_id si la cible diffère du chat "
                "par défaut. Pour Discord, l'envoi se fait via webhook_url stocké en config. "
                "Pour Slack, channel_name dans args (ex: '#alertes')."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "channel_id": {"type": "string", "description": "ID Gungnir du canal (depuis /api/plugins/channels)."},
                    "channel_name": {"type": "string", "description": "Alternative à channel_id : nom exact du canal."},
                    "message": {"type": "string", "description": "Message à envoyer (sera auto-splitté si dépasse la limite du protocole)."},
                    "chat_id": {"type": "string", "description": "Telegram : chat_id de destination. Si absent, default_chat_id de la config."},
                    "slack_channel": {"type": "string", "description": "Slack : nom de channel destinataire (ex: '#alertes')."},
                },
                "required": ["message"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "channel_list",
            "description": "Liste les canaux Gungnir configurés par l'utilisateur (avec id, nom, type, statut).",
            "parameters": {"type": "object", "properties": {}, "required": []},
        },
    },
]


# ── Helpers ──────────────────────────────────────────────────────────────

def _user_channels_path(user_id: int) -> Path:
    return CHANNELS_BASE / str(user_id) / "channels.json"


def _load_channels_for_user(user_id: int) -> list[dict]:
    p = _user_channels_path(user_id)
    if not p.exists():
        return []
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
        if isinstance(data, dict):
            # Format historique : {channel_id: channel_dict}
            return [{"id": k, **v} for k, v in data.items() if isinstance(v, dict)]
        if isinstance(data, list):
            return data
    except Exception as e:
        logger.warning("[forge.channel] failed to load channels for uid=%s : %s", user_id, e)
    return []


def _split_for_protocol(text: str, kind: str) -> list[str]:
    """Split simple : 4096 chars Telegram, 2000 chars Discord, 4000 Slack."""
    limits = {"telegram": 4000, "discord": 1990, "slack": 3900}
    max_len = limits.get(kind, 4000)
    if len(text) <= max_len:
        return [text]
    # Coupe sur les sauts de ligne pour rester lisible.
    parts: list[str] = []
    cur = ""
    for line in text.split("\n"):
        if len(cur) + len(line) + 1 > max_len:
            if cur: parts.append(cur)
            cur = line
        else:
            cur = (cur + "\n" + line) if cur else line
    if cur: parts.append(cur)
    return parts or [text[:max_len]]


# ── Senders par protocole ────────────────────────────────────────────────

async def _send_telegram(channel: dict, message: str, chat_id: Optional[str]) -> dict:
    cfg = channel.get("config") or {}
    token = cfg.get("bot_token") or cfg.get("token")
    if not token:
        return {"ok": False, "error": "Telegram : bot_token absent dans la config du canal"}
    target = chat_id or cfg.get("default_chat_id") or cfg.get("chat_id")
    if not target:
        return {"ok": False, "error": "Telegram : chat_id requis (pas de default_chat_id configuré)"}
    import httpx
    parts = _split_for_protocol(message, "telegram")
    sent = 0
    last_status = 200
    last_err = ""
    async with httpx.AsyncClient(timeout=20.0) as client:
        for part in parts:
            try:
                resp = await client.post(
                    f"https://api.telegram.org/bot{token}/sendMessage",
                    json={"chat_id": target, "text": part},
                )
                last_status = resp.status_code
                if resp.status_code == 200:
                    sent += 1
                else:
                    last_err = resp.text[:300]
                    break
            except Exception as e:
                last_err = str(e); break
    return {"ok": sent == len(parts), "sent_parts": sent, "total_parts": len(parts),
            "status": last_status, "error": last_err or None,
            "protocol": "telegram", "chat_id": target}


async def _send_discord(channel: dict, message: str) -> dict:
    cfg = channel.get("config") or {}
    webhook_url = cfg.get("webhook_url")
    if not webhook_url:
        return {"ok": False, "error": "Discord : webhook_url absent dans la config du canal"}
    import httpx
    parts = _split_for_protocol(message, "discord")
    sent = 0
    last_err = ""
    async with httpx.AsyncClient(timeout=20.0) as client:
        for part in parts:
            try:
                resp = await client.post(webhook_url, json={"content": part})
                if resp.status_code in (200, 204):
                    sent += 1
                else:
                    last_err = f"{resp.status_code} {resp.text[:200]}"
                    break
            except Exception as e:
                last_err = str(e); break
    return {"ok": sent == len(parts), "sent_parts": sent, "total_parts": len(parts),
            "error": last_err or None, "protocol": "discord"}


async def _send_slack(channel: dict, message: str, slack_channel: Optional[str]) -> dict:
    cfg = channel.get("config") or {}
    bot_token = cfg.get("bot_token")
    target = slack_channel or cfg.get("default_channel") or cfg.get("channel")
    if not bot_token or not target:
        return {"ok": False, "error": "Slack : bot_token et channel requis"}
    import httpx
    async with httpx.AsyncClient(timeout=20.0) as client:
        try:
            resp = await client.post(
                "https://slack.com/api/chat.postMessage",
                headers={"Authorization": f"Bearer {bot_token}",
                         "Content-Type": "application/json"},
                json={"channel": target, "text": message},
            )
            data = resp.json()
            if not data.get("ok"):
                return {"ok": False, "error": f"Slack: {data.get('error', '?')}", "raw": data}
            return {"ok": True, "ts": data.get("ts"), "channel": data.get("channel"),
                    "protocol": "slack"}
        except Exception as e:
            return {"ok": False, "error": str(e)}


async def _send_email(channel: dict, message: str, chat_id: Optional[str]) -> dict:
    """`chat_id` est utilisé comme adresse email destinataire si fourni."""
    cfg = channel.get("config") or {}
    smtp_host = cfg.get("smtp_host")
    smtp_user = cfg.get("smtp_user") or cfg.get("user")
    smtp_pass = cfg.get("smtp_password") or cfg.get("password")
    to_addr = chat_id or cfg.get("default_to") or smtp_user
    if not (smtp_host and smtp_user and smtp_pass and to_addr):
        return {"ok": False, "error": "Email : config SMTP incomplète (smtp_host, smtp_user, smtp_password, default_to)"}
    try:
        import aiosmtplib
        from email.message import EmailMessage
        msg = EmailMessage()
        msg["From"] = smtp_user
        msg["To"] = to_addr
        msg["Subject"] = (cfg.get("subject_prefix") or "[Forge] ") + message[:60]
        msg.set_content(message)
        await aiosmtplib.send(
            msg, hostname=smtp_host,
            port=int(cfg.get("smtp_port") or 587),
            username=smtp_user, password=smtp_pass,
            start_tls=cfg.get("smtp_tls", True),
        )
        return {"ok": True, "to": to_addr, "protocol": "email"}
    except ImportError:
        return {"ok": False, "error": "aiosmtplib non installé côté backend"}
    except Exception as e:
        return {"ok": False, "error": f"Email : {e}"}


# ── Executors ────────────────────────────────────────────────────────────

async def _channel_send(message: str,
                         channel_id: Optional[str] = None,
                         channel_name: Optional[str] = None,
                         chat_id: Optional[str] = None,
                         slack_channel: Optional[str] = None) -> dict:
    uid = get_user_context()
    if not uid:
        return {"ok": False, "error": "Utilisateur non authentifié."}
    if not (channel_id or channel_name):
        return {"ok": False, "error": "channel_id ou channel_name requis"}
    if not (message or "").strip():
        return {"ok": False, "error": "Message vide"}

    channels = _load_channels_for_user(uid)
    target: Optional[dict] = None
    if channel_id:
        target = next((c for c in channels if str(c.get("id")) == str(channel_id)), None)
    if not target and channel_name:
        target = next((c for c in channels
                       if (c.get("name") or "").lower() == channel_name.lower()), None)
    if not target:
        avail = ", ".join(f"{c.get('id')}={c.get('name', '?')}({c.get('type', '?')})" for c in channels[:8])
        return {"ok": False, "error": f"Canal introuvable. Disponibles : {avail or 'aucun'}"}

    kind = (target.get("type") or "").lower()
    if not target.get("enabled", True):
        return {"ok": False, "error": f"Canal '{target.get('name')}' désactivé"}

    if kind == "telegram":
        return await _send_telegram(target, message, chat_id)
    if kind == "discord":
        return await _send_discord(target, message)
    if kind == "slack":
        return await _send_slack(target, message, slack_channel)
    if kind in ("email", "smtp", "imap"):
        return await _send_email(target, message, chat_id)
    return {"ok": False, "error": f"Type de canal non supporté pour l'envoi : '{kind}'"}


async def _channel_list() -> dict:
    uid = get_user_context()
    if not uid:
        return {"ok": False, "error": "Utilisateur non authentifié."}
    channels = _load_channels_for_user(uid)
    return {"ok": True, "channels": [
        {
            "id": c.get("id"),
            "name": c.get("name", ""),
            "type": c.get("type", ""),
            "enabled": bool(c.get("enabled", True)),
        }
        for c in channels
    ]}


CHANNEL_EXECUTORS: dict[str, Any] = {
    "channel_send":  _channel_send,
    "channel_list":  _channel_list,
}
