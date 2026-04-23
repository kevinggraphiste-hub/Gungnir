"""
Gungnir — Google Generative AI Provider
Uses the new google-genai SDK (recommended by Google, GA since 2025).
Fallback to legacy google-generativeai if needed.
"""
from typing import AsyncGenerator, Optional
from .base import LLMProvider, ChatMessage, ChatResponse, GeneratedImage
import base64 as _b64

# Try new SDK first, fallback to legacy
try:
    from google import genai as google_genai
    from google.genai import types
    USE_NEW_SDK = True
except ImportError:
    import google.generativeai as genai_legacy
    USE_NEW_SDK = False


class GoogleProvider(LLMProvider):
    name = "google"
    supports_streaming = True
    supports_tools = True
    supports_image_generation = True

    def __init__(self, api_key: str, base_url: Optional[str] = None, **kwargs):
        super().__init__(api_key, base_url, **kwargs)
        if USE_NEW_SDK:
            self.client = google_genai.Client(api_key=api_key)
        else:
            genai_legacy.configure(api_key=api_key)

    async def chat(
        self,
        messages: list[ChatMessage],
        model: str,
        **kwargs
    ) -> ChatResponse:
        if USE_NEW_SDK:
            return await self._chat_new(messages, model, **kwargs)
        return await self._chat_legacy(messages, model, **kwargs)

    async def _chat_new(self, messages, model, **kwargs):
        contents = []
        system_prompt = None

        for m in messages:
            if m.role == "system":
                system_prompt = m.content
            elif m.role == "user":
                parts = []
                if m.content:
                    parts.append(types.Part.from_text(text=m.content))
                if m.images:
                    import base64
                    for img in m.images:
                        if img.startswith("data:"):
                            header, b64_data = img.split(",", 1)
                            mime = header.split(":")[1].split(";")[0]
                            parts.append(types.Part.from_bytes(data=base64.b64decode(b64_data), mime_type=mime))
                contents.append(types.Content(role="user", parts=parts))
            elif m.role == "assistant":
                contents.append(types.Content(role="model", parts=[types.Part.from_text(text=m.content)]))

        config = types.GenerateContentConfig(
            system_instruction=system_prompt if system_prompt else None,
            max_output_tokens=kwargs.get("max_tokens", 8192),
            temperature=kwargs.get("temperature", 0.7),
        )

        resp = await self.client.aio.models.generate_content(
            model=model,
            contents=contents,
            config=config,
        )

        return ChatResponse(
            content=resp.text or "",
            model=model,
            tokens_input=resp.usage_metadata.prompt_token_count if resp.usage_metadata else 0,
            tokens_output=resp.usage_metadata.candidates_token_count if resp.usage_metadata else 0,
        )

    async def _chat_legacy(self, messages, model, **kwargs):
        import google.generativeai as genai
        model_instance = genai.GenerativeModel(model)
        chat_history = []
        system_prompt = None

        for m in messages:
            if m.role == "system":
                system_prompt = m.content
            elif m.role == "user":
                parts = [m.content] if m.content else []
                if m.images:
                    import base64
                    for img in m.images:
                        if img.startswith("data:"):
                            header, b64_data = img.split(",", 1)
                            mime = header.split(":")[1].split(";")[0]
                            parts.append({"mime_type": mime, "data": base64.b64decode(b64_data)})
                chat_history.append({"role": "user", "parts": parts})
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
        if USE_NEW_SDK:
            async for chunk in self._stream_new(messages, model, **kwargs):
                yield chunk
        else:
            async for chunk in self._stream_legacy(messages, model, **kwargs):
                yield chunk

    async def _stream_new(self, messages, model, **kwargs):
        contents = []
        system_prompt = None

        for m in messages:
            if m.role == "system":
                system_prompt = m.content
            elif m.role == "user":
                parts = []
                if m.content:
                    parts.append(types.Part.from_text(text=m.content))
                if m.images:
                    import base64
                    for img in m.images:
                        if img.startswith("data:"):
                            header, b64_data = img.split(",", 1)
                            mime = header.split(":")[1].split(";")[0]
                            parts.append(types.Part.from_bytes(data=base64.b64decode(b64_data), mime_type=mime))
                contents.append(types.Content(role="user", parts=parts))
            elif m.role == "assistant":
                contents.append(types.Content(role="model", parts=[types.Part.from_text(text=m.content)]))

        config = types.GenerateContentConfig(
            system_instruction=system_prompt if system_prompt else None,
            max_output_tokens=kwargs.get("max_tokens", 8192),
            temperature=kwargs.get("temperature", 0.7),
        )

        async for chunk in self.client.aio.models.generate_content_stream(
            model=model,
            contents=contents,
            config=config,
        ):
            if chunk.text:
                yield chunk.text

    async def _stream_legacy(self, messages, model, **kwargs):
        import google.generativeai as genai
        model_instance = genai.GenerativeModel(model)
        chat_history = []
        system_prompt = None

        for m in messages:
            if m.role == "system":
                system_prompt = m.content
            elif m.role == "user":
                parts = [m.content] if m.content else []
                if m.images:
                    import base64
                    for img in m.images:
                        if img.startswith("data:"):
                            header, b64_data = img.split(",", 1)
                            mime = header.split(":")[1].split(";")[0]
                            parts.append({"mime_type": mime, "data": base64.b64decode(b64_data)})
                chat_history.append({"role": "user", "parts": parts})
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
        if USE_NEW_SDK:
            try:
                models = []
                # New SDK: list() returns a pager, iterate with async for
                pager = await self.client.aio.models.list(config={"page_size": 100})
                for m in pager.models:
                    name = m.name if hasattr(m, 'name') else str(m)
                    name = name.replace("models/", "")
                    models.append(name)
                # Fetch remaining pages
                while pager.next_page_token:
                    pager = await self.client.aio.models.list(
                        config={"page_size": 100, "page_token": pager.next_page_token}
                    )
                    for m in pager.models:
                        name = m.name if hasattr(m, 'name') else str(m)
                        name = name.replace("models/", "")
                        models.append(name)
                return models
            except Exception as e:
                import logging
                logging.getLogger("gungnir").warning(f"Google new SDK list_models failed: {e}")
                # Fallback to sync
                try:
                    models = []
                    result = self.client.models.list(config={"page_size": 100})
                    for m in result.models:
                        name = m.name if hasattr(m, 'name') else str(m)
                        name = name.replace("models/", "")
                        models.append(name)
                    return models
                except Exception as e2:
                    logging.getLogger("gungnir").warning(f"Google sync list_models failed: {e2}")
        # Legacy SDK fallback
        try:
            import google.generativeai as genai
            genai.configure(api_key=self.api_key)
            models = []
            for m in genai.list_models():
                if "generateContent" in m.supported_generation_methods:
                    models.append(m.name.replace("models/", ""))
            return models
        except Exception:
            return []

    async def generate_image(
        self,
        prompt: str,
        model: str,
        *,
        size: str = "1024x1024",
        n: int = 1,
        **kwargs,
    ) -> list[GeneratedImage]:
        """Deux chemins selon le modèle :

        - `imagen-*` → API Imagen (`client.models.generate_images`). Le SDK
          renvoie des bytes PNG directement.
        - `gemini-2.5-flash-image-*` (NanoBanana) et `gemini-2.0-flash-exp-image-generation`
          → API Gemini `generate_content` avec `response_modalities=["IMAGE"]`.
          Les images arrivent en inline_data (b64) dans les parts du candidat.
        """
        if not USE_NEW_SDK:
            raise NotImplementedError(
                "Génération d'image Google nécessite le nouveau SDK google-genai. "
                "Installer : pip install google-genai>=1.0.0"
            )

        out: list[GeneratedImage] = []

        # ── Imagen ─────────────────────────────────────────────────────────
        if "imagen" in model.lower():
            # size "1024x1024" → aspect_ratio "1:1" ; "1792x1024" → "16:9" ; etc.
            aspect_map = {
                "1024x1024": "1:1",
                "1792x1024": "16:9", "1024x1792": "9:16",
                "1536x1024": "3:2", "1024x1536": "2:3",
            }
            aspect_ratio = aspect_map.get(size, "1:1")
            try:
                config = types.GenerateImagesConfig(
                    number_of_images=n,
                    aspect_ratio=aspect_ratio,
                )
            except Exception:
                # Fallback minimal si certains champs manquent selon la version
                config = types.GenerateImagesConfig(number_of_images=n)
            resp = self.client.models.generate_images(
                model=model, prompt=prompt, config=config,
            )
            for img in getattr(resp, "generated_images", []) or []:
                data = getattr(getattr(img, "image", None), "image_bytes", None)
                if not data:
                    continue
                out.append(GeneratedImage(
                    b64=_b64.b64encode(data).decode("ascii"),
                    mime_type="image/png",
                    size=size,
                ))
            return out

        # ── Gemini Flash Image (NanoBanana) ────────────────────────────────
        try:
            config = types.GenerateContentConfig(
                response_modalities=["IMAGE", "TEXT"],
            )
        except Exception:
            config = None
        resp = self.client.models.generate_content(
            model=model, contents=prompt, config=config,
        )
        revised = ""
        for cand in getattr(resp, "candidates", []) or []:
            content = getattr(cand, "content", None)
            if not content:
                continue
            for part in getattr(content, "parts", []) or []:
                inline = getattr(part, "inline_data", None)
                if inline and getattr(inline, "data", None):
                    raw = inline.data
                    if isinstance(raw, (bytes, bytearray)):
                        b64 = _b64.b64encode(raw).decode("ascii")
                    else:
                        # Certaines versions du SDK renvoient déjà du b64
                        b64 = str(raw)
                    out.append(GeneratedImage(
                        b64=b64,
                        mime_type=getattr(inline, "mime_type", "image/png") or "image/png",
                        size=size,
                    ))
                elif getattr(part, "text", None):
                    revised += part.text
        if revised and out:
            out[0].revised_prompt = revised.strip()[:500]
        return out
