"""
Gungnir Plugin — Voice (Chat Vocal Temps Réel)

4 providers temps réel natif :
  - ElevenLabs Conversational AI (WebSocket direct via signed URL)
  - OpenAI Realtime API (WebSocket relay, PCM16 24kHz)
  - Google Gemini Live (WebSocket, Multimodal Live API)
  - xAI Grok Realtime (WebSocket, protocole OpenAI-compatible)

Tous utilisent du vrai bidirectionnel audio — PAS de STT/TTS séparé.
"""
import asyncio
import json
import logging
import uuid
from datetime import datetime
from pathlib import Path
from typing import Optional

import httpx
from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect
from pydantic import BaseModel

logger = logging.getLogger("gungnir.voice")
router = APIRouter()

# ── Data persistence ────────────────────────────────────────────────────────

DATA_DIR = Path("data")
SESSIONS_FILE = DATA_DIR / "voice_sessions.json"
CUSTOM_PROVIDERS_FILE = DATA_DIR / "voice_custom_providers.json"


def _load_sessions() -> list[dict]:
    if SESSIONS_FILE.exists():
        try:
            return json.loads(SESSIONS_FILE.read_text(encoding="utf-8"))
        except Exception:
            pass
    return []


def _save_sessions(sessions: list[dict]):
    SESSIONS_FILE.parent.mkdir(parents=True, exist_ok=True)
    SESSIONS_FILE.write_text(json.dumps(sessions, indent=2, ensure_ascii=False), encoding="utf-8")


# ── Custom voice providers persistence ─────────────────────────────────────

class CustomVoiceProviderConfig(BaseModel):
    """Configuration d'un provider vocal custom ajouté par l'utilisateur."""
    id: str                                    # slug unique (ex: "hume", "deepgram-aura")
    display_name: str                          # Nom affiché (ex: "Hume AI EVI")
    icon: str = "🔊"                           # Emoji icon
    description: str = ""                      # Description courte
    enabled: bool = True

    # Connection
    ws_url: str                                # WebSocket URL (peut contenir {api_key})
    auth_method: str = "header"                # "header" | "query" | "setup_message" | "none"
    auth_header_name: str = "Authorization"    # Header name si auth_method=header
    auth_header_prefix: str = "Bearer "        # ex: "Bearer ", "xi-api-key " etc.
    auth_query_param: str = "key"              # Query param name si auth_method=query
    api_key: Optional[str] = None              # Clé API du provider

    # Audio format
    sample_rate_in: int = 16000                # Input sample rate (micro → provider)
    sample_rate_out: int = 16000               # Output sample rate (provider → playback)
    audio_format: str = "pcm16"                # "pcm16" | "opus" | "mp3"

    # Protocol — comment envoyer/recevoir l'audio via JSON
    send_audio_wrapper: str = '{"type":"audio","data":"{audio}"}'      # Template JSON, {audio} = base64
    recv_audio_path: str = "audio.data"        # Dot-path pour extraire le base64 audio reçu
    recv_transcript_path: str = ""             # Dot-path pour extraire le transcript (optionnel)
    recv_transcript_role_path: str = ""        # Dot-path pour le rôle (user/assistant)

    # Setup message (envoyé après connexion WS)
    setup_message: str = ""                    # JSON template, vide = pas de setup. {api_key}, {agent_name} remplacés

    # Ping/pong
    ping_type: str = ""                        # Si le provider envoie des pings, quel type matcher
    pong_response: str = ""                    # La réponse pong JSON à envoyer

    # Compatibility info
    protocol_type: str = "generic"             # "generic" | "openai_compatible" | "elevenlabs_compatible"
    doc_url: str = ""


def _load_custom_providers() -> list[dict]:
    if CUSTOM_PROVIDERS_FILE.exists():
        try:
            return json.loads(CUSTOM_PROVIDERS_FILE.read_text(encoding="utf-8"))
        except Exception:
            pass
    return []


def _save_custom_providers(providers: list[dict]):
    CUSTOM_PROVIDERS_FILE.parent.mkdir(parents=True, exist_ok=True)
    CUSTOM_PROVIDERS_FILE.write_text(json.dumps(providers, indent=2, ensure_ascii=False), encoding="utf-8")


def _get_nested(data: dict, path: str):
    """Extract a nested value using dot-path notation: 'audio.data' → data['audio']['data']."""
    if not path:
        return None
    keys = path.split(".")
    current = data
    for k in keys:
        if isinstance(current, dict):
            current = current.get(k)
        else:
            return None
    return current


def _get_voice_config(provider: str = "elevenlabs") -> dict:
    """Load voice config for a specific provider from settings."""
    try:
        from backend.core.config.settings import Settings
        settings = Settings.load()
        vcfg = settings.voice.get(provider)
        if vcfg:
            return vcfg.model_dump()
    except Exception as e:
        logger.warning(f"Failed to load voice config: {e}")
    return {"enabled": False, "api_key": None, "voice_id": None, "agent_id": None, "language": "fr"}


