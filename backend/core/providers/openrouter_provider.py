from typing import AsyncGenerator, Optional
import httpx
from .base import LLMProvider, ChatMessage, ChatResponse


class OpenRouterProvider(LLMProvider):
    name = "openrouter"
    supports_streaming = True
    supports_tools = True

    BASE_URL = "https://openrouter.ai/api/v1"

    def __init__(self, api_key: str, base_url: Optional[str] = None, **kwargs):
        super().__init__(api_key, base_url, **kwargs)
        clean_key = (api_key or "").strip()
        try:
            clean_key.encode("ascii")
        except UnicodeEncodeError:
            raise ValueError(
                "Clé API OpenRouter invalide : elle contient des caractères non-ASCII "
                "(probablement un copier-coller corrompu). Re-saisis-la dans "
                "Paramètres → Providers → OpenRouter."
            )
        self.client = httpx.AsyncClient(
            base_url=self.base_url or self.BASE_URL,
            headers={
                "Authorization": f"Bearer {clean_key}",
                "HTTP-Referer": "https://openclaude.local",
                "X-Title": "OpenClaude",
            },
            timeout=120.0,
        )

    async def chat(
        self,
        messages: list[ChatMessage],
        model: str,
        **kwargs
    ) -> ChatResponse:
        payload = {
            "model": model,
            "messages": [m.to_openai_format() for m in messages],
            "stream": False,
            **kwargs,
        }
        resp = await self.client.post("/chat/completions", json=payload)
        resp.raise_for_status()
        data = resp.json()
        choice = data["choices"][0]
        return ChatResponse(
            content=choice["message"].get("content") or "",
            model=data.get("model", model),
            tokens_input=data.get("usage", {}).get("prompt_tokens", 0),
            tokens_output=data.get("usage", {}).get("completion_tokens", 0),
            tool_calls=choice["message"].get("tool_calls"),
        )

    async def chat_stream(
        self,
        messages: list[ChatMessage],
        model: str,
        **kwargs
    ) -> AsyncGenerator[str, None]:
        payload = {
            "model": model,
            "messages": [m.to_openai_format() for m in messages],
            "stream": True,
            **kwargs,
        }
        async with self.client.stream("POST", "/chat/completions", json=payload) as resp:
            resp.raise_for_status()
            async for line in resp.aiter_lines():
                if line.startswith("data: "):
                    chunk = line[6:]
                    if chunk.strip() == "[DONE]":
                        break
                    try:
                        import json
                        data = json.loads(chunk)
                        delta = data["choices"][0].get("delta", {})
                        if content := delta.get("content"):
                            yield content
                    except (json.JSONDecodeError, KeyError, IndexError):
                        continue

    async def list_models(self) -> list[str]:
        resp = await self.client.get("/models")
        resp.raise_for_status()
        data = resp.json()
        return [m["id"] for m in data.get("data", [])]
