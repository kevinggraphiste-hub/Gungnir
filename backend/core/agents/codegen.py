import os
import asyncio
import tempfile
import shutil
from pathlib import Path
from typing import Optional
from pydantic import BaseModel

from backend.core.config.settings import Settings
from backend.core.providers.base import ChatMessage


class AgentResponse(BaseModel):
    content: str
    tool_results: list[dict] = []
    success: bool = True


class CodeAgent:
    def __init__(self, settings: Settings, provider_name: str, model: str):
        self.settings = settings
        self.provider_name = provider_name
        self.model = model
        self.workspace = Path(settings.app.workspace_dir)
        self.workspace.mkdir(exist_ok=True, parents=True)
        self.current_model = model
        
        self.system_prompt = """Tu es un agent de coding expert. Tu peux lire, écrire et exécuter du code dans l'espace de travail défini.
Tu as accès aux outils suivants:
- read_file: Lire un fichier
- write_file: Écrire un fichier
- list_dir: Lister les fichiers d'un répertoire
- run_command: Exécuter une commande shell
- search_in_files: Rechercher dans les fichiers

Réponds de manière concise et efficace. Si tu as besoin d'exécuter du code, utilise les outils disponibles."""

    async def execute(self, user_message: str) -> AgentResponse:
        from backend.core.providers import get_provider
        
        settings = Settings.load()
        provider_config = settings.providers.get(self.provider_name)
        
        if not provider_config or not provider_config.enabled or not provider_config.api_key:
            return AgentResponse(content="Provider non configuré", success=False)
        
        provider = get_provider(
            self.provider_name,
            provider_config.api_key,
            provider_config.base_url,
        )
        
        messages = [
            ChatMessage(role="system", content=self.system_prompt),
            ChatMessage(role="user", content=user_message),
        ]
        
        try:
            response = await provider.chat(messages, self.model or provider_config.default_model)
            return AgentResponse(content=response.content)
        except Exception as e:
            return AgentResponse(content=f"Erreur: {str(e)}", success=False)

    async def change_model(self, provider_name: str, model: str):
        self.provider_name = provider_name
        self.model = model

    def get_workspace_path(self) -> Path:
        return self.workspace
