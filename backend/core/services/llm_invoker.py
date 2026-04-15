"""
LLM invocation helper for background tasks (no HTTP context).

Mirrors the provider + API-key resolution logic from backend/core/api/chat.py
so that daemons (automata, conscience, etc.) can invoke a user's configured
LLM with the same per-user key precedence: user keys first, global fallback.
"""
from __future__ import annotations

import json as _json
import logging
import uuid as _uuid
from typing import Any, Awaitable, Callable

from backend.core.config.settings import Settings
from backend.core.db.engine import async_session
from backend.core.api.auth_helpers import get_user_settings, get_user_provider_key
from backend.core.providers import get_provider, ChatMessage

logger = logging.getLogger("gungnir.llm_invoker")

ExecutorFn = Callable[..., Awaitable[Any]]


async def invoke_llm_for_user(
    user_id: int,
    prompt: str,
    system_prompt: str | None = None,
    provider: str | None = None,
    model: str | None = None,
    tools: list[dict] | None = None,
    executors: dict[str, ExecutorFn] | None = None,
    max_tool_rounds: int = 5,
) -> dict:
    """Invoke a user's configured LLM from a non-HTTP context.

    When ``tools`` and ``executors`` are provided, the invoker runs a
    tool-calling loop (up to ``max_tool_rounds`` rounds) that mirrors the
    chat.py native tool-call flow. Unknown tool names are returned as errors
    to the LLM so it can fall back to a text answer.

    Returns a dict:
        { "ok": True, "content": "...", "model": "...", "provider": "...",
          "tool_calls": [...] }
      or
        { "ok": False, "error": "..." }
    """
    settings = Settings.load()
    provider_name = provider or settings.app.active_provider or "openrouter"

    # Resolve API key: STRICT per-user. A background task must run as a known
    # user, and that user must have their own key — no global fallback.
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
        return {
            "ok": False,
            "error": f"Aucune clé API pour le provider '{provider_name}' (user {user_id})",
        }
    # Fall back to the global base_url (metadata only, no secret) if the user
    # didn't set a custom endpoint.
    if not base_url and provider_config:
        base_url = provider_config.base_url

    chosen_model = model or (provider_config.default_model if provider_config else None)
    if not chosen_model:
        return {"ok": False, "error": f"Aucun modèle par défaut pour '{provider_name}'"}

    messages: list[ChatMessage] = []
    if system_prompt:
        messages.append(ChatMessage(role="system", content=system_prompt))
    messages.append(ChatMessage(role="user", content=prompt))

    tool_events: list[dict] = []
    totals_in = 0
    totals_out = 0

    try:
        p = get_provider(provider_name, api_key, base_url)

        # ── Text-only path (no tools wired) ──────────────────────────────────
        if not tools or not executors:
            response = await p.chat(messages, chosen_model)
        else:
            # ── Tool-calling loop ────────────────────────────────────────────
            response = None
            for _round in range(max_tool_rounds):
                try:
                    response = await p.chat(
                        messages,
                        chosen_model,
                        tools=tools,
                        tool_choice="auto",
                    )
                except Exception as tool_err:
                    # Provider doesn't support tools on this model — retry text-only
                    logger.warning(
                        f"LLM tool call failed for user {user_id} "
                        f"(provider={provider_name}, model={chosen_model}): {tool_err}. Retrying without tools."
                    )
                    clean = [
                        ChatMessage(role=m.role, content=m.content or "")
                        for m in messages
                        if m.role != "tool"
                    ]
                    response = await p.chat(clean, chosen_model)
                    break

                totals_in += getattr(response, "tokens_input", 0) or 0
                totals_out += getattr(response, "tokens_output", 0) or 0

                if not response.tool_calls:
                    break  # Final text answer

                # Execute each tool call, then feed results back to the LLM
                messages.append(ChatMessage(
                    role="assistant",
                    content=response.content or "",
                    tool_calls=response.tool_calls,
                ))
                for tc in response.tool_calls:
                    fn = tc.get("function", {})
                    tool_name = fn.get("name", "")
                    call_id = tc.get("id") or str(_uuid.uuid4())[:8]
                    try:
                        raw_args = fn.get("arguments", "{}")
                        args = _json.loads(raw_args) if isinstance(raw_args, str) else raw_args
                    except Exception:
                        args = {}

                    executor = executors.get(tool_name)
                    if executor is None:
                        tool_result = {"ok": False, "error": f"Outil '{tool_name}' inconnu."}
                    else:
                        try:
                            tool_result = await executor(**args)
                        except Exception as ex:
                            tool_result = {"ok": False, "error": str(ex)}

                    tool_events.append({"tool": tool_name, "args": args, "result": tool_result})
                    messages.append(ChatMessage(
                        role="tool",
                        content=_json.dumps(tool_result, ensure_ascii=False),
                        tool_call_id=call_id,
                    ))

            # If we exhausted the rounds while still asking for tools, force a
            # final text-only answer so the cron doesn't record an empty pass.
            if response is not None and response.tool_calls:
                try:
                    response = await p.chat(messages, chosen_model)
                except Exception as final_err:
                    logger.warning(
                        f"Final no-tools wrap-up failed for user {user_id}: {final_err}"
                    )

        # ── Common result handling ──────────────────────────────────────────
        content = (response.content or "").strip() if response is not None else ""
        if not content:
            logger.warning(
                f"LLM returned empty content for user {user_id} "
                f"(provider={provider_name}, model={chosen_model}, "
                f"tokens_in={getattr(response, 'tokens_input', 0)}, "
                f"tokens_out={getattr(response, 'tokens_output', 0)}, "
                f"tools_used={len(tool_events)})"
            )
            return {
                "ok": False,
                "error": f"Réponse vide du provider {provider_name} ({chosen_model})",
                "model": getattr(response, "model", None) or chosen_model,
                "provider": provider_name,
                "tool_events": tool_events,
            }

        return {
            "ok": True,
            "content": content,
            "model": getattr(response, "model", None) or chosen_model,
            "provider": provider_name,
            "tokens_input": (getattr(response, "tokens_input", 0) or 0) + totals_in,
            "tokens_output": (getattr(response, "tokens_output", 0) or 0) + totals_out,
            "tool_events": tool_events,
        }
    except Exception as e:
        logger.error(f"LLM invocation failed for user {user_id}: {e}")
        return {"ok": False, "error": str(e), "tool_events": tool_events}
