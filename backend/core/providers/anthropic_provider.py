from typing import AsyncGenerator, Optional
import anthropic
from .base import LLMProvider, ChatMessage, ChatResponse


class AnthropicProvider(LLMProvider):
    name = "anthropic"
    supports_streaming = True
    supports_tools = True

    def __init__(self, api_key: str, base_url: Optional[str] = None, **kwargs):
        super().__init__(api_key, base_url, **kwargs)
        self.client = anthropic.AsyncAnthropic(api_key=api_key)

    async def chat(
        self,
        messages: list[ChatMessage],
        model: str,
        **kwargs
    ) -> ChatResponse:
        system_msg = ""
        chat_msgs = []
        for m in messages:
            if m.role == "system":
                system_msg = m.content
            elif m.role == "tool":
                # Anthropic attend le rôle "user" avec tool_result
                chat_msgs.append({
                    "role": "user",
                    "content": [
                        {
                            "type": "tool_result",
                            "tool_use_id": m.tool_call_id or "unknown",
                            "content": m.content,
                        }
                    ],
                })
            elif m.role == "assistant" and m.tool_calls:
                # Reconstruire les tool_use blocks pour Anthropic
                content_blocks = []
                if m.content:
                    content_blocks.append({"type": "text", "text": m.content})
                for tc in m.tool_calls:
                    fn = tc.get("function", {})
                    import json as _json
                    try:
                        args = _json.loads(fn.get("arguments", "{}")) if isinstance(fn.get("arguments"), str) else fn.get("arguments", {})
                    except Exception:
                        args = {}
                    content_blocks.append({
                        "type": "tool_use",
                        "id": tc.get("id", "unknown"),
                        "name": fn.get("name", ""),
                        "input": args,
                    })
                chat_msgs.append({"role": "assistant", "content": content_blocks})
            else:
                chat_msgs.append({"role": m.role, "content": m.content})

        # Construire les params de l'appel
        create_params = {
            "model": model,
            "system": system_msg or anthropic.NOT_GIVEN,
            "messages": chat_msgs,
            "max_tokens": kwargs.get("max_tokens", 4096),
        }

        # Support des tools (function calling)
        raw_tools = kwargs.get("tools")
        if raw_tools:
            anthropic_tools = []
            for t in raw_tools:
                fn = t.get("function", t)
                anthropic_tools.append({
                    "name": fn["name"],
                    "description": fn.get("description", ""),
                    "input_schema": fn.get("parameters", {"type": "object", "properties": {}}),
                })
            create_params["tools"] = anthropic_tools
            if kwargs.get("tool_choice") == "auto":
                create_params["tool_choice"] = {"type": "auto"}

        resp = await self.client.messages.create(**create_params)

        # Extraire contenu texte + tool_calls
        content = ""
        tool_calls = []
        for block in resp.content:
            if hasattr(block, "text"):
                content += block.text
            elif block.type == "tool_use":
                import json as _json
                tool_calls.append({
                    "id": block.id,
                    "type": "function",
                    "function": {
                        "name": block.name,
                        "arguments": _json.dumps(block.input),
                    },
                })

        return ChatResponse(
            content=content,
            model=resp.model,
            tokens_input=resp.usage.input_tokens,
            tokens_output=resp.usage.output_tokens,
            tool_calls=tool_calls if tool_calls else None,
        )

    async def chat_stream(
        self,
        messages: list[ChatMessage],
        model: str,
        **kwargs
    ) -> AsyncGenerator[str, None]:
        system_msg = ""
        chat_msgs = []
        for m in messages:
            if m.role == "system":
                system_msg = m.content
            else:
                chat_msgs.append({"role": m.role, "content": m.content})

        async with self.client.messages.stream(
            model=model,
            system=system_msg or anthropic.NOT_GIVEN,
            messages=chat_msgs,
            max_tokens=kwargs.get("max_tokens", 4096),
        ) as stream:
            async for text in stream.text_stream:
                yield text

    async def list_models(self) -> list[str]:
        return ["claude-3-5-sonnet-20241022", "claude-3-5-haiku-20241022", "claude-3-opus-20240229"]
