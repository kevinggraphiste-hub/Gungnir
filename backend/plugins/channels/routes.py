"""
Gungnir Plugin — Channels
Canaux de communication externes : Telegram, Discord, Slack, WhatsApp, Email, Web Widget, API.
Chaque canal expose un endpoint de réception des messages et les route vers le chat Gungnir.
Indépendant — lit uniquement la config core via Settings.load().
"""
import json
import uuid
import hmac
import hashlib
import asyncio
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional
from pydantic import BaseModel, Field
from fastapi import APIRouter, HTTPException, Request, Response

router = APIRouter()

# ── Data persistence (per-user) ─────────────────────────────────────
# Layout:
#   data/channels/_index.json            → {channel_owner: {channel_id: user_id}}
#   data/channels/{uid}/channels.json    → {channel_id: channel_obj}
#   data/channels/{uid}/channel_logs.json → [log_entries]
#
# Auto-migrates from legacy layout (data/channels.json + data/channel_logs.json)
# on module import if the new structure is missing.
DATA_DIR = Path(__file__).parent.parent.parent.parent / "data"
DATA_DIR.mkdir(exist_ok=True)
CHANNELS_BASE = DATA_DIR / "channels"
CHANNELS_INDEX = CHANNELS_BASE / "_index.json"
LEGACY_CHANNELS_FILE = DATA_DIR / "channels.json"
LEGACY_LOGS_FILE = DATA_DIR / "channel_logs.json"

MAX_LOGS = 500
DEFAULT_ORPHAN_OWNER = 1  # kevin/admin — receives logs whose channel_id is unknown

# ── Limites de taille de message par canal ──────────────────────────
# Les sorties d'outils (bash, web_fetch, code_read_file…) peuvent facilement
# dépasser ces limites. On les respecte pour éviter les 400 API, au prix d'un
# split en plusieurs messages successifs côté canal.
CHANNEL_MAX_LEN = {
    "telegram": 4096,
    "discord": 2000,
    "slack": 40000,
    "whatsapp": 4096,
    "email": 100000,
    "web_widget": 100000,
    "api": 100000,
}


def _split_message(text: str, max_len: int) -> list[str]:
    """Découpe un texte en morceaux ≤ max_len sans casser les mots ni les
    blocs de code Markdown (``` ... ```). Préserve le texte tel quel côté
    content — aucune réécriture, juste des breaks bien placés.
    """
    if not text:
        return []
    if len(text) <= max_len:
        return [text]

    parts: list[str] = []
    remaining = text
    while len(remaining) > max_len:
        # Cherche un point de coupure propre : double-newline, puis newline,
        # puis espace. Fallback dur au max_len si aucune option.
        cut = remaining.rfind("\n\n", 0, max_len)
        if cut < max_len // 2:
            cut = remaining.rfind("\n", 0, max_len)
        if cut < max_len // 2:
            cut = remaining.rfind(" ", 0, max_len)
        if cut <= 0:
            cut = max_len
        parts.append(remaining[:cut].rstrip())
        remaining = remaining[cut:].lstrip()
    if remaining:
        parts.append(remaining)
    return parts


def _messages_for_channel(text: str, channel_type: str) -> list[str]:
    """Helper haut-niveau : prend une réponse complète + le type de canal,
    renvoie la liste de messages à envoyer séquentiellement."""
    if not text:
        return []
    max_len = CHANNEL_MAX_LEN.get(channel_type, 4000)
    return _split_message(text, max_len)


def _user_channels_path(user_id: int) -> Path:
    p = CHANNELS_BASE / str(user_id) / "channels.json"
    p.parent.mkdir(parents=True, exist_ok=True)
    return p


def _user_logs_path(user_id: int) -> Path:
    p = CHANNELS_BASE / str(user_id) / "channel_logs.json"
    p.parent.mkdir(parents=True, exist_ok=True)
    return p


def _load_user_channels(user_id: int) -> dict:
    p = _user_channels_path(user_id)
    if p.exists():
        return json.loads(p.read_text(encoding="utf-8"))
    return {}


def _save_user_channels(user_id: int, channels: dict) -> None:
    p = _user_channels_path(user_id)
    p.write_text(json.dumps(channels, indent=2, ensure_ascii=False, default=str), encoding="utf-8")


def _load_user_logs(user_id: int) -> list:
    p = _user_logs_path(user_id)
    if p.exists():
        return json.loads(p.read_text(encoding="utf-8"))
    return []


def _save_user_logs(user_id: int, logs: list) -> None:
    p = _user_logs_path(user_id)
    p.write_text(json.dumps(logs[-MAX_LOGS:], indent=2, ensure_ascii=False, default=str), encoding="utf-8")


def _read_index() -> dict:
    if not CHANNELS_INDEX.exists():
        return {}
    try:
        d = json.loads(CHANNELS_INDEX.read_text(encoding="utf-8"))
        owners = d.get("channel_owner") if isinstance(d, dict) else None
        return owners if isinstance(owners, dict) else {}
    except Exception:
        return {}


def _write_index(index: dict) -> None:
    CHANNELS_BASE.mkdir(parents=True, exist_ok=True)
    current = {}
    if CHANNELS_INDEX.exists():
        try:
            current = json.loads(CHANNELS_INDEX.read_text(encoding="utf-8"))
            if not isinstance(current, dict):
                current = {}
        except Exception:
            current = {}
    current["channel_owner"] = index
    current.setdefault("_migrated_at", datetime.now(timezone.utc).isoformat())
    CHANNELS_INDEX.write_text(json.dumps(current, indent=2, ensure_ascii=False), encoding="utf-8")


def _channel_owner(channel_id: str) -> Optional[int]:
    uid = _read_index().get(channel_id)
    return int(uid) if uid is not None else None


def _register_channel_owner(channel_id: str, user_id: int) -> None:
    idx = _read_index()
    idx[channel_id] = int(user_id)
    _write_index(idx)


def _unregister_channel_owner(channel_id: str) -> None:
    idx = _read_index()
    if channel_id in idx:
        del idx[channel_id]
        _write_index(idx)


def _all_user_dirs() -> list:
    if not CHANNELS_BASE.exists():
        return []
    out = []
    for p in CHANNELS_BASE.iterdir():
        if p.is_dir() and p.name.isdigit():
            out.append(int(p.name))
    return sorted(out)


def _load_channels() -> dict:
    """Aggregate read of all users' channels. Read-only; mutations must go
    through the per-user helpers + index registration."""
    merged = {}
    for uid in _all_user_dirs():
        merged.update(_load_user_channels(uid))
    return merged


def _auto_migrate_legacy() -> None:
    """One-shot migration: legacy data/channels.json + channel_logs.json
    → data/channels/{uid}/. Idempotent; skips if index already exists."""
    if CHANNELS_INDEX.exists():
        return
    if not LEGACY_CHANNELS_FILE.exists() and not LEGACY_LOGS_FILE.exists():
        return
    import logging, shutil as _shutil
    log = logging.getLogger("gungnir.plugins.channels")
    try:
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        channels_by_user: dict = {}
        index: dict = {}
        if LEGACY_CHANNELS_FILE.exists():
            legacy = json.loads(LEGACY_CHANNELS_FILE.read_text(encoding="utf-8"))
            if isinstance(legacy, dict):
                for cid, ch in legacy.items():
                    if not isinstance(ch, dict):
                        continue
                    uid = int(ch.get("user_id") or DEFAULT_ORPHAN_OWNER)
                    index[cid] = uid
                    channels_by_user.setdefault(uid, {})[cid] = ch
            _shutil.copy2(LEGACY_CHANNELS_FILE, LEGACY_CHANNELS_FILE.with_suffix(f".json.bak.{stamp}"))

        logs_by_user: dict = {}
        orphan_count = 0
        if LEGACY_LOGS_FILE.exists():
            legacy_logs = json.loads(LEGACY_LOGS_FILE.read_text(encoding="utf-8"))
            if isinstance(legacy_logs, list):
                for entry in legacy_logs:
                    if not isinstance(entry, dict):
                        continue
                    uid = index.get(entry.get("channel_id"))
                    if uid is None:
                        uid = DEFAULT_ORPHAN_OWNER
                        orphan_count += 1
                    logs_by_user.setdefault(int(uid), []).append(entry)
            _shutil.copy2(LEGACY_LOGS_FILE, LEGACY_LOGS_FILE.with_suffix(f".json.bak.{stamp}"))

        CHANNELS_BASE.mkdir(parents=True, exist_ok=True)
        _write_index(index)
        for uid, channels in channels_by_user.items():
            _save_user_channels(uid, channels)
        for uid, logs in logs_by_user.items():
            _save_user_logs(uid, logs)

        log.info(
            "channels auto-migration OK: %d channels, %d logs (orphans=%d)",
            sum(len(c) for c in channels_by_user.values()),
            sum(len(l) for l in logs_by_user.values()),
            orphan_count,
        )
    except Exception as e:
        log.error("channels auto-migration failed: %s", e)


