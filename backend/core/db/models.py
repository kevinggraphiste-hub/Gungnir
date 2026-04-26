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
    # Modèle / provider effectivement utilisés pour GÉNÉRER ce message
    # (rempli côté assistant uniquement). Permet à l'UI de garder la bonne
    # étiquette sur les bulles historiques même si l'user change de modèle
    # actif en cours de conversation.
    model = Column(String(255), default="")
    provider = Column(String(100), default="")
    # Images GÉNÉRÉES par l'assistant (DALL-E, Imagen, NanoBanana…) — distinct
    # du champ `content` texte et des images UPLOADÉES par l'user (stockées
    # en base64 dans le payload de requête, pas persistées). Format :
    # [{"url": "...", "b64": "...", "mime_type": "image/png", "size": "1024x1024", "revised_prompt": "..."}]
    images_out = Column(JSON, nullable=True)
    # Coût USD calculé via le pricing dynamique (OpenRouter live + fallback
    # statique) au moment du write. Permet à l'UI de sommer les coûts réels
    # par bulle pour le compteur « coût session » sans estimation approximative.
    cost_usd = Column(Float, default=0.0)

    conversation = relationship("Conversation", back_populates="messages")


class User(Base):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True, autoincrement=True)
    username = Column(String(100), unique=True, nullable=False)
    display_name = Column(String(200), default="")
    password_hash = Column(String(256), nullable=True)
    api_token = Column(String(128), nullable=True, unique=True)
    # Expiration du token (fix sécu M1). Si NULL, le token est valide
    # indéfiniment (compat arrière — les users existants ne sont pas
    # déconnectés). Un nouveau login pose 30 jours par défaut.
    token_expires_at = Column(DateTime, nullable=True)
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

    # Migrations core : tables du noyau (users, conversations, user_settings).
    core_migrations: list[tuple[str, str]] = [
        ("ALTER TABLE conversations ADD COLUMN user_id INTEGER REFERENCES users(id)", "user_id -> conversations"),
        ("ALTER TABLE users ADD COLUMN is_admin BOOLEAN DEFAULT FALSE", "is_admin -> users"),
        ("ALTER TABLE conversations ADD COLUMN folder_id INTEGER REFERENCES conversation_folders(id)", "folder_id -> conversations"),
        ("ALTER TABLE user_settings ADD COLUMN language VARCHAR(10) DEFAULT 'fr'", "language -> user_settings"),
        ("ALTER TABLE user_settings ADD COLUMN voice_config JSONB DEFAULT '{}'::jsonb", "voice_config -> user_settings"),
        ("ALTER TABLE user_settings ADD COLUMN huntr_config JSONB DEFAULT '{}'::jsonb", "huntr_config -> user_settings"),
        ("ALTER TABLE user_settings ADD COLUMN ui_preferences JSONB DEFAULT '{}'::jsonb", "ui_preferences -> user_settings"),
        ("ALTER TABLE users ADD COLUMN token_expires_at TIMESTAMP NULL", "token_expires_at -> users"),
        ("ALTER TABLE messages ADD COLUMN model VARCHAR(255) DEFAULT ''", "model -> messages"),
        ("ALTER TABLE messages ADD COLUMN provider VARCHAR(100) DEFAULT ''", "provider -> messages"),
        ("ALTER TABLE messages ADD COLUMN images_out JSONB DEFAULT NULL", "images_out -> messages"),
        ("ALTER TABLE messages ADD COLUMN cost_usd DOUBLE PRECISION DEFAULT 0.0", "cost_usd -> messages"),
        ("ALTER TABLE conversations ADD COLUMN is_pinned BOOLEAN DEFAULT FALSE", "is_pinned -> conversations"),
    ]

    # Migrations plugin : chaque plugin expose optionnellement sa propre liste
    # via `backend.plugins.<name>.migrations.MIGRATIONS`. Scan non-intrusif —
    # un plugin sans fichier migrations.py est simplement ignoré.
    plugin_migrations: list[tuple[str, str]] = []
    try:
        from pathlib import Path as _Path
        import importlib as _il
        _plugins_dir = _Path(__file__).resolve().parents[2] / "plugins"
        external_dir = _Path(__file__).resolve().parents[3] / "data" / "plugins_external"
        for base in (_plugins_dir, external_dir):
            if not base.exists():
                continue
            for d in sorted(base.iterdir()):
                if not d.is_dir():
                    continue
                mig_file = d / "migrations.py"
                if not mig_file.exists():
                    continue
                # Résolution du module selon le path (core vs external)
                if base == _plugins_dir:
                    mod_name = f"backend.plugins.{d.name}.migrations"
                else:
                    mod_name = f"plugins_external.{d.name}.migrations"
                try:
                    mod = _il.import_module(mod_name)
                    items = getattr(mod, "MIGRATIONS", []) or []
                    for entry in items:
                        if isinstance(entry, (tuple, list)) and len(entry) == 2:
                            plugin_migrations.append((str(entry[0]), str(entry[1])))
                except Exception as e:
                    print(f"[DB] Plugin migration scan failed for {d.name}: {e}")
    except Exception as e:
        print(f"[DB] Plugin migration discovery failed: {e}")

    migrations = core_migrations + plugin_migrations
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
