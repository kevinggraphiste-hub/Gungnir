from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse
from sqlalchemy.ext.asyncio import AsyncSession

from backend.core.config.settings import Settings, ProviderConfig, VoiceConfig, MCPServerConfig, ServiceConfig, encrypt_value, decrypt_value
from backend.core.providers import get_provider
from backend.core.agents.mcp_client import mcp_manager
from backend.core.db.engine import get_session
from backend.core.db.models import MCPServerConfig as DBMCPServerConfig
from backend.core.api.auth_helpers import get_user_settings, get_user_provider_key
from sqlalchemy import select, delete

router = APIRouter()


@router.get("/config")
async def get_config(request: Request, session: AsyncSession = Depends(get_session)):
    settings = Settings.load()
    # Per-user language override
    language = settings.app.language
    user_id = getattr(request.state, "user_id", None)
    if user_id:
        user_settings = await get_user_settings(user_id, session)
        if user_settings.language:
            language = user_settings.language
    return {
        "is_configured": settings.is_configured,
        "language": language,
        "theme": settings.app.theme,
        "providers": {
            name: {
                "enabled": p.enabled,
                "has_api_key": bool(p.api_key),
                "default_model": p.default_model,
                "models": p.models,
            }
            for name, p in settings.providers.items()
        },
        "voice": {
            name: {"enabled": v.enabled, "provider": v.provider}
            for name, v in settings.voice.items()
        },
        "services": {
            name: {
                "enabled": s.enabled,
                "base_url": s.base_url,
                "has_api_key": bool(s.api_key),
                "has_token": bool(s.token),
                "project_id": s.project_id,
                "region": s.region,
                "bucket": s.bucket,
                "database": s.database,
                "webhook_url": s.webhook_url,
                "namespace": s.namespace,
            }
            for name, s in settings.services.items()
        },
    }


@router.post("/config/providers/{provider_name}")
async def configure_provider(provider_name: str, config: ProviderConfig, request: Request, session: AsyncSession = Depends(get_session)):
    uid = getattr(request.state, "user_id", None)
    if uid is not None:
        from backend.core.api.auth_helpers import require_admin
        if not await require_admin(request, session):
            return JSONResponse({"error": "Admin requis"}, status_code=403)
    # Strip whitespace from API key (common copy-paste issue)
    if config.api_key:
        config.api_key = config.api_key.strip()
    settings = Settings.load()
    existing = settings.providers.get(provider_name)
    if existing:
        # Préserver les champs sensibles/existants si absents de la requête
        if not config.api_key:
            config.api_key = existing.api_key
        if not config.models:
            config.models = existing.models
        if not config.base_url:
            config.base_url = existing.base_url
        if config.enabled is False and existing.enabled is True and config.api_key:
            config.enabled = existing.enabled
    settings.providers[provider_name] = config
    settings.save()
    return {"status": "saved"}


@router.post("/config/voice/{voice_name}")
async def configure_voice(voice_name: str, config: VoiceConfig):
    settings = Settings.load()
    if voice_name not in settings.voice:
        settings.voice[voice_name] = VoiceConfig()
    settings.voice[voice_name] = config
    settings.save()
    return {"status": "saved"}


@router.post("/config/app")
async def configure_app(app_config: dict, request: Request, session: AsyncSession = Depends(get_session)):
    uid = getattr(request.state, "user_id", None)
    if uid is not None:
        from backend.core.api.auth_helpers import require_admin
        if not await require_admin(request, session):
            return JSONResponse({"error": "Admin requis"}, status_code=403)
    settings = Settings.load()
    for key, value in app_config.items():
        if hasattr(settings.app, key):
            setattr(settings.app, key, value)
    settings.save()
    return {"status": "saved"}