_auto_migrate_legacy()


def _add_log(channel_id: str, channel_name: str, direction: str, summary: str, status: str = "ok"):
    """Append a log entry under the owning user's file (falls back to admin
    when the channel_id is unknown — e.g. after a deletion or legacy orphan)."""
    uid = _channel_owner(channel_id) or DEFAULT_ORPHAN_OWNER
    logs = _load_user_logs(uid)
    logs.append({
        "id": str(uuid.uuid4())[:8],
        "channel_id": channel_id,
        "channel_name": channel_name,
        "direction": direction,
        "summary": summary,
        "status": status,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    })
    _save_user_logs(uid, logs)


def _mask_secret(value: str | None) -> str | None:
    if not value or len(value) < 8:
        return value
    return value[:4] + "•" * (len(value) - 8) + value[-4:]


def _get_public_base_url(request: Request) -> str:
    """Reconstruct the public base URL from reverse proxy headers.

    Inside Docker, request.base_url returns http://127.0.0.1:8000.
    Nginx forwards X-Forwarded-Proto and Host headers that give us
    the real public URL (e.g. https://gungnir.scarletwolf.cloud).
    """
    proto = request.headers.get("x-forwarded-proto", request.url.scheme)
    host = request.headers.get("host", request.url.netloc)
    return f"{proto}://{host}"


async def _register_telegram_webhook(channel_id: str, ch: dict, base_url: str) -> dict:
    """Register (or delete) Telegram webhook. Returns result dict."""
    import httpx
    bot_token = ch.get("config", {}).get("bot_token", "")
    if not bot_token or "•" in bot_token:
        return {"ok": False, "error": "Token bot manquant"}

    enabled = ch.get("enabled", False)

    async with httpx.AsyncClient(timeout=15) as client:
        if enabled:
            webhook_url = f"{base_url}/api/plugins/channels/webhook/telegram/{channel_id}"
            secret = ch.get("config", {}).get("webhook_secret", "")
            payload = {"url": webhook_url}
            if secret:
                payload["secret_token"] = secret
            r = await client.post(
                f"https://api.telegram.org/bot{bot_token}/setWebhook",
                json=payload,
            )
            data = r.json()
            if data.get("ok"):
                _add_log(channel_id, ch.get("name", ""), "system",
                         f"Webhook Telegram enregistré → {webhook_url}", "ok")
                return {"ok": True, "webhook_url": webhook_url}
            else:
                _add_log(channel_id, ch.get("name", ""), "system",
                         f"Erreur setWebhook: {data.get('description', '')}", "error")
                return {"ok": False, "error": data.get("description", "Erreur setWebhook")}
        else:
            # Disable = delete webhook
            r = await client.post(
                f"https://api.telegram.org/bot{bot_token}/deleteWebhook",
            )
            data = r.json()
            _add_log(channel_id, ch.get("name", ""), "system", "Webhook Telegram supprimé", "ok")
            return {"ok": True, "deleted": True}


