"""
Gungnir Plugin — Intégrations (Webhooks + Apps + MCP)

Hub central pour connecter des apps externes à l'agent :
  - Intégrations prédéfinies (Gmail, Drive, Calendar, GitHub, Slack, Notion, etc.)
  - Serveurs MCP (outils accessibles par l'agent via JSON-RPC)
  - Webhooks custom (entrants/sortants)

L'agent accède à tout via le système MCP tools existant.
Plugin indépendant — lit la config core, pas d'import cross-plugin.
"""
import asyncio
import hashlib as _hashlib
import hmac as _hmac
import json
import logging
import uuid
from datetime import datetime
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException, Request, Depends, Response
from fastapi.responses import JSONResponse
from sqlalchemy.ext.asyncio import AsyncSession
from backend.core.db.engine import get_session
from pydantic import BaseModel

logger = logging.getLogger("gungnir.webhooks")
router = APIRouter()

DATA_DIR = Path("data")


# ══════════════════════════════════════════════════════════════════════════════
# Per-user data isolation
# ══════════════════════════════════════════════════════════════════════════════
#
# Toutes les écritures DOIVENT être scopées au user authentifié, sinon on
# retombait sur ``data/<plugin>/0/`` (fallback uid=0) — partagé entre tous
# les users en mode setup et exposé à un cross-user leak. Les helpers ici
# raise 401 si l'appelant n'a pas de user_id valide. Pour la route entrante
# publique ``/incoming/{webhook_id}`` qui ne peut pas exiger un Bearer (les
# services externes type GitHub/Stripe/n8n ne l'envoient pas), on résout le
# user_id depuis le webhook_id via :func:`_resolve_webhook_owner`.


def _require_user_id(request: Request) -> int:
    uid = getattr(request.state, "user_id", None)
    if not uid or int(uid) <= 0:
        raise HTTPException(status_code=401, detail="Authentification requise")
    return int(uid)


def _user_integrations_file(request: Request) -> Path:
    """Return per-user integrations file path. 401 si pas authentifié."""
    uid = _require_user_id(request)
    p = DATA_DIR / "integrations" / str(uid) / "integrations.json"
    p.parent.mkdir(parents=True, exist_ok=True)
    return p


def _user_webhooks_file(request: Request) -> Path:
    """Return per-user webhooks file path. 401 si pas authentifié."""
    uid = _require_user_id(request)
    p = DATA_DIR / "webhooks" / str(uid) / "webhooks.json"
    p.parent.mkdir(parents=True, exist_ok=True)
    return p


def _user_webhook_logs_file(request: Request) -> Path:
    """Return per-user webhook logs file path. 401 si pas authentifié."""
    uid = _require_user_id(request)
    p = DATA_DIR / "webhooks" / str(uid) / "webhook_logs.json"
    p.parent.mkdir(parents=True, exist_ok=True)
    return p


def _webhooks_file_for_uid(uid: int) -> Path:
    """Variante qui prend un uid déjà résolu (pour les routes publiques type
    /incoming/{webhook_id} où l'uid vient du webhook_id, pas du Bearer)."""
    p = DATA_DIR / "webhooks" / str(int(uid)) / "webhooks.json"
    p.parent.mkdir(parents=True, exist_ok=True)
    return p


def _webhook_logs_file_for_uid(uid: int) -> Path:
    p = DATA_DIR / "webhooks" / str(int(uid)) / "webhook_logs.json"
    p.parent.mkdir(parents=True, exist_ok=True)
    return p


def _resolve_webhook_owner(webhook_id: str) -> Optional[tuple[int, dict]]:
    """Trouve le user qui possède ``webhook_id`` en scannant les dossiers
    ``data/webhooks/<uid>/webhooks.json``. Renvoie ``(uid, webhook_dict)``
    ou ``None`` si introuvable.

    On ignore ``data/webhooks/0/`` (legacy / fallback partagé) — un webhook
    qui aurait atterri là par accident ne sera pas servi, ce qui force une
    re-création propre dans le dossier du user authentifié."""
    base = DATA_DIR / "webhooks"
    if not base.exists():
        return None
    for user_dir in base.iterdir():
        if not user_dir.is_dir():
            continue
        try:
            uid = int(user_dir.name)
        except ValueError:
            continue
        if uid <= 0:
            continue
        webhooks_file = user_dir / "webhooks.json"
        if not webhooks_file.exists():
            continue
        try:
            data = json.loads(webhooks_file.read_text(encoding="utf-8"))
        except Exception:
            continue
        if not isinstance(data, list):
            continue
        for wh in data:
            if isinstance(wh, dict) and wh.get("id") == webhook_id:
                return uid, wh
    return None


# ══════════════════════════════════════════════════════════════════════════════
# Mirror integrations → mcp_server_configs (DB)
# ══════════════════════════════════════════════════════════════════════════════
# Pourquoi : la liste des intégrations est stockée en JSON per-user, mais le
# manager MCP lit uniquement mcp_server_configs (DB) via ensure_user_started.
# Sans mirror, une intégration démarrée survit en mémoire, mais au prochain
# boot du backend elle serait oubliée. Le backup/restore exporte aussi depuis
# la DB — donc écrire dedans garantit la persistence complète.

async def _mirror_integration_to_db(
    user_id: int,
    server_name: str,
    command: str,
    args: list[str],
    env: dict,
    enabled: bool,
) -> None:
    """Upsert mcp_server_configs depuis une intégration webhooks. Les env vars
    sensibles (key/secret/token/password) sont chiffrées avant stockage."""
    if not user_id or not server_name or not command:
        return
    from backend.core.db.engine import get_session
    from backend.core.db.models import MCPServerConfig as DBMCPServerConfig
    from backend.core.config.settings import encrypt_value
    from sqlalchemy import select, delete as _sqldelete

    env_to_store: dict = {}
    for k, v in (env or {}).items():
        if not isinstance(v, str) or not v:
            env_to_store[k] = v
            continue
        sensitive = any(t in k.lower() for t in ("key", "secret", "token", "password"))
        if sensitive and not v.startswith(("FERNET:", "enc:")):
            env_to_store[k] = encrypt_value(v)
        else:
            env_to_store[k] = v

    async for sess in get_session():
        try:
            await sess.execute(_sqldelete(DBMCPServerConfig).where(
                DBMCPServerConfig.user_id == user_id,
                DBMCPServerConfig.name == server_name,
            ))
            sess.add(DBMCPServerConfig(
                user_id=user_id,
                name=server_name,
                command=command,
                args_json=list(args or []),
                env_json=env_to_store,
                enabled=bool(enabled),
            ))
            await sess.commit()
            logger.info(f"MCP mirrored to DB: user={user_id} name={server_name} enabled={enabled}")
        except Exception as e:
            await sess.rollback()
            logger.warning(f"MCP mirror failed: {e}")
        break


async def _remove_integration_from_db(user_id: int, server_name: str) -> None:
    """Supprime l'entrée mcp_server_configs correspondante si elle existe."""
    if not user_id or not server_name:
        return
    from backend.core.db.engine import get_session
    from backend.core.db.models import MCPServerConfig as DBMCPServerConfig
    from sqlalchemy import delete as _sqldelete

    async for sess in get_session():
        try:
            await sess.execute(_sqldelete(DBMCPServerConfig).where(
                DBMCPServerConfig.user_id == user_id,
                DBMCPServerConfig.name == server_name,
            ))
            await sess.commit()
        except Exception as e:
            await sess.rollback()
            logger.warning(f"MCP DB delete failed: {e}")
        break


# ══════════════════════════════════════════════════════════════════════════════
# Data Persistence
# ══════════════════════════════════════════════════════════════════════════════

