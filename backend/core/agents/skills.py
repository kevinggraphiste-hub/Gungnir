from pydantic import BaseModel
from typing import Optional
from datetime import datetime


class Skill(BaseModel):
    id: str
    name: str
    description: str
    prompt: str
    tools: list[str] = []
    category: str = "general"
    created_at: datetime = None
    usage_count: int = 0


class Personality(BaseModel):
    id: str
    name: str
    description: str
    system_prompt: str
    traits: list[str] = []
    created_at: datetime = None


class SkillLibrary:
    from pathlib import Path
    SKILLS_FILE = Path(__file__).parent.parent.parent / "data" / "skills.json"

    DEFAULT_SKILLS = [
        {
            "name": "code_reviewer",
            "description": "Analyse et suggère des améliorations de code",
            "prompt": """Tu es un expert en revue de code. Ton rôle est d'analyser le code fourni et de suggérer des améliorations.
Critiques toujours de manière constructive.
Fournis des suggestions précises avec des exemples de code si possible.""",
            "tools": ["read_file", "search_in_files"],
            "category": "development"
        },
        {
            "name": "debugger",
            "description": "Aide à déboguer du code et trouver des bugs",
            "prompt": """Tu es un expert en débogage. Ton rôle est d'analyser le code et les erreurs pour identifier la cause racine.
Pose des questions clarifiantes pour comprendre le contexte.
Propose des solutions progressives du plus simple au plus complexe.""",
            "tools": ["read_file", "run_command"],
            "category": "development"
        },
        {
            "name": "architect",
            "description": "Propose des architectures et bonnes pratiques",
            "prompt": """Tu es un architecte logiciel. Ton rôle est de proposer des architectures robustes et scalables.
Tiens compte des contraintes du projet (language, scale, deadline).
Documente tes décisions avec leurs trade-offs.""",
            "tools": ["list_dir", "read_file"],
            "category": "design"
        },
        {
            "name": "researcher",
            "description": "Recherche et synthétise des informations",
            "prompt": """Tu es un expert en recherche. Ton rôle est de trouver et synthétiser des informations pertinentes.
Cite toujours tes sources.
Résume les points clés de manière claire.""",
            "tools": ["web_search"],
            "category": "research"
        },
        {
            "name": "writer",
            "description": "Aide à rédiger et améliorer du contenu",
            "prompt": """Tu es un expert en rédaction. Ton rôle est d'aider à produire du contenu clair et percutant.
Adapte le style au public cible.
Propose des améliorations grammaticales et stylistiques.""",
            "tools": ["read_file", "write_file"],
            "category": "writing"
        },
    ]

    def __init__(self):
        self.skills: dict[str, Skill] = {}
        self._load()

    def _load(self):
        import uuid, json
        if self.SKILLS_FILE.exists():
            try:
                data = json.loads(self.SKILLS_FILE.read_text(encoding="utf-8"))
                for s in data.get("skills", []):
                    s.setdefault("id", str(uuid.uuid4())[:8])
                    s.setdefault("tools", [])
                    s.setdefault("category", "general")
                    s.setdefault("usage_count", 0)
                    if isinstance(s.get("created_at"), str):
                        try:
                            s["created_at"] = datetime.fromisoformat(s["created_at"])
                        except Exception:
                            s["created_at"] = datetime.utcnow()
                    skill = Skill(**s)
                    self.skills[skill.name] = skill
                return
            except Exception:
                pass
        self._load_defaults()

    def _save(self):
        import json
        data = {
            "skills": [
                {
                    **s.model_dump(),
                    "created_at": s.created_at.isoformat() if s.created_at else None,
                }
                for s in self.skills.values()
            ]
        }
        self.SKILLS_FILE.parent.mkdir(exist_ok=True)
        self.SKILLS_FILE.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")

    def _load_defaults(self):
        import uuid
        for skill_data in self.DEFAULT_SKILLS:
            skill = Skill(
                id=str(uuid.uuid4())[:8],
                name=skill_data["name"],
                description=skill_data["description"],
                prompt=skill_data["prompt"],
                tools=skill_data.get("tools", []),
                category=skill_data.get("category", "general"),
                created_at=datetime.utcnow()
            )
            self.skills[skill.name] = skill
        self._save()

    def add_skill(self, skill: Skill):
        self.skills[skill.name] = skill
        self._save()

    def get_skill(self, name: str) -> Skill | None:
        return self.skills.get(name)

    def list_skills(self, category: str = None) -> list[Skill]:
        skills = list(self.skills.values())
        if category:
            skills = [s for s in skills if s.category == category]
        return skills

    def remove_skill(self, name: str):
        self.skills.pop(name, None)
        self._save()

    def create_skill_from_interaction(self, name: str, description: str, user_feedback: str):
        import uuid
        
        prompt = f"""Tu es un expert en {description}.
Tu as été créé suite au feedback suivant: {user_feedback}
Utilise cette expertise pour aider l'utilisateur."""
        
        skill = Skill(
            id=str(uuid.uuid4())[:8],
            name=name,
            description=description,
            prompt=prompt,
            tools=[],
            created_at=datetime.utcnow()
        )
        self.add_skill(skill)
        return skill

    def suggest_skill(self, task: str) -> Skill | None:
        task_lower = task.lower()
        
        if any(kw in task_lower for kw in ["bug", "error", "crash", "debug"]):
            return self.get_skill("debugger")
        if any(kw in task_lower for kw in ["review", "improve", "refactor", "clean"]):
            return self.get_skill("code_reviewer")
        if any(kw in task_lower for kw in ["architecture", "design", "structure"]):
            return self.get_skill("architect")
        if any(kw in task_lower for kw in ["recherche", "search", "trouve"]):
            return self.get_skill("researcher")
        if any(kw in task_lower for kw in ["écris", "write", "rédaction", "doc"]):
            return self.get_skill("writer")
        
        return None