# ── Channel catalog ────────────────────────────────────────────────
CHANNEL_CATALOG = {
    "telegram": {
        "display_name": "Telegram",
        "icon": "Send",
        "category": "messagerie",
        "description": "Bot Telegram — reçoit et répond aux messages via l'API Bot. Le plus simple à configurer.",
        "complexity": "facile",
        "fields": [
            {"key": "bot_token", "label": "Bot Token", "type": "password", "required": True, "placeholder": "123456:ABC-DEF..."},
            {"key": "webhook_secret", "label": "Webhook Secret (optionnel)", "type": "password", "required": False},
        ],
        "doc_url": "https://core.telegram.org/bots/api",
        "setup_guide": (
            "1. Ouvrez Telegram et cherchez @BotFather\n"
            "2. Envoyez /newbot et suivez les instructions\n"
            "3. Copiez le token fourni par BotFather\n"
            "4. Collez-le ici et enregistrez\n"
            "5. Cliquez sur l'URL webhook fournie pour activer la réception\n"
            "\n"
            "IMPORTANT :\n"
            "- HTTPS obligatoire (ports 443, 80, 88 ou 8443)\n"
            "- En dev local, utilisez ngrok ou un tunnel\n"
            "- Le bot ne peut pas initier une conversation — l'utilisateur doit envoyer /start d'abord\n"
            "- Limite : ~30 msg/sec vers différents chats, 1 msg/sec par chat"
        ),
    },
    "discord": {
        "display_name": "Discord",
        "icon": "MessageCircle",
        "category": "messagerie",
        "description": "Bot Discord — répond via slash commands (/ask). Interactions Endpoint.",
        "complexity": "moyen",
        "fields": [
            {"key": "bot_token", "label": "Bot Token", "type": "password", "required": True},
            {"key": "application_id", "label": "Application ID", "type": "text", "required": True},
            {"key": "public_key", "label": "Public Key (vérification)", "type": "text", "required": True},
            {"key": "allowed_channels", "label": "Channel IDs autorisés (virgule)", "type": "text", "required": False, "placeholder": "123456,789012"},
        ],
        "doc_url": "https://discord.com/developers/docs/intro",
        "setup_guide": (
            "1. Créez une app sur discord.com/developers/applications\n"
            "2. Copiez l'Application ID et la Public Key\n"
            "3. Créez un Bot (section Bot) et copiez le token\n"
            "4. Activez l'intent MESSAGE_CONTENT (section Bot > Privileged Intents)\n"
            "5. Dans 'General Information', collez l'URL Interactions fournie ci-dessous\n"
            "6. Invitez le bot : OAuth2 > URL Generator > scopes: bot + applications.commands\n"
            "7. Créez une slash command /ask via l'API ou le portail\n"
            "\n"
            "NOTE : Ce mode utilise les Interactions (slash commands uniquement).\n"
            "L'utilisateur tape /ask <message> pour parler au bot.\n"
            "Pour un bot qui lit tous les messages, un Gateway WebSocket est nécessaire\n"
            "(non supporté ici — utilisez discord.py séparément).\n"
            "Limite : 50 req/sec global, 5 msg/5sec par channel"
        ),
    },
    "slack": {
        "display_name": "Slack",
        "icon": "Hash",
        "category": "messagerie",
        "description": "App Slack — répond aux mentions et messages directs via Events API.",
        "complexity": "moyen",
        "fields": [
            {"key": "bot_token", "label": "Bot Token (xoxb-...)", "type": "password", "required": True},
            {"key": "signing_secret", "label": "Signing Secret", "type": "password", "required": True},
            {"key": "app_token", "label": "App Token (xapp-..., Socket Mode)", "type": "password", "required": False},
        ],
        "doc_url": "https://api.slack.com/start",
        "setup_guide": (
            "1. Créez une app sur api.slack.com/apps (From scratch)\n"
            "2. OAuth & Permissions > Scopes > Bot Token Scopes :\n"
            "   chat:write, app_mentions:read, im:history, channels:history\n"
            "3. Installez l'app dans votre workspace (Install to Workspace)\n"
            "4. Copiez le Bot User OAuth Token (xoxb-...)\n"
            "5. Basic Information > Signing Secret — copiez-le\n"
            "6. Event Subscriptions > Enable > collez l'URL Events fournie\n"
            "7. Abonnez-vous aux events : message.im, app_mention\n"
            "\n"
            "IMPORTANT :\n"
            "- Slack exige une réponse HTTP en moins de 3 secondes\n"
            "- Gungnir répond 200 immédiatement puis traite en async\n"
            "- Le bot doit être invité dans un channel pour y voir les messages\n"
            "- Formatage Slack : *gras*, _italique_, <url|texte>"
        ),
    },
    "whatsapp": {
        "display_name": "WhatsApp",
        "icon": "Phone",
        "category": "messagerie",
        "description": "WhatsApp Business API via Meta Cloud API. Configuration complexe.",
        "complexity": "avance",
        "fields": [
            {"key": "access_token", "label": "Access Token (permanent)", "type": "password", "required": True},
            {"key": "phone_number_id", "label": "Phone Number ID", "type": "text", "required": True},
            {"key": "verify_token", "label": "Verify Token (webhook)", "type": "text", "required": True, "placeholder": "gungnir_verify_2024"},
            {"key": "app_secret", "label": "App Secret (vérification signature)", "type": "password", "required": False},
            {"key": "waba_id", "label": "WhatsApp Business Account ID", "type": "text", "required": False},
        ],
        "doc_url": "https://developers.facebook.com/docs/whatsapp/cloud-api",
        "setup_guide": (
            "PRÉREQUIS (long, plusieurs jours possible) :\n"
            "1. Compte Meta Developer (developers.facebook.com)\n"
            "2. Compte Meta Business (business.facebook.com)\n"
            "3. Vérification Business Meta (documents officiels requis)\n"
            "4. Moyen de paiement sur le compte Business\n"
            "\n"
            "CONFIGURATION :\n"
            "5. Créez une app Meta > type Business\n"
            "6. Ajoutez le produit WhatsApp\n"
            "7. Configuration > Webhook > collez l'URL fournie + verify token\n"
            "8. Abonnez-vous au champ : messages\n"
            "9. Obtenez un access token permanent (System User > Generate Token)\n"
            "\n"
            "LIMITES CRITIQUES :\n"
            "- Fenêtre 24h : vous ne pouvez répondre librement que dans les 24h\n"
            "  après le dernier message de l'utilisateur\n"
            "- Après 24h : seuls les Message Templates (pré-approuvés) sont autorisés\n"
            "- Le numéro utilisé ne doit PAS être déjà sur WhatsApp personnel\n"
            "- Pricing : ~0.005-0.15$/conversation selon pays et catégorie\n"
            "- 1000 conversations service/mois gratuites\n"
            "- Alternative plus simple : passer par Twilio ou 360dialog"
        ),
    },
    "email": {
        "display_name": "Email",
        "icon": "Mail",
        "category": "communication",
        "description": "Reçoit et répond aux emails via IMAP/SMTP. Polling en arrière-plan.",
        "complexity": "moyen",
        "fields": [
            {"key": "imap_host", "label": "Serveur IMAP", "type": "text", "required": True, "placeholder": "imap.gmail.com"},
            {"key": "imap_port", "label": "Port IMAP", "type": "text", "required": False, "placeholder": "993"},
            {"key": "smtp_host", "label": "Serveur SMTP", "type": "text", "required": True, "placeholder": "smtp.gmail.com"},
            {"key": "smtp_port", "label": "Port SMTP", "type": "text", "required": False, "placeholder": "587"},
            {"key": "email_address", "label": "Adresse email", "type": "text", "required": True},
            {"key": "email_password", "label": "Mot de passe / App Password", "type": "password", "required": True},
            {"key": "check_interval", "label": "Intervalle vérification (sec)", "type": "text", "required": False, "placeholder": "60"},
        ],
        "doc_url": "https://support.google.com/mail/answer/7126229",
        "setup_guide": (
            "POUR GMAIL :\n"
            "1. Activez la 2FA sur votre compte Google\n"
            "2. Allez sur myaccount.google.com/apppasswords\n"
            "3. Créez un mot de passe d'application (type: Mail)\n"
            "4. Serveurs : imap.gmail.com:993 / smtp.gmail.com:587\n"
            "\n"
            "POUR OUTLOOK :\n"
            "- imap-mail.outlook.com:993 / smtp-mail.outlook.com:587\n"
            "\n"
            "FONCTIONNEMENT :\n"
            "- Gungnir vérifie les nouveaux emails par polling IMAP\n"
            "- L'intervalle par défaut est 60 secondes\n"
            "- Les réponses sont envoyées via SMTP\n"
            "\n"
            "LIMITES :\n"
            "- Gmail : 500 emails/jour (perso), 2000/jour (Workspace)\n"
            "- Le polling n'est pas instantané (délai = intervalle)\n"
            "- Les réponses automatiques peuvent atterrir en spam si le domaine\n"
            "  n'a pas de DKIM/SPF configuré"
        ),
    },
    "web_widget": {
        "display_name": "Widget Web",
        "icon": "Globe",
        "category": "web",
        "description": "Chat widget intégrable sur n'importe quel site web.",
        "complexity": "facile",
        "fields": [
            {"key": "allowed_origins", "label": "Origines autorisées (virgule)", "type": "text", "required": False, "placeholder": "https://monsite.com,https://app.monsite.com"},
            {"key": "widget_title", "label": "Titre du widget", "type": "text", "required": False, "placeholder": "Gungnir Assistant"},
            {"key": "widget_color", "label": "Couleur primaire", "type": "text", "required": False, "placeholder": "#dc2626"},
            {"key": "welcome_message", "label": "Message d'accueil", "type": "text", "required": False, "placeholder": "Bonjour ! Comment puis-je vous aider ?"},
        ],
        "doc_url": "",
        "setup_guide": (
            "1. Configurez les origines autorisées (domaines de votre site)\n"
            "2. Personnalisez le titre et la couleur\n"
            "3. Utilisez l'endpoint API fourni pour envoyer des messages\n"
            "4. Intégrez le fetch dans votre frontend\n"
            "\n"
            "Aucune configuration externe nécessaire."
        ),
    },
    "api": {
        "display_name": "API REST",
        "icon": "Code",
        "category": "dev",
        "description": "Endpoint API pour intégrations custom (chatbots, apps, scripts).",
        "complexity": "facile",
        "fields": [
            {"key": "api_key", "label": "Clé API", "type": "password", "required": False, "placeholder": "Générée automatiquement si vide"},
            {"key": "rate_limit", "label": "Rate limit (req/min)", "type": "text", "required": False, "placeholder": "60"},
            {"key": "allowed_ips", "label": "IPs autorisées (virgule, vide = toutes)", "type": "text", "required": False},
        ],
        "doc_url": "",
        "setup_guide": (
            "1. Créez le canal — une clé API est générée automatiquement\n"
            "2. Envoyez des requêtes POST à l'endpoint /incoming/{channel_id}\n"
            "3. Header : Authorization: Bearer <votre_clé_api>\n"
            "4. Body JSON : {\"text\": \"votre message\", \"sender_id\": \"user1\"}\n"
            "\n"
            "Idéal pour connecter des scripts, chatbots tiers, ou workflows n8n."
        ),
    },
}

CHANNEL_CATEGORIES = {
    "messagerie": {"label": "Messagerie", "icon": "MessageSquare"},
    "communication": {"label": "Communication", "icon": "Mail"},
    "web": {"label": "Web", "icon": "Globe"},
    "dev": {"label": "Développement", "icon": "Code"},
}


# ── Pydantic models ────────────────────────────────────────────────
class ChannelConfig(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4())[:8])
    type: str  # key from CHANNEL_CATALOG
    name: str
    config: dict = Field(default_factory=dict)
    enabled: bool = False
    user_id: Optional[int] = None  # Owner of this channel — uses their API keys
    created_at: str = Field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    stats: dict = Field(default_factory=lambda: {"messages_in": 0, "messages_out": 0, "last_activity": None})


class IncomingMessage(BaseModel):
    text: str
    sender_id: Optional[str] = None
    sender_name: Optional[str] = None
    metadata: dict = Field(default_factory=dict)


# ── Health ──────────────────────────────────────────────────────────
@router.get("/health")
async def channels_health():
    channels = _load_channels()
    active = sum(1 for c in channels.values() if c.get("enabled"))
    return {"plugin": "channels", "status": "ok", "total": len(channels), "active": active}


# ── Catalog ─────────────────────────────────────────────────────────
@router.get("/catalog")
async def get_catalog():
    return {
        "channels": CHANNEL_CATALOG,
        "categories": CHANNEL_CATEGORIES,
    }


# ── CRUD Channels ───────────────────────────────────────────────────
@router.get("/list")
async def list_channels(request: Request):
    channels = _load_channels()
    # Filter by authenticated user — admin sees all, others see only their own
    auth_user_id = getattr(request.state, "user_id", None)
    is_admin = False
    if auth_user_id:
        try:
            from backend.core.db.engine import async_session
            from backend.core.db.models import User
            async with async_session() as session:
                user = await session.get(User, auth_user_id)
                is_admin = user and user.is_admin
        except Exception:
            pass

    result = []
    for cid, ch in channels.items():
        # Show channel if: no user_id (legacy), user is admin, or user owns it
        ch_owner = ch.get("user_id")
        if auth_user_id and not is_admin and ch_owner is not None and ch_owner != auth_user_id:
            continue
        safe = {**ch}
        # Masquer les secrets
        if "config" in safe:
            safe_config = {}
            for k, v in safe["config"].items():
                catalog_entry = CHANNEL_CATALOG.get(ch.get("type", ""), {})
                field_defs = {f["key"]: f for f in catalog_entry.get("fields", [])}
                if k in field_defs and field_defs[k].get("type") == "password":
                    safe_config[k] = _mask_secret(v)
                else:
                    safe_config[k] = v
            safe["config"] = safe_config
        result.append(safe)
    return {"channels": result}


