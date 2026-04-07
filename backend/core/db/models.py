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

    messages = relationship("Message", back_populates="conversation", cascade="all, delete-orphan")


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
    avatar_url = Column(Text, default="")
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime, server_default=func.now())
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())


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
    provider = Column(String(100), unique=True, nullable=False)
    monthly_limit = Column(Float, nullable=True)
    weekly_limit = Column(Float, nullable=True)


# ── Plugin registry ──────────────────────────────────────────────────────────

class PluginRegistry(Base):
    __tablename__ = "plugin_registry"

    id = Column(Integer, primary_key=True, autoincrement=True)
    name = Column(String(100), unique=True, nullable=False)
    enabled = Column(Boolean, default=True)
    version = Column(String(20), default="1.0.0")
    config_json = Column(JSON, default=dict)
    installed_at = Column(DateTime, server_default=func.now())


# ── DB init ──────────────────────────────────────────────────────────────────

async def init_db(engine):
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        # Migrate: add user_id column to conversations if missing
        try:
            await conn.execute(
                __import__("sqlalchemy").text(
                    "ALTER TABLE conversations ADD COLUMN user_id INTEGER REFERENCES users(id)"
                )
            )
            print("[DB] Migration: added user_id to conversations")
        except Exception:
            pass  # Column already exists