class PersonalityManager:
    from pathlib import Path
    PERSONALITIES_FILE = Path(__file__).parent.parent.parent / "data" / "personalities.json"

    DEFAULT_PERSONALITIES = [
        {
            "name": "professional",
            "description": "Professionnel et efficace",
            "system_prompt": "Tu es Wolf, un super-assistant IA professionnel, concis et orienté résultats. Tu réponds toujours de manière structurée et factuelle.",
            "traits": ["efficient", "concise", "professional"]
        },
        {
            "name": "friendly",
            "description": "Amical et décontracté",
            "system_prompt": "Tu es Wolf, un super-assistant IA amical et chaleureux. Utilise un ton décontracté, fais des blagues légères et montre de l'empathie. Tutoie toujours l'utilisateur.",
            "traits": ["friendly", "casual", "helpful"]
        },
        {
            "name": "mentor",
            "description": "Pédagogue et formateur",
            "system_prompt": "Tu es Wolf, un mentor pédagogique bienveillant. Explique chaque concept clairement, étape par étape, avec des exemples concrets. Encourage l'apprentissage et la curiosité.",
            "traits": ["pedagogical", "patient", "educational"]
        },
        {
            "name": "expert",
            "description": "Expert technique détaillé",
            "system_prompt": "Tu es Wolf, un expert technique de haut niveau. Sois précis, exhaustif et n'hésite pas à utiliser la terminologie technique appropriée. Cite des sources et des références quand c'est pertinent.",
            "traits": ["technical", "precise", "detailed"]
        },
        {
            "name": "creative",
            "description": "Créatif et imaginatif",
            "system_prompt": "Tu es Wolf, un assistant IA créatif et imaginatif. Propose des idées originales, pense hors des sentiers battus et apporte une touche d'originalité à chaque réponse.",
            "traits": ["creative", "original", "innovative"]
        },
    ]

    def __init__(self):
        self.personalities: dict[str, Personality] = {}
        self.active_personality: str = "professional"
        self._load()

    def _load(self):
        import uuid, json
        from datetime import datetime
        if self.PERSONALITIES_FILE.exists():
            try:
                data = json.loads(self.PERSONALITIES_FILE.read_text(encoding="utf-8"))
                self.active_personality = data.get("active", "professional")
                for p in data.get("personalities", []):
                    p.setdefault("id", str(uuid.uuid4())[:8])
                    p.setdefault("traits", [])
                    p.setdefault("created_at", datetime.utcnow().isoformat())
                    if isinstance(p.get("created_at"), str):
                        try:
                            p["created_at"] = datetime.fromisoformat(p["created_at"])
                        except Exception:
                            p["created_at"] = datetime.utcnow()
                    personality = Personality(**p)
                    self.personalities[p["name"]] = personality
                return
            except Exception:
                pass
        self._load_defaults()

    def _save(self):
        import json
        data = {
            "active": self.active_personality,
            "personalities": [
                {
                    **p.model_dump(),
                    "created_at": p.created_at.isoformat() if p.created_at else None,
                }
                for p in self.personalities.values()
            ]
        }
        self.PERSONALITIES_FILE.parent.mkdir(exist_ok=True)
        self.PERSONALITIES_FILE.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")

    def _load_defaults(self):
        import uuid
        from datetime import datetime
        for pers_data in self.DEFAULT_PERSONALITIES:
            personality = Personality(
                id=str(uuid.uuid4())[:8],
                name=pers_data["name"],
                description=pers_data["description"],
                system_prompt=pers_data["system_prompt"],
                traits=pers_data.get("traits", []),
                created_at=datetime.utcnow()
            )
            self.personalities[pers_data["name"]] = personality
        self._save()

    def set_active(self, name: str) -> bool:
        if name in self.personalities:
            self.active_personality = name
            self._save()
            return True
        return False

    def get_active(self) -> "Personality":
        return self.personalities.get(self.active_personality) or next(iter(self.personalities.values()))

    def add_personality(self, personality: "Personality"):
        self.personalities[personality.name] = personality
        self._save()

    def update_personality(self, name: str, **kwargs) -> bool:
        if name not in self.personalities:
            return False
        p = self.personalities[name]
        for k, v in kwargs.items():
            if v is not None and hasattr(p, k) and k not in ("id", "created_at"):
                setattr(p, k, v)
        self._save()
        return True

    def remove_personality(self, name: str) -> bool:
        if name not in self.personalities:
            return False
        del self.personalities[name]
        if self.active_personality == name:
            fallback = next((k for k in self.personalities if k != name), None)
            self.active_personality = fallback or "professional"
        self._save()
        return True

    def list_personalities(self) -> list["Personality"]:
        return list(self.personalities.values())

    def detect_personality_command(self, message: str) -> Optional[str]:
        """Détecte si le message contient une commande de changement de personnalité.
        Retourne le nom de la personnalité si détectée, None sinon."""
        msg_lower = message.lower().strip()
        # Commandes explicites: /persona nom ou !perso nom
        import re
        match = re.match(r'^[/!](?:persona|perso|personnalité|personality)\s+(\w+)', msg_lower)
        if match:
            requested = match.group(1)
            for name in self.personalities:
                if name.lower() == requested.lower():
                    return name
        # Détection par nom dans la phrase
        triggers = ["sois en mode", "passe en mode", "active la personnalité", "personnalité", "mode "]
        for trigger in triggers:
            if trigger in msg_lower:
                for name in self.personalities:
                    if name.lower() in msg_lower:
                        return name
        return None


