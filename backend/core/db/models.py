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
    title = Column(String(255), default="Nouvelle conversation")
    provider = Column(String(100))
    model = Column(String(255))
    created_at = Column(DateTime, server_default=func.now())
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())
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