def _load_json(path: Path, default=None):
    if path.exists():
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            pass
    return default if default is not None else []


def _save_json(path: Path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")


# ══════════════════════════════════════════════════════════════════════════════
# Pre-defined Integration Catalog
# ══════════════════════════════════════════════════════════════════════════════

INTEGRATION_CATALOG = {
    # ── Google Workspace ─────────────────────────────────────
    "gmail": {
        "display_name": "Gmail",
        "icon": "📧",
        "category": "communication",
        "description": "Lire, envoyer et gérer vos emails",
        "auth_type": "oauth2",
        "mcp_package": "@anthropic/gmail-mcp",
        "mcp_command": "npx",
        "mcp_args": ["-y", "@anthropic/gmail-mcp"],
        "required_env": ["GMAIL_OAUTH_CLIENT_ID", "GMAIL_OAUTH_CLIENT_SECRET", "GMAIL_REFRESH_TOKEN"],
        "doc_url": "https://developers.google.com/gmail/api",
        "setup_guide": "Créez un projet Google Cloud, activez l'API Gmail, créez des credentials OAuth2.",
    },
    "google_calendar": {
        "display_name": "Google Calendar",
        "icon": "📅",
        "category": "productivite",
        "description": "Gérer vos événements et rendez-vous",
        "auth_type": "oauth2",
        "mcp_package": "@anthropic/google-calendar-mcp",
        "mcp_command": "npx",
        "mcp_args": ["-y", "@anthropic/google-calendar-mcp"],
        "required_env": ["GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET", "GOOGLE_REFRESH_TOKEN"],
        "doc_url": "https://developers.google.com/calendar",
        "setup_guide": "Utilisez les mêmes credentials OAuth2 Google que Gmail.",
    },
    "google_drive": {
        "display_name": "Google Drive",
        "icon": "📁",
        "category": "stockage",
        "description": "Accéder et gérer vos fichiers Drive",
        "auth_type": "oauth2",
        "mcp_package": "@anthropic/google-drive-mcp",
        "mcp_command": "npx",
        "mcp_args": ["-y", "@anthropic/google-drive-mcp"],
        "required_env": ["GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET", "GOOGLE_REFRESH_TOKEN"],
        "doc_url": "https://developers.google.com/drive",
        "setup_guide": "Utilisez les mêmes credentials OAuth2 Google.",
    },
    "google_tasks": {
        "display_name": "Google Tasks",
        "icon": "✅",
        "category": "productivite",
        "description": "Gérer vos listes de tâches",
        "auth_type": "oauth2",
        "mcp_package": "@anthropic/google-tasks-mcp",
        "mcp_command": "npx",
        "mcp_args": ["-y", "@anthropic/google-tasks-mcp"],
        "required_env": ["GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET", "GOOGLE_REFRESH_TOKEN"],
        "doc_url": "https://developers.google.com/tasks",
        "setup_guide": "Utilisez les mêmes credentials OAuth2 Google.",
    },

    # ── Dev & Collaboration ──────────────────────────────────
    "github": {
        "display_name": "GitHub",
        "icon": "🐙",
        "category": "dev",
        "description": "Repos, issues, PRs, actions",
        "auth_type": "token",
        "mcp_package": "@modelcontextprotocol/server-github",
        "mcp_command": "npx",
        "mcp_args": ["-y", "@modelcontextprotocol/server-github"],
        "required_env": ["GITHUB_PERSONAL_ACCESS_TOKEN"],
        "doc_url": "https://github.com/modelcontextprotocol/servers/tree/main/src/github",
        "setup_guide": "Créez un Personal Access Token sur GitHub > Settings > Developer settings.",
    },
    "gitlab": {
        "display_name": "GitLab",
        "icon": "🦊",
        "category": "dev",
        "description": "Repos, issues, merge requests",
        "auth_type": "token",
        "mcp_package": "@modelcontextprotocol/server-gitlab",
        "mcp_command": "npx",
        "mcp_args": ["-y", "@modelcontextprotocol/server-gitlab"],
        "required_env": ["GITLAB_PERSONAL_ACCESS_TOKEN", "GITLAB_API_URL"],
        "doc_url": "https://github.com/modelcontextprotocol/servers/tree/main/src/gitlab",
        "setup_guide": "GitLab > Preferences > Access Tokens. URL par défaut : https://gitlab.com/api/v4",
    },
    "notion": {
        "display_name": "Notion",
        "icon": "📝",
        "category": "productivite",
        "description": "Pages, bases de données, blocs",
        "auth_type": "token",
        "mcp_package": "@modelcontextprotocol/server-notion",
        "mcp_command": "npx",
        "mcp_args": ["-y", "@modelcontextprotocol/server-notion"],
        "required_env": ["NOTION_API_KEY"],
        "doc_url": "https://github.com/modelcontextprotocol/servers/tree/main/src/notion",
        "setup_guide": "Notion > Settings > Integrations > New integration. Copiez le token.",
    },
    "linear": {
        "display_name": "Linear",
        "icon": "📐",
        "category": "productivite",
        "description": "Issues, projets, cycles",
        "auth_type": "token",
        "mcp_package": "@anthropic/linear-mcp",
        "mcp_command": "npx",
        "mcp_args": ["-y", "@anthropic/linear-mcp"],
        "required_env": ["LINEAR_API_KEY"],
        "doc_url": "https://linear.app/docs",
        "setup_guide": "Linear > Settings > API > Personal API Keys.",
    },

    # ── Communication ────────────────────────────────────────
    "slack": {
        "display_name": "Slack",
        "icon": "💬",
        "category": "communication",
        "description": "Messages, channels, fichiers",
        "auth_type": "token",
        "mcp_package": "@modelcontextprotocol/server-slack",
        "mcp_command": "npx",
        "mcp_args": ["-y", "@modelcontextprotocol/server-slack"],
        "required_env": ["SLACK_BOT_TOKEN", "SLACK_TEAM_ID"],
        "doc_url": "https://github.com/modelcontextprotocol/servers/tree/main/src/slack",
        "setup_guide": "Créez une Slack App, ajoutez les scopes bot, installez dans le workspace.",
    },
    "discord": {
        "display_name": "Discord",
        "icon": "🎮",
        "category": "communication",
        "description": "Messages, channels, serveurs",
        "auth_type": "token",
        "mcp_package": None,
        "mcp_command": None,
        "mcp_args": [],
        "required_env": ["DISCORD_BOT_TOKEN"],
        "doc_url": "https://discord.com/developers/docs",
        "setup_guide": "Discord Developer Portal > New Application > Bot > Token.",
    },

    # ── Automation ───────────────────────────────────────────
    "n8n": {
        "display_name": "n8n",
        "icon": "⚡",
        "category": "automation",
        "description": "Workflows, automatisations, 400+ intégrations",
        "auth_type": "api_key",
        "mcp_package": "@n8n/n8n-mcp-server",
        "mcp_command": "npx",
        "mcp_args": ["-y", "@n8n/n8n-mcp-server"],
        "required_env": ["N8N_HOST", "N8N_API_KEY"],
        "doc_url": "https://docs.n8n.io",
        "setup_guide": "n8n > Settings > API > Create API Key. Host = URL de votre instance n8n.",
    },
    "zapier": {
        "display_name": "Zapier",
        "icon": "⚙️",
        "category": "automation",
        "description": "Zaps, triggers, 5000+ apps",
        "auth_type": "api_key",
        "mcp_package": None,
        "mcp_command": None,
        "mcp_args": [],
        "required_env": ["ZAPIER_NLA_API_KEY"],
        "doc_url": "https://nla.zapier.com",
        "setup_guide": "Zapier > Developer > Natural Language Actions API Key.",
    },

    # ── Bases & Search ───────────────────────────────────────
    "supabase": {
        "display_name": "Supabase",
        "icon": "🟢",
        "category": "database",
        "description": "Base PostgreSQL, Auth, Storage, Realtime, pgvector",
        "auth_type": "api_key",
        "mcp_package": "@supabase/mcp-server-supabase",
        "mcp_command": "npx",
        "mcp_args": ["-y", "@supabase/mcp-server-supabase"],
        "required_env": ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"],
        "doc_url": "https://supabase.com/docs",
        "setup_guide": "Supabase Dashboard > Settings > API. Copiez l'URL et le service_role key.",
    },
    "brave_search": {
        "display_name": "Brave Search",
        "icon": "🔍",
        "category": "search",
        "description": "Recherche web via API Brave",
        "auth_type": "api_key",
        "mcp_package": "@modelcontextprotocol/server-brave-search",
        "mcp_command": "npx",
        "mcp_args": ["-y", "@modelcontextprotocol/server-brave-search"],
        "required_env": ["BRAVE_API_KEY"],
        "doc_url": "https://brave.com/search/api/",
        "setup_guide": "Brave Search API > Get API Key.",
    },

    # ── Fichiers & Données ───────────────────────────────────
    "filesystem": {
        "display_name": "Système de fichiers",
        "icon": "📂",
        "category": "stockage",
        "description": "Lire/écrire des fichiers locaux",
        "auth_type": "none",
        "mcp_package": "@modelcontextprotocol/server-filesystem",
        "mcp_command": "npx",
        "mcp_args": ["-y", "@modelcontextprotocol/server-filesystem"],
        "required_env": [],
        "extra_args": ["./data/workspace"],
        "doc_url": "https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem",
        "setup_guide": "Aucune configuration requise. Accès au dossier workspace par défaut.",
    },

    # ── Productivité & Tickets ───────────────────────────────
    "linear": {
        "display_name": "Linear",
        "icon": "📐",
        "category": "productivite",
        "description": "Issues, cycles, projets, équipes",
        "auth_type": "token",
        "mcp_package": "@tacticlaunch/mcp-linear",
        "mcp_command": "npx",
        "mcp_args": ["-y", "@tacticlaunch/mcp-linear"],
        "required_env": ["LINEAR_API_KEY"],
        "doc_url": "https://linear.app/settings/api",
        "setup_guide": "Linear → Settings → API → Personal API keys → Create new key.",
    },
    "asana": {
        "display_name": "Asana",
        "icon": "🎯",
        "category": "productivite",
        "description": "Tâches, projets, workspaces",
        "auth_type": "token",
        "mcp_package": "@roychri/mcp-server-asana",
        "mcp_command": "npx",
        "mcp_args": ["-y", "@roychri/mcp-server-asana"],
        "required_env": ["ASANA_ACCESS_TOKEN"],
        "doc_url": "https://app.asana.com/0/my-apps",
        "setup_guide": "Asana → Profile → My Apps → Create new token. Format starts with 1/...",
    },
    "trello": {
        "display_name": "Trello",
        "icon": "📌",
        "category": "productivite",
        "description": "Boards, listes, cards Trello",
        "auth_type": "token",
        "mcp_package": "@delorenj/mcp-server-trello",
        "mcp_command": "npx",
        "mcp_args": ["-y", "@delorenj/mcp-server-trello"],
        "required_env": ["TRELLO_API_KEY", "TRELLO_TOKEN"],
        "doc_url": "https://trello.com/app-key",
        "setup_guide": "Trello → trello.com/app-key → récupère API key + générer un token.",
    },
    "jira": {
        "display_name": "Jira",
        "icon": "🦗",
        "category": "productivite",
        "description": "Issues, projets, sprints Jira",
        "auth_type": "token",
        "mcp_package": "mcp-atlassian",
        "mcp_command": "npx",
        "mcp_args": ["-y", "mcp-atlassian"],
        "required_env": ["JIRA_HOST", "JIRA_EMAIL", "JIRA_API_TOKEN"],
        "doc_url": "https://id.atlassian.com/manage-profile/security/api-tokens",
        "setup_guide": "Atlassian → Account → Security → API tokens → Create. JIRA_HOST = ton domaine *.atlassian.net.",
    },

    # ── Database & Storage ────────────────────────────────────
    "postgres": {
        "display_name": "PostgreSQL",
        "icon": "🐘",
        "category": "database",
        "description": "Requêtes SQL en lecture sur ta base PostgreSQL",
        "auth_type": "token",
        "mcp_package": "@modelcontextprotocol/server-postgres",
        "mcp_command": "npx",
        "mcp_args": ["-y", "@modelcontextprotocol/server-postgres"],
        "required_env": ["POSTGRES_CONNECTION_STRING"],
        "doc_url": "https://github.com/modelcontextprotocol/servers/tree/main/src/postgres",
        "setup_guide": "Format : postgresql://user:password@host:port/dbname (ou postgres://). Lecture seule.",
    },
    "sqlite": {
        "display_name": "SQLite",
        "icon": "💾",
        "category": "database",
        "description": "Lire/requêter une base SQLite locale",
        "auth_type": "none",
        "mcp_package": "@modelcontextprotocol/server-sqlite",
        "mcp_command": "npx",
        "mcp_args": ["-y", "@modelcontextprotocol/server-sqlite"],
        "required_env": [],
        "extra_args": ["./data/database.db"],
        "doc_url": "https://github.com/modelcontextprotocol/servers/tree/main/src/sqlite",
        "setup_guide": "Modifie extra_args pour pointer vers ton fichier .db si différent.",
    },
    "supabase": {
        "display_name": "Supabase",
        "icon": "⚡",
        "category": "database",
        "description": "Tables, fonctions edge, storage Supabase",
        "auth_type": "token",
        "mcp_package": "@supabase/mcp-server-supabase",
        "mcp_command": "npx",
        "mcp_args": ["-y", "@supabase/mcp-server-supabase"],
        "required_env": ["SUPABASE_ACCESS_TOKEN"],
        "doc_url": "https://supabase.com/dashboard/account/tokens",
        "setup_guide": "Supabase Dashboard → Account → Access Tokens → Generate.",
    },

    # ── Recherche ─────────────────────────────────────────────
    "brave_search": {
        "display_name": "Brave Search",
        "icon": "🦁",
        "category": "search",
        "description": "Recherche web via Brave Search API",
        "auth_type": "token",
        "mcp_package": "@modelcontextprotocol/server-brave-search",
        "mcp_command": "npx",
        "mcp_args": ["-y", "@modelcontextprotocol/server-brave-search"],
        "required_env": ["BRAVE_API_KEY"],
        "doc_url": "https://brave.com/search/api/",
        "setup_guide": "Brave Search API → Subscribe au plan Free (2000 req/mois) → API key.",
    },

    # ── Automatisation ───────────────────────────────────────
    "stripe": {
        "display_name": "Stripe",
        "icon": "💳",
        "category": "automation",
        "description": "Customers, charges, subscriptions, invoices",
        "auth_type": "token",
        "mcp_package": "@stripe/mcp",
        "mcp_command": "npx",
        "mcp_args": ["-y", "@stripe/mcp", "--tools=all"],
        "required_env": ["STRIPE_SECRET_KEY"],
        "doc_url": "https://dashboard.stripe.com/apikeys",
        "setup_guide": "Stripe Dashboard → Developers → API keys → Secret key (sk_test_... ou sk_live_...).",
    },
    "discord": {
        "display_name": "Discord",
        "icon": "🎮",
        "category": "communication",
        "description": "Send messages, manage channels, members",
        "auth_type": "token",
        "mcp_package": "@v-3/discordmcp",
        "mcp_command": "npx",
        "mcp_args": ["-y", "@v-3/discordmcp"],
        "required_env": ["DISCORD_TOKEN"],
        "doc_url": "https://discord.com/developers/applications",
        "setup_guide": "Discord Developer Portal → New Application → Bot → Reset Token. Active les bons intents.",
    },
    "youtube": {
        "display_name": "YouTube",
        "icon": "📺",
        "category": "search",
        "description": "Recherche vidéos, transcripts, métadonnées",
        "auth_type": "token",
        "mcp_package": "@anaisbetts/mcp-youtube",
        "mcp_command": "npx",
        "mcp_args": ["-y", "@anaisbetts/mcp-youtube"],
        "required_env": ["YOUTUBE_API_KEY"],
        "doc_url": "https://console.cloud.google.com/apis/library/youtube.googleapis.com",
        "setup_guide": "Google Cloud Console → activer YouTube Data API v3 → Credentials → API key.",
    },

    # ── MCP officiels (utilities transversales) ──────────────
    "memory": {
        "display_name": "Memory / Knowledge Graph",
        "icon": "🧠",
        "category": "stockage",
        "description": "Knowledge graph local persistant — entités, relations, observations",
        "auth_type": "none",
        "mcp_package": "@modelcontextprotocol/server-memory",
        "mcp_command": "npx",
        "mcp_args": ["-y", "@modelcontextprotocol/server-memory"],
        "required_env": [],
        "doc_url": "https://github.com/modelcontextprotocol/servers/tree/main/src/memory",
        "setup_guide": "Aucune config. L'agent stocke automatiquement les entités/faits dans un knowledge graph local persistant.",
    },
    "sequential_thinking": {
        "display_name": "Sequential Thinking",
        "icon": "🪜",
        "category": "automation",
        "description": "Raisonnement structuré multi-étapes (chain-of-thought explicite)",
        "auth_type": "none",
        "mcp_package": "@modelcontextprotocol/server-sequential-thinking",
        "mcp_command": "npx",
        "mcp_args": ["-y", "@modelcontextprotocol/server-sequential-thinking"],
        "required_env": [],
        "doc_url": "https://github.com/modelcontextprotocol/servers/tree/main/src/sequentialthinking",
        "setup_guide": "Aucune config. Force l'agent à dérouler son raisonnement en étapes vérifiables.",
    },
    "time": {
        "display_name": "Time / Timezone",
        "icon": "⏰",
        "category": "automation",
        "description": "Conversion timezone, calculs date/heure",
        "auth_type": "none",
        "mcp_package": "@modelcontextprotocol/server-time",
        "mcp_command": "uvx",
        "mcp_args": ["mcp-server-time"],
        "required_env": [],
        "doc_url": "https://github.com/modelcontextprotocol/servers/tree/main/src/time",
        "setup_guide": "Aucune config. Utilise `uvx` (Python). Permet à l'agent de raisonner correctement sur les timezones.",
    },
    "fetch": {
        "display_name": "Fetch HTTP",
        "icon": "🌐",
        "category": "automation",
        "description": "Fetch d'URL générique avec extraction du contenu",
        "auth_type": "none",
        "mcp_package": "@modelcontextprotocol/server-fetch",
        "mcp_command": "uvx",
        "mcp_args": ["mcp-server-fetch"],
        "required_env": [],
        "doc_url": "https://github.com/modelcontextprotocol/servers/tree/main/src/fetch",
        "setup_guide": "Aucune config. Alternative au `web_fetch` interne. Extrait le contenu principal des pages web (markdown).",
    },
    "puppeteer": {
        "display_name": "Puppeteer / Browser",
        "icon": "🎭",
        "category": "automation",
        "description": "Browser headless — navigation, screenshot, click, formulaires",
        "auth_type": "none",
        "mcp_package": "@modelcontextprotocol/server-puppeteer",
        "mcp_command": "npx",
        "mcp_args": ["-y", "@modelcontextprotocol/server-puppeteer"],
        "required_env": [],
        "doc_url": "https://github.com/modelcontextprotocol/servers/tree/main/src/puppeteer",
        "setup_guide": "Aucune config. Alternative aux browser tools internes. Plus puissant pour les sites lourds en JS.",
    },

    # ── Dev / Infra ──────────────────────────────────────────
    "sentry": {
        "display_name": "Sentry",
        "icon": "🛡️",
        "category": "dev",
        "description": "Issues, performance, releases Sentry",
        "auth_type": "token",
        "mcp_package": "@sentry/mcp-server",
        "mcp_command": "npx",
        "mcp_args": ["-y", "@sentry/mcp-server"],
        "required_env": ["SENTRY_AUTH_TOKEN", "SENTRY_ORG"],
        "doc_url": "https://sentry.io/settings/account/api/auth-tokens/",
        "setup_guide": "Sentry → User Settings → Auth Tokens → Create New Token (scope `org:read`, `project:read`, `event:read`). SENTRY_ORG = ton slug d'organisation.",
    },
    "vercel": {
        "display_name": "Vercel",
        "icon": "▲",
        "category": "dev",
        "description": "Projets, déploiements, environments Vercel",
        "auth_type": "token",
        "mcp_package": "@vercel/mcp-server",
        "mcp_command": "npx",
        "mcp_args": ["-y", "@vercel/mcp-server"],
        "required_env": ["VERCEL_API_TOKEN"],
        "doc_url": "https://vercel.com/account/tokens",
        "setup_guide": "Vercel Account → Tokens → Create. Optionnel : restreindre à un team/projet.",
    },
    "cloudflare": {
        "display_name": "Cloudflare",
        "icon": "🟠",
        "category": "dev",
        "description": "Workers, KV, R2, DNS, Pages",
        "auth_type": "token",
        "mcp_package": "@cloudflare/mcp-server-cloudflare",
        "mcp_command": "npx",
        "mcp_args": ["-y", "@cloudflare/mcp-server-cloudflare"],
        "required_env": ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"],
        "doc_url": "https://dash.cloudflare.com/profile/api-tokens",
        "setup_guide": "CF Dashboard → My Profile → API Tokens → Create Custom Token. ACCOUNT_ID dans la sidebar du dashboard.",
    },
    "figma": {
        "display_name": "Figma",
        "icon": "🎨",
        "category": "dev",
        "description": "Lecture de design files, components, frames",
        "auth_type": "token",
        "mcp_package": "figma-mcp",
        "mcp_command": "npx",
        "mcp_args": ["-y", "figma-mcp"],
        "required_env": ["FIGMA_API_KEY"],
        "doc_url": "https://www.figma.com/developers/api#access-tokens",
        "setup_guide": "Figma → Settings → Personal access tokens → Generate (scope `file_read`).",
    },

    # ── Database / Cache supplémentaires ──────────────────────
    "mongodb": {
        "display_name": "MongoDB",
        "icon": "🍃",
        "category": "database",
        "description": "Query collections, aggregations MongoDB",
        "auth_type": "token",
        "mcp_package": "mongodb-mcp-server",
        "mcp_command": "npx",
        "mcp_args": ["-y", "mongodb-mcp-server"],
        "required_env": ["MONGODB_URI"],
        "doc_url": "https://www.mongodb.com/docs/manual/reference/connection-string/",
        "setup_guide": "Format URI : mongodb+srv://user:pass@cluster.mongodb.net/db (Atlas) ou mongodb://localhost:27017 (local).",
    },
    "redis": {
        "display_name": "Redis",
        "icon": "🔴",
        "category": "database",
        "description": "Get/set/list/hash sur une instance Redis",
        "auth_type": "token",
        "mcp_package": "@modelcontextprotocol/server-redis",
        "mcp_command": "npx",
        "mcp_args": ["-y", "@modelcontextprotocol/server-redis"],
        "required_env": ["REDIS_URL"],
        "doc_url": "https://redis.io/docs/connect/clients/",
        "setup_guide": "Format URL : redis://[:password]@host:6379/db. Le serveur expose des tools get/set/delete/list/etc.",
    },
    "airtable": {
        "display_name": "Airtable",
        "icon": "🟦",
        "category": "database",
        "description": "Bases, tables, records Airtable",
        "auth_type": "token",
        "mcp_package": "airtable-mcp-server",
        "mcp_command": "npx",
        "mcp_args": ["-y", "airtable-mcp-server"],
        "required_env": ["AIRTABLE_API_KEY"],
        "doc_url": "https://airtable.com/create/tokens",
        "setup_guide": "Airtable → Developer hub → Personal access tokens → Create. Scope minimum : data.records:read + data.records:write + schema.bases:read.",
    },

    # ── ML / Search ───────────────────────────────────────────
    "huggingface": {
        "display_name": "Hugging Face",
        "icon": "🤗",
        "category": "automation",
        "description": "Models, datasets, spaces — search et inférence",
        "auth_type": "token",
        "mcp_package": "@llmindset/mcp-hfspace",
        "mcp_command": "npx",
        "mcp_args": ["-y", "@llmindset/mcp-hfspace"],
        "required_env": ["HF_TOKEN"],
        "doc_url": "https://huggingface.co/settings/tokens",
        "setup_guide": "HF → Settings → Access Tokens → Create new token (scope read suffisant pour la plupart des cas).",
    },
    "duckduckgo": {
        "display_name": "DuckDuckGo Search",
        "icon": "🦆",
        "category": "search",
        "description": "Recherche web sans API key (alternative à Brave)",
        "auth_type": "none",
        "mcp_package": "duckduckgo-mcp-server",
        "mcp_command": "uvx",
        "mcp_args": ["duckduckgo-mcp-server"],
        "required_env": [],
        "doc_url": "https://github.com/nickclyde/duckduckgo-mcp-server",
        "setup_guide": "Aucune config. Recherche anonyme via DuckDuckGo. Idéal en self-hosting sans clé.",
    },
    "wikipedia": {
        "display_name": "Wikipedia",
        "icon": "📖",
        "category": "search",
        "description": "Recherche d'articles + extracts",
        "auth_type": "none",
        "mcp_package": "@shelm/wikipedia-mcp-server",
        "mcp_command": "npx",
        "mcp_args": ["-y", "@shelm/wikipedia-mcp-server"],
        "required_env": [],
        "doc_url": "https://www.mediawiki.org/wiki/API:Main_page",
        "setup_guide": "Aucune config. Recherche multi-langue (FR/EN/etc.) via l'API publique MediaWiki.",
    },
    "arxiv": {
        "display_name": "arXiv",
        "icon": "📄",
        "category": "search",
        "description": "Recherche de papiers scientifiques",
        "auth_type": "none",
        "mcp_package": "arxiv-mcp-server",
        "mcp_command": "uvx",
        "mcp_args": ["arxiv-mcp-server"],
        "required_env": [],
        "doc_url": "https://info.arxiv.org/help/api/index.html",
        "setup_guide": "Aucune config. Recherche, lecture et résumé de prépublications scientifiques.",
    },
    "reddit": {
        "display_name": "Reddit",
        "icon": "🟥",
        "category": "search",
        "description": "Search posts, comments, subreddits",
        "auth_type": "token",
        "mcp_package": "mcp-server-reddit",
        "mcp_command": "uvx",
        "mcp_args": ["mcp-server-reddit"],
        "required_env": ["REDDIT_CLIENT_ID", "REDDIT_CLIENT_SECRET", "REDDIT_USER_AGENT"],
        "doc_url": "https://www.reddit.com/prefs/apps",
        "setup_guide": "Reddit → Preferences → Apps → Create app (script). USER_AGENT format: `gungnir-bot:v1.0 (by /u/ton_pseudo)`.",
    },

    # ── Communication & Note-taking ───────────────────────────
    "twilio": {
        "display_name": "Twilio",
        "icon": "📞",
        "category": "communication",
        "description": "SMS, voice, WhatsApp via Twilio",
        "auth_type": "token",
        "mcp_package": "twilio-mcp-server",
        "mcp_command": "npx",
        "mcp_args": ["-y", "twilio-mcp-server"],
        "required_env": ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_PHONE_NUMBER"],
        "doc_url": "https://console.twilio.com/",
        "setup_guide": "Twilio Console → Account Info → SID + Auth Token. PHONE_NUMBER = numéro Twilio acheté (format E.164: +33...).",
    },
    "obsidian": {
        "display_name": "Obsidian",
        "icon": "🟣",
        "category": "productivite",
        "description": "Lecture/écriture dans un vault Obsidian local",
        "auth_type": "none",
        "mcp_package": "obsidian-mcp",
        "mcp_command": "npx",
        "mcp_args": ["-y", "obsidian-mcp"],
        "required_env": [],
        "extra_args": ["./data/obsidian-vault"],
        "doc_url": "https://github.com/obsidian-mcp/obsidian-mcp",
        "setup_guide": "Modifie extra_args pour pointer vers ton vault Obsidian. L'agent peut lire/créer des notes en markdown.",
    },
    "n8n": {
        "display_name": "n8n",
        "icon": "🔗",
        "category": "automation",
        "description": "Workflows, executions, credentials n8n",
        "auth_type": "token",
        "mcp_package": "n8n-mcp",
        "mcp_command": "npx",
        "mcp_args": ["-y", "n8n-mcp"],
        "required_env": ["N8N_API_URL", "N8N_API_KEY"],
        "doc_url": "https://docs.n8n.io/api/authentication/",
        "setup_guide": "n8n → Settings → API → Create API key. N8N_API_URL = ton URL n8n + /api/v1 (ex: http://n8n.local/api/v1).",
    },
}

CATEGORIES = {
    "communication": {"label": "Communication", "icon": "💬"},
    "productivite": {"label": "Productivité", "icon": "📋"},
    "dev": {"label": "Développement", "icon": "🐙"},
    "stockage": {"label": "Stockage & Fichiers", "icon": "📁"},
    "automation": {"label": "Automatisation", "icon": "⚡"},
    "database": {"label": "Base de données", "icon": "🗄️"},
    "search": {"label": "Recherche", "icon": "🔍"},
}


# ══════════════════════════════════════════════════════════════════════════════
# Pydantic Models
# ══════════════════════════════════════════════════════════════════════════════

class IntegrationConfig(BaseModel):
    id: str                                    # Matches catalog key or custom ID
    enabled: bool = True
    env_values: dict[str, str] = {}            # User's env values for the MCP server
    mcp_server_name: Optional[str] = None      # Override MCP server name
    extra_args: list[str] = []                 # Additional args for MCP command
    notes: str = ""                            # User notes


class WebhookConfig(BaseModel):
    name: str
    direction: str = "incoming"                # "incoming" | "outgoing"
    url: Optional[str] = None                  # For outgoing: target URL
    secret: Optional[str] = None               # Shared secret for validation
    events: list[str] = []                     # Event types to handle
    enabled: bool = True
    headers: dict[str, str] = {}               # Extra headers for outgoing


# ══════════════════════════════════════════════════════════════════════════════
# Health
# ══════════════════════════════════════════════════════════════════════════════

@router.get("/health")
async def webhooks_health(request: Request):
    integrations = _load_json(_user_integrations_file(request), [])
    webhooks = _load_json(_user_webhooks_file(request), [])
    active_integrations = sum(1 for i in integrations if i.get("enabled"))

    # MCP status — scoped to the current user
    try:
        from backend.core.agents.mcp_client import mcp_manager
        _uid = getattr(request.state, "user_id", None) or 0
        mcp_status = mcp_manager.get_user_server_status(_uid)
    except Exception:
        mcp_status = []

    return {
        "plugin": "webhooks",
        "status": "ok",
        "version": "2.0.0",
        "integrations_total": len(integrations),
        "integrations_active": active_integrations,
        "webhooks_total": len(webhooks),
        "mcp_servers_running": len(mcp_status),
        "mcp_tools_available": sum(s.get("tools", 0) for s in mcp_status),
    }


# ══════════════════════════════════════════════════════════════════════════════
# Integration Catalog
# ══════════════════════════════════════════════════════════════════════════════

@router.get("/catalog")
async def get_catalog():
    """Return the full catalog of available integrations + categories."""
    return {"integrations": INTEGRATION_CATALOG, "categories": CATEGORIES}


# ══════════════════════════════════════════════════════════════════════════════
# User Integrations — CRUD
# ══════════════════════════════════════════════════════════════════════════════

@router.get("/integrations")
async def list_integrations(request: Request):
    """List all user-configured integrations with their status."""
    integrations = _load_json(_user_integrations_file(request), [])

    # Get this user's MCP status for running info
    try:
        from backend.core.agents.mcp_client import mcp_manager
        _uid = getattr(request.state, "user_id", None) or 0
        mcp_status = {s["name"]: s for s in mcp_manager.get_user_server_status(_uid)}
    except Exception:
        mcp_status = {}

    result = []
    for integ in integrations:
        catalog_info = INTEGRATION_CATALOG.get(integ["id"], {})
        server_name = integ.get("mcp_server_name") or integ["id"]
        status = mcp_status.get(server_name, {})

        result.append({
            **integ,
            "display_name": catalog_info.get("display_name", integ["id"]),
            "icon": catalog_info.get("icon", "🔌"),
            "category": catalog_info.get("category", "custom"),
            "description": catalog_info.get("description", ""),
            "is_running": status.get("running", False),
            "tools_count": status.get("tools", 0),
            "tool_names": status.get("tool_names", []),
            "has_mcp": bool(catalog_info.get("mcp_package") or integ.get("mcp_server_name")),
            # Mask secrets in env values
            "env_values": {
                k: ("***" if any(s in k.lower() for s in ["key", "secret", "token", "password"]) and v else v)
                for k, v in integ.get("env_values", {}).items()
            },
        })

    return {"integrations": result}


@router.post("/integrations")
async def add_integration(config: IntegrationConfig, request: Request):
    """Add or update an integration configuration."""
    integrations_file = _user_integrations_file(request)
    integrations = _load_json(integrations_file, [])

    # Check if exists — update
    existing_idx = next((i for i, x in enumerate(integrations) if x["id"] == config.id), None)
    new_data = config.model_dump()

    if existing_idx is not None:
        old = integrations[existing_idx]
        # Preserve masked secrets
        for k, v in new_data.get("env_values", {}).items():
            if v == "***" and k in old.get("env_values", {}):
                new_data["env_values"][k] = old["env_values"][k]
        integrations[existing_idx] = new_data
    else:
        integrations.append(new_data)

    _save_json(integrations_file, integrations)
    logger.info(f"Integration saved: {config.id}")
    return {"ok": True, "integration": config.id}


@router.delete("/integrations/{integration_id}")
async def remove_integration(integration_id: str, request: Request):
    """Remove an integration and stop its MCP server if running."""
    integrations_file = _user_integrations_file(request)
    integrations = _load_json(integrations_file, [])
    before = len(integrations)
    removed = next((i for i in integrations if i["id"] == integration_id), None)
    integrations = [i for i in integrations if i["id"] != integration_id]

    if len(integrations) == before:
        raise HTTPException(404, f"Intégration '{integration_id}' non trouvée")

    _save_json(integrations_file, integrations)

    # Stop MCP server if running — scoped to this user
    if removed:
        try:
            from backend.core.agents.mcp_client import mcp_manager
            _uid = getattr(request.state, "user_id", None) or 0
            server_name = removed.get("mcp_server_name") or integration_id
            if await mcp_manager.stop_client_for_user(_uid, server_name):
                logger.info(f"Stopped MCP server for integration: {integration_id}")
            # Supprime aussi l'entrée DB miroir — sinon ensure_user_started
            # tenterait encore de la relancer au prochain boot.
            await _remove_integration_from_db(_uid, server_name)
        except Exception as e:
            logger.warning(f"Error stopping MCP for {integration_id}: {e}")

    return {"ok": True, "deleted": integration_id}


# ══════════════════════════════════════════════════════════════════════════════
# MCP Server Control (start/stop/status per integration)
# ══════════════════════════════════════════════════════════════════════════════

@router.post("/integrations/{integration_id}/start")
async def start_integration_mcp(integration_id: str, request: Request):
    """Start the MCP server for an integration."""
    integrations = _load_json(_user_integrations_file(request), [])
    integ = next((i for i in integrations if i["id"] == integration_id), None)
    if not integ:
        raise HTTPException(404, f"Intégration '{integration_id}' non trouvée")

    catalog = INTEGRATION_CATALOG.get(integration_id, {})
    mcp_command = catalog.get("mcp_command")
    mcp_args = catalog.get("mcp_args", [])
    extra_args = integ.get("extra_args", []) or catalog.get("extra_args", [])

    if not mcp_command:
        return {"ok": False, "error": "Pas de serveur MCP disponible pour cette intégration"}

    server_name = integ.get("mcp_server_name") or integration_id
    env_values = integ.get("env_values", {})

    try:
        from backend.core.agents.mcp_client import mcp_manager

        _uid = getattr(request.state, "user_id", None) or 0
        # start_client_for_user replaces any existing entry with the same name
        client = await mcp_manager.start_client_for_user(
            _uid,
            server_name,
            mcp_command,
            mcp_args + extra_args,
            env_values,
        )

        # Mirror dans mcp_server_configs : garantit que le serveur redémarre au
        # prochain chat si le backend reboot, et qu'il est inclus dans les
        # exports de backup.
        await _mirror_integration_to_db(
            user_id=_uid,
            server_name=server_name,
            command=mcp_command,
            args=mcp_args + extra_args,
            env=env_values,
            enabled=True,
        )

        logger.info(f"MCP started for integration '{integration_id}' (user={_uid}): {len(client.tools)} tools")
        return {
            "ok": True,
            "integration": integration_id,
            "server": server_name,
            "tools_count": len(client.tools),
            "tool_names": [t["name"] for t in client.tools],
        }

    except FileNotFoundError:
        return {"ok": False, "error": f"Commande '{mcp_command}' introuvable. Installez Node.js/npx."}
    except Exception as e:
        return {"ok": False, "error": str(e)[:300]}


@router.post("/integrations/{integration_id}/stop")
async def stop_integration_mcp(integration_id: str, request: Request):
    """Stop the MCP server for an integration."""
    try:
        from backend.core.agents.mcp_client import mcp_manager
        _uid = getattr(request.state, "user_id", None) or 0
        integrations = _load_json(_user_integrations_file(request), [])
        integ = next((i for i in integrations if i["id"] == integration_id), None)
        server_name = (integ.get("mcp_server_name") if integ else None) or integration_id

        if await mcp_manager.stop_client_for_user(_uid, server_name):
            # Passe l'entrée DB en enabled=False pour qu'elle ne soit plus
            # auto-redémarrée par ensure_user_started au prochain boot.
            try:
                from backend.core.db.models import MCPServerConfig as DBMCPServerConfig
                from backend.core.db.engine import get_session
                from sqlalchemy import select, update as _sqlupdate
                async for sess in get_session():
                    await sess.execute(_sqlupdate(DBMCPServerConfig).where(
                        DBMCPServerConfig.user_id == _uid,
                        DBMCPServerConfig.name == server_name,
                    ).values(enabled=False))
                    await sess.commit()
                    break
            except Exception as e:
                logger.warning(f"MCP disable-in-db failed: {e}")
            return {"ok": True, "stopped": server_name}
        return {"ok": False, "error": "Serveur non actif"}
    except Exception as e:
        return {"ok": False, "error": str(e)[:200]}


@router.get("/integrations/{integration_id}/tools")
async def get_integration_tools(integration_id: str, request: Request):
    """List tools provided by an integration's MCP server."""
    try:
        from backend.core.agents.mcp_client import mcp_manager
        _uid = getattr(request.state, "user_id", None) or 0
        integrations = _load_json(_user_integrations_file(request), [])
        integ = next((i for i in integrations if i["id"] == integration_id), None)
        server_name = (integ.get("mcp_server_name") if integ else None) or integration_id

        client = mcp_manager.get_client_for_user(_uid, server_name)
        if not client:
            return {"tools": [], "error": "Serveur MCP non actif"}

        tools = []
        for t in client.tools:
            tools.append({
                "name": t["name"],
                "full_name": f"mcp_{server_name}_{t['name']}",
                "description": t.get("description", ""),
                "parameters": t.get("inputSchema", {}),
            })
        return {"tools": tools, "server": server_name}
    except Exception as e:
        return {"tools": [], "error": str(e)[:200]}


# ══════════════════════════════════════════════════════════════════════════════
# MCP Global Status
# ══════════════════════════════════════════════════════════════════════════════

@router.get("/mcp/status")
async def mcp_global_status(request: Request):
    """Get status of running MCP servers for the current user (integrations + core config)."""
    try:
        from backend.core.agents.mcp_client import mcp_manager
        _uid = getattr(request.state, "user_id", None) or 0
        status = mcp_manager.get_user_server_status(_uid)
        schemas = mcp_manager.get_user_schemas(_uid)
        return {
            "servers": status,
            "total_tools": len(schemas),
            "tools": [s["function"]["name"] for s in schemas],
        }
    except Exception as e:
        return {"servers": [], "total_tools": 0, "error": str(e)[:200]}


# ══════════════════════════════════════════════════════════════════════════════
# Webhooks — Incoming & Outgoing
# ══════════════════════════════════════════════════════════════════════════════

@router.get("/webhooks")
async def list_webhooks(request: Request):
    """List all configured webhooks."""
    webhooks = _load_json(_user_webhooks_file(request), [])
    # Mask secrets
    for wh in webhooks:
        if wh.get("secret"):
            wh["secret"] = "***"
    return {"webhooks": webhooks}


@router.post("/webhooks")
async def create_webhook(config: WebhookConfig, request: Request):
    """Create a new webhook."""
    webhooks_file = _user_webhooks_file(request)
    webhooks = _load_json(webhooks_file, [])

    webhook = config.model_dump()
    webhook["id"] = str(uuid.uuid4())[:8]
    webhook["created_at"] = datetime.now().isoformat()
    # Generate endpoint URL for incoming webhooks
    if config.direction == "incoming":
        webhook["endpoint"] = f"/api/plugins/webhooks/incoming/{webhook['id']}"

    webhooks.append(webhook)
    _save_json(webhooks_file, webhooks)
    return {"ok": True, "webhook": webhook}


@router.delete("/webhooks/{webhook_id}")
async def delete_webhook(webhook_id: str, request: Request):
    webhooks_file = _user_webhooks_file(request)
    webhooks = _load_json(webhooks_file, [])
    before = len(webhooks)
    webhooks = [w for w in webhooks if w.get("id") != webhook_id]
    if len(webhooks) == before:
        raise HTTPException(404, "Webhook non trouvé")
    _save_json(webhooks_file, webhooks)
    return {"ok": True, "deleted": webhook_id}


@router.put("/webhooks/{webhook_id}/toggle")
async def toggle_webhook(webhook_id: str, request: Request):
    webhooks_file = _user_webhooks_file(request)
    webhooks = _load_json(webhooks_file, [])
    for wh in webhooks:
        if wh.get("id") == webhook_id:
            wh["enabled"] = not wh.get("enabled", True)
            _save_json(webhooks_file, webhooks)
            return {"ok": True, "enabled": wh["enabled"]}
    raise HTTPException(404, "Webhook non trouvé")


# ── Incoming webhook receiver ───────────────────────────────────────────────

@router.post("/incoming/{webhook_id}")
async def receive_webhook(webhook_id: str, request: Request):
    """Receive an incoming webhook call.

    Route publique par design : un service externe (GitHub, Stripe, n8n…)
    appelle cette URL sans Bearer token. L'auth est assurée par :
    - Le HMAC ``X-Webhook-Signature`` quand le webhook a un secret défini
      (on encourage fortement à en mettre un côté UI)
    - À défaut, l'opacité de l'UUID ``webhook_id`` qui sert de bearer
      simple (mais n'a aucune valeur cryptographique : qui connaît l'URL
      peut spammer l'endpoint, juste pas usurper les logs d'autres users
      grâce à la résolution stricte ci-dessous)

    Avant ce fix, on cherchait le webhook dans ``data/webhooks/0/`` à cause
    du fallback uid=0 (le service externe n'envoie pas de Bearer → middleware
    ne pose pas state.user_id). Conséquence : 404 systématique pour tous les
    webhooks créés en mode auth-actif (ils sont dans ``data/webhooks/<uid>/``).
    Ce fix résout l'owner via :func:`_resolve_webhook_owner` qui scanne tous
    les dossiers users — et écrit les logs dans le dossier du bon owner.
    """
    resolution = _resolve_webhook_owner(webhook_id)
    if not resolution:
        return JSONResponse({"error": "Webhook non trouvé"}, status_code=404)
    owner_uid, wh = resolution
    if not wh.get("enabled", True):
        return JSONResponse({"error": "Webhook désactivé"}, status_code=403)

    # Verify HMAC signature if webhook has a secret
    webhook_secret = wh.get("secret", "")
    if webhook_secret:
        sig_header = request.headers.get("X-Webhook-Signature", "")
        body_bytes = await request.body()
        expected_sig = _hmac.new(webhook_secret.encode(), body_bytes, _hashlib.sha256).hexdigest()
        if not _hmac.compare_digest(sig_header, expected_sig):
            return JSONResponse({"error": "Signature invalide"}, status_code=401)

    # Parse body
    try:
        body = await request.json()
    except Exception:
        body = {"raw": (await request.body()).decode()[:5000]}

    # Log the event dans le dossier de l'owner du webhook (et pas un fallback
    # /data/webhooks/0/ partagé entre tous les users).
    logs_file = _webhook_logs_file_for_uid(owner_uid)
    logs = _load_json(logs_file, [])
    log_entry = {
        "id": str(uuid.uuid4())[:8],
        "webhook_id": webhook_id,
        "webhook_name": wh.get("name", webhook_id),
        "direction": "incoming",
        "timestamp": datetime.now().isoformat(),
        "headers": dict(request.headers),
        "body": body,
        "status": "received",
    }
    logs.insert(0, log_entry)
    if len(logs) > 200:
        logs = logs[:200]
    _save_json(logs_file, logs)

    logger.info(f"Webhook received: {wh.get('name', webhook_id)} (owner uid={owner_uid})")
    return {"ok": True, "event_id": log_entry["id"]}


# ── Outgoing webhook trigger ───────────────────────────────────────────────

@router.post("/outgoing/{webhook_id}/trigger")
async def trigger_outgoing_webhook(webhook_id: str, request: Request):
    """Trigger an outgoing webhook."""
    import httpx

    webhooks_file = _user_webhooks_file(request)
    webhooks = _load_json(webhooks_file, [])
    wh = next((w for w in webhooks if w.get("id") == webhook_id), None)
    if not wh or wh.get("direction") != "outgoing":
        raise HTTPException(404, "Webhook sortant non trouvé")
    if not wh.get("url"):
        raise HTTPException(400, "URL non configurée")

    try:
        payload = await request.json()
    except Exception:
        payload = {}

    url = wh["url"]
    if url and not url.startswith("https://"):
        logging.getLogger("gungnir").warning(f"Outgoing webhook uses insecure HTTP: {url}")

    headers = {**(wh.get("headers", {})), "Content-Type": "application/json"}
    if wh.get("secret"):
        headers["X-Webhook-Secret"] = wh["secret"]

    logs_file = _user_webhook_logs_file(request)
    logs = _load_json(logs_file, [])
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
    except Exception as e:
        log_entry["status"] = "error"
        log_entry["error"] = str(e)[:300]

    logs.insert(0, log_entry)
    if len(logs) > 200:
        logs = logs[:200]
    _save_json(logs_file, logs)

    return {"ok": log_entry["status"] == "sent", "log": log_entry}


# ════════════════════════════════════════════════════════════════════════════
# OAuth — connecteurs prefab (GitHub, Google, Notion, etc.)
# ════════════════════════════════════════════════════════════════════════════

@router.get("/oauth/providers")
async def oauth_list_providers():
    """Liste les providers OAuth supportés + leur statut « configuré côté serveur »."""
    from backend.plugins.webhooks.oauth_registry import list_providers
    return {"providers": list_providers()}


@router.get("/oauth/connections")
async def oauth_list_connections(request: Request, session: AsyncSession = Depends(get_session)):
    """Liste les connexions OAuth de l'user courant (par provider, statut + label)."""
    from backend.core.api.auth_helpers import get_user_settings
    from backend.plugins.webhooks.oauth_core import list_user_connections
    uid = getattr(request.state, "user_id", None)
    if not uid:
        return {"connections": []}
    us = await get_user_settings(uid, session)
    return {"connections": list_user_connections(us)}


@router.get("/oauth/{provider}/authorize")
async def oauth_authorize(provider: str, request: Request):
    """Démarre le flow OAuth — retourne l'URL de consentement à laquelle
    le frontend redirige l'user."""
    from backend.plugins.webhooks.oauth_core import build_authorize_url
    uid = getattr(request.state, "user_id", None)
    if not uid:
        return JSONResponse({"error": "Authentification requise"}, status_code=401)
    base_url = str(request.base_url).rstrip("/")
    url = build_authorize_url(provider, uid, base_url)
    if not url:
        return JSONResponse(
            {"error": f"Provider '{provider}' inconnu ou credentials non configurés côté serveur."},
            status_code=400,
        )
    return {"authorize_url": url}


@router.get("/oauth/callback")
async def oauth_callback(
    request: Request, code: str = "", state: str = "", error: str = "",
    session: AsyncSession = Depends(get_session),
):
    """Callback OAuth — l'user vient d'autoriser chez le provider. On échange
    le code contre tokens et on persiste. Retourne une page HTML qui ferme
    la fenêtre popup et notifie le parent."""
    from backend.plugins.webhooks.oauth_core import decode_state, handle_callback
    if error or not code or not state:
        msg = error or "Paramètres manquants"
        return Response(content=_oauth_close_page(False, msg), media_type="text/html")
    decoded = decode_state(state)
    if not decoded:
        return Response(content=_oauth_close_page(False, "État OAuth invalide"), media_type="text/html")
    base_url = str(request.base_url).rstrip("/")
    res = await handle_callback(decoded["p"], code, state, base_url, session)
    if not res.get("ok"):
        return Response(content=_oauth_close_page(False, res.get("error", "Échec")), media_type="text/html")
    label = res.get("account_label", decoded["p"])
    return Response(
        content=_oauth_close_page(True, f"Connecté à {decoded['p']} ({label})"),
        media_type="text/html",
    )


@router.post("/oauth/{provider}/disconnect")
async def oauth_disconnect(provider: str, request: Request, session: AsyncSession = Depends(get_session)):
    from backend.plugins.webhooks.oauth_core import disconnect
    uid = getattr(request.state, "user_id", None)
    if not uid:
        return JSONResponse({"error": "Authentification requise"}, status_code=401)
    return await disconnect(provider, uid, session)


@router.post("/oauth/{provider}/device_start")
async def oauth_device_start(provider: str, request: Request):
    """OAuth Device Flow — démarre le flow et retourne user_code + verification_uri."""
    from backend.plugins.webhooks.oauth_core import device_flow_start
    uid = getattr(request.state, "user_id", None)
    if not uid:
        return JSONResponse({"error": "Authentification requise"}, status_code=401)
    return await device_flow_start(provider, uid)


@router.post("/oauth/device_poll")
async def oauth_device_poll(payload: dict, session: AsyncSession = Depends(get_session)):
    """OAuth Device Flow — poll pour vérifier si l'user a complété l'auth.
    Body : {"device_code": "..."}. Retour : {status: pending|complete|error}."""
    from backend.plugins.webhooks.oauth_core import device_flow_poll
    device_code = (payload or {}).get("device_code", "")
    if not device_code:
        return {"ok": False, "error": "device_code manquant"}
    return await device_flow_poll(device_code, session)


@router.post("/oauth/{provider}/manual_token")
async def oauth_set_manual_token(
    provider: str, payload: dict, request: Request,
    session: AsyncSession = Depends(get_session),
):
    """Mode BYOT : l'user colle un PAT/Integration Token directement.

    Body : {"token": "ghp_..."}.
    Le token est validé contre l'API du provider avant d'être persisté.
    """
    from backend.plugins.webhooks.oauth_core import set_manual_token
    uid = getattr(request.state, "user_id", None)
    if not uid:
        return JSONResponse({"error": "Authentification requise"}, status_code=401)
    token = (payload or {}).get("token", "")
    return await set_manual_token(provider, uid, token, session)


def _oauth_close_page(success: bool, message: str) -> str:
    color = "#22c55e" if success else "#dc2626"
    icon = "✅" if success else "❌"
    return (
        f"<html><head><style>body{{font-family:system-ui;background:#1a1a2e;"
        f"color:#eee;display:flex;align-items:center;justify-content:center;"
        f"height:100vh;margin:0}}.card{{background:#16213e;padding:2rem;"
        f"border-radius:1rem;text-align:center;max-width:400px}}h2{{color:{color}}}"
        f"p{{color:#aaa}}</style></head><body><div class='card'>"
        f"<h2>{icon} {message}</h2>"
        f"<p>Vous pouvez fermer cette fenêtre.</p></div>"
        f"<script>setTimeout(()=>{{try{{window.opener&&window.opener.postMessage("
        f"{{type:'gungnir-oauth',success:{('true' if success else 'false')},"
        f"message:{json.dumps(message)}}},'*');}}catch(e){{}}window.close();}},800);"
        f"</script></body></html>"
    )


# ── Webhook Logs ────────────────────────────────────────────────────────────

@router.get("/logs")
async def get_webhook_logs(request: Request, limit: int = 50):
    """Get recent webhook event logs."""
    logs = _load_json(_user_webhook_logs_file(request), [])
    return {"logs": logs[:limit]}


@router.delete("/logs")
async def clear_webhook_logs(request: Request):
    _save_json(_user_webhook_logs_file(request), [])
    return {"ok": True}
