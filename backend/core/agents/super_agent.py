import json
import uuid
from typing import Optional
from pathlib import Path

from backend.core.config.settings import Settings
from backend.core.providers.base import ChatMessage
from backend.core.providers import get_provider
from backend.core.agents.tools import FileTool, BashTool, GitTool
from backend.core.agents.skills import skill_library, personality_manager, Skill, Personality
from backend.core.agents.memory import AgentMemory, Memory, KnowledgeEntry
from backend.core.agents.mode_manager import mode_pool, mode_manager, AgentMode, PermissionRequest
from backend.core.agents.security import security_scanner
from backend.core.agents.creators import skill_creator, sub_agent_creator
from backend.core.agents.wolf_tools import WOLF_TOOL_SCHEMAS, WOLF_EXECUTORS, READ_ONLY_TOOLS


TOOL_SCHEMAS = {
    "read_file": {
        "name": "read_file",
        "description": "Lire le contenu d'un fichier",
        "parameters": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "Chemin du fichier"}
            },
            "required": ["path"]
        }
    },
    "write_file": {
        "name": "write_file",
        "description": "Écrire du contenu dans un fichier",
        "parameters": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "Chemin du fichier"},
                "content": {"type": "string", "description": "Contenu à écrire"}
            },
            "required": ["path", "content"]
        }
    },
    "list_dir": {
        "name": "list_dir",
        "description": "Lister les fichiers d'un répertoire",
        "parameters": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "Chemin du répertoire"}
            }
        }
    },
    "run_command": {
        "name": "run_command",
        "description": "Exécuter une commande shell",
        "parameters": {
            "type": "object",
            "properties": {
                "command": {"type": "string", "description": "Commande à exécuter"},
                "timeout": {"type": "integer", "description": "Timeout en secondes"}
            },
            "required": ["command"]
        }
    },
    "search_in_files": {
        "name": "search_in_files",
        "description": "Rechercher dans les fichiers",
        "parameters": {
            "type": "object",
            "properties": {
                "pattern": {"type": "string", "description": "Motif de recherche"},
                "path": {"type": "string", "description": "Répertoire de recherche"}
            },
            "required": ["pattern"]
        }
    },
    "git_status": {
        "name": "git_status",
        "description": "Voir le statut git",
        "parameters": {"type": "object", "properties": {}}
    },
    "git_log": {
        "name": "git_log",
        "description": "Voir l'historique git",
        "parameters": {
            "type": "object",
            "properties": {
                "limit": {"type": "integer", "description": "Nombre de commits"}
            }
        }
    },
    "git_commit": {
        "name": "git_commit",
        "description": "Créer un commit git",
        "parameters": {
            "type": "object",
            "properties": {
                "message": {"type": "string", "description": "Message de commit"}
            },
            "required": ["message"]
        }
    },
    "git_push": {
        "name": "git_push",
        "description": "Pusher sur le remote",
        "parameters": {"type": "object", "properties": {}}
    },
}