class SubAgent(BaseModel):
    id: str
    name: str
    role: str
    expertise: str
    system_prompt: str
    tools: list[str] = []
    provider: str = "openrouter"
    model: str = ""          # vide = utiliser le modèle par défaut du provider
    created_at: Optional[datetime] = None


class SubAgentLibrary:
    from pathlib import Path
    AGENTS_FILE = Path(__file__).parent.parent.parent / "data" / "agents.json"

    def __init__(self):
        self.agents: dict[str, SubAgent] = {}
        self._load()

    def _load(self):
        import uuid, json
        if self.AGENTS_FILE.exists():
            try:
                data = json.loads(self.AGENTS_FILE.read_text(encoding="utf-8"))
                for a in data.get("agents", []):
                    a.setdefault("id", str(uuid.uuid4())[:8])
                    a.setdefault("tools", [])
                    if isinstance(a.get("created_at"), str):
                        try:
                            a["created_at"] = datetime.fromisoformat(a["created_at"])
                        except Exception:
                            a["created_at"] = datetime.utcnow()
                    agent = SubAgent(**a)
                    self.agents[agent.name] = agent
                return
            except Exception:
                pass

    def _save(self):
        import json
        data = {
            "agents": [
                {
                    **a.model_dump(),
                    "created_at": a.created_at.isoformat() if a.created_at else None,
                }
                for a in self.agents.values()
            ]
        }
        self.AGENTS_FILE.parent.mkdir(exist_ok=True)
        self.AGENTS_FILE.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")

    def add_agent(self, agent: SubAgent):
        self.agents[agent.name] = agent
        self._save()

    def get_agent(self, name: str) -> Optional[SubAgent]:
        return self.agents.get(name)

    def list_agents(self) -> list[SubAgent]:
        return list(self.agents.values())

    def remove_agent(self, name: str):
        self.agents.pop(name, None)
        self._save()


skill_library = SkillLibrary()
personality_manager = PersonalityManager()
subagent_library = SubAgentLibrary()