@router.post("/create")
async def create_channel(data: ChannelConfig, request: Request):
    if data.type not in CHANNEL_CATALOG:
        raise HTTPException(400, f"Type inconnu: {data.type}")

    # Assign channel to authenticated user (fallback to admin for legacy no-auth contexts)
    auth_user_id = getattr(request.state, "user_id", None)
    owner_uid = int(auth_user_id) if auth_user_id else DEFAULT_ORPHAN_OWNER
    data.user_id = owner_uid

    # Générer une API key si type API et pas fournie
    if data.type == "api" and not data.config.get("api_key"):
        data.config["api_key"] = f"gun_{uuid.uuid4().hex[:24]}"

    channels = _load_user_channels(owner_uid)
    channels[data.id] = data.model_dump()
    _save_user_channels(owner_uid, channels)
    _register_channel_owner(data.id, owner_uid)
    _add_log(data.id, data.name, "system", f"Canal {data.type} créé", "ok")

    return {"ok": True, "channel": channels[data.id]}


@router.get("/{channel_id}")
async def get_channel(channel_id: str):
    channels = _load_channels()
    if channel_id not in channels:
        raise HTTPException(404, "Canal introuvable")
    return channels[channel_id]


@router.put("/{channel_id}")
async def update_channel(channel_id: str, data: dict, request: Request):
    owner_uid = _channel_owner(channel_id)
    if owner_uid is None:
        raise HTTPException(404, "Canal introuvable")
    channels = _load_user_channels(owner_uid)
    if channel_id not in channels:
        raise HTTPException(404, "Canal introuvable")

    ch = channels[channel_id]
    if "name" in data:
        ch["name"] = data["name"]
    if "enabled" in data:
        ch["enabled"] = data["enabled"]
    if "config" in data:
        # Merge — ne remplace pas les champs masqués
        for k, v in data["config"].items():
            if v and "•" not in str(v):
                ch.setdefault("config", {})[k] = v
    channels[channel_id] = ch
    _save_user_channels(owner_uid, channels)

    # Auto-register webhook if channel has a token and is enabled
    webhook_result = None
    ch_type = ch.get("type", "")
    if ch_type == "telegram" and ch.get("enabled"):
        bot_token = ch.get("config", {}).get("bot_token", "")
        if bot_token and "•" not in bot_token:
            try:
                base_url = _get_public_base_url(request)
                webhook_result = await _register_telegram_webhook(channel_id, ch, base_url)
            except Exception as e:
                webhook_result = {"ok": False, "error": str(e)}

    return {"ok": True, "channel": ch, "webhook": webhook_result}


@router.delete("/{channel_id}")
async def delete_channel(channel_id: str):
    owner_uid = _channel_owner(channel_id)
    if owner_uid is None:
        raise HTTPException(404, "Canal introuvable")
    channels = _load_user_channels(owner_uid)
    if channel_id not in channels:
        raise HTTPException(404, "Canal introuvable")
    name = channels[channel_id].get("name", channel_id)
    # Log before unregistering so _add_log can still find the owner
    _add_log(channel_id, name, "system", "Canal supprimé", "ok")
    del channels[channel_id]
    _save_user_channels(owner_uid, channels)
    _unregister_channel_owner(channel_id)
    return {"ok": True}


@router.post("/{channel_id}/toggle")
async def toggle_channel(channel_id: str, request: Request):
    owner_uid = _channel_owner(channel_id)
    if owner_uid is None:
        raise HTTPException(404, "Canal introuvable")
    channels = _load_user_channels(owner_uid)
    if channel_id not in channels:
        raise HTTPException(404, "Canal introuvable")
    ch = channels[channel_id]
    ch["enabled"] = not ch.get("enabled", False)
    channels[channel_id] = ch
    _save_user_channels(owner_uid, channels)
    status = "activé" if ch["enabled"] else "désactivé"
    _add_log(channel_id, ch.get("name", ""), "system", f"Canal {status}", "ok")

    # Auto-register/unregister webhook for supported channel types
    webhook_result = None
    base_url = _get_public_base_url(request)
    ch_type = ch.get("type", "")
    if ch_type == "telegram":
        try:
            webhook_result = await _register_telegram_webhook(channel_id, ch, base_url)
        except Exception as e:
            webhook_result = {"ok": False, "error": str(e)}
            _add_log(channel_id, ch.get("name", ""), "system", f"Erreur webhook: {e}", "error")

    return {"ok": True, "enabled": ch["enabled"], "webhook": webhook_result}


