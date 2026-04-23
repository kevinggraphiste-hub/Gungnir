"""
Endpoints de génération d'images — chat principal Gungnir.

L'utilisateur sélectionne explicitement un modèle image-gen (DALL-E 3,
GPT Image 1, Imagen 3, Gemini Flash Image aka NanoBanana, etc.) et
Gungnir route vers le provider approprié qui implémente `generate_image`.

Distinct des uploads d'images (input utilisateur → multimodal chat) :
ici c'est de l'OUTPUT généré par le LLM, persisté en
`Message.images_out` pour l'historique conversation.
"""
from __future__ import annotations

import logging
from typing import Optional
from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse
from sqlalchemy.ext.asyncio import AsyncSession

from backend.core.config.settings import Settings, ProviderConfig
from backend.core.db.engine import get_session
from backend.core.db.models import Conversation, Message
from backend.core.api.auth_helpers import get_user_settings, get_user_provider_key
from backend.core.providers import get_provider

router = APIRouter()
logger = logging.getLogger("gungnir.image_gen")


# ═══════════════════════════════════════════════════════════════════════════
# Catalogue curé des modèles image-gen connus, par provider. Pour chaque
# modèle on liste les tailles supportées (le frontend adapte le sélecteur).
# ═══════════════════════════════════════════════════════════════════════════

IMAGE_MODELS_CATALOG: dict[str, list[dict]] = {
    "openai": [
        {"id": "gpt-image-2", "label": "GPT Image 2 (nouveau)", "sizes": ["1024x1024", "1024x1536", "1536x1024"], "default_size": "1024x1024", "quality": True},
        {"id": "gpt-image-1", "label": "GPT Image 1", "sizes": ["1024x1024", "1024x1536", "1536x1024"], "default_size": "1024x1024", "quality": True},
        {"id": "dall-e-3", "label": "DALL-E 3", "sizes": ["1024x1024", "1792x1024", "1024x1792"], "default_size": "1024x1024", "quality": True},
        {"id": "dall-e-2", "label": "DALL-E 2 (legacy)", "sizes": ["256x256", "512x512", "1024x1024"], "default_size": "1024x1024", "quality": False},
    ],
    "google": [
        {"id": "gemini-2.5-flash-image-preview", "label": "Gemini 2.5 Flash Image (NanoBanana)", "sizes": ["1024x1024"], "default_size": "1024x1024", "quality": False},
        {"id": "gemini-2.0-flash-exp-image-generation", "label": "Gemini 2.0 Flash Image (expérimental)", "sizes": ["1024x1024"], "default_size": "1024x1024", "quality": False},
        {"id": "imagen-3.0-generate-002", "label": "Imagen 3", "sizes": ["1024x1024", "1792x1024", "1024x1792"], "default_size": "1024x1024", "quality": False},
        {"id": "imagen-3.0-fast-generate-001", "label": "Imagen 3 Fast", "sizes": ["1024x1024"], "default_size": "1024x1024", "quality": False},
    ],
    "openrouter": [
        {"id": "openai/gpt-image-2", "label": "GPT Image 2 (OpenRouter)", "sizes": ["1024x1024", "1024x1536", "1536x1024"], "default_size": "1024x1024", "quality": True},
        {"id": "openai/dall-e-3", "label": "DALL-E 3 (OpenRouter)", "sizes": ["1024x1024", "1792x1024", "1024x1792"], "default_size": "1024x1024", "quality": True},
        {"id": "openai/gpt-image-1", "label": "GPT Image 1 (OpenRouter)", "sizes": ["1024x1024", "1024x1536", "1536x1024"], "default_size": "1024x1024", "quality": True},
        {"id": "google/gemini-2.5-flash-image-preview", "label": "Gemini 2.5 Flash Image (OpenRouter)", "sizes": ["1024x1024"], "default_size": "1024x1024", "quality": False},
        {"id": "google/imagen-3-generate-002", "label": "Imagen 3 (OpenRouter)", "sizes": ["1024x1024", "1792x1024", "1024x1792"], "default_size": "1024x1024", "quality": False},
    ],
}


async def _resolve_provider_for_user(provider_name: str, user_id: int, session: AsyncSession):
    """Résout provider + clé API pour un user donné, même logique que /catalog
    du plugin model_guide : clé per-user stricte, pas de fallback global."""
    settings = Settings.load()
    user_settings = None
    try:
        user_settings = await get_user_settings(user_id, session)
    except Exception:
        pass
    if user_settings is None:
        return None, "Utilisateur sans settings"

    decoded = get_user_provider_key(user_settings, provider_name) or {}
    api_key = decoded.get("api_key")
    base_url = decoded.get("base_url")
    if not api_key and not base_url:
        return None, f"Pas de clé configurée pour le provider '{provider_name}'"

    base = settings.providers.get(provider_name)
    cfg = ProviderConfig(
        enabled=True,
        api_key=api_key or "local",
        base_url=base_url or (base.base_url if base else None),
        default_model=base.default_model if base else None,
        models=base.models if base else [],
    )
    try:
        provider = get_provider(provider_name, cfg.api_key, cfg.base_url)
        return provider, None
    except Exception as e:
        return None, f"Instanciation provider échouée : {e}"