def _get_llm_key(provider: str) -> Optional[str]:
    """Fallback: get API key from LLM providers config."""
    try:
        from backend.core.config.settings import Settings
        settings = Settings.load()
        pcfg = settings.providers.get(provider)
        if pcfg and pcfg.api_key:
            return pcfg.api_key
    except Exception:
        pass
    return None


def _get_agent_name() -> str:
    try:
        from backend.core.config.settings import Settings
        return Settings.load().app.agent_name or "Gungnir"
    except Exception:
        return "Gungnir"


# ── Health ──────────────────────────────────────────────────────────────────

@router.get("/health")
async def voice_health():
    cfg_el = _get_voice_config("elevenlabs")
    cfg_oai = _get_voice_config("openai")
    cfg_google = _get_voice_config("google")
    return {
        "plugin": "voice",
        "status": "ok",
        "version": "2.0.0",
        "providers": {
            "elevenlabs": {"configured": bool(cfg_el.get("api_key")), "has_agent": bool(cfg_el.get("agent_id"))},
            "openai": {"configured": bool(cfg_oai.get("api_key") or _get_llm_key("openai"))},
            "google": {"configured": bool(cfg_google.get("api_key") or _get_llm_key("google"))},
            "grok": {"configured": bool(_get_llm_key("xai"))},
        },
    }


# ══════════════════════════════════════════════════════════════════════════════
# Multi-Provider Registry
# ══════════════════════════════════════════════════════════════════════════════

PROVIDER_INFO = {
    "elevenlabs": {
        "display_name": "ElevenLabs",
        "icon": "🎙️",
        "description": "Conversational AI — voix ultra-réalistes, agent dédié",
        "mode": "direct",  # Frontend connects directly to ElevenLabs WS
        "sample_rate_in": 16000,
        "sample_rate_out": 16000,
        "doc_url": "https://elevenlabs.io/docs/agents-platform",
    },
    "openai": {
        "display_name": "OpenAI Realtime",
        "icon": "💚",
        "description": "GPT-4o natif — voix + raisonnement intégrés",
        "mode": "relay",  # Backend relays WebSocket
        "sample_rate_in": 24000,
        "sample_rate_out": 24000,
        "doc_url": "https://platform.openai.com/docs/guides/realtime",
    },
    "google": {
        "display_name": "Gemini Live",
        "icon": "🔷",
        "description": "Gemini 2.5 Multimodal Live — conversation native",
        "mode": "relay",
        "sample_rate_in": 16000,
        "sample_rate_out": 24000,
        "doc_url": "https://ai.google.dev/gemini-api/docs/live-api",
    },
    "grok": {
        "display_name": "Grok Realtime",
        "icon": "⚡",
        "description": "xAI Grok — protocole OpenAI-compatible, 2M tokens",
        "mode": "relay",
        "sample_rate_in": 24000,
        "sample_rate_out": 24000,
        "doc_url": "https://docs.x.ai/docs",
    },
}


@router.get("/providers")
async def list_voice_providers():
    """List all voice providers with their configuration status."""
    try:
        from backend.core.config.settings import Settings
        settings = Settings.load()
    except Exception:
        return {"providers": []}

    providers = []
    for name, info in PROVIDER_INFO.items():
        vcfg = settings.voice.get(name, None)
        has_voice_key = bool(vcfg and vcfg.api_key) if vcfg else False
        has_llm_key = bool(settings.providers.get(name if name != "grok" else "xai", None))

        # For grok, check xai provider or openrouter
        if name == "grok":
            has_llm_key = bool(_get_llm_key("xai"))

        providers.append({
            "name": name,
            **info,
            "enabled": has_voice_key or has_llm_key,
            "has_voice_key": has_voice_key,
            "has_llm_key": has_llm_key,
            "has_agent": bool(vcfg and vcfg.agent_id) if vcfg else False,
            "voice_id": (vcfg.voice_id if vcfg else None) or "",
            "language": (vcfg.language if vcfg else None) or "fr",
        })

    # Add custom providers
    for cp in _load_custom_providers():
        providers.append({
            "name": cp["id"],
            "display_name": cp.get("display_name", cp["id"]),
            "icon": cp.get("icon", "🔊"),
            "description": cp.get("description", "Provider personnalisé"),
            "mode": "relay",
            "sample_rate_in": cp.get("sample_rate_in", 16000),
            "sample_rate_out": cp.get("sample_rate_out", 16000),
            "doc_url": cp.get("doc_url", ""),
            "enabled": cp.get("enabled", False) and bool(cp.get("api_key")),
            "has_voice_key": bool(cp.get("api_key")),
            "has_llm_key": False,
            "has_agent": False,
            "voice_id": "",
            "language": "fr",
            "is_custom": True,
            "protocol_type": cp.get("protocol_type", "generic"),
        })

    return {"providers": providers}