@router.get("/models/{provider_name}")
async def list_models(provider_name: str, request: Request, session: AsyncSession = Depends(get_session)):
    settings = Settings.load()
    provider_config = settings.providers.get(provider_name)
    if not provider_config:
        return {"models": []}
    # Toujours retourner les modèles statiques comme fallback
    static_models = provider_config.models or []

    # Resolve API key: per-user first, then global
    api_key = None
    base_url = provider_config.base_url
    user_id = getattr(request.state, "user_id", None)
    if user_id:
        user_settings = await get_user_settings(user_id, session)
        user_prov = get_user_provider_key(user_settings, provider_name)
        if user_prov and user_prov.get("api_key"):
            api_key = user_prov["api_key"]
            base_url = user_prov.get("base_url") or base_url
    if not api_key:
        api_key = provider_config.api_key

    if not api_key:
        return {"models": static_models}
    try:
        provider = get_provider(provider_name, api_key, base_url)
        live_models = await provider.list_models()
        if live_models:
            # Merge: modèles live + statiques manquants
            model_set = set(live_models)
            for m in static_models:
                if m not in model_set:
                    live_models.append(m)
            return {"models": sorted(live_models)}
        return {"models": static_models}
    except Exception as e:
        import logging; logging.getLogger("gungnir").error(f"Model fetch error: {e}")
        return {"models": static_models, "error": "Erreur lors de la récupération des modèles"}


@router.delete("/config/providers/{provider_name}")
async def delete_provider(provider_name: str, request: Request, session: AsyncSession = Depends(get_session)):
    """Supprime un provider de la configuration."""
    uid = getattr(request.state, "user_id", None)
    if uid is not None:
        from backend.core.api.auth_helpers import require_admin
        if not await require_admin(request, session):
            return JSONResponse({"error": "Admin requis"}, status_code=403)
    settings = Settings.load()
    if provider_name in settings.providers:
        del settings.providers[provider_name]
        settings.save()
        return {"ok": True}
    return JSONResponse({"error": f"Provider '{provider_name}' non trouvé"}, status_code=404)


# ── Service Providers ─────────────────────────────────────────────────────────

SERVICE_LABELS = {
    # Base de données
    "supabase": "Supabase",
    "postgresql": "PostgreSQL",
    "mysql": "MySQL / MariaDB",
    "mongodb": "MongoDB",
    "redis": "Redis",
    "sqlite": "SQLite (externe)",
    # Stockage
    "s3": "S3 / MinIO",
    "google_drive": "Google Drive",
    "dropbox": "Dropbox",
    "azure_blob": "Azure Blob Storage",
    "ftp": "FTP / SFTP",
    # RAG / Vectoriel
    "pinecone": "Pinecone",
    "qdrant": "Qdrant",
    "weaviate": "Weaviate",
    "chromadb": "ChromaDB",
    "milvus": "Milvus",
    "elasticsearch": "Elasticsearch",
    # Développement
    "github": "GitHub",
    "gitlab": "GitLab",
    "notion": "Notion",
    "jira": "Jira",
    "linear": "Linear",
    "confluence": "Confluence",
    # Communication
    "slack": "Slack",
    "discord": "Discord",
    "telegram": "Telegram Bot API",
    "email_smtp": "Email (SMTP)",
    "teams": "Microsoft Teams",
    "whatsapp": "WhatsApp Business",
    # Automatisation
    "n8n": "n8n",
    "make": "Make (Integromat)",
    "zapier": "Zapier",
    "activepieces": "Activepieces",
    # Monitoring / Analytics
    "sentry": "Sentry",
    "grafana": "Grafana",
    "posthog": "PostHog",
    # IA / APIs externes
    "huggingface": "Hugging Face",
    "replicate": "Replicate",
    "stability": "Stability AI",
    "serper": "Serper (Google Search)",
    "tavily": "Tavily (Web Search)",
}

SERVICE_CATEGORIES = {
    "database": ["supabase", "postgresql", "mysql", "mongodb", "redis", "sqlite"],
    "storage": ["s3", "google_drive", "dropbox", "azure_blob", "ftp"],
    "rag": ["qdrant", "pinecone", "weaviate", "chromadb", "milvus", "elasticsearch"],
    "dev": ["github", "gitlab", "notion", "jira", "linear", "confluence"],
    "communication": ["slack", "discord", "telegram", "email_smtp", "teams", "whatsapp"],
    "automation": ["n8n", "make", "zapier", "activepieces"],
    "monitoring": ["sentry", "grafana", "posthog"],
    "ai": ["huggingface", "replicate", "stability", "serper", "tavily"],
}


