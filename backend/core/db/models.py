"""
Gungnir — Core database models
"""
from datetime import datetime
from sqlalchemy import (
    Column, Integer, String, Text, DateTime, Date,
    Boolean, Float, ForeignKey, JSON, func
)
from sqlalchemy.orm import DeclarativeBase, relationship


class Base(DeclarativeBase):
    pass


# ── Core tables ──────────────────────────────────────────────────────────────

class Conversation(Base):
    __tablename__ = "conversations"

    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=True)
    title = Column(String(255), default="Nouvelle conversation")
    provider = Column(String(100))
    model = Column(String(255))
    created_at = Column(DateTime, default=datetime.utcnow, server_default=func.now())
    updated_at = Column(DateTime, default=datetime.utcnow, server_default=func.now(), onupdate=datetime.utcnow)
    is_pinned = Column(Boolean, default=False)
    metadata_json = Column(JSON, default=dict)
    # Classement
    folder_id = Column(Integer, ForeignKey("conversation_folders.id"), nullable=True)

    messages = relationship("Message", back_populates="conversation", cascade="all, delete-orphan")
    tasks = relationship("ConversationTask", back_populates="conversation", cascade="all, delete-orphan")


class ConversationFolder(Base):
    """Dossier pour regrouper des conversations. Supporte une arborescence via parent_id."""
    __tablename__ = "conversation_folders"

    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=True)
    name = Column(String(255), nullable=False)
    parent_id = Column(Integer, ForeignKey("conversation_folders.id"), nullable=True)
    color = Column(String(20), default="#dc2626")
    icon = Column(String(50), default="folder")
    position = Column(Integer, default=0)
    created_at = Column(DateTime, server_default=func.now())
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())


class ConversationTag(Base):
    """Étiquette transversale — une conversation peut avoir plusieurs tags."""
    __tablename__ = "conversation_tags"

    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=True)
    name = Column(String(100), nullable=False)
    color = Column(String(20), default="#6366f1")
    created_at = Column(DateTime, server_default=func.now())


class ConversationTagLink(Base):
    """Table de liaison many-to-many Conversation ↔ Tag."""
    __tablename__ = "conversation_tag_links"

    id = Column(Integer, primary_key=True, autoincrement=True)
    conversation_id = Column(Integer, ForeignKey("conversations.id", ondelete="CASCADE"), nullable=False)
    tag_id = Column(Integer, ForeignKey("conversation_tags.id", ondelete="CASCADE"), nullable=False)


class ConversationTask(Base):
    """
    Tâche de projet liée à une conversation — modèle todo-list façon Claude Code.
    L'agent et l'utilisateur peuvent créer, cocher, réordonner ces tâches.
    """
    __tablename__ = "conversation_tasks"

    id = Column(Integer, primary_key=True, autoincrement=True)
    conversation_id = Column(Integer, ForeignKey("conversations.id", ondelete="CASCADE"), nullable=False)
    content = Column(Text, nullable=False)       # Forme impérative ("Écrire la doc")
    active_form = Column(Text, nullable=True)    # Forme continue ("Écriture de la doc")
    status = Column(String(20), default="pending")  # pending | in_progress | completed
    position = Column(Integer, default=0)
    created_by = Column(String(20), default="user")  # user | agent
    created_at = Column(DateTime, server_default=func.now())
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())

    conversation = relationship("Conversation", back_populates="tasks")


class Message(Base):
    __tablename__ = "messages"

    id = Column(Integer, primary_key=True, autoincrement=True)
    conversation_id = Column(Integer, ForeignKey("conversations.id"))
    role = Column(String(20))
    content = Column(Text)
    tool_calls = Column(JSON, nullable=True)
    created_at = Column(DateTime, server_default=func.now())
    tokens_input = Column(Integer, default=0)
    tokens_output = Column(Integer, default=0)

    conversation = relationship("Conversation", back_populates="messages")


class User(Base):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True, autoincrement=True)
    username = Column(String(100), unique=True, nullable=False)
    display_name = Column(String(200), default="")
    password_hash = Column(String(256), nullable=True)
    api_token = Column(String(128), nullable=True, unique=True)
    avatar_url = Column(Text, default="")
    is_active = Column(Boolean, default=True)
    is_admin = Column(Boolean, default=False)
    created_at = Column(DateTime, server_default=func.now())
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())

    settings = relationship("UserSettings", back_populates="user", uselist=False, cascade="all, delete-orphan")


