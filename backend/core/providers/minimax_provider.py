from typing import AsyncGenerator, Optional
import json as _json
import logging
import httpx
from .base import LLMProvider, ChatMessage, ChatResponse

_log = logging.getLogger("gungnir.providers.minimax")


def _format_minimax_error(status: int, body: str) -> str:
    """Construit un message d'erreur lisible à partir d'une réponse non-200.

    MiniMax remonte souvent un JSON `{"base_resp": {"status_code": X,
    "status_msg": "..."}}` avec un status HTTP 401/4xx. On cherche d'abord
    ce détail, sinon on renvoie le body brut tronqué. Sans ça le caller
    voyait juste "401 Unauthorized" et le wrapper Gungnir traduisait en
    "Clé API invalide ou expirée" — message trompeur quand la vraie cause
    est un GroupId mal renseigné, une région bloquée, un modèle inactif…
    """
    detail = body.strip()
    try:
        parsed = _json.loads(body)
        if isinstance(parsed, dict):
            br = parsed.get("base_resp") or parsed.get("error") or {}
            if isinstance(br, dict):
                msg = br.get("status_msg") or br.get("message") or ""
                code = br.get("status_code") or br.get("code")
                if msg or code:
                    detail = f"code={code} msg={msg}"
    except Exception:
        pass
    return f"MiniMax HTTP {status}: {detail[:400]}"


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
        # IMPORTANT — la doc officielle MiniMax sur la route OpenAI-compat
        # `https://api.minimax.io/v1/chat/completions` ne demande PAS de
        # GroupId : seule la clé API en Bearer suffit (cf.
        # https://platform.minimax.io/docs/api-reference/text-openai-api).
        # GroupId est requis uniquement sur l'ancienne route native
        # `/v1/text/chatcompletion_v2` qu'on n'utilise pas. Garder
        # group_id optionnel : si l'user le renseigne, on le passe en
        # query param (zéro impact si l'API l'ignore), sinon on l'omet
        # complètement plutôt que de bloquer la requête.
        self.api_key = (api_key or "").strip()
        self.group_id = (group_id or "").strip() or None
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }
        params = {"GroupId": self.group_id} if self.group_id else None
        self.client = httpx.AsyncClient(
            base_url=self.base_url or self.BASE_URL,
            headers=headers,
            params=params,
            timeout=120.0,
        )

    @staticmethod
    def _sanitize_kwargs(kwargs: dict) -> dict:
        """Filtre les paramètres non-supportés par MiniMax (cf. doc OpenAI-compat).

        L'API reject hard si on envoie :
        - `n` autre que 1 (multiple completions non supporté)
        - `temperature` à 0 ou > 1 (range officiel = (0, 1])
        - `presence_penalty`, `frequency_penalty`, `logit_bias` (non gérés)
        - `function_call` (déprécié, remplacé par `tool_choice`)
        """
        clean = {k: v for k, v in kwargs.items() if k not in {
            "presence_penalty", "frequency_penalty", "logit_bias", "function_call",
        }}
        if "n" in clean and clean["n"] != 1:
            clean["n"] = 1
        t = clean.get("temperature")
        if t is not None:
            if t <= 0:
                clean["temperature"] = 0.01  # MiniMax refuse 0 strict
            elif t > 1:
                clean["temperature"] = 1.0
        return clean

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
            **self._sanitize_kwargs(kwargs),
        }
        resp = await self.client.post("/chat/completions", json=payload)
        # Surface du body MiniMax sur erreur HTTP — sans ça `raise_for_status`
        # remontait juste "401 Unauthorized" et Gungnir traduisait en
        # "Clé API invalide" alors que la vraie cause est ailleurs.
        if resp.status_code != 200:
            err = _format_minimax_error(resp.status_code, resp.text)
            _log.warning(f"chat failed for model={model}: {err}")
            raise ValueError(err)
        try:
            data = resp.json()
        except Exception as e:
            raise ValueError(f"MiniMax: réponse JSON invalide ({e}): {resp.text[:200]}")
        # MiniMax retourne parfois un base_resp.status_code != 0 même
        # avec HTTP 200 (ex: GroupId invalide). On le surface au lieu
        # de crasher sur le KeyError "choices".
        base_resp = data.get("base_resp") or {}
        if base_resp.get("status_code") not in (None, 0):
            raise ValueError(
                f"MiniMax: code={base_resp.get('status_code')} "
                f"msg={base_resp.get('status_msg', 'unknown')}"
            )
        if not data.get("choices"):
            raise ValueError(f"MiniMax: réponse sans 'choices' — {str(data)[:300]}")
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
            **self._sanitize_kwargs(kwargs),
        }
        async with self.client.stream("POST", "/chat/completions", json=payload) as resp:
            if resp.status_code != 200:
                body = await resp.aread()
                err = _format_minimax_error(resp.status_code, body.decode("utf-8", errors="replace"))
                _log.warning(f"stream failed for model={model}: {err}")
                raise ValueError(err)
            async for line in resp.aiter_lines():
                if line.startswith("data: "):
                    chunk = line[6:]
                    if chunk.strip() == "[DONE]":
                        break
                    try:
                        data = _json.loads(chunk)
                        delta = data["choices"][0].get("delta", {})
                        if content := delta.get("content"):
                            yield content
                    except (_json.JSONDecodeError, KeyError, IndexError):
                        continue

    async def list_models(self) -> list[str]:
        try:
            resp = await self.client.get("/models")
            if resp.status_code != 200:
                _log.info(
                    f"list_models /models returned {resp.status_code}, "
                    f"falling back to static list. Body: {resp.text[:200]}"
                )
                raise httpx.HTTPStatusError("non-200", request=resp.request, response=resp)
            data = resp.json()
            ids = [m["id"] for m in data.get("data", []) if isinstance(m, dict) and m.get("id")]
            return ids or self._static_models()
        except Exception:
            return self._static_models()

    @staticmethod
    def _static_models() -> list[str]:
        # Fallback : casse exacte des modèles MiniMax — l'API rejette
        # les noms en minuscules même sur le routeur OpenAI-compat.
        # Les variantes `-highspeed` sont des versions accélérées du même
        # modèle (latence réduite, coût plus élevé) — listées dans la doc
        # officielle aux côtés des versions standard.
        return [
            "MiniMax-M2.7",
            "MiniMax-M2.7-highspeed",
            "MiniMax-M2.5",
            "MiniMax-M2.5-highspeed",
            "MiniMax-M2.1",
            "MiniMax-M2.1-highspeed",
            "MiniMax-M2",
            "MiniMax-M1",
            "MiniMax-Text-01",
            "abab6.5s-chat",
            "abab6.5g-chat",
        ]