# ── Incoming message handler (generic) ──────────────────────────────
async def _process_incoming(channel_id: str, text: str, sender_id: str = "unknown", sender_name: str = "unknown", metadata: dict = None):
    """Route un message entrant vers le chat Gungnir et retourne la réponse."""
    owner_uid = _channel_owner(channel_id)
    if owner_uid is None:
        return None
    channels = _load_user_channels(owner_uid)
    ch = channels.get(channel_id)
    if not ch:
        return None

    # Update stats
    ch.setdefault("stats", {"messages_in": 0, "messages_out": 0, "last_activity": None})
    ch["stats"]["messages_in"] = ch["stats"].get("messages_in", 0) + 1
    ch["stats"]["last_activity"] = datetime.now(timezone.utc).isoformat()
    channels[channel_id] = ch
    _save_user_channels(owner_uid, channels)

    _add_log(channel_id, ch.get("name", ""), "in", f"[{sender_name}] {text[:100]}", "ok")

    # Appel LLM via le pipeline complet (soul + personnalité + consciousness)
    try:
        from backend.core.config.settings import Settings
        from backend.core.providers import get_provider, ChatMessage
        from pathlib import Path as _Path
        settings = Settings.load()

        # Resolve provider: per-user keys first (channel owner), then global fallback
        provider_name = None
        provider_config = None
        model = None
        channel_owner_id = ch.get("user_id")
        # Timezone du propriétaire du canal — utilisée pour le contexte temporel
        # injecté dans le system prompt (fix dates hallucinées sur Valkyrie/scheduler).
        user_timezone = "Europe/Paris"

        if channel_owner_id:
            try:
                from backend.core.db.engine import async_session as _ch_session_maker
                from backend.core.api.auth_helpers import get_user_settings, get_user_provider_key
                async with _ch_session_maker() as _us_session:
                    user_settings = await get_user_settings(channel_owner_id, _us_session)
                    # Récupère la TZ depuis ui_preferences si l'user l'a configurée
                    try:
                        _prefs = user_settings.ui_preferences or {}
                        _tz_from_prefs = _prefs.get("timezone")
                        if _tz_from_prefs:
                            user_timezone = str(_tz_from_prefs)
                    except Exception:
                        pass
                    # Use user's active provider/model
                    _user_prov_name = user_settings.active_provider or "openrouter"
                    _user_prov = get_user_provider_key(user_settings, _user_prov_name)
                    if _user_prov and _user_prov.get("api_key"):
                        from backend.core.config.settings import ProviderConfig
                        _base = settings.providers.get(_user_prov_name)
                        provider_name = _user_prov_name
                        provider_config = ProviderConfig(
                            enabled=True,
                            api_key=_user_prov["api_key"],
                            base_url=_user_prov.get("base_url") or (_base.base_url if _base else None),
                            default_model=_base.default_model if _base else None,
                            models=_base.models if _base else [],
                        )
                        model = user_settings.active_model or (provider_config.default_model if provider_config else None)
            except Exception as _e:
                import logging
                logging.getLogger("gungnir").warning(f"Channel user key lookup failed: {_e}")

        # STRICT per-user: no global fallback. If the channel owner has no key
        # configured, refuse to answer instead of using someone else's credits.
        if not provider_name or not provider_config:
            return "Ce canal n'a pas de clé API configurée pour son propriétaire. Ajoutez une clé dans Paramètres → Providers."

        provider = get_provider(provider_name, provider_config.api_key, provider_config.base_url)
        if not model:
            model = provider_config.default_model

        # ── Build system prompt like the main chat ──
        # Soul (identity)
        _data_dir = _Path(__file__).parent.parent.parent.parent / "data"
        _soul_file = _data_dir / "soul.md"
        soul = _soul_file.read_text(encoding="utf-8") if _soul_file.exists() else (
            "Tu es **Wolf**, un super-assistant IA développé par ScarletWolf.\n"
            "Tu es intelligent, proactif, précis et loyal envers ton utilisateur."
        )

        # Personality overlay
        personality_block = ""
        try:
            from backend.core.agents.skills import personality_manager
            active = personality_manager.get_active()
            if active and active.system_prompt:
                personality_block = f"\n\n## Mode de personnalité actif : {active.name}\n{active.system_prompt}"
        except Exception:
            pass

        # Consciousness context (memories) — per-user strict : on utilise le
        # user_id propriétaire du canal, pas le contexte système (0).
        consciousness_uid = int(channel_owner_id) if channel_owner_id else 0
        consciousness_block = ""
        try:
            from backend.plugins.consciousness.engine import consciousness_manager
            _ch_consciousness = consciousness_manager.get(consciousness_uid)
            if _ch_consciousness.enabled:
                memories = await _ch_consciousness.recall(text, limit=3)
                if memories:
                    consciousness_block = "\n\n## Souvenirs pertinents\n" + "\n".join(
                        f"- {m.get('content', '')[:200]}" for m in memories
                    )
        except Exception:
            pass

        _lang = settings.app.language or "fr"
        # Capacités outils + contexte temporel — le LLM doit savoir qu'il peut
        # appeler n'importe quel outil, ET connaître la date courante pour
        # calculer correctement les dates relatives (demain, la semaine
        # prochaine, etc.) qui partent sinon dans la date de son cutoff.
        from backend.core.agents.agent_loop import (
            build_tools_capability_block,
            build_temporal_block,
            run_agent_loop,
        )
        tools_block = build_tools_capability_block()
        temporal_block = build_temporal_block(user_timezone)

        system_prompt = (
            f"{soul}"
            f"\n\n**Modele LLM actuel :** Tu tournes sur le modele `{model}` via le provider `{provider_name}`."
            f" Quand on te demande quel modele tu es, reponds avec cet identifiant."
            f" Tu n'es PAS GPT-4o, PAS Claude, PAS un autre modele — tu es `{model}`."
            f"{personality_block}"
            f"{temporal_block}"
            f"{consciousness_block}"
            f"{tools_block}"
            f"\n\n## Contexte canal"
            f"\nTu réponds via le canal externe '{ch.get('name', ch['type'])}' (type: {ch.get('type', 'inconnu')})."
            f"\nExpéditeur : {sender_name} ({sender_id})."
            f"\nRéponds de manière concise et adaptée à une messagerie. Langue : {_lang}."
            f"\nTu as accès à TOUS tes outils (WOLF, MCP, plugins) sur ce canal — utilise-les dès qu'ils sont pertinents."
        )

        messages = [
            ChatMessage(role="system", content=system_prompt),
            ChatMessage(role="user", content=text),
        ]

        loop_result = await run_agent_loop(
            provider=provider,
            model=model,
            messages=messages,
            user_id=consciousness_uid,
            conversation_id=None,
        )
        response_text = loop_result.content

        # Log des outils exécutés pour traçabilité canal
        for ev in loop_result.tool_events:
            _add_log(
                channel_id, ch.get("name", ""), "tool",
                f"{ev.tool}({str(ev.args)[:80]}) → {str(ev.result)[:120]}",
                "ok",
            )

        # Store in consciousness
        try:
            from backend.plugins.consciousness.engine import consciousness_manager
            _ch_consciousness = consciousness_manager.get(consciousness_uid)
            if _ch_consciousness.enabled:
                await _ch_consciousness.store_interaction(
                    f"[{ch.get('type', 'channel')}:{sender_name}] {text}",
                    response_text,
                )
        except Exception:
            pass

        # Update outgoing stats
        channels = _load_user_channels(owner_uid)
        if channel_id in channels:
            channels[channel_id].setdefault("stats", {"messages_in": 0, "messages_out": 0, "last_activity": None})
            channels[channel_id]["stats"]["messages_out"] = channels[channel_id]["stats"].get("messages_out", 0) + 1
            _save_user_channels(owner_uid, channels)

        _add_log(channel_id, ch.get("name", ""), "out", f"Réponse: {str(response_text)[:100]}", "ok")
        return response_text

    except Exception as e:
        _add_log(channel_id, ch.get("name", ""), "out", f"Erreur: {str(e)[:200]}", "error")
        return f"Erreur interne: {str(e)}"


# ── Telegram webhook ────────────────────────────────────────────────
@router.post("/webhook/telegram/{channel_id}")
async def telegram_webhook(channel_id: str, request: Request):
    channels = _load_channels()
    ch = channels.get(channel_id)
    if not ch or ch.get("type") != "telegram" or not ch.get("enabled"):
        raise HTTPException(404, "Canal Telegram introuvable ou désactivé")

    body = await request.json()

    # Vérifier le secret si configuré
    secret = ch.get("config", {}).get("webhook_secret")
    if secret:
        token = request.headers.get("X-Telegram-Bot-Api-Secret-Token", "")
        if token != secret:
            raise HTTPException(403, "Secret invalide")

    # Extraire le message
    msg = body.get("message") or body.get("edited_message") or {}
    text = msg.get("text", "")
    if not text:
        return {"ok": True, "skipped": "no text"}

    sender = msg.get("from", {})
    sender_id = str(sender.get("id", ""))
    sender_name = sender.get("first_name", "") + " " + sender.get("last_name", "")
    chat_id = msg.get("chat", {}).get("id")

    response_text = await _process_incoming(channel_id, text, sender_id, sender_name.strip())

    # Répondre via l'API Telegram — split auto si > 4096 chars
    if response_text and chat_id:
        import httpx
        bot_token = ch.get("config", {}).get("bot_token", "")
        parts = _messages_for_channel(str(response_text), "telegram")
        try:
            async with httpx.AsyncClient() as client:
                for part in parts:
                    resp = await client.post(
                        f"https://api.telegram.org/bot{bot_token}/sendMessage",
                        json={"chat_id": chat_id, "text": part},
                        timeout=30,
                    )
                    if resp.status_code != 200:
                        _add_log(channel_id, ch.get("name", ""), "out",
                                 f"Telegram sendMessage error: {resp.text[:200]}", "error")
                        break
        except Exception as e:
            _add_log(channel_id, ch.get("name", ""), "out", f"Erreur envoi Telegram: {e}", "error")

    return {"ok": True}


# ── Discord interactions endpoint ───────────────────────────────────
def _verify_discord_signature(request: Request, body_bytes: bytes, public_key_hex: str) -> bool:
    """Verify Discord Ed25519 interaction signature."""
    signature = request.headers.get("X-Signature-Ed25519", "")
    timestamp = request.headers.get("X-Signature-Timestamp", "")
    if not signature or not timestamp or not public_key_hex:
        return False
    try:
        # Use nacl if available, otherwise skip verification
        from nacl.signing import VerifyKey
        verify_key = VerifyKey(bytes.fromhex(public_key_hex))
        verify_key.verify(f"{timestamp}{body_bytes.decode('utf-8')}".encode(), bytes.fromhex(signature))
        return True
    except ImportError:
        # nacl not installed — log warning but allow (don't break the plugin)
        import logging
        logging.getLogger("gungnir.plugins.channels").warning(
            "PyNaCl not installed — Discord signature verification skipped. Install with: pip install PyNaCl"
        )
        return True
    except Exception:
        return False


@router.post("/webhook/discord/{channel_id}")
async def discord_webhook(channel_id: str, request: Request):
    channels = _load_channels()
    ch = channels.get(channel_id)
    if not ch or ch.get("type") != "discord" or not ch.get("enabled"):
        raise HTTPException(404, "Canal Discord introuvable ou désactivé")

    body_bytes = await request.body()

    # Verify Discord signature if public_key is configured
    public_key = ch.get("config", {}).get("public_key", "")
    if public_key:
        if not _verify_discord_signature(request, body_bytes, public_key):
            raise HTTPException(401, "Signature Discord invalide")

    body = json.loads(body_bytes)

    # Discord interaction verification (type 1 = PING)
    if body.get("type") == 1:
        return {"type": 1}

    # Type 2 = APPLICATION_COMMAND
    if body.get("type") == 2:
        text = ""
        options = body.get("data", {}).get("options", [])
        for opt in options:
            if opt.get("name") == "message":
                text = opt.get("value", "")
        sender = body.get("member", {}).get("user", {}) or body.get("user", {})
        sender_id = sender.get("id", "")
        sender_name = sender.get("username", "")

        response_text = await _process_incoming(channel_id, text, sender_id, sender_name)
        parts = _messages_for_channel(str(response_text) if response_text else "…", "discord")
        # Discord interaction response ne peut porter qu'un seul message.
        # On renvoie le premier chunk ; les suivants seraient à envoyer via
        # follow-up webhook (TODO : support @followup si besoin de longues
        # sorties Discord). En attendant, on ajoute un marqueur si tronqué.
        first = parts[0] if parts else "…"
        if len(parts) > 1:
            first = first[: CHANNEL_MAX_LEN["discord"] - 24] + "\n\n… (suite tronquée)"
        return {"type": 4, "data": {"content": first}}

    return {"ok": True}


