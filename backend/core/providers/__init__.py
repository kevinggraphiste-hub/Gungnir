from .base import LLMProvider, ChatMessage, ChatResponse
from .openrouter_provider import OpenRouterProvider
from .anthropic_provider import AnthropicProvider
from .google_provider import GoogleProvider
from .openai_provider import OpenAIProvider
from .minimax_provider import MiniMaxProvider
from .mistral_provider import MistralProvider
from .xai_provider import XAIProvider
from .ollama_provider import OllamaProvider

PROVIDERS: dict[str, type[LLMProvider]] = {
    "openrouter": OpenRouterProvider,
    "anthropic": AnthropicProvider,
    "google": GoogleProvider,
    "openai": OpenAIProvider,
    "minimax": MiniMaxProvider,
    "mistral": MistralProvider,
    "xai": XAIProvider,
    "ollama": OllamaProvider,
}


def get_provider(name: str, api_key: str, base_url: str | None = None, **kwargs) -> LLMProvider:
    provider_cls = PROVIDERS.get(name)
    if not provider_cls:
        raise ValueError(f"Provider inconnu: {name}. Disponibles: {list(PROVIDERS.keys())}")
    return provider_cls(api_key=api_key, base_url=base_url, **kwargs)


__all__ = [
    "LLMProvider", "ChatMessage", "ChatResponse",
    "PROVIDERS", "get_provider",
]
