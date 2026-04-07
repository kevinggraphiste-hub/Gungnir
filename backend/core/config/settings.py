"""
Gungnir — Configuration centrale
"""
import json
import os
import base64
import hashlib
import platform
from pathlib import Path
from typing import Optional
from pydantic import BaseModel, Field
from pydantic_settings import BaseSettings

BASE_DIR = Path(__file__).parent.parent.parent.parent  # Gungnir/
DATA_DIR = BASE_DIR / "data"
DATA_DIR.mkdir(exist_ok=True)
PLUGINS_DIR = BASE_DIR / "backend" / "plugins"

# ── API Key encryption (at rest) ──────────────────────────────────────────────
# Derives a machine-specific key from hostname + install path for obfuscation.
# Not crypto-grade (no hardware security module) but prevents plaintext leaks.
_ENCRYPTION_SALT = b"gungnir-scarletwolf-2026"

def _derive_key() -> bytes:
    """Derive a 32-byte key from machine identity."""
    identity = f"{platform.node()}:{BASE_DIR}".encode()
    return hashlib.pbkdf2_hmac("sha256", identity, _ENCRYPTION_SALT, 100_000)

def encrypt_value(plaintext: str) -> str:
    """Encrypt a string value. Returns 'enc:base64data'."""
    if not plaintext or plaintext.startswith("enc:"):
        return plaintext
    key = _derive_key()
    # XOR-based stream cipher with key stretching
    data = plaintext.encode("utf-8")
    encrypted = bytes(b ^ key[i % len(key)] for i, b in enumerate(data))
    return "enc:" + base64.b64encode(encrypted).decode()

def decrypt_value(encrypted: str) -> str:
    """Decrypt a value. If not encrypted (no 'enc:' prefix), return as-is."""
    if not encrypted or not encrypted.startswith("enc:"):
        return encrypted or ""
    key = _derive_key()
    data = base64.b64decode(encrypted[4:])
    decrypted = bytes(b ^ key[i % len(key)] for i, b in enumerate(data))
    return decrypted.decode("utf-8")


class ProviderConfig(BaseModel):
    enabled: bool = False
    api_key: Optional[str] = None
    base_url: Optional[str] = None
    default_model: Optional[str] = None
    models: list[str] = Field(default_factory=list)


class VoiceConfig(BaseModel):
    enabled: bool = False
    provider: str = "elevenlabs"
    api_key: Optional[str] = None
    voice_id: Optional[str] = None
    agent_id: Optional[str] = None
    language: str = "fr"


class ServiceConfig(BaseModel):
    """Configuration d'un service externe (DB, storage, RAG, communication, automation)."""
    enabled: bool = False
    api_key: Optional[str] = None
    base_url: Optional[str] = None
    project_id: Optional[str] = None      # Supabase project, Firebase project, etc.
    region: Optional[str] = None           # AWS region, etc.
    bucket: Optional[str] = None           # S3 bucket, MinIO bucket
    database: Optional[str] = None         # DB name, collection
    token: Optional[str] = None            # OAuth token, bot token (Slack, Discord)
    webhook_url: Optional[str] = None      # Webhook/notification URL
    namespace: Optional[str] = None        # Pinecone namespace, Qdrant collection
    extra: dict[str, str] = Field(default_factory=dict)  # Champs custom par service


class MCPServerConfig(BaseModel):
    name: str
    command: str                          # e.g. "npx"
    args: list[str] = Field(default_factory=list)  # e.g. ["-y", "@n8n/n8n-mcp-server"]
    env: dict[str, str] = Field(default_factory=dict)  # e.g. {"N8N_HOST": "http://localhost:5678", "N8N_API_KEY": "..."}
    enabled: bool = True


class AppSettings(BaseModel):
    language: str = "fr"
    theme: str = "dark-scarlet"
    agent_name: str = "Gungnir"
    workspace_dir: str = str(DATA_DIR / "workspace")
    auto_update: bool = False
    update_channel: str = "stable"