class UserSettings(Base):
    """Per-user API keys and preferences. Each user brings their own keys."""
    __tablename__ = "user_settings"

    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(Integer, ForeignKey("users.id"), unique=True, nullable=False)
    # JSON blob: {"openrouter": {"api_key": "enc:...", "enabled": true}, ...}
    provider_keys = Column(JSON, default=dict)
    # JSON blob: {"qdrant": {"api_key": "enc:...", "base_url": "..."}, ...}
    service_keys = Column(JSON, default=dict)
    # Tombstone for bundled defaults the user explicitly deleted, so the seed
    # functions don't re-create them on the next list call. Shape:
    # {"skills": ["old_template"], "personalities": [...], "sub_agents": [...]}
    deleted_defaults = Column(JSON, default=dict)
    # User preferences (active provider/model/language)
    active_provider = Column(String(100), default="openrouter")
    active_model = Column(String(255), default="")
    language = Column(String(10), default="fr")
    # Per-user agent name (overrides Settings.app.agent_name when set). Filled
    # by the welcome onboarding chat at first login.
    agent_name = Column(String(100), default="")
    # Onboarding state machine. Shape:
    # {"step": "name|formality|personality|soul|mode|api_key|done",
    #  "convo_id": <int|None>,  # the welcome conversation id
    #  "answers": {"name": "...", "formality": "tu", ...}}
    onboarding_state = Column(JSON, default=dict)
    # Per-user voice provider config (ElevenLabs, OpenAI Realtime, Gemini Live, Grok).
    # Shape: {"elevenlabs": {"enabled": bool, "api_key": "enc:...", "voice_id": str,
    #         "agent_id": str, "language": "fr"}, "openai": {...}, ...}
    # API keys are encrypted with Settings.encrypt_value before persistence.
    voice_config = Column(JSON, default=dict)
    # Per-user HuntR preferences (custom response format override, etc.).
    # Shape: {"custom_format": "Texte libre décrivant le squelette Markdown attendu"}
    # Si custom_format est présent, il remplace le _BASE_STRUCTURE dans le system
    # prompt pro — c'est LA manière correcte de changer le format par-user, pas
    # l'édition du code.
    huntr_config = Column(JSON, default=dict)
    # Accessibilité / préférences UI. Shape :
    # {"font_family": "inter" | "opendyslexic" | "atkinson", "font_style": "sans" | "serif",
    #  "font_size": "small" | "normal" | "large", "line_spacing": "tight"|"normal"|"loose"}
    ui_preferences = Column(JSON, default=dict)
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())

    user = relationship("User", back_populates="settings")


class AgentTask(Base):
    __tablename__ = "agent_tasks"

    id = Column(Integer, primary_key=True, autoincrement=True)
    conversation_id = Column(Integer, ForeignKey("conversations.id"))
    task_type = Column(String(50))
    status = Column(String(20), default="pending")
    input_data = Column(JSON)
    output_data = Column(JSON, nullable=True)
    error = Column(Text, nullable=True)
    created_at = Column(DateTime, server_default=func.now())
    completed_at = Column(DateTime, nullable=True)


# ── Cost & Budget ───────────────────────────────────────────────────────────

class CostAnalytics(Base):
    __tablename__ = "cost_analytics"

    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=True)
    date = Column(Date, nullable=False)
    conversation_id = Column(Integer, ForeignKey("conversations.id"), nullable=True)
    model = Column(String(255), nullable=False)
    tokens_input = Column(Integer, default=0)
    tokens_output = Column(Integer, default=0)
    cost = Column(Float, default=0.0)
    created_at = Column(DateTime, default=datetime.utcnow, server_default=func.now())


class BudgetSettings(Base):
    __tablename__ = "budget_settings"

    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=True)
    monthly_limit = Column(Float, nullable=True)
    weekly_limit = Column(Float, nullable=True)
    alert_80 = Column(Boolean, default=True)
    alert_90 = Column(Boolean, default=True)
    alert_100 = Column(Boolean, default=True)
    block_on_limit = Column(Boolean, default=False)
    updated_at = Column(DateTime, default=datetime.utcnow, server_default=func.now())


class ProviderBudget(Base):
    __tablename__ = "provider_budgets"

    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=True)
    provider = Column(String(100), nullable=False)
    monthly_limit = Column(Float, nullable=True)
    weekly_limit = Column(Float, nullable=True)
    block_on_limit = Column(Boolean, default=False)


# ── Plugin registry ──────────────────────────────────────────────────────────

class PluginRegistry(Base):
    __tablename__ = "plugin_registry"

    id = Column(Integer, primary_key=True, autoincrement=True)
    name = Column(String(100), unique=True, nullable=False)
    enabled = Column(Boolean, default=True)
    version = Column(String(20), default="1.0.0")
    config_json = Column(JSON, default=dict)
    installed_at = Column(DateTime, server_default=func.now())


# ── Per-user data (skills, personalities, sub-agents) ───────────────────────

class UserSkill(Base):
    """Per-user skills — each user has their own skill library."""
    __tablename__ = "user_skills"

    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    name = Column(String(100), nullable=False)
    data_json = Column(JSON, default=dict)  # Full skill data: description, prompt, category, tools, icon, is_favorite, etc.
    is_active = Column(Boolean, default=False)
    position = Column(Integer, default=0)
    created_at = Column(DateTime, server_default=func.now())
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())


class UserPersonality(Base):
    """Per-user personalities — each user customizes their own set."""
    __tablename__ = "user_personalities"

    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    name = Column(String(100), nullable=False)
    data_json = Column(JSON, default=dict)  # Full personality data: description, system_prompt, traits
    is_active = Column(Boolean, default=False)
    position = Column(Integer, default=0)
    created_at = Column(DateTime, server_default=func.now())
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())


