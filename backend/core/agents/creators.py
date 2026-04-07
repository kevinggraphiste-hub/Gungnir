import uuid
import json
from pathlib import Path
from typing import Optional
from datetime import datetime

from backend.core.agents.skills import Skill, skill_library
from backend.core.agents.security import security_scanner, SecurityError
from backend.core.agents.mode_manager import mode_manager, AgentMode


class SkillCreator:
    def __init__(self):
        self.skills_dir = Path(__file__).parent.parent.parent / "data" / "skills"
        self.skills_dir.mkdir(exist_ok=True, parents=True)

    async def create_skill(
        self,
        name: str,
        description: str,
        prompt: str,
        tools: list[str] = [],
        code: str = None,
        category: str = "custom",
        tags: list[str] = [],
        version: str = "1.0.0",
        author: str = "user",
        license: str = "MIT",
        examples: list[dict] = [],
        output_format: str = "text",
        annotations: dict = {},
    ) -> dict:
        security_result = security_scanner.scan_skill(prompt, code)

        if not security_result["approved"]:
            return {
                "success": False,
                "error": "Skill rejected for security reasons",
                "violations": security_result["violations"],
                "severity": "high"
            }

        skill_id = str(uuid.uuid4())[:8]

        if not name.startswith("custom_"):
            name = f"custom_{name}"

        skill = Skill(
            id=skill_id,
            name=name,
            description=description,
            prompt=prompt,
            tools=tools,
            category=category,
            created_at=datetime.utcnow(),
            version=version,
            author=author,
            tags=tags,
            license=license,
            examples=examples,
            output_format=output_format,
            annotations=annotations,
            compatibility=["gungnir"],
        )

        skill_library.add_skill(skill)

        self._save_skill_file(skill, code)

        return {
            "success": True,
            "skill_id": skill_id,
            "name": name,
            "security_score": security_result["score"]
        }

    def _save_skill_file(self, skill: Skill, code: str = None):
        skill_file = self.skills_dir / f"{skill.name}.json"
        
        data = skill.model_dump(mode="json")
        data["code"] = code
        skill_file.write_text(json.dumps(data, indent=2, default=str))

    async def import_skill(self, skill_data: dict) -> dict:
        security_result = security_scanner.scan_skill(
            skill_data.get("prompt", ""),
            skill_data.get("code", "")
        )
        
        if not security_result["approved"]:
            return {
                "success": False,
                "error": "Import rejected - security violation detected",
                "violations": security_result["violations"]
            }
        
        if "name" not in skill_data or "prompt" not in skill_data:
            return {"success": False, "error": "Missing required fields (name, prompt)"}
        
        return await self.create_skill(
            name=skill_data["name"],
            description=skill_data.get("description", ""),
            prompt=skill_data["prompt"],
            tools=skill_data.get("tools", []),
            code=skill_data.get("code"),
            category=skill_data.get("category", "imported"),
            tags=skill_data.get("tags", []),
            version=skill_data.get("version", "1.0.0"),
            author=skill_data.get("author", "imported"),
            license=skill_data.get("license", "MIT"),
            examples=skill_data.get("examples", []),
            output_format=skill_data.get("output_format", "text"),
            annotations=skill_data.get("annotations", {}),
        )

    async def validate_all_skills(self) -> dict:
        results = []
        
        for skill in skill_library.list_skills():
            security_result = security_scanner.scan_skill(skill.prompt)
            results.append({
                "name": skill.name,
                "safe": security_result["safe"],
                "score": security_result["score"],
                "violations": len(security_result["violations"]),
            })
        
        safe_count = sum(1 for r in results if r["safe"])
        
        return {
            "total": len(results),
            "safe": safe_count,
            "unsafe": len(results) - safe_count,
            "results": results,
            "action_required": safe_count < len(results)
        }

    async def update_skill(self, name: str, description: str = None, prompt: str = None,
                           tools: list = None, category: str = None, tags: list = None,
                           version: str = None, examples: list = None,
                           output_format: str = None, annotations: dict = None) -> dict:
        skill = skill_library.get_skill(name)
        if not skill:
            return {"success": False, "error": "Skill introuvable"}
        if prompt is not None:
            security_result = security_scanner.scan_skill(prompt)
            if not security_result["approved"]:
                return {"success": False, "error": "Prompt rejeté pour raisons de sécurité", "violations": security_result["violations"]}
            skill.prompt = prompt
        if description is not None:
            skill.description = description
        if tools is not None:
            skill.tools = tools
        if category is not None:
            skill.category = category
        if tags is not None:
            skill.tags = tags
        if version is not None:
            skill.version = version
        if examples is not None:
            skill.examples = examples
        if output_format is not None:
            skill.output_format = output_format
        if annotations is not None:
            skill.annotations = annotations
        skill_library._save()
        self._save_skill_file(skill)
        return {"success": True}

    async def delete_skill(self, name: str) -> dict:
        if name in ["code_reviewer", "debugger", "architect", "researcher", "writer"]:
            return {"success": False, "error": "Cannot delete default skills"}
        
        skill_file = self.skills_dir / f"{name}.json"
        if skill_file.exists():
            skill_file.unlink()
        
        skill_library.remove_skill(name)
        
        return {"success": True}


class SubAgentCreator:
    def __init__(self):
        self.agents_dir = Path(__file__).parent.parent.parent / "data" / "agents"
        self.agents_dir.mkdir(exist_ok=True, parents=True)

    async def create_sub_agent(
        self,
        name: str,
        role: str,
        expertise: str,
        system_prompt: str = None,
        tools: list[str] = [],
        max_iterations: int = 5,
        mode: str = "ask_permission"
    ) -> dict:
        from backend.core.agents.memory import agent_memory
        
        if not name.startswith("agent_"):
            name = f"agent_{name}"
        
        security_result = security_scanner.scan_skill(system_prompt or "")
        
        if not security_result["safe"]:
            return {
                "success": False,
                "error": "Sub-agent rejected for security reasons",
                "violations": security_result["violations"]
            }
        
        agent_id = agent_memory.create_sub_agent(name, role, expertise, tools)
        
        return {
            "success": True,
            "agent_id": agent_id,
            "name": name,
            "role": role,
            "mode": mode
        }

    async def list_sub_agents(self) -> list[dict]:
        from backend.core.agents.memory import agent_memory
        
        return [
            {"name": name, "description": info.get("description", "")}
            for name, info in agent_memory.skills.items()
            if name.startswith("agent_")
        ]

    async def delete_sub_agent(self, agent_name: str) -> dict:
        from backend.core.agents.memory import agent_memory
        
        if agent_name in agent_memory.skills:
            del agent_memory.skills[agent_name]
            return {"success": True}
        
        return {"success": False, "error": "Agent not found"}


skill_creator = SkillCreator()
sub_agent_creator = SubAgentCreator()
