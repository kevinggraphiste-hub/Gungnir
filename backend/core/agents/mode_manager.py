from enum import Enum
from pathlib import Path
from pydantic import BaseModel
from typing import Optional
from datetime import datetime
import json


class AgentMode(str, Enum):
    AUTONOMOUS = "autonomous"
    ASK_PERMISSION = "ask_permission"
    RESTRAINED = "restrained"


class PermissionRequest(BaseModel):
    id: str
    action: str
    details: dict
    timestamp: datetime = None
    status: str = "pending"
    response: Optional[str] = None


class AgentModeConfig(BaseModel):
    mode: AgentMode = AgentMode.ASK_PERMISSION
    max_file_size_mb: int = 10
    max_command_duration: int = 60
    allowed_commands: list[str] = []
    blocked_commands: list[str] = ["rm -rf", "del", "format", "mkfs"]
    require_confirmation_for: list[str] = ["delete", "write", "execute", "git_push"]
    auto_approve_tools: list[str] = ["read_file", "list_dir", "git_status", "git_log"]
    notify_on: list[str] = ["error", "tool_execution", "skill_change"]


class ModeManager:
    _MODE_FILE = Path(__file__).parent.parent.parent.parent / "data" / "agent_mode.json"

    def __init__(self):
        self.config = AgentModeConfig()
        self.pending_requests: dict[str, PermissionRequest] = {}
        # Charger le mode persisté ou utiliser le défaut
        saved_mode = self._load_mode()
        self.current_mode = saved_mode
        self.set_mode(saved_mode)

    # Outils Wolf en lecture seule (toujours autorisés)
    WOLF_READ_TOOLS = ["skill_list", "kb_read", "kb_list", "soul_read", "subagent_list"]
    # Outils Wolf d'écriture (autorisés en mode autonome/ask_permission)
    WOLF_WRITE_TOOLS = [
        "skill_create", "skill_update", "skill_delete",
        "personality_create", "personality_update", "personality_delete", "personality_set_active",
        "subagent_create", "subagent_update", "subagent_delete",
        "kb_write", "soul_write",
    ]

    def _load_mode(self) -> AgentMode:
        try:
            if self._MODE_FILE.exists():
                data = json.loads(self._MODE_FILE.read_text())
                return AgentMode(data.get("mode", "ask_permission"))
        except Exception:
            pass
        return AgentMode.ASK_PERMISSION

    def _save_mode(self):
        try:
            self._MODE_FILE.write_text(json.dumps({"mode": self.current_mode.value}, indent=2))
        except Exception:
            pass

    def set_mode(self, mode: AgentMode):
        self.current_mode = mode
        self._save_mode()

        if mode == AgentMode.AUTONOMOUS:
            self.config.auto_approve_tools = (
                ["read_file", "write_file", "list_dir", "run_command", "git_status", "git_log"]
                + self.WOLF_READ_TOOLS + self.WOLF_WRITE_TOOLS
            )
        elif mode == AgentMode.ASK_PERMISSION:
            # En mode demande, seuls les outils en lecture sont auto-approuvés
            # Les outils d'écriture nécessitent une confirmation de l'utilisateur dans le chat
            self.config.auto_approve_tools = (
                ["read_file", "list_dir", "git_status", "git_log"]
                + self.WOLF_READ_TOOLS
            )
        elif mode == AgentMode.RESTRAINED:
            # Mode restreint : tous les outils sont disponibles, mais le LLM
            # ne doit les utiliser QUE sur demande explicite de l'utilisateur.
            # Le contrôle est dans le system prompt, pas dans un blocage technique.
            self.config.auto_approve_tools = (
                ["read_file", "write_file", "list_dir", "run_command", "git_status", "git_log"]
                + self.WOLF_READ_TOOLS + self.WOLF_WRITE_TOOLS
            )
            self.config.require_confirmation_for = []

    def needs_permission(self, action: str, tool: str = None) -> bool:
        if self.current_mode == AgentMode.AUTONOMOUS:
            return False
        
        if self.current_mode == AgentMode.RESTRAINED:
            return True
        
        if tool in self.config.auto_approve_tools:
            return False
        
        for req in self.config.require_confirmation_for:
            if req in action.lower():
                return True
        
        return False

    async def request_permission(self, request_id: str, action: str, details: dict) -> PermissionRequest:
        request = PermissionRequest(
            id=request_id,
            action=action,
            details=details,
            timestamp=datetime.utcnow()
        )
        self.pending_requests[request_id] = request
        return request

    async def approve_request(self, request_id: str, response: str = "approved") -> bool:
        if request_id in self.pending_requests:
            self.pending_requests[request_id].status = "approved"
            self.pending_requests[request_id].response = response
            return True
        return False

    async def deny_request(self, request_id: str, reason: str) -> bool:
        if request_id in self.pending_requests:
            self.pending_requests[request_id].status = "denied"
            self.pending_requests[request_id].response = reason
            return True
        return False

    def get_pending_requests(self) -> list[PermissionRequest]:
        return [r for r in self.pending_requests.values() if r.status == "pending"]

    def can_execute_tool(self, tool_name: str) -> tuple[bool, str]:
        if tool_name in ["eval", "exec", "__import__"]:
            return False, "Execution of arbitrary code is blocked"
        
        for blocked in self.config.blocked_commands:
            if blocked in tool_name:
                return False, f"Tool {tool_name} is blocked"
        
        return True, "allowed"


mode_manager = ModeManager()
