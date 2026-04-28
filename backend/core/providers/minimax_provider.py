from typing import AsyncGenerator, Optional
import httpx
from .base import LLMProvider, ChatMessage, ChatResponse


class MiniMaxProvider(LLMProvider):
    name = "minimax"
    supports_streaming = True
    supports_tools = False

    # api.minimax.chat = endpoint Chine (souvent bloqué hors APAC)
    # api.minimax.io   = endpoint international officiel (US/Europe)
    # On défaut sur l'international ; l'user peut override via Settings
    # → Provider → base_url custom s'il a besoin de l'endpoint chinois.
    BASE_URL = "https://api.minimax.io/v1"

    def __init__(
        self,
        api_key: str,
        base_url: Optional[str] = None,
        group_id: Optional[str] = None,
        **kwargs,
    ):
        super().__init__(api_key, base_url, **kwargs)
        # GroupId est OBLIGATOIRE sur tous les appels chat MiniMax (sinon
        # l'API renvoie une erreur d'authentification trompeuse — la clé
        # est valide mais le request est rejeté). On l'attache comme
        # query param `?GroupId=...` et non en header. Source officielle :
        # https://platform.minimax.io/docs/api-reference/text-openai-api
        self.group_id = (group_id or "").strip() or None
        params = {"GroupId": self.group_id} if self.group_id else None
        self.client = httpx.AsyncClient(
            base_url=self.base_url or self.BASE_URL,
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            params=params,
            timeout=120.0,
        )

    async def chat(
        self,
        messages: list[ChatMessage],
        model: str,
        **kwargs
    ) -> ChatResponse:
        if not self.group_id:
            raise ValueError(
                "MiniMax: GroupId manquant. Ajoute-le dans Settings → Providers → "
                "MiniMax → 'Group ID' (le trouver sur platform.minimax.io)."
            )
        payload = {
            "model": model,
            "messages": [m.to_openai_format() for m in messages],
            "stream": False,
            **kwargs,
        }
        resp = await self.client.post("/chat/completions", json=payload)
        resp.raise_for_status()
        data = resp.json()
        # MiniMax retourne parfois un base_resp.status_code != 0 même
        # avec HTTP 200 (ex: GroupId invalide). On le surface au lieu
        # de crasher sur le KeyError "choices".
        base_resp = data.get("base_resp") or {}
        if base_resp.get("status_code") not in (None, 0):
            raise ValueError(
                f"MiniMax error {base_resp.get('status_code')}: "
                f"{base_resp.get('status_msg', 'unknown')}"
            )
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
        if not self.group_id:
            raise ValueError(
                "MiniMax: GroupId manquant. Ajoute-le dans Settings → Providers → "
                "MiniMax → 'Group ID' (le trouver sur platform.minimax.io)."
            )
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
        try:
            resp = await self.client.get("/models")
            resp.raise_for_status()
            data = resp.json()
            return [m["id"] for m in data.get("data", [])]
        except Exception:
            # Fallback: respecter la casse exacte des modèles MiniMax —
            # l'API rejette les noms en minuscules même sur le routeur
            # OpenAI-compat.
            return [
                "MiniMax-M2.7",
                "MiniMax-M2.5",
                "MiniMax-M2",
                "MiniMax-M1",
                "MiniMax-Text-01",
                "abab6.5s-chat",
                "abab6.5g-chat",
            ]