# ── Slack events ────────────────────────────────────────────────────
# Slack exige une réponse HTTP en < 3 secondes. On répond 200 immédiatement
# puis on traite le message en arrière-plan (asyncio.create_task).

async def _slack_process_and_reply(channel_id: str, text: str, sender_id: str, slack_channel: str, bot_token: str, channel_name: str):
    """Traitement Slack en background : LLM + envoi réponse (split auto)."""
    try:
        response_text = await _process_incoming(channel_id, text, sender_id, sender_id)
        if response_text:
            import httpx
            parts = _messages_for_channel(str(response_text), "slack")
            async with httpx.AsyncClient() as client:
                for part in parts:
                    await client.post(
                        "https://slack.com/api/chat.postMessage",
                        headers={"Authorization": f"Bearer {bot_token}"},
                        json={"channel": slack_channel, "text": part},
                        timeout=30,
                    )
    except Exception as e:
        _add_log(channel_id, channel_name, "out", f"Erreur envoi Slack: {e}", "error")


def _verify_slack_signature(request: Request, body_bytes: bytes, signing_secret: str) -> bool:
    """Verify Slack request signature (v0 HMAC-SHA256)."""
    timestamp = request.headers.get("X-Slack-Request-Timestamp", "")
    slack_signature = request.headers.get("X-Slack-Signature", "")
    if not timestamp or not slack_signature:
        return False
    # Prevent replay attacks (> 5 min old)
    import time
    try:
        if abs(time.time() - float(timestamp)) > 300:
            return False
    except ValueError:
        return False
    sig_basestring = f"v0:{timestamp}:{body_bytes.decode('utf-8')}"
    my_signature = "v0=" + hmac.new(
        signing_secret.encode(), sig_basestring.encode(), hashlib.sha256
    ).hexdigest()
    return hmac.compare_digest(my_signature, slack_signature)


@router.post("/webhook/slack/{channel_id}")
async def slack_webhook(channel_id: str, request: Request):
    channels = _load_channels()
    ch = channels.get(channel_id)
    if not ch or ch.get("type") != "slack" or not ch.get("enabled"):
        raise HTTPException(404, "Canal Slack introuvable ou désactivé")

    body_bytes = await request.body()
    body = json.loads(body_bytes)

    # URL verification challenge (before signature check — Slack requires it)
    if body.get("type") == "url_verification":
        return {"challenge": body.get("challenge", "")}

    # Verify Slack signature if signing_secret is configured
    signing_secret = ch.get("config", {}).get("signing_secret", "")
    if signing_secret:
        if not _verify_slack_signature(request, body_bytes, signing_secret):
            raise HTTPException(401, "Signature Slack invalide")

    # Ignorer les retries Slack (header X-Slack-Retry-Num = retry d'un event déjà traité)
    if request.headers.get("X-Slack-Retry-Num"):
        return {"ok": True, "skipped": "retry"}

    # Event callback — répondre 200 IMMÉDIATEMENT, traiter en background
    event = body.get("event", {})
    if event.get("type") == "message" and not event.get("bot_id"):
        text = event.get("text", "")
        sender_id = event.get("user", "")
        slack_channel = event.get("channel", "")
        bot_token = ch.get("config", {}).get("bot_token", "")

        # Lancer en background — ne PAS attendre la réponse LLM
        asyncio.create_task(
            _slack_process_and_reply(channel_id, text, sender_id, slack_channel, bot_token, ch.get("name", ""))
        )

    return {"ok": True}


# ── WhatsApp webhook ────────────────────────────────────────────────
@router.get("/webhook/whatsapp/{channel_id}")
async def whatsapp_verify(channel_id: str, request: Request):
    """WhatsApp webhook verification (GET)."""
    channels = _load_channels()
    ch = channels.get(channel_id)
    if not ch or ch.get("type") != "whatsapp":
        raise HTTPException(404)

    mode = request.query_params.get("hub.mode")
    token = request.query_params.get("hub.verify_token")
    challenge = request.query_params.get("hub.challenge")

    verify_token = ch.get("config", {}).get("verify_token", "")
    if mode == "subscribe" and token == verify_token:
        return Response(content=challenge, media_type="text/plain")
    raise HTTPException(403, "Vérification échouée")


@router.post("/webhook/whatsapp/{channel_id}")
async def whatsapp_webhook(channel_id: str, request: Request):
    channels = _load_channels()
    ch = channels.get(channel_id)
    if not ch or ch.get("type") != "whatsapp" or not ch.get("enabled"):
        raise HTTPException(404)

    # Verify WhatsApp HMAC-SHA256 signature if app_secret is configured
    app_secret = ch.get("config", {}).get("app_secret", "")
    if app_secret:
        body_bytes = await request.body()
        expected_sig = hmac.new(app_secret.encode(), body_bytes, hashlib.sha256).hexdigest()
        received_sig = request.headers.get("X-Hub-Signature-256", "").replace("sha256=", "")
        if not hmac.compare_digest(expected_sig, received_sig):
            raise HTTPException(401, "Signature WhatsApp invalide")
        body = json.loads(body_bytes)
    else:
        body = await request.json()

    for entry in body.get("entry", []):
        for change in entry.get("changes", []):
            value = change.get("value", {})
            for msg in value.get("messages", []):
                if msg.get("type") != "text":
                    continue
                text = msg.get("text", {}).get("body", "")
                sender_phone = msg.get("from", "")
                sender_name = ""
                for contact in value.get("contacts", []):
                    if contact.get("wa_id") == sender_phone:
                        sender_name = contact.get("profile", {}).get("name", "")

                response_text = await _process_incoming(channel_id, text, sender_phone, sender_name or sender_phone)

                # Répondre via WhatsApp Cloud API (split auto à 4096)
                if response_text:
                    import httpx
                    access_token = ch.get("config", {}).get("access_token", "")
                    phone_number_id = ch.get("config", {}).get("phone_number_id", "")
                    parts = _messages_for_channel(str(response_text), "whatsapp")
                    try:
                        async with httpx.AsyncClient() as client:
                            for part in parts:
                                await client.post(
                                    f"https://graph.facebook.com/v18.0/{phone_number_id}/messages",
                                    headers={"Authorization": f"Bearer {access_token}"},
                                    json={
                                        "messaging_product": "whatsapp",
                                        "to": sender_phone,
                                        "type": "text",
                                        "text": {"body": part},
                                    },
                                    timeout=30,
                                )
                    except Exception as e:
                        _add_log(channel_id, ch.get("name", ""), "out", f"Erreur envoi WhatsApp: {e}", "error")

    return {"ok": True}


# ── Generic API endpoint ────────────────────────────────────────────
@router.post("/incoming/{channel_id}")
async def incoming_message(channel_id: str, data: IncomingMessage, request: Request):
    """Endpoint générique — accepte des messages de n'importe quelle source."""
    channels = _load_channels()
    ch = channels.get(channel_id)
    if not ch or not ch.get("enabled"):
        raise HTTPException(404, "Canal introuvable ou désactivé")

    # Vérifier l'API key si c'est un canal API
    if ch.get("type") == "api":
        expected_key = ch.get("config", {}).get("api_key", "")
        auth_header = request.headers.get("Authorization", "")
        provided_key = auth_header.replace("Bearer ", "") if auth_header.startswith("Bearer ") else ""
        if expected_key and provided_key != expected_key:
            raise HTTPException(403, "Clé API invalide")

    response_text = await _process_incoming(
        channel_id,
        data.text,
        data.sender_id or "api",
        data.sender_name or "API Client",
        data.metadata,
    )

    return {"ok": True, "response": response_text}


