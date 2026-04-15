"""
LLM invocation helper for background tasks (no HTTP context).

Mirrors the provider + API-key resolution logic from backend/core/api/chat.py
so that daemons (automata, conscience, etc.) can invoke a user's configured
LLM with the same per-user key precedence: user keys first, global fallback.
"""
from __future__ import annotations

import logging

from backend.core.config.settings import Settings
from backend.core.db.engine import async_session
from backend.core.api.auth_helpers import get_user_settings, get_user_provider_key
from backend.core.providers import get_provider, ChatMessage

logger = logging.getLogger("gungnir.llm_invoker")


async def invoke_llm_for_user(
    user_id: int,
    prompt: str,
    system_prompt: str | None = None,
    provider: str | None = None,
    model: str | None = None,
) -> dict:
    """Invoke a user's configured LLM from a non-HTTP context.

    Returns a dict:
        { "ok": True, "content": "...", "model": "...", "provider": "..." }
      or
        { "ok": False, "error": "..." }
    """
    settings = Settings.load()
    provider_name = provider or settings.app.active_provider or "openrouter"

    # Resolve API key: user override first, then global
    api_key = None
    base_url = None
    try:
        async with async_session() as session:
            user_settings = await get_user_settings(user_id, session)
            user_prov = get_user_provider_key(user_settings, provider_name)
            if user_prov and user_prov.get("api_key"):
                api_key = user_prov["api_key"]
                base_url = user_prov.get("base_url")
    except Exception as e:
        logger.warning(f"User key lookup failed for user {user_id}: {e}")

    provider_config = settings.providers.get(provider_name)
    if not api_key:
        if not provider_config or not provider_config.api_key:
            return {"ok": False, "error": f"Aucune clé API pour le provider '{provider_name}'"}
        api_key = provider_config.api_key
        base_url = provider_config.base_url

    chosen_model = model or (provider_config.default_model if provider_config else None)
    if not chosen_model:
        return {"ok": False, "error": f"Aucun modèle par défaut pour '{provider_name}'"}

    messages: list[ChatMessage] = []
    if system_prompt:
        messages.append(ChatMessage(role="system", content=system_prompt))
    messages.append(ChatMessage(role="user", content=prompt))

    try:
        p = get_provider(provider_name, api_key, base_url)
        response = await p.chat(messages, chosen_model)
        content = (response.content or "").strip()
        if not content:
            # Some providers (seen with minimax via openrouter) intermittently
            # return a 200 with an empty body + zero tokens. Treat it as an
            # error so callers can surface the real failure instead of logging
            # a fake "success".
            logger.warning(
                f"LLM returned empty content for user {user_id} "
                f"(provider={provider_name}, model={chosen_model}, "
                f"tokens_in={response.tokens_input}, tokens_out={response.tokens_output})"
            )
            return {
                "ok": False,
                "error": f"Réponse vide du provider {provider_name} ({chosen_model})",
                "model": response.model or chosen_model,
                "provider": provider_name,
            }
        return {
            "ok": True,
            "content": content,
            "model": response.model or chosen_model,
            "provider": provider_name,
            "tokens_input": response.tokens_input,
            "tokens_output": response.tokens_output,
        }
    except Exception as e:
        logger.error(f"LLM invocation failed for user {user_id}: {e}")
        return {"ok": False, "error": str(e)}