@router.post("/provider/test")
async def test_voice_provider(data: dict):
    """Test a voice provider connection."""
    provider = data.get("provider", "elevenlabs")
    cfg = _get_voice_config(provider)
    api_key = cfg.get("api_key") or _get_llm_key(provider if provider != "grok" else "xai")

    if not api_key:
        return {"ok": False, "error": f"Pas de clé API pour {provider}"}

    try:
        async with httpx.AsyncClient(timeout=10) as client:
            if provider == "elevenlabs":
                resp = await client.get(
                    "https://api.elevenlabs.io/v1/user",
                    headers={"xi-api-key": api_key},
                )
                if resp.status_code == 200:
                    user = resp.json()
                    sub = user.get("subscription", {})
                    return {
                        "ok": True, "provider": provider,
                        "tier": sub.get("tier", "free"),
                        "characters_used": sub.get("character_count", 0),
                        "characters_limit": sub.get("character_limit", 0),
                    }

            elif provider == "openai":
                resp = await client.get(
                    "https://api.openai.com/v1/models",
                    headers={"Authorization": f"Bearer {api_key}"},
                )
                if resp.status_code == 200:
                    return {"ok": True, "provider": provider, "message": "Connexion OpenAI OK — Realtime disponible"}

            elif provider == "google":
                resp = await client.get(
                    f"https://generativelanguage.googleapis.com/v1beta/models?key={api_key}",
                )
                if resp.status_code == 200:
                    return {"ok": True, "provider": provider, "message": "Connexion Google OK — Gemini Live disponible"}

            elif provider == "grok":
                resp = await client.get(
                    "https://api.x.ai/v1/models",
                    headers={"Authorization": f"Bearer {api_key}"},
                )
                if resp.status_code == 200:
                    return {"ok": True, "provider": provider, "message": "Connexion xAI OK — Grok Realtime disponible"}

            return {"ok": False, "error": f"HTTP {resp.status_code}: {resp.text[:100]}"}

    except Exception as e:
        return {"ok": False, "error": str(e)[:200]}


# ══════════════════════════════════════════════════════════════════════════════
# ElevenLabs Conversational AI (Direct WebSocket)
# ══════════════════════════════════════════════════════════════════════════════

ELEVENLABS_API = "https://api.elevenlabs.io/v1"
ELEVENLABS_CONVAI_API = "https://api.elevenlabs.io/v1/convai"


@router.get("/convai/config")
async def convai_config():
    """Return ElevenLabs ConvAI configuration status."""
    cfg = _get_voice_config("elevenlabs")
    has_key = bool(cfg.get("api_key"))
    has_agent = bool(cfg.get("agent_id"))
    return {
        "configured": has_key and has_agent,
        "has_api_key": has_key,
        "has_agent": has_agent,
        "agent_id": cfg.get("agent_id") if has_agent else None,
        "voice_id": cfg.get("voice_id"),
        "language": cfg.get("language", "fr"),
    }


@router.get("/convai/signed-url")
async def convai_signed_url():
    """Generate a signed WebSocket URL for ElevenLabs ConvAI."""
    cfg = _get_voice_config("elevenlabs")
    api_key = cfg.get("api_key")
    agent_id = cfg.get("agent_id")

    if not api_key:
        raise HTTPException(400, "Clé API ElevenLabs non configurée. Paramètres > Voice.")
    if not agent_id:
        raise HTTPException(400, "Agent ID non configuré. Créez un agent d'abord.")

    try:
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.get(
                f"{ELEVENLABS_CONVAI_API}/conversation/get_signed_url",
                params={"agent_id": agent_id},
                headers={"xi-api-key": api_key},
            )
            if resp.status_code == 200:
                data = resp.json()
                signed_url = data.get("signed_url")
                if signed_url:
                    logger.info(f"ConvAI signed URL generated for agent {agent_id[:8]}...")
                    return {"signed_url": signed_url, "agent_id": agent_id}
                raise HTTPException(500, "Réponse ElevenLabs invalide")
            elif resp.status_code == 401:
                raise HTTPException(401, "Clé API ElevenLabs invalide")
            elif resp.status_code == 404:
                raise HTTPException(404, "Agent ID introuvable — recréez l'agent")
            else:
                raise HTTPException(resp.status_code, f"Erreur ElevenLabs: {resp.text[:200]}")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, f"Erreur: {str(e)[:200]}")