# ── Web Widget embed snippet ───────────────────────────────────────
@router.get("/{channel_id}/widget-snippet")
async def get_widget_snippet(channel_id: str, request: Request):
    """Retourne le snippet JS à intégrer sur un site."""
    channels = _load_channels()
    ch = channels.get(channel_id)
    if not ch or ch.get("type") != "web_widget":
        raise HTTPException(404, "Canal Widget introuvable")

    base_url = _get_public_base_url(request)
    title = ch.get("config", {}).get("widget_title", "Gungnir Assistant")
    color = ch.get("config", {}).get("widget_color", "#dc2626")
    welcome = ch.get("config", {}).get("welcome_message", "Bonjour ! Comment puis-je vous aider ?")

    # Retourne les paramètres pour que le dev construise le widget côté client
    return {
        "channel_id": channel_id,
        "endpoint": f"{base_url}/api/plugins/channels/incoming/{channel_id}",
        "config": {
            "title": title,
            "color": color,
            "welcome_message": welcome,
        },
        "example_fetch": (
            f"fetch('{base_url}/api/plugins/channels/incoming/{channel_id}', {{\n"
            f"  method: 'POST',\n"
            f"  headers: {{'Content-Type': 'application/json'}},\n"
            f"  body: JSON.stringify({{text: 'Bonjour', sender_id: 'visitor', sender_name: 'Visiteur'}})\n"
            f"}})"
        ),
    }


# ── Channel stats ───────────────────────────────────────────────────
@router.get("/{channel_id}/stats")
async def get_channel_stats(channel_id: str):
    channels = _load_channels()
    ch = channels.get(channel_id)
    if not ch:
        raise HTTPException(404, "Canal introuvable")
    return {
        "channel_id": channel_id,
        "name": ch.get("name", ""),
        "type": ch.get("type", ""),
        "enabled": ch.get("enabled", False),
        "stats": ch.get("stats", {"messages_in": 0, "messages_out": 0, "last_activity": None}),
    }


# ── Webhook URL info ───────────────────────────────────────────────
@router.get("/{channel_id}/webhook-url")
async def get_webhook_url(channel_id: str, request: Request):
    """Retourne l'URL du webhook à configurer côté plateforme."""
    channels = _load_channels()
    ch = channels.get(channel_id)
    if not ch:
        raise HTTPException(404, "Canal introuvable")

    base_url = _get_public_base_url(request)
    ch_type = ch.get("type", "")

    urls = {}
    if ch_type == "telegram":
        urls["webhook_url"] = f"{base_url}/api/plugins/channels/webhook/telegram/{channel_id}"
        bot_token = ch.get("config", {}).get("bot_token", "")
        if bot_token and "•" not in bot_token:
            urls["set_webhook_command"] = f"https://api.telegram.org/bot{bot_token}/setWebhook?url={urls['webhook_url']}"
    elif ch_type == "discord":
        urls["interactions_url"] = f"{base_url}/api/plugins/channels/webhook/discord/{channel_id}"
    elif ch_type == "slack":
        urls["events_url"] = f"{base_url}/api/plugins/channels/webhook/slack/{channel_id}"
    elif ch_type == "whatsapp":
        urls["webhook_url"] = f"{base_url}/api/plugins/channels/webhook/whatsapp/{channel_id}"
    else:
        urls["incoming_url"] = f"{base_url}/api/plugins/channels/incoming/{channel_id}"

    return {"channel_id": channel_id, "type": ch_type, "urls": urls}


@router.post("/{channel_id}/register-webhook")
async def register_webhook(channel_id: str, request: Request):
    """Manually register the webhook for a channel (Telegram, etc.)."""
    channels = _load_channels()
    ch = channels.get(channel_id)
    if not ch:
        raise HTTPException(404, "Canal introuvable")

    ch_type = ch.get("type", "")
    base_url = _get_public_base_url(request)

    if ch_type == "telegram":
        try:
            result = await _register_telegram_webhook(channel_id, ch, base_url)
            return result
        except Exception as e:
            return {"ok": False, "error": str(e)}
    else:
        return {"ok": False, "error": f"Type '{ch_type}' ne supporte pas l'enregistrement automatique de webhook"}


# ── Logs ────────────────────────────────────────────────────────────
async def _is_admin(auth_user_id: Optional[int]) -> bool:
    if not auth_user_id:
        return False
    try:
        from backend.core.db.engine import async_session
        from backend.core.db.models import User
        async with async_session() as session:
            user = await session.get(User, int(auth_user_id))
            return bool(user and user.is_admin)
    except Exception:
        return False


@router.get("/logs")
async def get_logs(request: Request, channel_id: Optional[str] = None, limit: int = 100):
    auth_uid = getattr(request.state, "user_id", None)
    is_admin = await _is_admin(auth_uid)
    # Admins see every user's logs; regular users see only their own bucket.
    uids = _all_user_dirs() if is_admin else ([int(auth_uid)] if auth_uid else [])
    logs: list = []
    for uid in uids:
        logs.extend(_load_user_logs(uid))
    if channel_id:
        logs = [l for l in logs if l.get("channel_id") == channel_id]
    logs.sort(key=lambda l: l.get("timestamp", ""), reverse=False)
    return {"logs": logs[-limit:]}


@router.delete("/logs")
async def clear_logs(request: Request):
    auth_uid = getattr(request.state, "user_id", None)
    is_admin = await _is_admin(auth_uid)
    uids = _all_user_dirs() if is_admin else ([int(auth_uid)] if auth_uid else [])
    for uid in uids:
        _save_user_logs(uid, [])
    return {"ok": True}


# ── Test channel connectivity ───────────────────────────────────────
@router.post("/{channel_id}/test")
async def test_channel(channel_id: str):
    """Teste la connectivité d'un canal (vérifie le token/API key)."""
    channels = _load_channels()
    ch = channels.get(channel_id)
    if not ch:
        raise HTTPException(404, "Canal introuvable")

    ch_type = ch.get("type", "")
    config = ch.get("config", {})

    try:
        import httpx
        async with httpx.AsyncClient(timeout=10) as client:
            if ch_type == "telegram":
                bot_token = config.get("bot_token", "")
                if not bot_token or "•" in bot_token:
                    return {"ok": False, "error": "Token manquant"}
                r = await client.get(f"https://api.telegram.org/bot{bot_token}/getMe")
                data = r.json()
                if data.get("ok"):
                    bot = data["result"]
                    # Also check webhook status
                    wh_r = await client.get(f"https://api.telegram.org/bot{bot_token}/getWebhookInfo")
                    wh_data = wh_r.json()
                    wh_url = wh_data.get("result", {}).get("url", "")
                    wh_info = f" | Webhook: {'✓ actif' if wh_url else '✗ non configuré'}"
                    return {"ok": True, "info": f"@{bot.get('username', '')} ({bot.get('first_name', '')}){wh_info}"}
                return {"ok": False, "error": data.get("description", "Erreur inconnue")}

            elif ch_type == "discord":
                bot_token = config.get("bot_token", "")
                if not bot_token or "•" in bot_token:
                    return {"ok": False, "error": "Token manquant"}
                r = await client.get(
                    "https://discord.com/api/v10/users/@me",
                    headers={"Authorization": f"Bot {bot_token}"},
                )
                if r.status_code == 200:
                    data = r.json()
                    return {"ok": True, "info": f"{data.get('username', '')}#{data.get('discriminator', '')}"}
                return {"ok": False, "error": f"HTTP {r.status_code}"}

            elif ch_type == "slack":
                bot_token = config.get("bot_token", "")
                if not bot_token or "•" in bot_token:
                    return {"ok": False, "error": "Token manquant"}
                r = await client.post(
                    "https://slack.com/api/auth.test",
                    headers={"Authorization": f"Bearer {bot_token}"},
                )
                data = r.json()
                if data.get("ok"):
                    return {"ok": True, "info": f"{data.get('team', '')} — {data.get('user', '')}"}
                return {"ok": False, "error": data.get("error", "Erreur")}

            elif ch_type == "whatsapp":
                access_token = config.get("access_token", "")
                phone_id = config.get("phone_number_id", "")
                if not access_token or "•" in access_token:
                    return {"ok": False, "error": "Access token manquant"}
                r = await client.get(
                    f"https://graph.facebook.com/v18.0/{phone_id}",
                    headers={"Authorization": f"Bearer {access_token}"},
                )
                if r.status_code == 200:
                    data = r.json()
                    return {"ok": True, "info": f"Phone: {data.get('display_phone_number', phone_id)}"}
                return {"ok": False, "error": f"HTTP {r.status_code}"}

            elif ch_type == "email":
                # Test IMAP connection
                import imaplib
                host = config.get("imap_host", "")
                port = int(config.get("imap_port", 993))
                email_addr = config.get("email_address", "")
                email_pass = config.get("email_password", "")
                if not host or not email_addr:
                    return {"ok": False, "error": "Configuration IMAP incomplète"}
                try:
                    imap = imaplib.IMAP4_SSL(host, port)
                    imap.login(email_addr, email_pass)
                    imap.logout()
                    return {"ok": True, "info": f"IMAP OK — {email_addr}"}
                except Exception as e:
                    return {"ok": False, "error": str(e)}

            else:
                return {"ok": True, "info": "Canal configuré (pas de test spécifique)"}

    except Exception as e:
        return {"ok": False, "error": str(e)}


