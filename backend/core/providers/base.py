from abc import ABC, abstractmethod
from typing import AsyncGenerator, Optional
from pydantic import BaseModel


class ChatMessage(BaseModel):
    role: str
    content: str = ""
    tool_calls: Optional[list[dict]] = None
    tool_call_id: Optional[str] = None
    images: list[str] = []  # base64-encoded images (data:image/...;base64,...)

    def to_openai_format(self) -> dict:
        """Convert to OpenAI-compatible message format, with multimodal support."""
        base = {"role": self.role}
        if self.tool_calls:
            base["tool_calls"] = self.tool_calls
        if self.tool_call_id:
            base["tool_call_id"] = self.tool_call_id

        if self.images:
            parts: list[dict] = []
            if self.content:
                parts.append({"type": "text", "text": self.content})
            for img in self.images:
                parts.append({"type": "image_url", "image_url": {"url": img}})
            base["content"] = parts
        else:
            base["content"] = self.content
        return {k: v for k, v in base.items() if v is not None}


class ChatResponse(BaseModel):
    content: str = ""
    model: str
    tokens_input: int = 0
    tokens_output: int = 0
    tool_calls: Optional[list[dict]] = None


class GeneratedImage(BaseModel):
    """Image retournée par `generate_image`. Un provider donné utilisera soit
    `url` (OpenAI DALL-E 3, URL temporaire), soit `b64` (data-uri base64)."""
    url: Optional[str] = None
    b64: Optional[str] = None   # Base64 sans le préfixe data:image/...;base64,
    mime_type: str = "image/png"
    revised_prompt: Optional[str] = None  # OpenAI réécrit parfois le prompt
    size: Optional[str] = None  # ex: "1024x1024"

    def as_data_uri(self) -> Optional[str]:
        """Renvoie un data URI inline si on a le base64, sinon l'URL."""
        if self.b64:
            return f"data:{self.mime_type};base64,{self.b64}"
        return self.url


class LLMProvider(ABC):
    name: str
    supports_streaming: bool = True
    supports_tools: bool = False
    # Quand True, ce provider implémente `generate_image`. Permet à l'UI de
    # filtrer les providers dans le sélecteur de modèle image.
    supports_image_generation: bool = False

    def __init__(self, api_key: str, base_url: Optional[str] = None, **kwargs):
        self.api_key = api_key
        self.base_url = base_url

    @abstractmethod
    async def chat(
        self,
        messages: list[ChatMessage],
        model: str,
        **kwargs
    ) -> ChatResponse:
        ...

    @abstractmethod
    async def chat_stream(
        self,
        messages: list[ChatMessage],
        model: str,
        **kwargs
    ) -> AsyncGenerator[str, None]:
        yield ""

    @abstractmethod
    async def list_models(self) -> list[str]:
        ...

    async def generate_image(
        self,
        prompt: str,
        model: str,
        *,
        size: str = "1024x1024",
        n: int = 1,
        **kwargs,
    ) -> list[GeneratedImage]:
        """Génère une ou plusieurs images à partir d'un prompt texte. Le
        provider par défaut lève NotImplementedError — à override dans les
        providers qui supportent."""
        raise NotImplementedError(
            f"Le provider '{self.name}' ne supporte pas la génération d'images."
        )

    async def test_connection(self) -> bool:
        try:
            models = await self.list_models()
            return len(models) > 0
        except Exception:
            return False