@router.get("/config/services")
async def list_services():
    """List all service providers with their config status."""
    settings = Settings.load()
    services = {}
    for name, s in settings.services.items():
        services[name] = {
            **s.model_dump(),
            "label": SERVICE_LABELS.get(name, name),
            # Mask secrets
            "api_key": "***" if s.api_key else None,
            "token": "***" if s.token else None,
        }
    return {"services": services, "categories": SERVICE_CATEGORIES, "labels": SERVICE_LABELS}


@router.get("/config/services/{service_name}")
async def get_service(service_name: str):
    """Get a single service configuration (secrets masked)."""
    settings = Settings.load()
    svc = settings.services.get(service_name)
    if not svc:
        return JSONResponse({"error": f"Service '{service_name}' non trouvé"}, status_code=404)
    data = svc.model_dump()
    data["api_key"] = "***" if svc.api_key else None
    data["token"] = "***" if svc.token else None
    data["label"] = SERVICE_LABELS.get(service_name, service_name)
    return data


@router.post("/config/services/{service_name}")
async def configure_service(service_name: str, config: ServiceConfig):
    """Configure a service provider."""
    settings = Settings.load()
    existing = settings.services.get(service_name)
    if existing:
        # Preserve secrets if masked or empty in request
        if not config.api_key or config.api_key == "***":
            config.api_key = existing.api_key
        if not config.token or config.token == "***":
            config.token = existing.token
    settings.services[service_name] = config
    settings.save()
    return {"status": "saved", "service": service_name}


@router.delete("/config/services/{service_name}")
async def delete_service(service_name: str):
    """Remove a service from configuration."""
    settings = Settings.load()
    if service_name not in settings.services:
        return JSONResponse({"error": f"Service '{service_name}' non trouvé"}, status_code=404)
    del settings.services[service_name]
    settings.save()
    return {"ok": True, "deleted": service_name}


@router.post("/config/services/{service_name}/test")
async def test_service(service_name: str):
    """Test connectivity to a service provider."""
    import asyncio
    import aiohttp

    settings = Settings.load()
    svc = settings.services.get(service_name)
    if not svc:
        return JSONResponse({"error": f"Service '{service_name}' non trouvé"}, status_code=404)
    if not svc.enabled:
        return {"ok": False, "error": "Service désactivé"}

    # Basic connectivity test per service type
    try:
        if service_name == "redis":
            # TCP ping
            url = svc.base_url or "redis://localhost:6379"
            host = url.replace("redis://", "").split(":")[0]
            port = int(url.replace("redis://", "").split(":")[-1]) if ":" in url.replace("redis://", "") else 6379
            _, writer = await asyncio.wait_for(asyncio.open_connection(host, port), timeout=5)
            writer.close()
            await writer.wait_closed()
            return {"ok": True, "service": service_name, "message": "Connexion Redis OK"}

        elif service_name == "postgresql":
            url = svc.base_url or "postgresql://localhost:5432"
            host = url.split("@")[-1].split("/")[0].split(":")[0] if "@" in url else url.replace("postgresql://", "").split(":")[0]
            port_str = url.split(":")[-1].split("/")[0]
            port = int(port_str) if port_str.isdigit() else 5432
            _, writer = await asyncio.wait_for(asyncio.open_connection(host, port), timeout=5)
            writer.close()
            await writer.wait_closed()
            return {"ok": True, "service": service_name, "message": "Connexion PostgreSQL OK"}

        elif service_name in ("n8n", "qdrant"):
            # HTTP health check
            url = svc.base_url
            if not url:
                return {"ok": False, "error": "URL non configurée"}
            async with aiohttp.ClientSession() as session:
                async with session.get(url, timeout=aiohttp.ClientTimeout(total=5)) as resp:
                    return {"ok": resp.status < 400, "service": service_name, "status": resp.status}

        else:
            # Generic HTTP check with auth header
            url = svc.base_url
            if not url:
                return {"ok": False, "error": "URL non configurée"}
            headers = {}
            if svc.api_key:
                headers["Authorization"] = f"Bearer {svc.api_key}"
            if svc.token:
                headers["Authorization"] = f"Bearer {svc.token}"
            async with aiohttp.ClientSession() as session:
                async with session.get(url, headers=headers, timeout=aiohttp.ClientTimeout(total=5)) as resp:
                    return {"ok": resp.status < 400, "service": service_name, "status": resp.status}

    except asyncio.TimeoutError:
        return {"ok": False, "service": service_name, "error": "Timeout — service injoignable"}
    except Exception as e:
        import logging; logging.getLogger("gungnir").error(f"Service test error ({service_name}): {e}")
        return {"ok": False, "service": service_name, "error": "Erreur de connexion au service"}