class SuperAgent:
    def __init__(self, settings: Settings):
        self.settings = settings
        self.workspace = Path(settings.app.workspace_dir)
        self.workspace.mkdir(exist_ok=True, parents=True)
        
        self.file_tool = FileTool(self.workspace)
        self.bash_tool = BashTool(str(self.workspace))
        self.git_tool = GitTool(str(self.workspace))
        
        self.memory = AgentMemory("main")
        self.current_skill: Optional[Skill] = None
        self.current_personality: Personality = personality_manager.get_active()
        
        self.provider_name = "openrouter"
        self.model = "anthropic/claude-3.5-sonnet"
        
        self.conversation_history: list[ChatMessage] = []
        
        self.mode_manager = mode_manager

    def get_tools_description(self) -> str:
        tools = []
        for name, schema in TOOL_SCHEMAS.items():
            tools.append(f"- {schema['name']}: {schema['description']}")
        # Ajouter les outils Wolf (browser, search, skills, etc.)
        for schema in WOLF_TOOL_SCHEMAS:
            fn = schema.get("function", {})
            tools.append(f"- {fn['name']}: {fn.get('description', '')}")
        return "\n".join(tools)

    def get_all_tool_schemas(self) -> list[dict]:
        """Retourne tous les schemas de tools (locaux + Wolf) au format OpenAI."""
        all_schemas = []
        # Outils locaux (file, bash, git)
        for name, schema in TOOL_SCHEMAS.items():
            all_schemas.append({
                "type": "function",
                "function": schema,
            })
        # Outils Wolf (browser, search, skills, etc.)
        all_schemas.extend(WOLF_TOOL_SCHEMAS)
        return all_schemas

    def get_system_prompt(self) -> str:
        personality = personality_manager.get_active()
        
        skill_prompt = ""
        if self.current_skill:
            skill_prompt = f"\n\n## Skill actif: {self.current_skill.name}\n{self.current_skill.prompt}"
        
        mode_info = f"\n\n## Mode de fonctionnement: {self.mode_manager.current_mode.value}"
        if self.mode_manager.current_mode == AgentMode.ASK_PERMISSION:
            mode_info += "\nDemande confirmation avant actions sensibles (write, delete, execute)"
        elif self.mode_manager.current_mode == AgentMode.RESTRAINED:
            mode_info += "\nTu dois attendre la confirmation de l'utilisateur pour toute action"
        
        return f"""{personality.system_prompt}

## Capacités
Tu as accès aux outils suivants:
{self.get_tools_description()}

## Mémoire
{random_pick(list(self.memory.knowledge.values())[:3], "Voici ce que tu sais déjà:")}
{skill_prompt}
{mode_info}

## 🎨 Création de skills (qualité > quantité)
Quand l'utilisateur demande de CRÉER un nouveau skill via `skill_create`, produis un skill ÉTOFFÉ et COMPLET, pas un stub minimaliste. Un skill utile contient (en 40-150 lignes de prompt) :
- **Rôle et posture** : qui est ce skill, son expertise, son ton, sa façon de parler
- **Méthodologie numérotée** : étapes concrètes que le skill applique à chaque tâche
- **Règles strictes** : anti-patterns à éviter, qualité non-négociable, cas limites
- **Format de sortie imposé** : sections markdown, longueur, structure
- **Critères de succès vérifiables** : comment savoir qu'une exécution est réussie
- **2-3 exemples concrets** : mini cas d'usage pour ancrer le comportement

Privilégie TOUJOURS un skill profond et opérationnel plutôt qu'un skill superficiel copié-collé. L'import depuis un fichier ou un autre projet reste possible (si l'utilisateur fournit explicitement un JSON à importer), mais la création doit viser la qualité maximale dès le premier jet. Si tu ne peux pas produire un prompt dense et structuré pour ce domaine, demande à l'utilisateur plus de contexte avant de créer.

## 🎛️ Orchestration multi-agents (IMPORTANT)
Tu disposes d'un pool de sous-agents spécialisés (SEO, dev, data, UX, copywriter, recherche, comptable, sécurité) orchestrés par `agent_coordinator`.

**Quand invoquer `agent_coordinator` via `subagent_invoke(name="agent_coordinator", task=...)`** :
- La requête touche **3 domaines d'expertise distincts ou plus** (ex: "audite mon app et propose amélioration SEO + sécurité + UX")
- La requête contient des mots-clés d'envergure : "audite", "plan complet", "stratégie 360°", "analyse globale", "pack", "benchmark", "comparatif approfondi"
- La requête demande **plusieurs livrables séparés** qu'il faudrait assembler
- L'utilisateur te demande explicitement une orchestration

**Quand invoquer UN SEUL sous-agent spécialisé** (via `subagent_invoke`) :
- Tâche mono-domaine (uniquement SEO, uniquement code, uniquement data…) → délègue direct à l'agent compétent
- Utilise `subagent_list` si tu as un doute sur les agents disponibles

**Quand ne rien invoquer** :
- Question conversationnelle simple / clarification rapide
- Tâche où tu peux répondre aussi bien que n'importe quel sous-agent
- Tu es DÉJÀ dans un contexte de sous-agent (anti-récursion)

Le `agent_coordinator` ne fait JAMAIS le travail lui-même — il décompose, délègue, et synthétise. Utilise-le quand la tâche le justifie réellement.

Réponds de manière concise. Utilise les outils quand nécessaire."""

    def set_mode(self, mode: str):
        try:
            self.mode_manager.set_mode(AgentMode(mode))
        except ValueError:
            pass

    async def execute_tool(self, tool_name: str, params: dict) -> dict:
        can_execute, reason = self.mode_manager.can_execute_tool(tool_name)
        if not can_execute:
            return {"error": reason}
        
        needs_perm = self.mode_manager.needs_permission(tool_name, tool_name)
        
        if needs_perm:
            request_id = str(uuid.uuid4())[:8]
            await self.mode_manager.request_permission(
                request_id, 
                f"execute_tool_{tool_name}",
                {"tool": tool_name, "params": params}
            )
            return {
                "pending": True,
                "request_id": request_id,
                "message": f"Permission requise pour exécuter {tool_name}"
            }
        
        return await self._do_execute_tool(tool_name, params)

    async def _do_execute_tool(self, tool_name: str, params: dict) -> dict:
        if tool_name == "read_file":
            path = params.get("path", "")
            if not security_scanner.check_workspace_access(path):
                return {"error": "Path outside workspace"}
            return await self.file_tool.read(path)
        
        elif tool_name == "write_file":
            path = params.get("path", "")
            if not security_scanner.check_workspace_access(path):
                return {"error": "Path outside workspace"}
            return await self.file_tool.write(path, params.get("content", ""))
        
        elif tool_name == "list_dir":
            return await self.file_tool.list(params.get("path", "."))
        
        elif tool_name == "run_command":
            command = params.get("command", "")
            if self.mode_manager.current_mode == AgentMode.RESTRAINED:
                return {"error": "Command execution is restrained"}
            return await self.bash_tool.run(command, params.get("timeout", 60))
        
        elif tool_name == "search_in_files":
            return await self.file_tool.search(params.get("pattern", ""), params.get("path", "."))
        
        elif tool_name == "git_status":
            return await self.git_tool.status()
        
        elif tool_name == "git_log":
            return await self.git_tool.log(params.get("limit", 10))
        
        elif tool_name == "git_commit":
            message = params.get("message", "")
            await self.git_tool.add(["."])
            return await self.git_tool.commit(message)
        
        elif tool_name == "git_push":
            if self.mode_manager.needs_permission("git_push"):
                return {"error": "Permission requise pour push"}
            return await self.git_tool.push()

        else:
            # Fallback : exécuter via WOLF_EXECUTORS (browser, search, skills, etc.)
            executor = WOLF_EXECUTORS.get(tool_name)
            if executor:
                try:
                    return await executor(**params)
                except Exception as ex:
                    return {"ok": False, "error": str(ex)}
            return {"error": f"Tool {tool_name} not found"}

    async def chat(self, user_message: str, stream: bool = False):
        settings = Settings.load()
        provider_config = settings.providers.get(self.provider_name)
        
        if not provider_config or not provider_config.enabled or not provider_config.api_key:
            yield {"error": "Provider non configuré"}
            return
        
        provider = get_provider(
            self.provider_name,
            provider_config.api_key,
            provider_config.base_url,
        )
        
        self.conversation_history.append(ChatMessage(role="user", content=user_message))
        
        messages = [
            ChatMessage(role="system", content=self.get_system_prompt()),
            *self.conversation_history,
        ]
        
        try:
            if stream:
                async for chunk in provider.chat_stream(messages, self.model):
                    yield {"chunk": chunk}
            else:
                response = await provider.chat(messages, self.model)
                self.conversation_history.append(
                    ChatMessage(role="assistant", content=response.content)
                )
                
                self.memory.create_memory_from_interaction(user_message, response.content)
                
                yield {"content": response.content}
        except Exception as e:
            yield {"error": str(e)}

    async def execute_with_tools(self, user_message: str):
        settings = Settings.load()
        provider_config = settings.providers.get(self.provider_name)

        if not provider_config or not provider_config.enabled:
            return {"error": "Provider non configuré"}

        provider = get_provider(
            self.provider_name,
            provider_config.api_key,
            provider_config.base_url,
        )

        self.conversation_history.append(ChatMessage(role="user", content=user_message))

        all_tools = self.get_all_tool_schemas()
        max_iterations = 12
        iteration = 0

        while iteration < max_iterations:
            iteration += 1

            messages = [
                ChatMessage(role="system", content=self.get_system_prompt()),
                *self.conversation_history,
            ]

            response = await provider.chat(
                messages, self.model,
                tools=all_tools,
                tool_choice="auto",
            )
            self.conversation_history.append(
                ChatMessage(
                    role="assistant",
                    content=response.content or "",
                    tool_calls=response.tool_calls,
                )
            )

            if not response.tool_calls:
                self.memory.create_memory_from_interaction(user_message, response.content)
                return {"content": response.content, "iterations": iteration}

            tool_results = []
            for tc in response.tool_calls:
                tool_name = tc.get("function", {}).get("name")
                args = tc.get("function", {}).get("arguments", {})
                call_id = tc.get("id") or str(uuid.uuid4())[:8]

                if isinstance(args, str):
                    args = json.loads(args)

                result = await self.execute_tool(tool_name, args)

                if result.get("pending"):
                    self.conversation_history.append(
                        ChatMessage(role="tool", content=json.dumps(result), tool_call_id=call_id)
                    )
                    continue

                tool_results.append({"tool": tool_name, "result": result})

                self.conversation_history.append(
                    ChatMessage(
                        role="tool",
                        content=json.dumps(result, ensure_ascii=False)[:2000],
                        tool_call_id=call_id,
                    )
                )

        # Dernière chance : réponse sans tools
        if response and response.tool_calls:
            response = await provider.chat(
                [ChatMessage(role="system", content=self.get_system_prompt()), *self.conversation_history],
                self.model,
            )

        return {"content": response.content if response else "Trop d'itérations", "iterations": iteration}

    def set_personality(self, name: str):
        personality_manager.set_active(name)
        self.current_personality = personality_manager.get_active()

    def set_skill(self, name: str):
        skill = skill_library.get_skill(name)
        if skill:
            self.current_skill = skill

    def auto_detect_skill(self, task: str) -> Skill | None:
        skill = skill_library.suggest_skill(task)
        if skill:
            self.current_skill = skill
        return skill

    async def learn(self, title: str, content: str, tags: list[str] = []):
        entry = KnowledgeEntry(
            id=str(uuid.uuid4())[:8],
            title=title,
            content=content,
            tags=tags,
            source="user"
        )
        self.memory.add_knowledge(entry)
        return entry

    async def create_skill(self, name: str, description: str, prompt: str, tools: list[str] = []) -> dict:
        return await skill_creator.create_skill(name, description, prompt, tools)

    async def create_sub_agent(self, name: str, role: str, expertise: str, tools: list[str] = []) -> dict:
        return await sub_agent_creator.create_sub_agent(name, role, expertise, tools=tools)


def random_pick(items: list, default: str) -> str:
    if items:
        return default + "\n" + "\n".join(f"- {i.title}: {i.content[:100]}..." for i in items[:3])
    return default
