import json
import asyncio
from typing import Optional
from pathlib import Path
from datetime import datetime


class AutoDiscovery:
    def __init__(self, agent):
        self.agent = agent
        self.learned_patterns: dict[str, dict] = {}

    async def analyze_task(self, user_input: str) -> dict:
        task_analysis = {
            "requires_code": False,
            "requires_search": False,
            "requires_git": False,
            "requires_file": False,
            "suggested_tools": [],
            "suggested_skill": None,
            "confidence": 0.0
        }
        
        input_lower = user_input.lower()
        
        keywords = {
            "file": ["créer fichier", "écrire", "modifier fichier", "file", "write", "read"],
            "code": ["code", "coder", "programmer", "function", "class", "debug"],
            "search": ["cherche", "recherche", "search", "trouve", "find", "google"],
            "git": ["git", "commit", "push", "pull", "branch", "merge"],
            "shell": ["commande", "terminal", "bash", "command", "exécute"],
            "analyze": ["analyse", "review", "critique", "explique"],
        }
        
        for category, words in keywords.items():
            matches = sum(1 for w in words if w in input_lower)
            if matches > 0:
                task_analysis["confidence"] = min(matches / len(words), 1.0)
                
                if category == "file":
                    task_analysis["requires_file"] = True
                    task_analysis["suggested_tools"].extend(["read_file", "write_file", "list_dir"])
                elif category == "code":
                    task_analysis["requires_code"] = True
                    task_analysis["suggested_tools"].extend(["read_file", "run_command"])
                elif category == "search":
                    task_analysis["requires_search"] = True
                    task_analysis["suggested_tools"].append("search_in_files")
                elif category == "git":
                    task_analysis["requires_git"] = True
                    task_analysis["suggested_tools"].extend(["git_status", "git_log", "git_commit"])
                elif category == "shell":
                    task_analysis["suggested_tools"].append("run_command")
                elif category == "analyze":
                    task_analysis["suggested_skill"] = "code_reviewer"
        
        skill = self.agent.auto_detect_skill(user_input)
        if skill:
            task_analysis["suggested_skill"] = skill.name
        
        return task_analysis

    async def learn_from_interaction(self, user_input: str, success: bool, tool_usage: list[str]):
        if not success:
            return
        
        pattern_key = f"{len(tool_usage)}_tools"
        
        if pattern_key not in self.learned_patterns:
            self.learned_patterns[pattern_key] = {
                "count": 0,
                "tools": tool_usage,
                "examples": []
            }
        
        self.learned_patterns[pattern_key]["count"] += 1
        self.learned_patterns[pattern_key]["examples"].append({
            "input": user_input[:100],
            "timestamp": datetime.utcnow().isoformat()
        })
        
        if len(self.learned_patterns[pattern_key]["examples"]) > 10:
            self.learned_patterns[pattern_key]["examples"] = self.learned_patterns[pattern_key]["examples"][-10:]

    async def suggest_new_capability(self, task: str) -> Optional[dict]:
        from backend.core.agents.skills import skill_library
        
        similar = self.agent.memory.search_knowledge(task)
        
        if len(similar) >= 3:
            return {
                "type": "new_skill",
                "name": f"auto_skill_{datetime.utcnow().strftime('%Y%m%d')}",
                "description": f"Compétence auto-générée basée sur {len(similar)} interactions similaires",
                "prompt": f"""Tu es un expert sur ce sujet. Tu as été créé automatiquement après avoir appris de {len(similar)} interactions.
Voici le contexte: {similar[0].content[:200]}""",
                "confidence": 0.7
            }
        
        return None

    async def auto_create_tool(self, tool_name: str, description: str, python_code: str) -> bool:
        from backend.core.agents.tool_registry import tool_registry
        
        try:
            tool_registry.create_tool_from_prompt(tool_name, description, python_code)
            return True
        except Exception as e:
            print(f"Failed to auto-create tool: {e}")
            return False

    async def adapt_personality(self, feedback: str) -> str:
        from backend.core.agents.skills import personality_manager
        
        feedback_lower = feedback.lower()
        
        if any(w in feedback_lower for w in ["trop", "long", "bredouille", "verbose"]):
            current = personality_manager.get_active()
            new_prompt = current.system_prompt + " Sois plus concis."
            personality = personality_manager.personalities[current.name]
            personality.system_prompt = new_prompt
            return "Personnalité ajustée: plus concis"
        
        if any(w in feedback_lower for w in ["clair", "bien", "parfait", "merci"]):
            return "Content que ça te plaise!"
        
        return "Feedback enregistré"


class SmartAssistant:
    def __init__(self, agent):
        self.agent = agent
        self.discovery = AutoDiscovery(agent)
        self.context_window: list[dict] = []
        self.max_context = 20

    async def process(self, user_input: str) -> dict:
        task_analysis = await self.discovery.analyze_task(user_input)
        
        self.context_window.append({
            "role": "user",
            "content": user_input,
            "analysis": task_analysis,
            "timestamp": datetime.utcnow().isoformat()
        })
        
        if len(self.context_window) > self.max_context:
            self.context_window = self.context_window[-self.max_context:]
        
        if task_analysis["suggested_skill"]:
            self.agent.set_skill(task_analysis["suggested_skill"])
        
        result = await self.agent.execute_with_tools(user_input)
        
        self.context_window.append({
            "role": "assistant",
            "content": result.get("content", ""),
            "tools_used": task_analysis["suggested_tools"],
            "timestamp": datetime.utcnow().isoformat()
        })
        
        await self.discovery.learn_from_interaction(
            user_input,
            "error" not in result,
            task_analysis["suggested_tools"]
        )
        
        return {
            **result,
            "analysis": task_analysis,
            "skill": self.agent.current_skill.name if self.agent.current_skill else None,
        }

    async def suggest_improvement(self) -> Optional[dict]:
        return await self.discovery.suggest_new_capability(self.context_window[-1]["content"] if self.context_window else "")