@router.post("/convai/create-agent")
async def convai_create_agent():
    """Create an ElevenLabs ConvAI agent with Gungnir personality."""
    cfg = _get_voice_config("elevenlabs")
    api_key = cfg.get("api_key")
    voice_id = cfg.get("voice_id")
    language = cfg.get("language", "fr")
    agent_name = _get_agent_name()

    if not api_key:
        raise HTTPException(400, "Clé API ElevenLabs non configurée")

    agent_config = {
        "name": f"{agent_name} Voice",
        "conversation_config": {
            "agent": {
                "prompt": {
                    "prompt": (
                        f"Tu es {agent_name}, un assistant IA vocal intelligent. "
                        f"Tu parles en français naturellement. Tu es concis mais utile. "
                        f"Ne lis jamais de code brut — décris ce qu'il fait."
                    ),
                    "llm": "gemini-2.0-flash",
                    "temperature": 0.7,
                    "max_tokens": 400,
                },
                "first_message": f"Salut ! Je suis {agent_name}. Comment je peux t'aider ?",
                "language": language,
            },
            "tts": {
                "voice_id": voice_id or "JBFqnCBsd6RMkjVDRZzb",
                "model_id": "eleven_turbo_v2_5",
            },
        },
    }

    try:
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.post(
                f"{ELEVENLABS_CONVAI_API}/agents/create",
                json=agent_config,
                headers={"xi-api-key": api_key, "Content-Type": "application/json"},
            )
            if resp.status_code in (200, 201):
                data = resp.json()
                new_agent_id = data.get("agent_id")
                if not new_agent_id:
                    raise HTTPException(500, "Pas d'agent_id dans la réponse")

                # Save to config
                try:
                    from backend.core.config.settings import Settings
                    settings = Settings.load()
                    if "elevenlabs" in settings.voice:
                        settings.voice["elevenlabs"].agent_id = new_agent_id
                        settings.save()
                except Exception as e:
                    logger.warning(f"Agent created but save failed: {e}")

                logger.info(f"ConvAI agent created: {new_agent_id}")
                return {"ok": True, "agent_id": new_agent_id, "name": agent_config["name"]}

            elif resp.status_code == 401:
                raise HTTPException(401, "Clé API ElevenLabs invalide")
            else:
                raise HTTPException(resp.status_code, f"Erreur: {resp.text[:200]}")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, f"Erreur: {str(e)[:200]}")


@router.get("/convai/voices")
async def convai_list_voices():
    """List available ElevenLabs voices."""
    cfg = _get_voice_config("elevenlabs")
    api_key = cfg.get("api_key")
    if not api_key:
        raise HTTPException(400, "Clé API ElevenLabs non configurée")

    try:
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.get(f"{ELEVENLABS_API}/voices", headers={"xi-api-key": api_key})
            if resp.status_code == 200:
                data = resp.json()
                voices = [
                    {"voice_id": v["voice_id"], "name": v["name"],
                     "category": v.get("category", ""), "preview_url": v.get("preview_url", "")}
                    for v in data.get("voices", [])
                ]
                return {"voices": voices, "total": len(voices)}
            raise HTTPException(resp.status_code, resp.text[:200])
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, str(e)[:200])


# ══════════════════════════════════════════════════════════════════════════════
# OpenAI Realtime API (WebSocket Relay)
# ══════════════════════════════════════════════════════════════════════════════

@router.websocket("/openai/realtime")
async def openai_realtime_relay(websocket: WebSocket):
    """Relay WebSocket entre le frontend et l'API OpenAI Realtime.
    PCM16 24kHz bidirectionnel. VAD automatique côté OpenAI."""
    await websocket.accept()

    api_key = _get_voice_config("openai").get("api_key") or _get_llm_key("openai")
    if not api_key:
        await websocket.send_json({"type": "error", "error": "Clé API OpenAI non configurée"})
        await websocket.close()
        return

    agent_name = _get_agent_name()
    voice = "alloy"  # Default, could be configurable

    try:
        import websockets
    except ImportError:
        await websocket.send_json({"type": "error", "error": "pip install websockets requis"})
        await websocket.close()
        return

    try:
        async with websockets.connect(
            "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview",
            additional_headers={
                "Authorization": f"Bearer {api_key}",
                "OpenAI-Beta": "realtime=v1",
            },
        ) as oai_ws:
            logger.info("OpenAI Realtime relay started")

            # Configure session
            await oai_ws.send(json.dumps({
                "type": "session.update",
                "session": {
                    "modalities": ["text", "audio"],
                    "instructions": (
                        f"Tu es {agent_name}, un assistant vocal IA. "
                        f"Parle en français naturellement. Sois concis et utile. "
                        f"Ne lis jamais de code — décris ce qu'il fait."
                    ),
                    "voice": voice,
                    "input_audio_format": "pcm16",
                    "output_audio_format": "pcm16",
                    "input_audio_transcription": {"model": "whisper-1"},
                    "turn_detection": {"type": "server_vad", "threshold": 0.5},
                    "temperature": 0.7,
                    "max_response_output_tokens": 512,
                },
            }))

            # Notify frontend
            await websocket.send_json({"type": "session.ready", "provider": "openai", "voice": voice})

            async def relay_client_to_openai():
                try:
                    while True:
                        data = await websocket.receive_text()
                        await oai_ws.send(data)
                except (WebSocketDisconnect, Exception):
                    pass

            async def relay_openai_to_client():
                try:
                    async for message in oai_ws:
                        await websocket.send_text(message)
                except Exception:
                    pass

            await asyncio.gather(relay_client_to_openai(), relay_openai_to_client())

    except Exception as e:
        logger.error(f"OpenAI Realtime error: {e}")
        try:
            await websocket.send_json({"type": "error", "error": str(e)[:200]})
            await websocket.close()
        except Exception:
            pass


