from fastapi import APIRouter
from fastapi.responses import JSONResponse

from backend.core.config.settings import Settings, ProviderConfig, VoiceConfig
from backend.core.providers import get_provider

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
                "default_model": p.default_model,
                "models": p.models,
            }
            for name, p in settings.providers.items()
        },
        "voice": {
            name: {"enabled": v.enabled, "provider": v.provider}
            for name, v in settings.voice.items()
        },
    }


@router.post("/config/providers/{provider_name}")
async def configure_provider(provider_name: str, config: ProviderConfig):
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
    if not provider_config or not provider_config.enabled:
        return {"models": []}
    try:
        provider = get_provider(provider_name, provider_config.api_key, provider_config.base_url)
        models = await provider.list_models()
        return {"models": models}
    except Exception as e:
        return {"models": [], "error": str(e)}


@router.delete("/config/providers/{provider_name}")
async def delete_provider(provider_name: str):
    """Supprime un provider de la configuration."""
    settings = Settings.load()
    if provider_name in settings.providers:
        del settings.providers[provider_name]
        settings.save()
        return {"ok": True}
    return JSONResponse({"error": f"Provider '{provider_name}' non trouvé"}, status_code=404)
