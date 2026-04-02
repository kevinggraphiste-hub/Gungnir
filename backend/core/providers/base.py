from abc import ABC, abstractmethod
from typing import AsyncGenerator, Optional
from pydantic import BaseModel


class ChatMessage(BaseModel):
    role: str
    content: str = ""
    tool_calls: Optional[list[dict]] = None
    tool_call_id: Optional[str] = None


class ChatResponse(BaseModel):
    content: str = ""
    model: str
    tokens_input: int = 0
    tokens_output: int = 0
    tool_calls: Optional[list[dict]] = None


class LLMProvider(ABC):
    name: str
    supports_streaming: bool = True
    supports_tools: bool = False

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

    async def test_connection(self) -> bool:
        try:
            models = await self.list_models()
            return len(models) > 0
        except Exception:
            return False