# ═══════════════════════════════════════════════════════════════════════════════
# OAuth flows — allow agent to set up channels with minimal user interaction
# User only needs to click 1 link to authorize, callback does the rest
# ═══════════════════════════════════════════════════════════════════════════════

# ── Slack OAuth ────────────────────────────────────────────────────────
SLACK_SCOPES = "channels:history,channels:read,chat:write,im:history,im:read,im:write,app_mentions:read,users:read"

@router.get("/oauth/slack/start/{channel_id}")
async def slack_oauth_start(channel_id: str, request: Request):
    """Generate Slack OAuth authorization URL. User clicks this to install the app."""
    channels = _load_channels()
    ch = channels.get(channel_id)
    if not ch or ch.get("type") != "slack":
        raise HTTPException(404, "Canal Slack introuvable")

    client_id = ch.get("config", {}).get("client_id", "")
    if not client_id:
        raise HTTPException(400, "client_id manquant dans la config du canal. Créez d'abord une app Slack.")

    base_url = _get_public_base_url(request)
    redirect_uri = f"{base_url}/api/plugins/channels/oauth/slack/callback/{channel_id}"

    oauth_url = (
        f"https://slack.com/oauth/v2/authorize"
        f"?client_id={client_id}"
        f"&scope={SLACK_SCOPES}"
        f"&redirect_uri={redirect_uri}"
    )
    return {"ok": True, "oauth_url": oauth_url, "redirect_uri": redirect_uri,
            "message": "Envoyez ce lien à l'utilisateur pour qu'il autorise l'app Slack."}


@router.get("/oauth/slack/callback/{channel_id}")
async def slack_oauth_callback(channel_id: str, request: Request):
    """Slack OAuth callback — receives the code, exchanges for bot token, saves to channel."""
    code = request.query_params.get("code")
    error = request.query_params.get("error")

    if error:
        return Response(
            content=f"<html><body><h2>Autorisation refusée</h2><p>{error}</p></body></html>",
            media_type="text/html"
        )
    if not code:
        return Response(
            content="<html><body><h2>Erreur</h2><p>Code d'autorisation manquant.</p></body></html>",
            media_type="text/html"
        )

    owner_uid = _channel_owner(channel_id)
    channels = _load_user_channels(owner_uid) if owner_uid is not None else {}
    ch = channels.get(channel_id)
    if not ch or ch.get("type") != "slack":
        return Response(
            content="<html><body><h2>Erreur</h2><p>Canal introuvable.</p></body></html>",
            media_type="text/html"
        )

    client_id = ch.get("config", {}).get("client_id", "")
    client_secret = ch.get("config", {}).get("client_secret", "")
    if not client_id or not client_secret:
        return Response(
            content="<html><body><h2>Erreur</h2><p>client_id ou client_secret manquant.</p></body></html>",
            media_type="text/html"
        )

    base_url = _get_public_base_url(request)
    redirect_uri = f"{base_url}/api/plugins/channels/oauth/slack/callback/{channel_id}"

    # Exchange code for bot token
    import httpx
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            r = await client.post("https://slack.com/api/oauth.v2.access", data={
                "client_id": client_id,
                "client_secret": client_secret,
                "code": code,
                "redirect_uri": redirect_uri,
            })
            data = r.json()

        if not data.get("ok"):
            return Response(
                content=f"<html><body><h2>Erreur Slack</h2><p>{data.get('error', 'unknown')}</p></body></html>",
                media_type="text/html"
            )

        # Extract tokens
        bot_token = data.get("access_token", "")
        team_name = data.get("team", {}).get("name", "")
        bot_user_id = data.get("bot_user_id", "")

        # Save to channel config
        ch.setdefault("config", {})
        ch["config"]["bot_token"] = bot_token
        ch["config"]["team_name"] = team_name
        ch["config"]["bot_user_id"] = bot_user_id
        ch["enabled"] = True
        channels[channel_id] = ch
        _save_user_channels(owner_uid, channels)

        _add_log(channel_id, ch.get("name", ""), "system",
                 f"OAuth Slack réussi — workspace: {team_name}, bot activé", "ok")

        return Response(
            content=(
                f"<html><head><style>body{{font-family:system-ui;background:#1a1a2e;color:#eee;display:flex;"
                f"align-items:center;justify-content:center;height:100vh;margin:0}}"
                f".card{{background:#16213e;padding:2rem;border-radius:1rem;text-align:center;max-width:400px}}"
                f"h2{{color:#dc2626}}p{{color:#aaa}}</style></head>"
                f"<body><div class='card'>"
                f"<h2>✅ Slack connecté !</h2>"
                f"<p>Workspace : <strong>{team_name}</strong></p>"
                f"<p>Le bot est maintenant actif. Vous pouvez fermer cette page.</p>"
                f"</div></body></html>"
            ),
            media_type="text/html"
        )
    except Exception as e:
        return Response(
            content=f"<html><body><h2>Erreur</h2><p>{str(e)}</p></body></html>",
            media_type="text/html"
        )


# ── Discord OAuth ──────────────────────────────────────────────────────
DISCORD_SCOPES = "bot applications.commands"
DISCORD_BOT_PERMISSIONS = "2048"  # Send Messages

@router.get("/oauth/discord/start/{channel_id}")
async def discord_oauth_start(channel_id: str, request: Request):
    """Generate Discord OAuth bot invite URL."""
    channels = _load_channels()
    ch = channels.get(channel_id)
    if not ch or ch.get("type") != "discord":
        raise HTTPException(404, "Canal Discord introuvable")

    application_id = ch.get("config", {}).get("application_id", "")
    if not application_id:
        raise HTTPException(400, "application_id manquant dans la config du canal.")

    base_url = _get_public_base_url(request)
    redirect_uri = f"{base_url}/api/plugins/channels/oauth/discord/callback/{channel_id}"

    oauth_url = (
        f"https://discord.com/api/oauth2/authorize"
        f"?client_id={application_id}"
        f"&permissions={DISCORD_BOT_PERMISSIONS}"
        f"&scope={DISCORD_SCOPES.replace(' ', '%20')}"
        f"&redirect_uri={redirect_uri}"
        f"&response_type=code"
    )
    return {"ok": True, "oauth_url": oauth_url,
            "message": "Envoyez ce lien à l'utilisateur pour inviter le bot Discord."}


@router.get("/oauth/discord/callback/{channel_id}")
async def discord_oauth_callback(channel_id: str, request: Request):
    """Discord OAuth callback — confirms bot was added to guild."""
    code = request.query_params.get("code")
    guild_id = request.query_params.get("guild_id")
    error = request.query_params.get("error")

    if error:
        return Response(
            content=f"<html><body><h2>Autorisation refusée</h2><p>{error}</p></body></html>",
            media_type="text/html"
        )

    owner_uid = _channel_owner(channel_id)
    channels = _load_user_channels(owner_uid) if owner_uid is not None else {}
    ch = channels.get(channel_id)
    if ch:
        if guild_id:
            ch.setdefault("config", {})["guild_id"] = guild_id
        ch["enabled"] = True
        channels[channel_id] = ch
        _save_user_channels(owner_uid, channels)
        _add_log(channel_id, ch.get("name", ""), "system",
                 f"OAuth Discord réussi — guild: {guild_id}", "ok")

    return Response(
        content=(
            f"<html><head><style>body{{font-family:system-ui;background:#1a1a2e;color:#eee;display:flex;"
            f"align-items:center;justify-content:center;height:100vh;margin:0}}"
            f".card{{background:#16213e;padding:2rem;border-radius:1rem;text-align:center;max-width:400px}}"
            f"h2{{color:#dc2626}}p{{color:#aaa}}</style></head>"
            f"<body><div class='card'>"
            f"<h2>✅ Discord connecté !</h2>"
            f"<p>Le bot a été ajouté au serveur. Vous pouvez fermer cette page.</p>"
            f"</div></body></html>"
        ),
        media_type="text/html"
    )
