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

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

logger = logging.getLogger("gungnir.webhooks")
router = APIRouter()

DATA_DIR = Path("data")


# ══════════════════════════════════════════════════════════════════════════════
# Per-user data isolation
# ══════════════════════════════════════════════════════════════════════════════

def _user_integrations_file(request: Request) -> Path:
    """Return per-user integrations file path."""
    uid = getattr(request.state, "user_id", None) or 0
    p = DATA_DIR / "integrations" / str(uid) / "integrations.json"
    p.parent.mkdir(parents=True, exist_ok=True)
    return p


def _user_webhooks_file(request: Request) -> Path:
    """Return per-user webhooks file path."""
    uid = getattr(request.state, "user_id", None) or 0
    p = DATA_DIR / "webhooks" / str(uid) / "webhooks.json"
    p.parent.mkdir(parents=True, exist_ok=True)
    return p


def _user_webhook_logs_file(request: Request) -> Path:
    """Return per-user webhook logs file path."""
    uid = getattr(request.state, "user_id", None) or 0
    p = DATA_DIR / "webhooks" / str(uid) / "webhook_logs.json"
    p.parent.mkdir(parents=True, exist_ok=True)
    return p


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
    """Receive an incoming webhook call."""
    webhooks_file = _user_webhooks_file(request)
    webhooks = _load_json(webhooks_file, [])
    wh = next((w for w in webhooks if w.get("id") == webhook_id), None)
    if not wh:
        return JSONResponse({"error": "Webhook non trouvé"}, status_code=404)
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

    # Log the event
    logs_file = _user_webhook_logs_file(request)
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

    logger.info(f"Webhook received: {wh.get('name', webhook_id)}")
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
