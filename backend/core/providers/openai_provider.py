from typing import AsyncGenerator, Optional
import openai
from .base import LLMProvider, ChatMessage, ChatResponse, GeneratedImage


class OpenAIProvider(LLMProvider):
    name = "openai"
    supports_streaming = True
    supports_tools = True
    supports_image_generation = True

    def __init__(self, api_key: str, base_url: Optional[str] = None, **kwargs):
        super().__init__(api_key, base_url, **kwargs)
        self.client = openai.AsyncOpenAI(
            api_key=api_key,
            base_url=base_url,
        )

    async def chat(
        self,
        messages: list[ChatMessage],
        model: str,
        **kwargs
    ) -> ChatResponse:
        resp = await self.client.chat.completions.create(
            model=model,
            messages=[m.to_openai_format() for m in messages],
            stream=False,
            **kwargs,
        )
        choice = resp.choices[0]
        return ChatResponse(
            content=choice.message.content or "",
            model=resp.model,
            tokens_input=resp.usage.prompt_tokens if resp.usage else 0,
            tokens_output=resp.usage.completion_tokens if resp.usage else 0,
            tool_calls=[tc.model_dump() for tc in choice.message.tool_calls] if choice.message.tool_calls else None,
        )

    async def chat_stream(
        self,
        messages: list[ChatMessage],
        model: str,
        **kwargs
    ) -> AsyncGenerator[str, None]:
        stream = await self.client.chat.completions.create(
            model=model,
            messages=[m.to_openai_format() for m in messages],
            stream=True,
            **kwargs,
        )
        async for chunk in stream:
            if chunk.choices and chunk.choices[0].delta.content:
                yield chunk.choices[0].delta.content

    async def list_models(self) -> list[str]:
        """List models via OpenAI SDK, with a raw httpx fallback.

        Some OpenAI-compat backends (DeepInfra, Groq, Together…) return a
        /models payload that the openai SDK refuses to parse strictly. We
        retry with a raw GET on `<base_url>/models` and accept any list-of-
        objects with an `id` field.
        """
        try:
            resp = await self.client.models.list()
            return [m.id for m in resp.data]
        except Exception as sdk_err:
            import httpx, logging
            log = logging.getLogger("gungnir.providers.openai_compat")
            log.warning(f"OpenAI SDK list_models failed ({sdk_err!r}) — retrying via raw HTTP")
            base = (self.base_url or "https://api.openai.com/v1").rstrip("/")
            url = f"{base}/models"
            async with httpx.AsyncClient(timeout=20.0) as client:
                r = await client.get(url, headers={"Authorization": f"Bearer {self.api_key}"})
                r.raise_for_status()
                payload = r.json()
            items = payload.get("data") if isinstance(payload, dict) else payload
            if not isinstance(items, list):
                return []
            return [str(it.get("id")) for it in items if isinstance(it, dict) and it.get("id")]

    async def generate_image(
        self,
        prompt: str,
        model: str,
        *,
        size: str = "1024x1024",
        n: int = 1,
        **kwargs,
    ) -> list[GeneratedImage]:
        """Images API — DALL-E 3, GPT Image 1, DALL-E 2. Normalise le retour
        (URL ou b64) en liste de GeneratedImage."""
        # dall-e-3 n'accepte pas n>1 → on boucle côté client.
        if model.startswith("dall-e-3") and n > 1:
            out: list[GeneratedImage] = []
            for _ in range(n):
                out.extend(await self.generate_image(prompt, model, size=size, n=1, **kwargs))
            return out

        params: dict = {"model": model, "prompt": prompt, "size": size, "n": n}
        response_format = kwargs.pop("response_format", None)
        if response_format:
            params["response_format"] = response_format
        for k in ("quality", "style", "background", "user"):
            if k in kwargs and kwargs[k] is not None:
                params[k] = kwargs[k]

        resp = await self.client.images.generate(**params)
        out: list[GeneratedImage] = []
        for item in resp.data or []:
            out.append(GeneratedImage(
                url=getattr(item, "url", None),
                b64=getattr(item, "b64_json", None),
                revised_prompt=getattr(item, "revised_prompt", None),
                size=size,
                mime_type="image/png",
            ))
        return out