# ── Per-User API Keys ────────────────────────────────────────────────────────
# Each user manages their own provider and service keys.
# Global config (above) is admin-only for system-level settings.

@router.get("/config/user/providers")
async def get_user_providers(request: Request, session: AsyncSession = Depends(get_session)):
    """Get the current user's provider keys (masked)."""
    user_id = getattr(request.state, "user_id", None)
    if not user_id:
        return {"providers": {}}
    user_settings = await get_user_settings(user_id, session)
    settings = Settings.load()
    result = {}
    for name, pcfg in settings.providers.items():
        user_prov = (user_settings.provider_keys or {}).get(name, {})
        has_key = bool(user_prov.get("api_key"))
        result[name] = {
            "enabled": user_prov.get("enabled", False),
            "has_api_key": has_key,
            "default_model": pcfg.default_model,
            "models": pcfg.models,
            "base_url": user_prov.get("base_url") or pcfg.base_url,
        }
    return {"providers": result}


@router.post("/config/user/providers/{provider_name}")
async def save_user_provider(provider_name: str, request: Request, session: AsyncSession = Depends(get_session)):
    """Save a provider API key for the current user. Fallback to global config if no auth."""
    user_id = getattr(request.state, "user_id", None)
    body = await request.json()

    # No auth (open mode / setup) → save to global config like before
    if not user_id:
        config = ProviderConfig(**body) if isinstance(body, dict) else ProviderConfig()
        if body.get("api_key"):
            config.api_key = body["api_key"].strip()
            config.enabled = True
        settings = Settings.load()
        existing = settings.providers.get(provider_name)
        if existing:
            if not config.api_key:
                config.api_key = existing.api_key
            if not config.models:
                config.models = existing.models
            if not config.base_url:
                config.base_url = existing.base_url
        settings.providers[provider_name] = config
        settings.save()
        return {"status": "saved"}
    user_settings = await get_user_settings(user_id, session)

    provider_keys = dict(user_settings.provider_keys or {})
    existing = provider_keys.get(provider_name, {})

    # Update fields
    if body.get("api_key"):
        existing["api_key"] = encrypt_value(body["api_key"].strip())
        existing["enabled"] = True  # Auto-enable on key save
    if "enabled" in body:
        existing["enabled"] = body["enabled"]
    if body.get("base_url"):
        existing["base_url"] = body["base_url"]

    provider_keys[provider_name] = existing
    # Force SQLAlchemy to detect JSON change (PostgreSQL needs this)
    from sqlalchemy.orm.attributes import flag_modified
    user_settings.provider_keys = provider_keys
    flag_modified(user_settings, "provider_keys")
    await session.commit()
    return {"status": "saved", "provider": provider_name}


@router.delete("/config/user/providers/{provider_name}")
async def delete_user_provider(provider_name: str, request: Request, session: AsyncSession = Depends(get_session)):
    """Remove a user's provider key."""
    user_id = getattr(request.state, "user_id", None)
    if not user_id:
        # Fallback: delete from global config
        settings = Settings.load()
        if provider_name in settings.providers:
            del settings.providers[provider_name]
            settings.save()
        return {"ok": True}
    user_settings = await get_user_settings(user_id, session)
    provider_keys = dict(user_settings.provider_keys or {})
    if provider_name in provider_keys:
        del provider_keys[provider_name]
        user_settings.provider_keys = provider_keys
        await session.commit()
    return {"ok": True}