@router.get("/chat/image/models")
async def list_image_models(request: Request, session: AsyncSession = Depends(get_session)):
    """Renvoie les modèles image-gen disponibles pour l'user courant, filtrés
    par les providers pour lesquels il a une clé configurée."""
    user_id = getattr(request.state, "user_id", None)
    if not user_id:
        return {"providers": []}
    try:
        user_settings = await get_user_settings(user_id, session)
    except Exception:
        return {"providers": []}

    out: list[dict] = []
    for provider_name, models in IMAGE_MODELS_CATALOG.items():
        decoded = get_user_provider_key(user_settings, provider_name) or {}
        has_key = bool(decoded.get("api_key") or decoded.get("base_url"))
        out.append({
            "provider": provider_name,
            "has_key": has_key,
            "models": models,
        })
    return {"providers": out}


@router.post("/chat/image")
async def generate_image(request: Request, data: dict, session: AsyncSession = Depends(get_session)):
    """Génère une ou plusieurs images. Body :
    ```
    {
      "prompt": "un chat en combinaison spatiale",
      "provider": "openai" | "google" | "openrouter",
      "model": "dall-e-3" | "imagen-3.0-generate-002" | ...,
      "size": "1024x1024",
      "n": 1,
      "conversation_id": 42          // optionnel — persiste en DB si fourni
    }
    ```
    Retourne `{ok, images: [{url?, b64?, mime_type, size, revised_prompt?}], message_id?}`.
    """
    user_id = getattr(request.state, "user_id", None)
    if not user_id:
        return JSONResponse({"ok": False, "error": "Authentification requise"}, status_code=401)

    prompt = (data.get("prompt") or "").strip()
    provider_name = (data.get("provider") or "").strip().lower()
    model = (data.get("model") or "").strip()
    size = (data.get("size") or "1024x1024").strip()
    n = max(1, min(4, int(data.get("n") or 1)))
    conversation_id = data.get("conversation_id")

    if not prompt:
        return {"ok": False, "error": "Prompt vide"}
    if provider_name not in IMAGE_MODELS_CATALOG:
        return {"ok": False, "error": f"Provider '{provider_name}' non supporté pour la génération d'image"}
    if not model:
        return {"ok": False, "error": "Modèle requis"}

    provider, err = await _resolve_provider_for_user(provider_name, user_id, session)
    if not provider:
        return {"ok": False, "error": err or "Provider indisponible"}

    # Appel provider — chaque implem capture ses propres erreurs SDK et
    # renvoie éventuellement une liste vide. On wrap pour toujours renvoyer
    # un JSON propre à l'UI.
    try:
        extras: dict = {}
        quality = data.get("quality")
        if quality:
            extras["quality"] = quality
        style = data.get("style")
        if style:
            extras["style"] = style
        images = await provider.generate_image(
            prompt, model, size=size, n=n, **extras,
        )
    except NotImplementedError as e:
        return {"ok": False, "error": str(e)}
    except Exception as e:
        logger.warning(f"Image gen failed provider={provider_name} model={model}: {e}")
        return {"ok": False, "error": f"Erreur de génération : {str(e)[:300]}"}

    if not images:
        return {"ok": False, "error": "Le provider n'a renvoyé aucune image."}

    # Normalise pour sérialisation JSON (b64/url/mime_type/size/revised_prompt)
    images_out = [img.model_dump(exclude_none=True) for img in images]

    # Persiste en DB si conversation_id fourni — le message user (prompt) et
    # l'assistant (images) sont stockés comme un couple, comme pour le chat.
    message_id = None
    if conversation_id is not None:
        try:
            conv = await session.get(Conversation, int(conversation_id))
            if conv and (conv.user_id is None or conv.user_id == user_id):
                user_msg = Message(
                    conversation_id=conv.id, role="user",
                    content=f"🎨 {prompt}",
                )
                assistant_msg = Message(
                    conversation_id=conv.id, role="assistant",
                    content="",
                    images_out=images_out,
                    model=model[:255],
                    provider=provider_name[:100],
                )
                session.add(user_msg)
                session.add(assistant_msg)
                import datetime as _dt
                conv.updated_at = _dt.datetime.utcnow()
                await session.commit()
                await session.refresh(assistant_msg)
                message_id = assistant_msg.id
        except Exception as e:
            logger.warning(f"Image gen DB persist failed: {e}")

    return {
        "ok": True,
        "images": images_out,
        "message_id": message_id,
        "model": model,
        "provider": provider_name,
    }
