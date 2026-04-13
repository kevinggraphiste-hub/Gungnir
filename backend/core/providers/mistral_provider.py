from typing import AsyncGenerator, Optional
import openai
from .base import LLMProvider, ChatMessage, ChatResponse


class MistralProvider(LLMProvider):
    """Mistral AI — API compatible OpenAI."""
    name = "mistral"
    supports_streaming = True
    supports_tools = True

    def __init__(self, api_key: str, base_url: Optional[str] = None, **kwargs):
        super().__init__(api_key, base_url, **kwargs)
        self.client = openai.AsyncOpenAI(
            api_key=api_key,
            base_url=base_url or "https://api.mistral.ai/v1",
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
        try:
            resp = await self.client.models.list()
            return [m.id for m in resp.data]
        except Exception:
            return ["mistral-large-latest", "mistral-small-latest", "mistral-medium-latest", "codestral-latest"]