@router.get("/config/user/services")
async def get_user_services(request: Request, session: AsyncSession = Depends(get_session)):
    """Get the current user's service keys (masked)."""
    user_id = getattr(request.state, "user_id", None)
    if not user_id:
        return {"services": {}}
    user_settings = await get_user_settings(user_id, session)
    settings = Settings.load()
    result = {}
    for name, scfg in settings.services.items():
        user_svc = (user_settings.service_keys or {}).get(name, {})
        result[name] = {
            "enabled": user_svc.get("enabled", False),
            "has_api_key": bool(user_svc.get("api_key")),
            "has_token": bool(user_svc.get("token")),
            "base_url": user_svc.get("base_url") or scfg.base_url,
            "label": SERVICE_LABELS.get(name, name),
        }
    return {"services": result, "categories": SERVICE_CATEGORIES, "labels": SERVICE_LABELS}


@router.post("/config/user/services/{service_name}")
async def save_user_service(service_name: str, request: Request, session: AsyncSession = Depends(get_session)):
    """Save a service config for the current user."""
    user_id = getattr(request.state, "user_id", None)
    if not user_id:
        return JSONResponse({"error": "Non authentifié"}, status_code=401)
    body = await request.json()
    user_settings = await get_user_settings(user_id, session)

    service_keys = dict(user_settings.service_keys or {})
    existing = service_keys.get(service_name, {})

    # Update all provided fields, encrypt secrets
    for field in ("base_url", "project_id", "region", "bucket", "database", "namespace", "webhook_url"):
        if field in body and body[field]:
            existing[field] = body[field]
    for secret_field in ("api_key", "token"):
        if body.get(secret_field) and body[secret_field] != "***":
            existing[secret_field] = encrypt_value(body[secret_field].strip())
    if "enabled" in body:
        existing["enabled"] = body["enabled"]

    service_keys[service_name] = existing
    from sqlalchemy.orm.attributes import flag_modified
    user_settings.service_keys = service_keys
    flag_modified(user_settings, "service_keys")
    await session.commit()

    # Auto-init consciousness vector memory when Qdrant is configured
    if service_name == "qdrant" and existing.get("base_url"):
        try:
            from backend.plugins.consciousness.engine import consciousness_manager
            c = consciousness_manager.get(user_id)
            if c.enabled and not c.vector_memory:
                await c.init_vector_memory()
        except Exception:
            pass  # Non-blocking

    return {"status": "saved", "service": service_name}


@router.post("/config/user/app")
async def save_user_app_settings(request: Request, session: AsyncSession = Depends(get_session)):
    """Save per-user app preferences (active provider/model)."""
    user_id = getattr(request.state, "user_id", None)
    if not user_id:
        # Fallback to global config for non-auth mode
        body = await request.json()
        settings = Settings.load()
        for key, value in body.items():
            if hasattr(settings.app, key):
                setattr(settings.app, key, value)
        settings.save()
        return {"status": "saved"}

    body = await request.json()
    user_settings = await get_user_settings(user_id, session)
    if "active_provider" in body:
        user_settings.active_provider = body["active_provider"]
    if "active_model" in body:
        user_settings.active_model = body["active_model"]
    if "language" in body:
        user_settings.language = body["language"]
    await session.commit()
    return {"status": "saved"}


# ── MCP Servers (per-user) ───────────────────────────────────────────────────

def _require_user_id(request: Request) -> int:
    """Resolve the authenticated user_id from request.state, rejecting unauthenticated calls."""
    uid = getattr(request.state, "user_id", None)
    return int(uid) if uid else 0


def _mask_env(env: dict) -> dict:
    """Mask secret values in an env dict for safe display."""
    return {
        k: ("***" if any(t in k.lower() for t in ("key", "secret", "token", "password")) else v)
        for k, v in (env or {}).items()
    }


@router.get("/mcp/servers")
async def list_mcp_servers(request: Request, session: AsyncSession = Depends(get_session)):
    """List the current user's configured MCP servers and their runtime status."""
    user_id = _require_user_id(request)
    if not user_id:
        return {"servers": [], "status": []}

    # Lazy-start so newly created servers from prior sessions are running
    await mcp_manager.ensure_user_started(user_id)

    result = await session.execute(
        select(DBMCPServerConfig).where(DBMCPServerConfig.user_id == user_id)
    )
    rows = result.scalars().all()
    configs = [
        {
            "name": r.name,
            "command": r.command,
            "args": list(r.args_json or []),
            "env": _mask_env({
                k: (decrypt_value(v) if isinstance(v, str) else v)
                for k, v in (r.env_json or {}).items()
            }),
            "enabled": r.enabled,
        }
        for r in rows
    ]
    status = mcp_manager.get_user_server_status(user_id)
    return {"servers": configs, "status": status}


