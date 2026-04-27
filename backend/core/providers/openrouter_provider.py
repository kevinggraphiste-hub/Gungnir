from typing import Any, AsyncGenerator, Optional
import httpx
from .base import LLMProvider, ChatMessage, ChatResponse, GeneratedImage


class OpenRouterProvider(LLMProvider):
    name = "openrouter"
    supports_streaming = True
    supports_tools = True
    supports_image_generation = True

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

    async def generate_image(
        self,
        prompt: str,
        model: str,
        *,
        size: str = "1024x1024",
        n: int = 1,
        **kwargs,
    ) -> list[GeneratedImage]:
        """OpenRouter route les modèles image-gen via :
        - `/images/generations` compatible OpenAI (dall-e-3, gpt-image-1…)
        - ou `/chat/completions` avec `modalities: ["image","text"]`
          (Gemini Flash Image, Grok Aurora, Imagen 3/4…)

        On tente d'abord /images/generations ; fallback sur le chat
        multimodal si le modèle n'est pas pris en charge par cet endpoint.

        Les modèles `imagen-*` ont un format particulier : OpenRouter
        attend `modalities: ["image"]` sans "text" (sinon 400). On adapte
        selon la famille du model id.
        """
        import logging as _log
        _logger = _log.getLogger("gungnir.providers.openrouter.image")
        out: list[GeneratedImage] = []

        # ── /images/generations (OpenAI-compatible) ──────────────────────
        try:
            resp = await self.client.post("/images/generations", json={
                "model": model, "prompt": prompt, "size": size, "n": n,
            })
            if resp.status_code == 200:
                data = resp.json()
                for item in data.get("data", []) or []:
                    out.append(GeneratedImage(
                        url=item.get("url"),
                        b64=item.get("b64_json"),
                        revised_prompt=item.get("revised_prompt"),
                        size=size,
                        mime_type="image/png",
                    ))
                if out:
                    return out
            else:
                # Log le body d'erreur pour diag (souvent OpenRouter dit
                # "model X doesn't support /images/generations").
                try:
                    body = resp.json()
                    _logger.info("[OpenRouter] /images/generations %s → %s : %s",
                                 model, resp.status_code, body)
                except Exception:
                    pass
        except httpx.HTTPError as e:
            _logger.info("[OpenRouter] /images/generations exception : %s", e)

        # ── /chat/completions avec modalities ────────────────────────────
        # Imagen veut juste ["image"] ; Gemini Flash Image et Grok Aurora
        # acceptent ["image","text"]. On adapte sur le préfixe model.
        m_lower = (model or "").lower()
        if "imagen" in m_lower:
            modalities = ["image"]
        else:
            modalities = ["image", "text"]
        payload: dict[str, Any] = {
            "model": model,
            "messages": [{"role": "user", "content": prompt}],
            "modalities": modalities,
            "stream": False,
        }
        resp = await self.client.post("/chat/completions", json=payload)
        if resp.status_code != 200:
            # Récupère le détail de l'erreur OpenRouter pour le remonter
            # de manière compréhensible (au lieu d'un raise_for_status sec).
            err_msg = ""
            try:
                err_body = resp.json()
                err = err_body.get("error") or {}
                err_msg = err.get("message") if isinstance(err, dict) else str(err_body)
            except Exception:
                err_msg = resp.text[:300]
            raise RuntimeError(
                f"OpenRouter {resp.status_code} pour modèle '{model}' : {err_msg or 'erreur inconnue'}"
            )
        data = resp.json()
        choice = (data.get("choices") or [{}])[0]
        message = choice.get("message") or {}
        images_field = message.get("images")
        if isinstance(images_field, list):
            for it in images_field:
                url, b64 = None, None
                if isinstance(it, dict):
                    img = it.get("image_url") or it
                    url = img.get("url") if isinstance(img, dict) else (img if isinstance(img, str) else None)
                    b64 = it.get("b64_json") or it.get("b64")
                out.append(GeneratedImage(url=url, b64=b64, size=size, mime_type="image/png"))
        content = message.get("content")
        if isinstance(content, list):
            for part in content:
                if not isinstance(part, dict):
                    continue
                if part.get("type") in ("image_url", "output_image"):
                    img = part.get("image_url") or part
                    url = img.get("url") if isinstance(img, dict) else None
                    if url:
                        out.append(GeneratedImage(url=url, size=size, mime_type="image/png"))
                inline = part.get("inline_data") or part.get("inlineData")
                if isinstance(inline, dict) and inline.get("data"):
                    out.append(GeneratedImage(
                        b64=str(inline["data"]),
                        mime_type=inline.get("mime_type") or inline.get("mimeType") or "image/png",
                        size=size,
                    ))
        return out