# ══════════════════════════════════════════════════════════════════════════════
# Google Gemini Live (Multimodal Live WebSocket)
# ══════════════════════════════════════════════════════════════════════════════

@router.websocket("/google/realtime")
async def google_realtime_relay(websocket: WebSocket):
    """Relay WebSocket pour Google Gemini Multimodal Live API.
    PCM16 16kHz in → 24kHz out. VAD automatique."""
    await websocket.accept()

    api_key = _get_voice_config("google").get("api_key") or _get_llm_key("google")
    if not api_key:
        await websocket.send_json({"type": "error", "error": "Clé API Google non configurée"})
        await websocket.close()
        return

    agent_name = _get_agent_name()
    gemini_ws_url = (
        f"wss://generativelanguage.googleapis.com/ws/"
        f"google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent"
        f"?key={api_key}"
    )

    try:
        import websockets
    except ImportError:
        await websocket.send_json({"type": "error", "error": "pip install websockets requis"})
        await websocket.close()
        return

    try:
        async with websockets.connect(gemini_ws_url) as gemini_ws:
            logger.info("Gemini Live relay started")

            # Send setup message
            setup = {
                "setup": {
                    "model": "models/gemini-2.0-flash-live-001",
                    "generationConfig": {
                        "temperature": 0.7,
                        "responseModalities": ["AUDIO"],
                    },
                    "systemInstruction": {
                        "parts": [{
                            "text": (
                                f"Tu es {agent_name}, un assistant vocal IA. "
                                f"Parle en français naturellement. Sois concis et utile. "
                                f"Ne lis jamais de code — décris ce qu'il fait."
                            )
                        }]
                    },
                    "realtimeInputConfig": {
                        "automaticActivityDetection": {
                            "disabled": False,
                            "startOfSpeechSensitivity": "START_SENSITIVITY_HIGH",
                            "endOfSpeechSensitivity": "END_SENSITIVITY_HIGH",
                            "prefixPaddingMs": 20,
                            "silenceDurationMs": 500,
                        },
                        "activityHandling": "START_OF_ACTIVITY_INTERRUPTS",
                    },
                    "inputAudioTranscription": {},
                    "outputAudioTranscription": {},
                },
            }
            await gemini_ws.send(json.dumps(setup))

            # Wait for setupComplete
            setup_resp = await asyncio.wait_for(gemini_ws.recv(), timeout=10)
            setup_data = json.loads(setup_resp)
            if "setupComplete" not in setup_data:
                await websocket.send_json({"type": "error", "error": f"Setup failed: {setup_resp[:200]}"})
                await websocket.close()
                return

            await websocket.send_json({"type": "session.ready", "provider": "google"})

            async def relay_client_to_gemini():
                """Receive audio from frontend, forward as realtimeInput to Gemini."""
                try:
                    while True:
                        data = await websocket.receive_text()
                        msg = json.loads(data)
                        # Frontend sends: {type: "audio", data: base64}
                        if msg.get("type") == "audio" and msg.get("data"):
                            gemini_msg = {
                                "realtimeInput": {
                                    "audio": {
                                        "data": msg["data"],
                                        "mimeType": "audio/pcm;rate=16000",
                                    }
                                }
                            }
                            await gemini_ws.send(json.dumps(gemini_msg))
                        elif msg.get("type") == "text" and msg.get("text"):
                            gemini_msg = {
                                "clientContent": {
                                    "turns": [{"role": "user", "parts": [{"text": msg["text"]}]}],
                                    "turnComplete": True,
                                }
                            }
                            await gemini_ws.send(json.dumps(gemini_msg))
                except (WebSocketDisconnect, Exception):
                    pass

            async def relay_gemini_to_client():
                """Receive from Gemini, normalize events for frontend."""
                try:
                    async for message in gemini_ws:
                        data = json.loads(message)
                        server_content = data.get("serverContent", {})

                        # Audio output
                        model_turn = server_content.get("modelTurn", {})
                        if model_turn:
                            for part in model_turn.get("parts", []):
                                if "inlineData" in part:
                                    inline = part["inlineData"]
                                    await websocket.send_json({
                                        "type": "audio",
                                        "data": inline.get("data", ""),
                                        "mime": inline.get("mimeType", "audio/pcm"),
                                    })
                                elif "text" in part:
                                    await websocket.send_json({
                                        "type": "transcript",
                                        "role": "assistant",
                                        "text": part["text"],
                                    })

                        # Turn complete
                        if server_content.get("turnComplete"):
                            await websocket.send_json({"type": "turn_complete"})

                        # Interrupted
                        if server_content.get("interrupted"):
                            await websocket.send_json({"type": "interruption"})

                        # Input transcription
                        input_tx = server_content.get("inputTranscription", {})
                        if input_tx.get("text"):
                            await websocket.send_json({
                                "type": "transcript",
                                "role": "user",
                                "text": input_tx["text"],
                            })

                        # Output transcription
                        output_tx = server_content.get("outputTranscription", {})
                        if output_tx.get("text"):
                            await websocket.send_json({
                                "type": "transcript",
                                "role": "assistant",
                                "text": output_tx["text"],
                            })

                except Exception:
                    pass

            await asyncio.gather(relay_client_to_gemini(), relay_gemini_to_client())

    except Exception as e:
        logger.error(f"Gemini Live error: {e}")
        try:
            await websocket.send_json({"type": "error", "error": str(e)[:200]})
            await websocket.close()
        except Exception:
            pass


