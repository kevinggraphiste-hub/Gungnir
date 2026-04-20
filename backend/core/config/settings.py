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
# Uses GUNGNIR_SECRET_KEY env var if set (stable across Docker rebuilds),
# otherwise falls back to machine identity (hostname + path).
# Set GUNGNIR_SECRET_KEY once in docker-compose.yml or .env and never change it.
_ENCRYPTION_SALT = b"gungnir-scarletwolf-2026"

def _derive_key() -> bytes:
    """Derive a 32-byte encryption key. Prefers GUNGNIR_SECRET_KEY env var for stability."""
    secret = os.getenv("GUNGNIR_SECRET_KEY", "")
    if secret:
        identity = secret.encode()
    else:
        import logging
        logging.getLogger("gungnir").warning(
            "GUNGNIR_SECRET_KEY not set — using fallback key derived from hostname. "
            "Set this env var in production for proper encryption!"
        )
        identity = f"{platform.node()}:{BASE_DIR}".encode()
    return hashlib.pbkdf2_hmac("sha256", identity, _ENCRYPTION_SALT, 100_000)

from cryptography.fernet import Fernet, InvalidToken

def _get_fernet() -> Fernet:
    key = _derive_key()
    # Fernet needs a 32-byte url-safe base64 key
    fernet_key = base64.urlsafe_b64encode(hashlib.sha256(key).digest())
    return Fernet(fernet_key)

def encrypt_value(value: str) -> str:
    """Encrypt a string value using Fernet (AES-128-CBC + HMAC)."""
    if not value or value.startswith("FERNET:"):
        return value
    token = _get_fernet().encrypt(value.encode())
    return "FERNET:" + token.decode()

def decrypt_value(value: str) -> str:
    """Decrypt a Fernet-encrypted value. Handles legacy XOR values too."""
    if not value:
        return value
    if value.startswith("FERNET:"):
        try:
            return _get_fernet().decrypt(value[7:].encode()).decode()
        except (InvalidToken, Exception):
            return ""
    if value.startswith("enc:"):
        # Legacy XOR — decrypt then re-encrypt on next save
        try:
            key = _derive_key()
            data = base64.b64decode(value[4:])
            decrypted = bytes(b ^ key[i % len(key)] for i, b in enumerate(data))
            return decrypted.decode("utf-8")
        except Exception:
            return ""
    return value


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
    active_provider: str = "openrouter"
    active_model: str = "mistralai/mistral-large"