# MCP command allowlist — only these executables can be used as MCP server commands
MCP_ALLOWED_COMMANDS = {
    "npx", "node", "python", "python3", "pip", "pipx", "uvx",
    "docker", "deno", "bun", "tsx", "ts-node",
}

MCP_BLOCKED_ARGS = [
    "rm ", "del ", "format ", "mkfs", "dd if=", "curl ", "wget ",
    "powershell", "cmd /c", "bash -c", "sh -c", "> /dev/", "| bash",
]


@router.post("/mcp/servers")
async def add_mcp_server(
    config: MCPServerConfig,
    request: Request,
    session: AsyncSession = Depends(get_session),
):
    """Add (or replace) an MCP server for the current user and start it."""
    user_id = _require_user_id(request)
    if not user_id:
        return JSONResponse({"error": "Authentification requise"}, status_code=401)

    # Validate MCP command against allowlist
    cmd_base = config.command.strip().split("/")[-1].split("\\")[-1].lower()
    if cmd_base not in MCP_ALLOWED_COMMANDS:
        return JSONResponse(
            {"error": f"Commande MCP non autorisée: '{config.command}'. Commandes autorisées: {', '.join(sorted(MCP_ALLOWED_COMMANDS))}"},
            status_code=400,
        )
    # Check args for injection patterns
    args_joined = " ".join(config.args).lower()
    for blocked in MCP_BLOCKED_ARGS:
        if blocked in args_joined:
            return JSONResponse(
                {"error": f"Arguments MCP contiennent un pattern bloqué: '{blocked.strip()}'"},
                status_code=400,
            )

    # Encrypt sensitive env values before persisting
    env_to_store = {}
    for k, v in (config.env or {}).items():
        if not isinstance(v, str) or not v:
            env_to_store[k] = v
            continue
        if any(t in k.lower() for t in ("key", "secret", "token", "password")) and not v.startswith(("FERNET:", "enc:")):
            env_to_store[k] = encrypt_value(v)
        else:
            env_to_store[k] = v

    # Upsert: delete existing entry with same (user_id, name), then insert
    await session.execute(
        delete(DBMCPServerConfig).where(
            DBMCPServerConfig.user_id == user_id,
            DBMCPServerConfig.name == config.name,
        )
    )
    row = DBMCPServerConfig(
        user_id=user_id,
        name=config.name,
        command=config.command,
        args_json=list(config.args or []),
        env_json=env_to_store,
        enabled=config.enabled,
    )
    session.add(row)
    await session.commit()

    # Start the server for this user
    if config.enabled:
        try:
            runtime_env = {
                k: (decrypt_value(v) if isinstance(v, str) else v)
                for k, v in env_to_store.items()
            }
            client = await mcp_manager.start_client_for_user(
                user_id, config.name, config.command, list(config.args or []), runtime_env
            )
            return {"ok": True, "tools_discovered": len(client.tools), "server": config.name}
        except Exception as e:
            import logging
            logging.getLogger("gungnir").error(f"MCP start error user={user_id} name={config.name}: {e}")
            return {"ok": False, "error": "Erreur au démarrage du serveur MCP", "server": config.name}
    return {"ok": True, "server": config.name, "status": "saved (disabled)"}


@router.delete("/mcp/servers/{server_name}")
async def remove_mcp_server(
    server_name: str,
    request: Request,
    session: AsyncSession = Depends(get_session),
):
    """Remove an MCP server owned by the current user and stop it."""
    user_id = _require_user_id(request)
    if not user_id:
        return JSONResponse({"error": "Authentification requise"}, status_code=401)

    result = await session.execute(
        delete(DBMCPServerConfig).where(
            DBMCPServerConfig.user_id == user_id,
            DBMCPServerConfig.name == server_name,
        )
    )
    if (result.rowcount or 0) == 0:
        return JSONResponse({"error": f"MCP server '{server_name}' not found"}, status_code=404)
    await session.commit()

    await mcp_manager.stop_client_for_user(user_id, server_name)
    return {"ok": True, "deleted": server_name}