# ══════════════════════════════════════════════════════════════════════════════
# xAI Grok Realtime (OpenAI-compatible WebSocket)
# ══════════════════════════════════════════════════════════════════════════════

@router.websocket("/grok/realtime")
async def grok_realtime_relay(websocket: WebSocket):
    """Relay WebSocket pour xAI Grok Realtime API.
    Protocole OpenAI-compatible. PCM16 24kHz."""
    await websocket.accept()

    api_key = _get_llm_key("xai")
    if not api_key:
        await websocket.send_json({"type": "error", "error": "Clé API xAI non configurée"})
        await websocket.close()
        return

    agent_name = _get_agent_name()

    try:
        import websockets
    except ImportError:
        await websocket.send_json({"type": "error", "error": "pip install websockets requis"})
        await websocket.close()
        return

    try:
        async with websockets.connect(
            "wss://api.x.ai/v1/realtime",
            additional_headers={"Authorization": f"Bearer {api_key}"},
        ) as grok_ws:
            logger.info("Grok Realtime relay started")

            # Configure session (OpenAI-compatible protocol)
            await grok_ws.send(json.dumps({
                "type": "session.update",
                "session": {
                    "modalities": ["text", "audio"],
                    "instructions": (
                        f"Tu es {agent_name}, un assistant vocal IA. "
                        f"Parle en français naturellement. Sois concis et utile."
                    ),
                    "voice": "alloy",
                    "input_audio_format": "pcm16",
                    "output_audio_format": "pcm16",
                    "turn_detection": {"type": "server_vad"},
                    "temperature": 0.7,
                },
            }))

            await websocket.send_json({"type": "session.ready", "provider": "grok"})

            async def relay_client_to_grok():
                try:
                    while True:
                        data = await websocket.receive_text()
                        await grok_ws.send(data)
                except (WebSocketDisconnect, Exception):
                    pass

            async def relay_grok_to_client():
                try:
                    async for message in grok_ws:
                        await websocket.send_text(message)
                except Exception:
                    pass

            await asyncio.gather(relay_client_to_grok(), relay_grok_to_client())

    except Exception as e:
        logger.error(f"Grok Realtime error: {e}")
        try:
            await websocket.send_json({"type": "error", "error": str(e)[:200]})
            await websocket.close()
        except Exception:
            pass


# ══════════════════════════════════════════════════════════════════════════════
# Custom Voice Providers — CRUD + Generic WebSocket Relay
# ══════════════════════════════════════════════════════════════════════════════

PROTOCOL_PRESETS = {
    "openai_compatible": {
        "description": "Protocole OpenAI Realtime (fonctionne avec tout provider compatible)",
        "ws_url": "wss://CHANGE_ME/v1/realtime",
        "auth_method": "header",
        "auth_header_name": "Authorization",
        "auth_header_prefix": "Bearer ",
        "sample_rate_in": 24000,
        "sample_rate_out": 24000,
        "send_audio_wrapper": '{"type":"input_audio_buffer.append","audio":"{audio}"}',
        "recv_audio_path": "delta",
        "recv_transcript_path": "transcript",
        "setup_message": json.dumps({
            "type": "session.update",
            "session": {
                "modalities": ["text", "audio"],
                "instructions": "Tu es {agent_name}, un assistant vocal IA. Parle en français.",
                "voice": "alloy",
                "input_audio_format": "pcm16",
                "output_audio_format": "pcm16",
                "turn_detection": {"type": "server_vad"},
                "temperature": 0.7,
            },
        }),
    },
    "generic": {
        "description": "Protocole générique — configurable manuellement",
        "ws_url": "wss://CHANGE_ME",
        "auth_method": "header",
        "sample_rate_in": 16000,
        "sample_rate_out": 16000,
        "send_audio_wrapper": '{"type":"audio","data":"{audio}"}',
        "recv_audio_path": "audio.data",
    },
}