class Settings(BaseSettings):
    app: AppSettings = Field(default_factory=AppSettings)
    providers: dict[str, ProviderConfig] = Field(default_factory=lambda: {
        "openrouter": ProviderConfig(
            default_model="mistralai/mistral-large",
            models=[
                "anthropic/claude-sonnet-4.6",
                "anthropic/claude-opus-4.6",
                "google/gemini-2.5-flash",
                "google/gemini-2.5-pro",
                "openai/gpt-4.1",
                "openai/gpt-4.1-mini",
                "openai/o4-mini",
                "mistralai/mistral-large",
                "mistralai/mistral-small",
                "mistralai/codestral",
                "x-ai/grok-3-beta",
                "x-ai/grok-3-mini-beta",
                "deepseek/deepseek-chat",
                "deepseek/deepseek-r1",
                "meta-llama/llama-4-maverick",
                "qwen/qwen3-235b-a22b",
                "minimax/minimax-m2.7",
            ]
        ),
        "anthropic": ProviderConfig(
            default_model="claude-sonnet-4-6",
            models=["claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5-20251001", "claude-3-5-sonnet-20241022"]
        ),
        "google": ProviderConfig(
            default_model="gemini-2.5-flash-preview",
            models=["gemini-2.5-flash-preview", "gemini-2.5-pro-preview", "gemini-2.0-flash-exp", "gemma-4-31b-it", "gemma-4-26b-a4b-it", "gemma-4-e4b-it"]
        ),
        "openai": ProviderConfig(
            default_model="gpt-4.1",
            models=["gpt-4.1", "gpt-4.1-mini", "gpt-4.1-nano", "o4-mini", "gpt-4o"]
        ),
        "mistral": ProviderConfig(
            default_model="mistral-large-latest",
            models=["mistral-large-latest", "mistral-small-latest", "mistral-medium-latest", "codestral-latest"]
        ),
        "xai": ProviderConfig(
            default_model="grok-3-beta",
            models=["grok-3-beta", "grok-3-mini-beta"]
        ),
        "minimax": ProviderConfig(
            base_url="https://api.minimax.chat/v1",
            default_model="minimax-m2.7",
            models=["minimax-m2.7", "minimax-m2.5"]
        ),
        # Ollama: default base_url works for local dev (non-Docker). For Docker
        # production, the user must override this in settings — see the
        # cheatsheet at the top of backend/core/providers/ollama_provider.py.
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
        # Base de données
        "supabase": ServiceConfig(base_url="https://your-project.supabase.co"),
        "postgresql": ServiceConfig(base_url="postgresql://localhost:5432", database="gungnir"),
        "mysql": ServiceConfig(base_url="mysql://localhost:3306"),
        "mongodb": ServiceConfig(base_url="mongodb://localhost:27017"),
        "redis": ServiceConfig(base_url="redis://localhost:6379"),
        "sqlite": ServiceConfig(base_url="sqlite:///data/external.db"),
        # Stockage
        "s3": ServiceConfig(base_url="https://s3.amazonaws.com", region="eu-west-1"),
        "google_drive": ServiceConfig(base_url="https://www.googleapis.com/drive/v3"),
        "dropbox": ServiceConfig(base_url="https://api.dropboxapi.com/2"),
        "azure_blob": ServiceConfig(base_url="https://your-account.blob.core.windows.net"),
        "ftp": ServiceConfig(base_url="sftp://your-server:22"),
        # RAG / Vectoriel
        "qdrant": ServiceConfig(base_url="http://localhost:6333"),
        "pinecone": ServiceConfig(base_url="https://api.pinecone.io"),
        "weaviate": ServiceConfig(base_url="http://localhost:8080"),
        "chromadb": ServiceConfig(base_url="http://localhost:8000"),
        "milvus": ServiceConfig(base_url="http://localhost:19530"),
        "elasticsearch": ServiceConfig(base_url="http://localhost:9200"),
        # Développement
        "github": ServiceConfig(base_url="https://api.github.com"),
        "gitlab": ServiceConfig(base_url="https://gitlab.com/api/v4"),
        "notion": ServiceConfig(base_url="https://api.notion.com/v1"),
        "jira": ServiceConfig(base_url="https://your-domain.atlassian.net"),
        "linear": ServiceConfig(base_url="https://api.linear.app"),
        "confluence": ServiceConfig(base_url="https://your-domain.atlassian.net/wiki"),
        # Communication
        "slack": ServiceConfig(),
        "discord": ServiceConfig(),
        "telegram": ServiceConfig(base_url="https://api.telegram.org"),
        "email_smtp": ServiceConfig(base_url="smtp://smtp.gmail.com:587"),
        "teams": ServiceConfig(base_url="https://graph.microsoft.com/v1.0"),
        "whatsapp": ServiceConfig(base_url="https://graph.facebook.com/v18.0"),
        # Automatisation
        "n8n": ServiceConfig(base_url="http://localhost:5678"),
        "make": ServiceConfig(base_url="https://hook.eu1.make.com"),
        "zapier": ServiceConfig(base_url="https://hooks.zapier.com"),
        "activepieces": ServiceConfig(base_url="http://localhost:8080"),
        # Monitoring
        "sentry": ServiceConfig(base_url="https://sentry.io/api/0"),
        "grafana": ServiceConfig(base_url="http://localhost:3000"),
        "posthog": ServiceConfig(base_url="https://app.posthog.com"),
        # IA / APIs externes
        "huggingface": ServiceConfig(base_url="https://api-inference.huggingface.co"),
        "replicate": ServiceConfig(base_url="https://api.replicate.com/v1"),
        "stability": ServiceConfig(base_url="https://api.stability.ai/v2beta"),
        # Recherche web (HuntR) — chaque utilisateur doit fournir SA PROPRE clé
        # dans user_settings.service_keys ; ces entrées sont juste les base_url
        # par défaut pour que le service apparaisse dans Paramètres → Services.
        "tavily":   ServiceConfig(base_url="https://api.tavily.com"),
        "brave":    ServiceConfig(base_url="https://api.search.brave.com/res/v1"),
        "exa":      ServiceConfig(base_url="https://api.exa.ai"),
        "serper":   ServiceConfig(base_url="https://google.serper.dev"),
        "serpapi":  ServiceConfig(base_url="https://serpapi.com"),
        "kagi":     ServiceConfig(base_url="https://kagi.com/api/v0"),
        "bing":     ServiceConfig(base_url="https://api.bing.microsoft.com/v7.0"),
        "searxng":  ServiceConfig(base_url="http://localhost:8080"),
    })
    # Legacy field — MCP servers are now stored per-user in the `mcp_server_configs`
    # DB table. Kept for the one-shot migration in main.py lifespan; no code path
    # writes to it after the initial boot that migrates the data to user #1.
    mcp_servers: list[MCPServerConfig] = Field(default_factory=list)

    _config_path: Path = DATA_DIR / "config.json"

    def save(self):
        data = self.model_dump()
        # Strip whitespace from API keys before saving
        for pname, pconf in data.get("providers", {}).items():
            if pconf.get("api_key"):
                pconf["api_key"] = pconf["api_key"].strip()
        for sname, sconf in data.get("services", {}).items():
            for field in ("api_key", "token"):
                if sconf.get(field):
                    sconf[field] = sconf[field].strip()
        # Encrypt API keys before writing to disk
        for pname, pconf in data.get("providers", {}).items():
            if pconf.get("api_key") and not pconf["api_key"].startswith(("FERNET:", "enc:")):
                pconf["api_key"] = encrypt_value(pconf["api_key"])
        # Encrypt service tokens/keys
        for sname, sconf in data.get("services", {}).items():
            for field in ("api_key", "token"):
                if sconf.get(field) and not sconf[field].startswith(("FERNET:", "enc:")):
                    sconf[field] = encrypt_value(sconf[field])
        # Encrypt voice API keys
        if "voice" in data:
            for vname, vconf in data["voice"].items():
                if isinstance(vconf, dict) and vconf.get("api_key") and not vconf["api_key"].startswith(("FERNET:", "enc:")):
                    vconf["api_key"] = encrypt_value(vconf["api_key"])
        # Encrypt MCP env secrets
        for mcp in data.get("mcp_servers", []):
            for ekey, evalue in mcp.get("env", {}).items():
                if ("key" in ekey.lower() or "token" in ekey.lower() or "secret" in ekey.lower()):
                    if evalue and not evalue.startswith(("FERNET:", "enc:")):
                        mcp["env"][ekey] = encrypt_value(evalue)
        self._config_path.write_text(json.dumps(data, indent=2, ensure_ascii=False))

    @classmethod
    def load(cls) -> "Settings":
        config_path = DATA_DIR / "config.json"
        if config_path.exists():
            data = json.loads(config_path.read_text())
            # Decrypt API keys transparently on load + strip whitespace
            for pname, pconf in data.get("providers", {}).items():
                if isinstance(pconf, dict) and (pconf.get("api_key") or "").startswith(("FERNET:", "enc:")):
                    pconf["api_key"] = decrypt_value(pconf["api_key"])
                if isinstance(pconf, dict) and pconf.get("api_key"):
                    pconf["api_key"] = pconf["api_key"].strip()
            for sname, sconf in data.get("services", {}).items():
                if isinstance(sconf, dict):
                    for field in ("api_key", "token"):
                        if (sconf.get(field) or "").startswith(("FERNET:", "enc:")):
                            sconf[field] = decrypt_value(sconf[field])
            # Decrypt voice API keys
            for vname, vconf in data.get("voice", {}).items():
                if isinstance(vconf, dict) and (vconf.get("api_key") or "").startswith(("FERNET:", "enc:")):
                    vconf["api_key"] = decrypt_value(vconf["api_key"])
            for mcp in data.get("mcp_servers", []):
                if isinstance(mcp, dict):
                    for ekey, evalue in mcp.get("env", {}).items():
                        if isinstance(evalue, str) and evalue.startswith(("FERNET:", "enc:")):
                            mcp["env"][ekey] = decrypt_value(evalue)
            # Merge missing providers/services from defaults so new ones appear automatically
            defaults = cls()
            if "providers" in data:
                for pname, pconf in defaults.providers.items():
                    if pname not in data["providers"]:
                        data["providers"][pname] = pconf.model_dump()
            if "services" in data:
                for sname, sconf in defaults.services.items():
                    if sname not in data["services"]:
                        data["services"][sname] = sconf.model_dump()
            return cls(**data)
        return cls()

    @property
    def is_configured(self) -> bool:
        return any(
            p.enabled and p.api_key
            for p in self.providers.values()
        )
