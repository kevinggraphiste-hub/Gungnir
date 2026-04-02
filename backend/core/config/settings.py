"""
Gungnir — Configuration centrale
"""
import json
import os
from pathlib import Path
from typing import Optional
from pydantic import BaseModel, Field
from pydantic_settings import BaseSettings

BASE_DIR = Path(__file__).parent.parent.parent.parent  # Gungnir/
DATA_DIR = BASE_DIR / "data"
DATA_DIR.mkdir(exist_ok=True)
PLUGINS_DIR = BASE_DIR / "backend" / "plugins"


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
            models=[
                "anthropic/claude-3.5-sonnet",
                "google/gemini-2.0-flash-exp",
                "openai/gpt-4o",
                "minimax/minimax-m2.7",
                "meta-llama/llama-3.1-70b-instruct",
            ]
        ),
        "anthropic": ProviderConfig(
            models=["claude-3-5-sonnet-20241022", "claude-3-5-haiku-20241022"]
        ),
        "google": ProviderConfig(
            models=["gemini-2.0-flash-exp", "gemini-1.5-pro"]
        ),
        "openai": ProviderConfig(
            models=["gpt-4o", "gpt-4o-mini"]
        ),
        "minimax": ProviderConfig(
            base_url="https://api.minimax.chat/v1",
            models=["minimax-m2.7"]
        ),
        "ollama": ProviderConfig(
            base_url="http://localhost:11434/v1",
            models=[]
        ),
    })
    voice: dict[str, VoiceConfig] = Field(default_factory=lambda: {
        "elevenlabs": VoiceConfig(),
        "google": VoiceConfig(),
        "openai": VoiceConfig(),
    })

    _config_path: Path = DATA_DIR / "config.json"

    def save(self):
        data = self.model_dump()
        self._config_path.write_text(json.dumps(data, indent=2, ensure_ascii=False))

    @classmethod
    def load(cls) -> "Settings":
        config_path = DATA_DIR / "config.json"
        if config_path.exists():
            data = json.loads(config_path.read_text())
            return cls(**data)
        return cls()

    @property
    def is_configured(self) -> bool:
        return any(
            p.enabled and p.api_key
            for p in self.providers.values()
        )
