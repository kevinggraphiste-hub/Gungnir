from typing import AsyncGenerator, Optional
import httpx
from .base import LLMProvider, ChatMessage, ChatResponse


class MiniMaxProvider(LLMProvider):
    name = "minimax"
    supports_streaming = True
    supports_tools = False

    BASE_URL = "https://api.minimax.chat/v1"

    def __init__(self, api_key: str, base_url: Optional[str] = None, **kwargs):
        super().__init__(api_key, base_url, **kwargs)
        self.client = httpx.AsyncClient(
            base_url=self.base_url or self.BASE_URL,
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
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
        }
        resp = await self.client.post("/chat/completions", json=payload)
        resp.raise_for_status()
        data = resp.json()
        choice = data["choices"][0]
        return ChatResponse(
            content=choice["message"]["content"],
            model=data.get("model", model),
            tokens_input=data.get("usage", {}).get("prompt_tokens", 0),
            tokens_output=data.get("usage", {}).get("completion_tokens", 0),
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
        return ["minimax-m2.7", "minimax-m2.5", "minimax-m2.1", "abab6.5s-chat", "abab5.5s-chat"]