class Settings(BaseSettings):
    app: AppSettings = Field(default_factory=AppSettings)
    providers: dict[str, ProviderConfig] = Field(default_factory=lambda: {
        "openrouter": ProviderConfig(
            default_model="minimax/minimax-m2.7",
            models=[
                "anthropic/claude-sonnet-4.6",
                "anthropic/claude-opus-4.6",
                "google/gemini-2.5-flash",
                "google/gemini-2.5-pro",
                "openai/gpt-4.1",
                "openai/gpt-4.1-mini",
                "openai/o4-mini",
                "minimax/minimax-m2.7",
                "deepseek/deepseek-chat",
                "deepseek/deepseek-r1",
                "meta-llama/llama-4-maverick",
                "qwen/qwen3-235b-a22b",
                "x-ai/grok-3-beta",
                "mistralai/mistral-large",
            ]
        ),
        "anthropic": ProviderConfig(
            default_model="claude-sonnet-4-6",
            models=["claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5-20251001", "claude-3-5-sonnet-20241022"]
        ),
        "google": ProviderConfig(
            default_model="gemini-2.5-flash-preview",
            models=["gemini-2.5-flash-preview", "gemini-2.5-pro-preview", "gemini-2.0-flash-exp"]
        ),
        "openai": ProviderConfig(
            default_model="gpt-4.1",
            models=["gpt-4.1", "gpt-4.1-mini", "gpt-4.1-nano", "o4-mini", "gpt-4o"]
        ),
        "minimax": ProviderConfig(
            base_url="https://api.minimax.chat/v1",
            default_model="minimax-m2.7",
            models=["minimax-m2.7", "minimax-m2.5"]
        ),
        "ollama": ProviderConfig(
            base_url="http://localhost:11434/v1",
            models=[]
        ),
    })
    voice: dict[str, VoiceConfig] = Field(default_factory=lambda: {
        "elevenlabs": VoiceConfig(),
        "openai": VoiceConfig(),
        "google": VoiceConfig(),
        "grok": VoiceConfig(provider="grok"),
    })
    services: dict[str, ServiceConfig] = Field(default_factory=lambda: {
        "supabase": ServiceConfig(
            base_url="https://your-project.supabase.co",
        ),
        "postgresql": ServiceConfig(
            base_url="postgresql://localhost:5432",
            database="gungnir",
        ),
        "s3": ServiceConfig(
            base_url="https://s3.amazonaws.com",
            region="eu-west-1",
        ),
        "github": ServiceConfig(
            base_url="https://api.github.com",
        ),
        "notion": ServiceConfig(
            base_url="https://api.notion.com/v1",
        ),
        "google_drive": ServiceConfig(
            base_url="https://www.googleapis.com/drive/v3",
        ),
        "pinecone": ServiceConfig(
            base_url="https://api.pinecone.io",
        ),
        "qdrant": ServiceConfig(
            base_url="http://localhost:6333",
        ),
        "slack": ServiceConfig(),
        "discord": ServiceConfig(),
        "n8n": ServiceConfig(
            base_url="http://localhost:5678",
        ),
        "redis": ServiceConfig(
            base_url="redis://localhost:6379",
        ),
    })
    mcp_servers: list[MCPServerConfig] = Field(default_factory=list)

    _config_path: Path = DATA_DIR / "config.json"

    def save(self):
        data = self.model_dump()
        # Encrypt API keys before writing to disk
        for pname, pconf in data.get("providers", {}).items():
            if pconf.get("api_key") and not pconf["api_key"].startswith("enc:"):
                pconf["api_key"] = encrypt_value(pconf["api_key"])
        # Encrypt service tokens/keys
        for sname, sconf in data.get("services", {}).items():
            for field in ("api_key", "token"):
                if sconf.get(field) and not sconf[field].startswith("enc:"):
                    sconf[field] = encrypt_value(sconf[field])
        # Encrypt MCP env secrets
        for mcp in data.get("mcp_servers", []):
            for ekey, evalue in mcp.get("env", {}).items():
                if ("key" in ekey.lower() or "token" in ekey.lower() or "secret" in ekey.lower()):
                    if evalue and not evalue.startswith("enc:"):
                        mcp["env"][ekey] = encrypt_value(evalue)
        self._config_path.write_text(json.dumps(data, indent=2, ensure_ascii=False))

    @classmethod
    def load(cls) -> "Settings":
        config_path = DATA_DIR / "config.json"
        if config_path.exists():
            data = json.loads(config_path.read_text())
            # Decrypt API keys transparently on load
            for pname, pconf in data.get("providers", {}).items():
                if isinstance(pconf, dict) and (pconf.get("api_key") or "").startswith("enc:"):
                    pconf["api_key"] = decrypt_value(pconf["api_key"])
            for sname, sconf in data.get("services", {}).items():
                if isinstance(sconf, dict):
                    for field in ("api_key", "token"):
                        if (sconf.get(field) or "").startswith("enc:"):
                            sconf[field] = decrypt_value(sconf[field])
            for mcp in data.get("mcp_servers", []):
                if isinstance(mcp, dict):
                    for ekey, evalue in mcp.get("env", {}).items():
                        if isinstance(evalue, str) and evalue.startswith("enc:"):
                            mcp["env"][ekey] = decrypt_value(evalue)
            return cls(**data)
        return cls()

    @property
    def is_configured(self) -> bool:
        return any(
            p.enabled and p.api_key
            for p in self.providers.values()
        )
