from typing import AsyncGenerator, Optional
import google.generativeai as genai
from .base import LLMProvider, ChatMessage, ChatResponse


class GoogleProvider(LLMProvider):
    name = "google"
    supports_streaming = True
    supports_tools = True

    def __init__(self, api_key: str, base_url: Optional[str] = None, **kwargs):
        super().__init__(api_key, base_url, **kwargs)
        genai.configure(api_key=api_key)

    async def chat(
        self,
        messages: list[ChatMessage],
        model: str,
        **kwargs
    ) -> ChatResponse:
        model_instance = genai.GenerativeModel(model)
        chat_history = []
        system_prompt = None

        for m in messages:
            if m.role == "system":
                system_prompt = m.content
            elif m.role == "user":
                chat_history.append({"role": "user", "parts": [m.content]})
            elif m.role == "assistant":
                chat_history.append({"role": "model", "parts": [m.content]})

        if system_prompt:
            model_instance = genai.GenerativeModel(model, system_instruction=system_prompt)

        chat = model_instance.start_chat(history=chat_history[:-1] if chat_history else [])
        last_msg = chat_history[-1]["parts"][0] if chat_history else ""
        resp = await chat.send_message_async(last_msg)

        return ChatResponse(
            content=resp.text,
            model=model,
            tokens_input=resp.usage_metadata.prompt_token_count if resp.usage_metadata else 0,
            tokens_output=resp.usage_metadata.candidates_token_count if resp.usage_metadata else 0,
        )

    async def chat_stream(
        self,
        messages: list[ChatMessage],
        model: str,
        **kwargs
    ) -> AsyncGenerator[str, None]:
        model_instance = genai.GenerativeModel(model)
        chat_history = []
        system_prompt = None

        for m in messages:
            if m.role == "system":
                system_prompt = m.content
            elif m.role == "user":
                chat_history.append({"role": "user", "parts": [m.content]})
            elif m.role == "assistant":
                chat_history.append({"role": "model", "parts": [m.content]})

        if system_prompt:
            model_instance = genai.GenerativeModel(model, system_instruction=system_prompt)

        chat = model_instance.start_chat(history=chat_history[:-1] if chat_history else [])
        last_msg = chat_history[-1]["parts"][0] if chat_history else ""

        resp = await chat.send_message_async(last_msg, stream=True)
        async for chunk in resp:
            if chunk.text:
                yield chunk.text

    async def list_models(self) -> list[str]:
        models = []
        for m in genai.list_models():
            if "generateContent" in m.supported_generation_methods:
                models.append(m.name.replace("models/", ""))
        return models