class UserSubAgent(Base):
    """Per-user sub-agents."""
    __tablename__ = "user_sub_agents"

    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    name = Column(String(100), nullable=False)
    data_json = Column(JSON, default=dict)  # Full agent data: role, expertise, system_prompt, tools, provider, model
    position = Column(Integer, default=0)
    created_at = Column(DateTime, server_default=func.now())
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())


class HuntRSearch(Base):
    """Per-user HuntR search history (replaces in-memory dict)."""
    __tablename__ = "huntr_searches"

    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=True, index=True)
    query = Column(Text, nullable=False)
    mode = Column(String(20), default="classique")       # "classique" | "pro"
    topic = Column(String(20), default="web", index=True)  # "web" | "news" | "academic" | "code"
    answer = Column(Text, default="")
    citations = Column(JSON, default=list)               # [{index, url, title, snippet}]
    related_questions = Column(JSON, default=list)       # [str]
    engines = Column(JSON, default=list)                 # ["duckduckgo", "tavily"]
    sources_count = Column(Integer, default=0)
    time_ms = Column(Integer, default=0)
    model = Column(String(255), default="")
    is_favorite = Column(Boolean, default=False, index=True)
    created_at = Column(DateTime, default=datetime.utcnow, server_default=func.now(), index=True)


class MCPServerConfig(Base):
    """Per-user MCP server configuration."""
    __tablename__ = "mcp_server_configs"

    id = Column(Integer, primary_key=True, autoincrement=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    name = Column(String(100), nullable=False)
    command = Column(String(255), nullable=False)
    args_json = Column(JSON, default=list)           # list[str]
    env_json = Column(JSON, default=dict)            # dict[str, str] — secrets encrypted via FERNET
    enabled = Column(Boolean, default=True)
    created_at = Column(DateTime, server_default=func.now())
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())


# ── DB init ──────────────────────────────────────────────────────────────────

async def init_db(engine):
    # 1) create_all dans une transaction isolée
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    # 2) Migrations ALTER TABLE — CHACUNE dans sa propre transaction, sinon sur
    # PostgreSQL un échec (colonne déjà présente) poisonne la transaction et
    # les migrations suivantes sont silencieusement ignorées.
    _text = __import__("sqlalchemy").text
    migrations = [
        ("ALTER TABLE conversations ADD COLUMN user_id INTEGER REFERENCES users(id)", "user_id -> conversations"),
        ("ALTER TABLE users ADD COLUMN is_admin BOOLEAN DEFAULT FALSE", "is_admin -> users"),
        ("ALTER TABLE conversations ADD COLUMN folder_id INTEGER REFERENCES conversation_folders(id)", "folder_id -> conversations"),
        ("ALTER TABLE user_settings ADD COLUMN language VARCHAR(10) DEFAULT 'fr'", "language -> user_settings"),
        ("ALTER TABLE huntr_searches ADD COLUMN topic VARCHAR(20) DEFAULT 'web'", "topic -> huntr_searches"),
        ("ALTER TABLE user_settings ADD COLUMN voice_config JSONB DEFAULT '{}'::jsonb", "voice_config -> user_settings"),
        ("ALTER TABLE user_settings ADD COLUMN huntr_config JSONB DEFAULT '{}'::jsonb", "huntr_config -> user_settings"),
        ("ALTER TABLE user_settings ADD COLUMN ui_preferences JSONB DEFAULT '{}'::jsonb", "ui_preferences -> user_settings"),
        # ── Plugin Valkyrie : extensions de carte (v1.1) ─────────────────
        ("ALTER TABLE valkyrie_cards ADD COLUMN subtitle VARCHAR(300) DEFAULT ''", "subtitle -> valkyrie_cards"),
        ("ALTER TABLE valkyrie_cards ADD COLUMN subtasks2_json JSONB DEFAULT '[]'::jsonb", "subtasks2_json -> valkyrie_cards"),
        ("ALTER TABLE valkyrie_cards ADD COLUMN tags_json JSONB DEFAULT '[]'::jsonb", "tags_json -> valkyrie_cards"),
        ("ALTER TABLE valkyrie_cards ADD COLUMN subtasks2_title VARCHAR(60) DEFAULT ''", "subtasks2_title -> valkyrie_cards"),
        ("ALTER TABLE valkyrie_cards ADD COLUMN due_date TIMESTAMP NULL", "due_date -> valkyrie_cards"),
        ("ALTER TABLE valkyrie_cards ADD COLUMN archived_at TIMESTAMP NULL", "archived_at -> valkyrie_cards"),
        ("ALTER TABLE valkyrie_cards ADD COLUMN origin VARCHAR(80) DEFAULT ''", "origin -> valkyrie_cards"),
    ]
    for sql, label in migrations:
        try:
            async with engine.begin() as conn:
                await conn.execute(_text(sql))
            print(f"[DB] Migration: {label}")
        except Exception as e:
            # Column already exists -> skip. Other error -> log for debug.
            msg = str(e).lower()
            if "already exists" not in msg and "duplicate column" not in msg:
                print(f"[DB] Migration skipped ({label}): {e}")
