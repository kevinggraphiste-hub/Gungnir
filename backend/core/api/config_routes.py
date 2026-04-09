from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse
from sqlalchemy.ext.asyncio import AsyncSession

from backend.core.config.settings import Settings, ProviderConfig, VoiceConfig, MCPServerConfig, ServiceConfig, encrypt_value, decrypt_value
from backend.core.providers import get_provider
from backend.core.agents.mcp_client import mcp_manager
from backend.core.db.engine import get_session
from backend.core.api.auth_helpers import get_user_settings, get_user_provider_key

router = APIRouter()


@router.get("/config")
async def get_config():
    settings = Settings.load()
    return {
        "is_configured": settings.is_configured,
        "language": settings.app.language,
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
async def configure_provider(provider_name: str, config: ProviderConfig):
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
async def configure_app(app_config: dict):
    settings = Settings.load()
    for key, value in app_config.items():
        if hasattr(settings.app, key):
            setattr(settings.app, key, value)
    settings.save()
    return {"status": "saved"}


@router.get("/models/{provider_name}")
async def list_models(provider_name: str):
    settings = Settings.load()
    provider_config = settings.providers.get(provider_name)
    if not provider_config:
        return {"models": []}
    # Toujours retourner les modèles statiques comme fallback
    static_models = provider_config.models or []
    if not provider_config.enabled or not provider_config.api_key:
        return {"models": static_models}
    try:
        provider = get_provider(provider_name, provider_config.api_key, provider_config.base_url)
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
async def delete_provider(provider_name: str):
    """Supprime un provider de la configuration."""
    settings = Settings.load()
    if provider_name in settings.providers:
        del settings.providers[provider_name]
        settings.save()
        return {"ok": True}
    return JSONResponse({"error": f"Provider '{provider_name}' non trouvé"}, status_code=404)


# ── Service Providers ─────────────────────────────────────────────────────────

SERVICE_LABELS = {
    "supabase": "Supabase",
    "postgresql": "PostgreSQL",
    "s3": "S3 / MinIO",
    "github": "GitHub",
    "notion": "Notion",
    "google_drive": "Google Drive",
    "pinecone": "Pinecone",
    "qdrant": "Qdrant",
    "slack": "Slack",
    "discord": "Discord",
    "n8n": "n8n",
    "redis": "Redis",
}

SERVICE_CATEGORIES = {
    "database": ["supabase", "postgresql", "redis"],
    "storage": ["s3", "google_drive"],
    "rag": ["supabase", "pinecone", "qdrant"],
    "dev": ["github", "notion"],
    "communication": ["slack", "discord"],
    "automation": ["n8n"],
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
    """Save a provider API key for the current user."""
    user_id = getattr(request.state, "user_id", None)
    if not user_id:
        return JSONResponse({"error": "Non authentifié"}, status_code=401)
    body = await request.json()
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
    user_settings.provider_keys = provider_keys
    await session.commit()
    return {"status": "saved", "provider": provider_name}


@router.delete("/config/user/providers/{provider_name}")
async def delete_user_provider(provider_name: str, request: Request, session: AsyncSession = Depends(get_session)):
    """Remove a user's provider key."""
    user_id = getattr(request.state, "user_id", None)
    if not user_id:
        return JSONResponse({"error": "Non authentifié"}, status_code=401)
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
    user_settings.service_keys = service_keys
    await session.commit()
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
    await session.commit()
    return {"status": "saved"}


# ── MCP Servers ───────────────────────────────────────────────────────────────

@router.get("/mcp/servers")
async def list_mcp_servers():
    """List configured MCP servers and their status."""
    settings = Settings.load()
    configs = [s.model_dump() for s in settings.mcp_servers]
    # Mask API keys in env
    for c in configs:
        c["env"] = {k: ("***" if "key" in k.lower() or "secret" in k.lower() else v) for k, v in c.get("env", {}).items()}
    status = mcp_manager.get_server_status()
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
async def add_mcp_server(config: MCPServerConfig):
    """Add a new MCP server and start it."""
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

    settings = Settings.load()
    # Replace if same name exists
    settings.mcp_servers = [s for s in settings.mcp_servers if s.name != config.name]
    settings.mcp_servers.append(config)
    settings.save()

    # Start the server
    if config.enabled:
        try:
            await mcp_manager.start_all([config.model_dump()])
            tools = mcp_manager.get_all_schemas()
            return {"ok": True, "tools_discovered": len(tools), "server": config.name}
        except Exception as e:
            import logging
            logging.getLogger("gungnir").error(f"MCP start error for {config.name}: {e}")
            return {"ok": False, "error": "Erreur au démarrage du serveur MCP", "server": config.name}
    return {"ok": True, "server": config.name, "status": "saved (disabled)"}


@router.delete("/mcp/servers/{server_name}")
async def remove_mcp_server(server_name: str):
    """Remove an MCP server and stop it."""
    settings = Settings.load()
    before = len(settings.mcp_servers)
    settings.mcp_servers = [s for s in settings.mcp_servers if s.name != server_name]
    if len(settings.mcp_servers) == before:
        return JSONResponse({"error": f"MCP server '{server_name}' not found"}, status_code=404)
    settings.save()

    # Stop the client if running
    client = mcp_manager.clients.pop(server_name, None)
    if client:
        await client.stop()
    return {"ok": True, "deleted": server_name}