@router.get("/custom-providers")
async def list_custom_providers():
    """List all custom voice providers."""
    providers = _load_custom_providers()
    # Mask API keys
    safe = []
    for p in providers:
        cp = {**p}
        if cp.get("api_key"):
            cp["api_key"] = "***"
        safe.append(cp)
    return {"providers": safe, "presets": PROTOCOL_PRESETS}


@router.get("/custom-providers/{provider_id}")
async def get_custom_provider(provider_id: str):
    for p in _load_custom_providers():
        if p["id"] == provider_id:
            safe = {**p}
            if safe.get("api_key"):
                safe["api_key"] = "***"
            return safe
    raise HTTPException(404, f"Provider custom '{provider_id}' non trouvé")


@router.post("/custom-providers")
async def create_custom_provider(config: CustomVoiceProviderConfig):
    """Create or update a custom voice provider."""
    providers = _load_custom_providers()

    # Validate unique ID doesn't clash with built-in
    if config.id in PROVIDER_INFO:
        raise HTTPException(400, f"'{config.id}' est un provider intégré — choisissez un autre ID")

    # Update if exists, create otherwise
    existing_idx = next((i for i, p in enumerate(providers) if p["id"] == config.id), None)
    new_data = config.model_dump()

    if existing_idx is not None:
        # Preserve API key if masked
        if not new_data.get("api_key") or new_data["api_key"] == "***":
            new_data["api_key"] = providers[existing_idx].get("api_key")
        providers[existing_idx] = new_data
    else:
        providers.append(new_data)

    _save_custom_providers(providers)
    logger.info(f"Custom voice provider saved: {config.id}")
    return {"ok": True, "provider": config.id}


@router.delete("/custom-providers/{provider_id}")
async def delete_custom_provider(provider_id: str):
    providers = _load_custom_providers()
    before = len(providers)
    providers = [p for p in providers if p["id"] != provider_id]
    if len(providers) == before:
        raise HTTPException(404, f"Provider custom '{provider_id}' non trouvé")
    _save_custom_providers(providers)
    return {"ok": True, "deleted": provider_id}


@router.get("/custom-providers/presets")
async def get_protocol_presets():
    """Return available protocol presets to help users configure new providers."""
    return {"presets": PROTOCOL_PRESETS}


