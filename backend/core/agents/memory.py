from pydantic import BaseModel
from typing import Optional
from datetime import datetime
import json
from pathlib import Path

MEMORY_PATH = Path(__file__).parent.parent.parent.parent / "data" / "memory.json"


class Memory(BaseModel):
    id: str
    type: str
    content: str
    context: dict = {}
    embeddings: list[float] = []
    created_at: datetime = None
    access_count: int = 0
    last_accessed: datetime = None


class KnowledgeEntry(BaseModel):
    id: str
    title: str
    content: str
    tags: list[str] = []
    source: str = "user"
    created_at: datetime = None


class AgentMemory:
    def __init__(self, agent_id: str = "default"):
        self.agent_id = agent_id
        self.memories: dict[str, Memory] = {}
        self.knowledge: dict[str, KnowledgeEntry] = {}
        self._load()

    def _load(self):
        if MEMORY_PATH.exists():
            try:
                data = json.loads(MEMORY_PATH.read_text())
                self.memories = {k: Memory(**v) for k, v in data.get("memories", {}).items()}
                self.knowledge = {k: KnowledgeEntry(**v) for k, v in data.get("knowledge", {}).items()}
            except Exception as e:
                print(f"Failed to load memory: {e}")

    def _save(self):
        data = {
            "memories": {k: v.model_dump(mode="json") for k, v in self.memories.items()},
            "knowledge": {k: v.model_dump(mode="json") for k, v in self.knowledge.items()}
        }
        MEMORY_PATH.parent.mkdir(exist_ok=True, parents=True)
        MEMORY_PATH.write_text(json.dumps(data, indent=2, default=str))

    def add_memory(self, memory: Memory):
        self.memories[memory.id] = memory
        self._save()

    def recall(self, query: str, limit: int = 5) -> list[Memory]:
        query_lower = query.lower()
        results = []
        
        for mem in self.memories.values():
            if query_lower in mem.content.lower():
                mem.access_count += 1
                mem.last_accessed = datetime.utcnow()
                results.append(mem)
        
        results.sort(key=lambda x: (x.access_count, x.last_accessed), reverse=True)
        self._save()
        return results[:limit]

    def add_knowledge(self, entry: KnowledgeEntry):
        self.knowledge[entry.id] = entry
        self._save()

    def search_knowledge(self, query: str) -> list[KnowledgeEntry]:
        query_lower = query.lower()
        results = []
        
        for entry in self.knowledge.values():
            if query_lower in entry.content.lower() or any(query_lower in t.lower() for t in entry.tags):
                results.append(entry)
        
        return results

    def create_memory_from_interaction(self, user_input: str, assistant_output: str, context: dict = {}):
        import uuid
        mem_id = str(uuid.uuid4())
        memory = Memory(
            id=mem_id,
            type="interaction",
            content=f"User: {user_input}\nAssistant: {assistant_output}",
            context=context,
            created_at=datetime.utcnow()
        )
        self.add_memory(memory)
        return mem_id

    def learn_from_error(self, error: str, recovery: str):
        import uuid
        mem_id = str(uuid.uuid4())
        memory = Memory(
            id=mem_id,
            type="error_recovery",
            content=f"Error: {error}\nRecovery: {recovery}",
            context={"error_type": "auto_learned"},
            created_at=datetime.utcnow()
        )
        self.add_memory(memory)


class DynamicAgent:
    def __init__(self, agent_id: str = "default"):
        self.agent_id = agent_id
        self.memory = AgentMemory(agent_id)
        self.skills: dict[str, dict] = {}
        self.tools: dict[str, callable] = {}

    def add_skill(self, name: str, description: str, prompt: str, tools: list[str] = []):
        self.skills[name] = {
            "name": name,
            "description": description,
            "prompt": prompt,
            "tools": tools,
        }

    def create_sub_agent(self, name: str, role: str, expertise: str, tools: list[str] = []):
        import uuid
        agent_id = str(uuid.uuid4())[:8]
        
        prompt = f"""Tu es {role} avec expertise en: {expertise}.
Tu dois répondre de manière concise et efficace.
Tu as accès aux outils: {', '.join(tools)}"""
        
        self.add_skill(name=f"agent_{agent_id}", description=role, prompt=prompt, tools=tools)
        return agent_id

    async def auto_discover_tools(self):
        from backend.core.agents.tool_registry import tool_registry
        
        await tool_registry.discover_mcp_tools()
        self.tools = {k: v for k, v in tool_registry.tools.items()}

    def suggest_new_skill(self, task: str) -> str | None:
        relevant_memories = self.memory.recall(task, limit=3)
        
        if relevant_memories:
            return f"Nouvelle compétence basée sur les interactions précédentes:\n" + "\n".join(
                f"- {m.content[:100]}..." for m in relevant_memories[:2]
            )
        return None


agent_memory = DynamicAgent()
