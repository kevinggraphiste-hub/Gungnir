import logging
from typing import AsyncGenerator, Optional
import httpx
from .base import LLMProvider, ChatMessage, ChatResponse

logger = logging.getLogger("gungnir.providers.ollama")


# Ollama deployment cheatsheet — pick base_url per user setup:
#   • Ollama on the Docker host (same VPS):   http://host.docker.internal:11434/v1
#     (requires `extra_hosts: - "host.docker.internal:host-gateway"` in compose)
#   • Ollama in another Docker container:     http://<container-name>:11434/v1
#     (both containers must share a Docker network — see docs/ollama.md)
#   • Ollama on another machine / LAN / WAN:  http://<ip-or-host>:11434/v1
#   • Local dev without Docker:               http://localhost:11434/v1


class OllamaProvider(LLMProvider):
    name = "ollama"
    supports_streaming = True
    supports_tools = False

    def __init__(self, api_key: str = "", base_url: Optional[str] = None, **kwargs):
        super().__init__(api_key or "ollama", base_url or "http://localhost:11434/v1", **kwargs)
        self.client = httpx.AsyncClient(
            base_url=self.base_url,
            timeout=120.0,
        )
        # Pre-compute the native /api root (strip /v1 suffix if present).
        # /v1/models is OpenAI-compat and may omit some pulled tags; /api/tags
        # is the canonical Ollama endpoint that lists everything.
        root = self.base_url.rstrip("/")
        if root.endswith("/v1"):
            root = root[:-3]
        self._native_root = root

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
        """List pulled Ollama models.

        Merges two sources so nothing is missed:
          1. /v1/models (OpenAI-compat) — what the chat endpoint sees
          2. /api/tags (Ollama native) — canonical list of pulled models

        Logs failures instead of silently returning [] so users can actually
        debug connection issues from the backend logs.
        """
        results: set[str] = set()

        # 1. OpenAI-compat endpoint
        try:
            resp = await self.client.get("/models")
            resp.raise_for_status()
            data = resp.json()
            for m in data.get("data", []):
                mid = m.get("id")
                if mid:
                    results.add(mid)
        except Exception as e:
            logger.warning(f"Ollama /v1/models failed at {self.base_url}: {e}")

        # 2. Native /api/tags — fetched with an absolute URL since it lives
        # outside the /v1 prefix the client is configured with.
        try:
            async with httpx.AsyncClient(timeout=30.0) as raw:
                resp = await raw.get(f"{self._native_root}/api/tags")
                resp.raise_for_status()
                data = resp.json()
                for m in data.get("models", []):
                    name = m.get("name") or m.get("model")
                    if name:
                        results.add(name)
        except Exception as e:
            logger.warning(f"Ollama /api/tags failed at {self._native_root}: {e}")

        if not results:
            logger.error(
                f"Ollama list_models returned empty at {self.base_url} — "
                f"check that Ollama is running and reachable from the backend container"
            )
        return sorted(results)

    async def test_connection(self) -> bool:
        try:
            resp = await self.client.get("/models")
            return resp.status_code == 200
        except Exception as e:
            logger.warning(f"Ollama test_connection failed at {self.base_url}: {e}")
            return False