@router.websocket("/custom/{provider_id}/realtime")
async def custom_realtime_relay(websocket: WebSocket, provider_id: str):
    """Generic WebSocket relay for any custom voice provider.
    Uses the provider's config to build WS URL, auth, audio message format."""
    await websocket.accept()

    # Load provider config
    providers = _load_custom_providers()
    cp = next((p for p in providers if p["id"] == provider_id), None)
    if not cp:
        await websocket.send_json({"type": "error", "error": f"Provider custom '{provider_id}' non trouvé"})
        await websocket.close()
        return

    api_key = cp.get("api_key", "")
    if not api_key:
        await websocket.send_json({"type": "error", "error": f"Clé API non configurée pour {cp.get('display_name', provider_id)}"})
        await websocket.close()
        return

    agent_name = _get_agent_name()

    try:
        import websockets
    except ImportError:
        await websocket.send_json({"type": "error", "error": "pip install websockets requis"})
        await websocket.close()
        return

    # Build connection URL
    ws_url = cp["ws_url"].replace("{api_key}", api_key)

    # Build auth headers
    extra_headers = {}
    if cp.get("auth_method") == "header":
        header_name = cp.get("auth_header_name", "Authorization")
        prefix = cp.get("auth_header_prefix", "Bearer ")
        extra_headers[header_name] = f"{prefix}{api_key}"
    elif cp.get("auth_method") == "query":
        param = cp.get("auth_query_param", "key")
        separator = "&" if "?" in ws_url else "?"
        ws_url = f"{ws_url}{separator}{param}={api_key}"

    try:
        async with websockets.connect(ws_url, additional_headers=extra_headers if extra_headers else None) as remote_ws:
            logger.info(f"Custom relay started: {provider_id}")

            # Send setup message if configured
            setup_msg = cp.get("setup_message", "")
            if setup_msg:
                setup_msg = setup_msg.replace("{api_key}", api_key).replace("{agent_name}", agent_name)
                await remote_ws.send(setup_msg)

                # Wait for first response (setup ack)
                try:
                    resp = await asyncio.wait_for(remote_ws.recv(), timeout=10)
                    logger.debug(f"Custom {provider_id} setup response: {str(resp)[:100]}")
                except asyncio.TimeoutError:
                    logger.warning(f"Custom {provider_id}: no setup response (continuing)")

            await websocket.send_json({"type": "session.ready", "provider": provider_id})

            # Template for sending audio
            send_template = cp.get("send_audio_wrapper", '{"type":"audio","data":"{audio}"}')
            recv_audio_path = cp.get("recv_audio_path", "")
            recv_transcript_path = cp.get("recv_transcript_path", "")
            recv_transcript_role_path = cp.get("recv_transcript_role_path", "")
            protocol = cp.get("protocol_type", "generic")
            ping_type = cp.get("ping_type", "")
            pong_response = cp.get("pong_response", "")

            async def relay_client_to_remote():
                try:
                    while True:
                        data = await websocket.receive_text()
                        msg = json.loads(data)

                        if msg.get("type") == "audio" and msg.get("data"):
                            if protocol == "openai_compatible":
                                # Forward as-is (OpenAI protocol)
                                await remote_ws.send(json.dumps({
                                    "type": "input_audio_buffer.append",
                                    "audio": msg["data"],
                                }))
                            else:
                                # Use template
                                payload = send_template.replace("{audio}", msg["data"])
                                await remote_ws.send(payload)
                        elif msg.get("type") == "text" and msg.get("text"):
                            # Text message — send as conversation turn
                            await remote_ws.send(json.dumps({
                                "type": "conversation.item.create",
                                "item": {
                                    "type": "message",
                                    "role": "user",
                                    "content": [{"type": "input_text", "text": msg["text"]}],
                                },
                            }))
                        else:
                            # Forward raw
                            await remote_ws.send(data)
                except (WebSocketDisconnect, Exception):
                    pass

            async def relay_remote_to_client():
                try:
                    async for message in remote_ws:
                        if isinstance(message, bytes):
                            # Binary frame → treat as raw audio
                            import base64
                            b64 = base64.b64encode(message).decode()
                            await websocket.send_json({"type": "audio", "data": b64})
                            continue

                        try:
                            data = json.loads(message)
                        except json.JSONDecodeError:
                            continue

                        # Handle ping/pong
                        if ping_type and data.get("type") == ping_type and pong_response:
                            await remote_ws.send(pong_response)
                            continue

                        if protocol == "openai_compatible":
                            # Forward OpenAI-style events to frontend
                            await websocket.send_text(message)
                        else:
                            # Generic: extract audio and transcript using dot-paths
                            audio_b64 = _get_nested(data, recv_audio_path) if recv_audio_path else None
                            if audio_b64 and isinstance(audio_b64, str):
                                await websocket.send_json({"type": "audio", "data": audio_b64})

                            transcript = _get_nested(data, recv_transcript_path) if recv_transcript_path else None
                            if transcript and isinstance(transcript, str):
                                role = _get_nested(data, recv_transcript_role_path) if recv_transcript_role_path else "assistant"
                                await websocket.send_json({"type": "transcript", "role": role or "assistant", "text": transcript})

                            # Forward raw for debugging
                            if not audio_b64 and not transcript:
                                await websocket.send_text(message)

                except Exception as e:
                    logger.debug(f"Custom relay recv error: {e}")

            await asyncio.gather(relay_client_to_remote(), relay_remote_to_client())

    except Exception as e:
        logger.error(f"Custom relay error ({provider_id}): {e}")
        try:
            await websocket.send_json({"type": "error", "error": str(e)[:200]})
            await websocket.close()
        except Exception:
            pass


# ══════════════════════════════════════════════════════════════════════════════
# Voice Session History
# ══════════════════════════════════════════════════════════════════════════════

@router.post("/sessions")
async def save_session(data: dict):
    """Save a voice session transcript."""
    sessions = _load_sessions()
    session = {
        "id": str(uuid.uuid4())[:8],
        "provider": data.get("provider", "elevenlabs"),
        "messages": data.get("messages", []),
        "duration_seconds": data.get("duration_seconds", 0),
        "created_at": datetime.now().isoformat(),
        "title": data.get("title", "Session vocale"),
    }
    sessions.insert(0, session)
    if len(sessions) > 50:
        sessions = sessions[:50]
    _save_sessions(sessions)
    return {"ok": True, "session": session}


@router.get("/sessions")
async def list_sessions():
    return {"sessions": _load_sessions()}


@router.get("/sessions/{session_id}")
async def get_session(session_id: str):
    for s in _load_sessions():
        if s.get("id") == session_id:
            return s
    raise HTTPException(404, "Session introuvable")


@router.delete("/sessions/{session_id}")
async def delete_session(session_id: str):
    sessions = [s for s in _load_sessions() if s.get("id") != session_id]
    _save_sessions(sessions)
    return {"ok": True}


@router.delete("/sessions")
async def clear_sessions():
    _save_sessions([])
    return {"ok": True}
